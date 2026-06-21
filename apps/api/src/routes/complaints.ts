import { Router } from "express";
import { createComplaintSchema, updateComplaintStatusSchema, PERMISSION_KEY, COMPLAINT_STATUS } from "@recd/shared";
import { prisma } from "../lib/prisma";
import { authenticate, requirePermission, type AuthenticatedRequest } from "../middleware/auth";
import { send as sendNotification } from "../services/notifications/notificationService";

export const complaintsRouter = Router();
complaintsRouter.use(authenticate);

complaintsRouter.get("/", requirePermission(PERMISSION_KEY.RAISE_COMPLAINT, PERMISSION_KEY.MANAGE_COMPLAINTS, PERMISSION_KEY.VIEW_COMPLAINTS_OVERVIEW), async (req: AuthenticatedRequest, res) => {
  const where = req.auth!.customerId ? { customerId: req.auth!.customerId } : {};
  const complaints = await prisma.complaint.findMany({
    where,
    include: { site: true, assignedTo: true },
    orderBy: { createdAt: "desc" },
  });
  res.json(complaints);
});

/** Company-wide count-by-status - Owner/Admin and Management only (see project notes). */
complaintsRouter.get("/overview", requirePermission(PERMISSION_KEY.VIEW_COMPLAINTS_OVERVIEW), async (_req, res) => {
  const grouped = await prisma.complaint.groupBy({ by: ["status"], _count: { _all: true } });
  const counts: Record<string, number> = Object.fromEntries(Object.values(COMPLAINT_STATUS).map((s) => [s, 0]));
  for (const row of grouped) counts[row.status] = row._count._all;
  res.json({ countsByStatus: counts });
});

complaintsRouter.post("/", requirePermission(PERMISSION_KEY.RAISE_COMPLAINT), async (req: AuthenticatedRequest, res) => {
  const parsed = createComplaintSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  if (!req.auth!.customerId) return res.status(403).json({ error: "Only customers can raise complaints" });

  const ticketNumber = `TCK-${new Date().getFullYear()}-${Math.floor(10000 + Math.random() * 90000)}`;
  const complaint = await prisma.complaint.create({
    data: {
      ticketNumber,
      customerId: req.auth!.customerId,
      siteId: parsed.data.siteId,
      category: parsed.data.category,
      description: parsed.data.description,
      severity: parsed.data.severity,
      status: COMPLAINT_STATUS.OPEN,
    },
  });

  const serviceTeamUsers = await prisma.user.findMany({ where: { role: { key: "service_team" } } });
  await Promise.all(
    serviceTeamUsers.map((u) =>
      sendNotification({ recipientId: u.id, templateKey: "complaint_raised", data: { ticketNumber } }),
    ),
  );

  res.status(201).json(complaint);
});

complaintsRouter.patch("/:id", requirePermission(PERMISSION_KEY.MANAGE_COMPLAINTS), async (req: AuthenticatedRequest, res) => {
  const parsed = updateComplaintStatusSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const complaint = await prisma.complaint.update({
    where: { id: req.params.id },
    data: {
      status: parsed.data.status,
      rootCause: parsed.data.rootCause,
      resolutionNotes: parsed.data.resolutionNotes,
      assignedToId: req.auth!.userId,
      closedAt: parsed.data.status === COMPLAINT_STATUS.CLOSED ? new Date() : undefined,
    },
    include: { customer: { include: { contacts: true } } },
  });

  const customerContact = complaint.customer.contacts[0];
  if (customerContact) {
    await sendNotification({
      recipientId: customerContact.id,
      templateKey: "complaint_status_updated",
      data: { ticketNumber: complaint.ticketNumber, status: complaint.status },
    });
  }

  res.json(complaint);
});
