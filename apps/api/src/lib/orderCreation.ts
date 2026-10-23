import { Prisma } from "@prisma/client";
import { canOverrideDuplicatePo, PO_DUPLICATE_OVERRIDE_ROLE_KEYS, STAGE_KEY } from "@recd/shared";
import { prisma } from "./prisma";
import { isOrderNumberConflict } from "./uniqueViolations";

/**
 * The one place a NEW order (with its site and RECD units) is created for POST /orders and for the AI
 * assistant's confirmed create_order action, so both apply the same rules:
 *
 *  - the customer and the product must exist (a clean client error, not a foreign-key 500);
 *  - the PO number is checked against the same customer's orders, case-insensitively after trimming;
 *  - a duplicate is refused unless an administrator role explicitly allows it, in which case the order is flagged;
 *  - order, site and units are saved in ONE transaction, so a failure leaves nothing behind;
 *  - a generated-order-number collision is retried a bounded number of times, each retry in a fresh transaction.
 *
 * `POST /sites/:id/clone-order` uses the SAME duplicate rule (`resolveDuplicatePo`, below): the PO it copies from the source
 * order (or the one the caller enters) is checked against the customer's orders under the same lock, refused as `DUPLICATE_PO`
 * unless an administrator role passes `allowDuplicatePo`, in which case the clone is created and flagged `poDuplicateFlag`.
 * Before this, clone-order skipped the check, so any user with `manage_orders` could create a duplicate-PO order through it.
 */

/** Roles that may knowingly create a second order for the same customer + PO number. */
export const ADMIN_ROLES_FOR_PO_OVERRIDE: readonly string[] = PO_DUPLICATE_OVERRIDE_ROLE_KEYS;

/** How many order numbers are tried before giving up. */
export const ORDER_NUMBER_MAX_ATTEMPTS = 5;

/** A client-visible problem with the request (HTTP `status`, our own safe `message`, optional machine `code`). */
export class OrderCreationError extends Error {
  constructor(public status: 400 | 409, message: string, public code?: string, public existingOrderNumber?: string) {
    super(message);
    this.name = "OrderCreationError";
  }
}

export const generateOrderNumber = () => `ORD-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`;

export const duplicatePoMessage = (poNumber: string, existingOrderNumber: string, mayOverride: boolean) =>
  `PO ${poNumber} already exists for this customer (order ${existingOrderNumber}).` +
  (mayOverride ? " Tick 'allow duplicate PO' to create it anyway." : " Ask an admin to override if this is intentional.");

/**
 * What the AI assistant says when it meets a duplicate PO. The assistant can never approve a duplicate itself; the
 * wording only depends on whether the signed-in user could do so on the Orders page (`canOverride`).
 */
export const agentDuplicatePoMessage = (poNumber: string, existingOrderNumber: string, canOverride: boolean, customerName?: string) =>
  `PO ${poNumber} already exists for ${customerName ?? "this customer"} (order ${existingOrderNumber}). The assistant cannot approve or create a duplicate PO itself.` +
  (canOverride
    ? " If this duplicate is intentional, reject this request and enter the order on the Orders page, ticking 'Allow a duplicate PO'. Otherwise, check the PO number."
    : " Check the PO number with the customer; if the duplicate is intentional, an administrator has to enter the order on the Orders page.");

export const orderNumberExhaustedMessage = `Could not allocate a free order number after ${ORDER_NUMBER_MAX_ATTEMPTS} attempts. Nothing was saved - please submit again.`;

type Tx = Prisma.TransactionClient;

/**
 * Serialises concurrent creations for the same customer + PO number for the rest of the transaction
 * (transaction-scoped advisory lock; released automatically on commit or rollback). The key is built in SQL with
 * lower(), the same comparison the duplicate lookup uses, so the lock and the lookup always agree.
 * No unique index is added: approved duplicates and clone-order siblings legitimately share a PO.
 */
