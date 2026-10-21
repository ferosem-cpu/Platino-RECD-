import { Router } from "express";
import { createCustomerSchema, updateCustomerSchema, normalizeIndianMobile, PERMISSION_KEY, ROLE_KEY, USER_AUDIT_ACTION } from "@recd/shared";
import { prisma } from "../lib/prisma";
import { authenticate, requirePermission, type AuthenticatedRequest } from "../middleware/auth";
import { asString } from "../lib/params";
import { phoneHeldByAnother } from "../lib/userPhone";
import { isUserEmailConflict, isUserPhoneConflict } from "../lib/uniqueViolations";
import { SITE_PEOPLE_INCLUDE } from "../lib/safeSelect";
import { logAccountsDeletedStrict, logUserAuditStrict } from "../lib/audit";

const PHONE_IN_USE = "A contact with that phone number already exists";
const EMAIL_IN_USE = "A contact with that email address already exists";

export const customersRouter = Router();
customersRouter.use(authenticate);

customersRouter.get("/", requirePermission(PERMISSION_KEY.MANAGE_ORDERS), async (_req, res) => {
  const customers = await prisma.customer.findMany({
    include: { contacts: { select: { id: true, name: true, phone: true, email: true }, orderBy: { createdAt: "asc" } } },
    orderBy: { name: "asc" },
  });
  res.json(customers);
});

customersRouter.get("/:id", requirePermission(PERMISSION_KEY.MANAGE_ORDERS), async (req, res) => {
  const id = asString(req.params.id);
  const customer = await prisma.customer.findUnique({
    where: { id },
    include: {
      contacts: { select: { id: true, name: true, phone: true, email: true }, orderBy: { createdAt: "asc" } },
      orders: {
        include: {
          product: true,
          units: { select: { id: true, serialNo: true, status: true }, orderBy: { createdAt: "asc" } },
          site: { include: SITE_PEOPLE_INCLUDE },
        },
        orderBy: { createdAt: "desc" },
      },
    },
  });
  if (!customer) return res.status(404).json({ error: "Customer not found" });
  res.json(customer);
});

/**
 * Create a customer plus its primary contact. The contact is a CUSTOMER-role user whose
 * phone is the credential they later use to log in (Order ID + phone -> OTP). No password
 * is set - customers never use email/password.
 */
customersRouter.post("/", requirePermission(PERMISSION_KEY.MANAGE_ORDERS), async (req: AuthenticatedRequest, res) => {
  const parsed = createCustomerSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const customerRole = await prisma.role.findUniqueOrThrow({ where: { key: ROLE_KEY.CUSTOMER } });

  const phoneTaken = await phoneHeldByAnother(parsed.data.contactPhone);
  if (phoneTaken) return res.status(400).json({ error: PHONE_IN_USE });

  let customer;
  try {
    // The customer, its login-capable contact and the contact's audit record are ONE transaction: none of them exists without the others.
    customer = await prisma.$transaction(async (tx) => {
      const created = await tx.customer.create({
        data: {
          name: parsed.data.name,
          address: parsed.data.address,
          salesOwnerId: req.auth!.userId,
          contacts: {
            create: {
              name: parsed.data.contactName,
              phone: parsed.data.contactPhone,
              email: parsed.data.contactEmail,
              roleId: customerRole.id,
              isActive: true,
              mustChangePassword: false,
            },
          },
        },
        include: { contacts: { select: { id: true, name: true, phone: true, email: true } } },
      });
      for (const contact of created.contacts) {
        // No phone / e-mail in the record: the trail says WHAT happened to WHOM, not the contact details.
        await logUserAuditStrict(tx, req.auth!.userId, contact.id, USER_AUDIT_ACTION.CREATED, { role: ROLE_KEY.CUSTOMER, customerId: created.id, via: "customer_created" });
      }
      return created;
    });
  } catch (err) {
    // Another request took the number between the check above and the insert; the nested create
    // is one statement, so no customer is left behind without its contact.
    if (isUserPhoneConflict(err)) return res.status(400).json({ error: PHONE_IN_USE });
    if (isUserEmailConflict(err)) return res.status(409).json({ error: EMAIL_IN_USE });
    throw err;
  }

  res.status(201).json(customer);
});

