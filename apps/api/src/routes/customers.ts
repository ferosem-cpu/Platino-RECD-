import { Router } from "express";
import { createCustomerSchema, PERMISSION_KEY, ROLE_KEY } from "@recd/shared";
import { prisma } from "../lib/prisma";
import { authenticate, requirePermission, type AuthenticatedRequest } from "../middleware/auth";

export const customersRouter = Router();
customersRouter.use(authenticate);

customersRouter.get("/", requirePermission(PERMISSION_KEY.MANAGE_ORDERS), async (_req, res) => {
  const customers = await prisma.customer.findMany({
    include: { contacts: { select: { id: true, name: true, phone: true, email: true } } },
    orderBy: { name: "asc" },
  });
  res.json(customers);
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