async function lockCustomerPo(tx: Tx, customerId: string, poNumber: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('order-po:' || ${customerId}::text || ':' || lower(${poNumber}::text), 0))`;
}

/**
 * The one duplicate-PO rule, run INSIDE the creating transaction (after taking the customer + PO lock): looks for another order of the same
 * customer with the same PO (case-insensitive, trimmed) and returns the value for `poDuplicateFlag`. A duplicate is refused (409 DUPLICATE_PO)
 * unless the caller asked to allow it AND holds an override role (`canOverrideDuplicatePo`); an approved duplicate is flagged on the order,
 * which is the audit trail. Another customer's identical PO is NOT a duplicate (the rule is per customer). A blank PO (legacy) is not checked.
 */
export async function resolveDuplicatePo(
  tx: Tx,
  args: { customerId: string; poNumber: string | null | undefined; allowDuplicatePo?: boolean; roleKey: string | null | undefined },
): Promise<boolean> {
  const poNumber = args.poNumber?.trim();
  if (!poNumber) return false;
  await lockCustomerPo(tx, args.customerId, poNumber);
  const dupe = await tx.order.findFirst({
    where: { customerId: args.customerId, poNumber: { equals: poNumber, mode: "insensitive" } },
    select: { orderNumber: true },
  });
  if (!dupe) return false;
  const mayOverride = canOverrideDuplicatePo(args.roleKey);
  if (!(args.allowDuplicatePo && mayOverride)) {
    throw new OrderCreationError(409, duplicatePoMessage(poNumber, dupe.orderNumber, mayOverride), "DUPLICATE_PO", dupe.orderNumber);
  }
  return true;
}

/** Throws a 400 when the customer or product does not exist (used before anything is written). */
export async function assertOrderReferences(db: Pick<typeof prisma, "customer" | "product">, customerId: string, productIds: string[]) {
  const customer = await db.customer.findUnique({ where: { id: customerId }, select: { id: true } });
  if (!customer) throw new OrderCreationError(400, "Customer not found");
  for (const productId of new Set(productIds)) {
    const product = await db.product.findUnique({ where: { id: productId }, select: { id: true } });
    if (!product) throw new OrderCreationError(400, "Product not found");
  }
}

/**
 * Runs `attempt` with a freshly generated order number, retrying (bounded) only when that number is already taken.
 * Every attempt is its own transaction, so a collision leaves no partial order, site or unit behind.
 */
export async function withOrderNumber<T>(attempt: (orderNumber: string) => Promise<T>): Promise<T> {
  for (let i = 0; i < ORDER_NUMBER_MAX_ATTEMPTS; i++) {
    try {
      return await attempt(generateOrderNumber());
    } catch (err) {
      if (isOrderNumberConflict(err)) continue;
      throw mapForeignKeyRace(err);
    }
  }
  throw new OrderCreationError(409, orderNumberExhaustedMessage, "ORDER_NUMBER_EXHAUSTED");
}

/** A customer / product deleted between our check and the insert surfaces as P2003: a safe retryable 409. */
function mapForeignKeyRace(err: unknown): unknown {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2003") {
    return new OrderCreationError(409, "The customer or product was changed while the order was being saved. Nothing was saved - please check and submit again.", "REFERENCE_CHANGED");
  }
  return err;
}

export interface NewOrderInput {
  customerId: string;
  productId: string;
  quantity: number;
  value?: number;
  orderDate?: string;
  promisedDeliveryDate?: string;
  plannedExhaustHookupType?: string | null;
  poNumber: string;
  poDate?: string;
  serials: string[];
  salesEngineerId: string;
  /** The caller asked to allow a duplicate PO (honoured only for administrator roles). */
  allowDuplicatePo?: boolean;
  /** Role of the caller; decides whether `allowDuplicatePo` may be honoured. */
  roleKey: string | null;
}

export async function createNewOrder(input: NewOrderInput) {
  const poNumber = input.poNumber.trim();
  if (!poNumber) throw new OrderCreationError(400, "PO number is required");
  await assertOrderReferences(prisma, input.customerId, [input.productId]);

  return withOrderNumber((orderNumber) =>
    prisma.$transaction(async (tx) => {
      const poDuplicateFlag = await resolveDuplicatePo(tx, { customerId: input.customerId, poNumber, allowDuplicatePo: input.allowDuplicatePo, roleKey: input.roleKey });

      const firstStage = await tx.stageDefinition.findUniqueOrThrow({ where: { key: STAGE_KEY.ORDER_RECEIVED } });
      const created = await tx.order.create({
        data: {
          orderNumber,
          customerId: input.customerId,
          productId: input.productId,
          quantity: input.quantity,
          value: input.value,
          orderDate: input.orderDate ? new Date(input.orderDate) : undefined,
          promisedDeliveryDate: input.promisedDeliveryDate ? new Date(input.promisedDeliveryDate) : undefined,
          plannedExhaustHookupType: input.plannedExhaustHookupType ?? undefined,
          poNumber,
          poDate: input.poDate ? new Date(input.poDate) : undefined,
          poDuplicateFlag,
          salesEngineerId: input.salesEngineerId,
          site: { create: { currentStageId: firstStage.id } },
        },
        include: { site: true },
      });
      await tx.recdUnit.createMany({
        data: input.serials.map((serialNo) => ({ serialNo, orderId: created.id, siteId: created.site?.id, productId: input.productId })),
      });
      return created;
    }),
  );
}