customersRouter.put("/:id", requirePermission(PERMISSION_KEY.MANAGE_ORDERS), async (req: AuthenticatedRequest, res) => {
  const id = asString(req.params.id);
  const parsed = updateCustomerSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const data = parsed.data;

  const existing = await prisma.customer.findUnique({
    where: { id },
    include: { contacts: { select: { id: true, name: true, phone: true, email: true }, orderBy: { createdAt: "asc" } } },
  });
  if (!existing) return res.status(404).json({ error: "Customer not found" });

  // Which contact is being edited: the one named by contactId (it must belong to THIS customer), else the
  // primary contact = the oldest one (the contact created with the customer) - never an arbitrary one.
  const changesContact = data.contactName !== undefined || data.contactPhone !== undefined || data.contactEmail !== undefined;
  let targetContact = existing.contacts[0];
  if (data.contactId !== undefined) {
    targetContact = existing.contacts.find((c) => c.id === data.contactId) as typeof targetContact;
    if (!targetContact) return res.status(404).json({ error: "Contact not found for this customer" });
  }
  if (changesContact && !targetContact) {
    return res.status(400).json({ error: "This customer has no contact to update" });
  }

  // Only a different number needs the duplicate check (same number in an older format is not a clash).
  if (data.contactPhone && targetContact && normalizeIndianMobile(targetContact.phone ?? "") !== data.contactPhone) {
    const phoneTaken = await phoneHeldByAnother(data.contactPhone, targetContact.id);
    if (phoneTaken) return res.status(400).json({ error: PHONE_IN_USE });
  }

  let customer;
  try {
    customer = await prisma.$transaction(async (tx) => {
      if (targetContact && changesContact) {
        // Which login details really change (a re-save of the same values, or the same number in an older format, is not a change).
        const fieldsChanged: string[] = [];
        if (data.contactName !== undefined && data.contactName !== targetContact.name) fieldsChanged.push("name");
        if (data.contactPhone !== undefined && normalizeIndianMobile(targetContact.phone ?? "") !== data.contactPhone) fieldsChanged.push("phone");
        if (data.contactEmail !== undefined && (data.contactEmail ?? null) !== (targetContact.email ?? null)) fieldsChanged.push("email");
        await tx.user.update({
          where: { id: targetContact.id },
          data: {
            name: data.contactName,
            phone: data.contactPhone,
            email: data.contactEmail,
            // The phone number / e-mail are how this person signs in: changing either ends every session issued before the change.
            ...(fieldsChanged.includes("phone") || fieldsChanged.includes("email") ? { tokenVersion: { increment: 1 } } : {}),
          },
        });
        // Mandatory audit record in the same transaction (field names only - never the old or new contact details).
        if (fieldsChanged.length) {
          await logUserAuditStrict(tx, req.auth!.userId, targetContact.id, USER_AUDIT_ACTION.UPDATED, { fieldsChanged, customerId: id, via: "customer_contact_edit" });
        }
      }
      return tx.customer.update({
        where: { id },
        data: {
          name: data.name,
          address: data.address,
        },
        include: { contacts: { select: { id: true, name: true, phone: true, email: true }, orderBy: { createdAt: "asc" } } },
      });
    });
  } catch (err) {
    if (isUserPhoneConflict(err)) return res.status(400).json({ error: PHONE_IN_USE });
    if (isUserEmailConflict(err)) return res.status(409).json({ error: EMAIL_IN_USE });
    throw err;
  }

  res.json(customer);
});

customersRouter.delete("/:id", requirePermission(PERMISSION_KEY.MANAGE_ORDERS), async (req: AuthenticatedRequest, res) => {
  const id = asString(req.params.id);
  const existing = await prisma.customer.findUnique({
    where: { id },
    include: { contacts: { select: { id: true, name: true } } },
  });
  if (!existing) return res.status(404).json({ error: "Customer not found" });

  const [orders, complaints, amcOrders] = await Promise.all([
    prisma.order.count({ where: { customerId: id } }),
    prisma.complaint.count({ where: { customerId: id } }),
    prisma.amcOrder.count({ where: { customerId: id } }),
  ]);
  if (orders > 0 || complaints > 0 || amcOrders > 0) {
    return res.status(400).json({
      error: "Cannot delete a customer with existing orders, complaints, or AMC orders",
    });
  }

  await prisma.$transaction(async (tx) => {
    // The deletion is recorded (and the contacts' earlier audit rows are stamped with their names) BEFORE the accounts go; the audit rows
    // themselves survive the deletion (UserAuditLog.targetUserId is ON DELETE SET NULL, targetIdRecorded keeps the id).
    await logAccountsDeletedStrict(tx, req.auth!.userId, existing.contacts, { role: ROLE_KEY.CUSTOMER, customerId: id, via: "customer_deleted" });
    await tx.user.deleteMany({ where: { id: { in: existing.contacts.map((c) => c.id) } } });
    await tx.customer.delete({ where: { id } });
  });
  res.status(204).end();
});
