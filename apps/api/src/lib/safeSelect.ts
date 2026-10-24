/**
 * Explicit Prisma `select` shapes for people / companies embedded in OTHER records' responses.
 *
 * `include: { assignedEngineer: true }` returns EVERY column of the User row - passwordHash, tokenVersion, phone, email,
 * notification preferences - to whoever may read the parent record (including customers and vendors on /sites). Embed a
 * relation through one of these constants instead, and add a field here only when a screen genuinely needs it.
 */

/** A staff member shown by name only (assigned engineer, sales engineer, event author, photo uploader). */
export const STAFF_REF_SELECT = { id: true, name: true } as const;

/** A vendor company shown by name only. Contact e-mail / phone / approval metadata stay on the vendor-management routes. */
export const VENDOR_REF_SELECT = { id: true, name: true } as const;

/** The customer company on a site / order / ticket. salesOwnerId (an internal user id) is not exposed. */
export const CUSTOMER_REF_SELECT = { id: true, name: true, address: true, createdAt: true } as const;

/**
 * An order as embedded in site / ticket / pending-action responses read by customers and vendors.
 * Commercial value and the sales engineer's user id are NOT included - the order pages (manage_orders) read the full order themselves.
 */
export const SITE_ORDER_SELECT = {
  id: true,
  orderNumber: true,
  customerId: true,
  productId: true,
  quantity: true,
  orderDate: true,
  promisedDeliveryDate: true,
  actualDispatchDate: true,
  plannedExhaustHookupType: true,
  createdAt: true,
  poNumber: true,
  poDate: true,
  poDuplicateFlag: true,
} as const;

/** SITE_ORDER_SELECT plus the customer and product it belongs to (the shape sites / orders screens expect). */
export const SITE_ORDER_WITH_REFS_SELECT = {
  ...SITE_ORDER_SELECT,
  customer: { select: CUSTOMER_REF_SELECT },
  product: true,
} as const;

/** The site relations every site-scoped screen shows: who is assigned, which vendor, current stage - names only. */
export const SITE_PEOPLE_INCLUDE = {
  currentStage: true,
  assignedEngineer: { select: STAFF_REF_SELECT },
  vendor: { select: VENDOR_REF_SELECT },
} as const;

/**
 * Keys that must never appear in any JSON response, whatever route produced it. This is a LAST line of defence behind the explicit
 * selects above (a future `include: true` is caught here) - it is not a substitute for them.
 */
export const NEVER_SERIALISE_KEYS: ReadonlySet<string> = new Set([
  "passwordHash",
  "tokenVersion",
  "codeHash",
  "otpHash",
  "sessionHash",
  "keyHash",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Deep copy of `value` without the keys in NEVER_SERIALISE_KEYS. Dates, Decimals, Buffers and other class instances pass through untouched. */
export function stripSecretKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => stripSecretKeys(v)) as unknown as T;
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (NEVER_SERIALISE_KEYS.has(k)) continue;
    out[k] = stripSecretKeys(v);
  }
  return out as T;
}
