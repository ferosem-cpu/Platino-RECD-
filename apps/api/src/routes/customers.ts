import { Router } from "express";
import { createCustomerSchema, updateCustomerSchema, PERMISSION_KEY, ROLE_KEY } from "@recd/shared";
import { prisma } from "../lib/prisma";
import { authenticate, requirePermission, type AuthenticatedRequest } from "../middleware/auth";
import { asString } from "../lib/params";

export const customersRouter = Router();
customersRouter.use(authenticate);

customersRouter.get("/", requirePermission(PERMISSION_KEY.MANAGE_ORDERS), async (_req, res) => {
  const customers = await prisma.customer.findMany({
    include: { contacts: { select: { id: true, name: true, phone: true, email: true } } },
    orderBy: { name: "asc" },
  });
  res.json(customers);
});

customersRouter.get("/:id", requirePermission(PERMISSION_KEY.MANAGE_ORDERS), async (req, res) => {
  const id = asString(req.params.id);
  const customer = await prisma.customer.findUnique({
    where: { id },
    include: {
      contacts: { select: { id: true, name: true, phone: true, email: true } },
      orders: {
        include: {
          product: true,
          site: { include: { currentStage: true, assignedEngineer: true, vendor: true } },
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

  const phoneTaken = await prisma.user.findUnique({ where: { phone: parsed.data.contactPhone } });
  if (phoneTaken) return res.status(400).json({ error: "A contact with that phone number already exists" });

  const customer = await prisma.customer.create({
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

  res.status(201).json(customer);
});

customersRouter.put("/:id", requirePermission(PERMISSION_KEY.MANAGE_ORDERS), async (req: AuthenticatedRequest, res) => {
  const id = asString(req.params.id);
  const parsed = updateCustomerSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const data = parsed.data;

  const existing = await prisma.customer.findUnique({
    where: { id },
    include: { contacts: { select: { id: true, phone: true } } },
  });
  if (!existing) return res.status(404).json({ error: "Customer not found" });

  const primaryContact = existing.contacts[0];
  if (data.contactPhone && data.contactPhone !== primaryContact?.phone) {
    const phoneTaken = await prisma.user.findUnique({ where: { phone: data.contactPhone } });
    if (phoneTaken) return res.status(400).json({ error: "A contact with that phone number already exists" });
  }

  const customer = await prisma.$transaction(async (tx) => {
    if (primaryContact && (data.contactName !== undefined || data.contactPhone !== undefined || data.contactEmail !== undefined)) {
      await tx.user.update({
        where: { id: primaryContact.id },
        data: {
          name: data.contactName,
          phone: data.contactPhone,
          email: data.contactEmail,
        },
      });
    }
    return tx.customer.update({
      where: { id },
      data: {
        name: data.name,
        address: data.address,
      },
      include: { contacts: { select: { id: true, name: true, phone: true, email: true } } },
    });
  });

  res.json(customer);
});

customersRouter.delete("/:id", requirePermission(PERMISSION_KEY.MANAGE_ORDERS), async (req: AuthenticatedRequest, res) => {
  const id = asString(req.params.id);
  const existing = await prisma.customer.findUnique({
    where: { id },
    include: { contacts: { select: { id: true } } },
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

  await prisma.$transaction([
    prisma.user.deleteMany({ where: { id: { in: existing.contacts.map((c) => c.id) } } }),
    prisma.customer.delete({ where: { id } }),
  ]);
  res.status(204).end();
});
