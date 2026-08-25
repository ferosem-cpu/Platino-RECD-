import { Router } from "express";
import bcrypt from "bcryptjs";
import { registerVendorSchema, archiveVendorSchema, PERMISSION_KEY, ROLE_KEY, VENDOR_STATUS } from "@recd/shared";
import { prisma } from "../lib/prisma";
import { authenticate, requirePermission, type AuthenticatedRequest } from "../middleware/auth";
import { asString } from "../lib/params";

export const vendorsRouter = Router();

/**
 * Create the vendor contact's engineer login on approval, unless a user with that email
 * already exists. Shared between the approve route and staff directly adding a vendor
 * (which is created pre-approved, so it needs the same login-creation side effect).
 */
async function createVendorContactLogin(vendor: { id: string; contactName: string; contactEmail: string; contactPhone: string | null }, createdById: string) {
  const emailTaken = await prisma.user.findUnique({ where: { email: vendor.contactEmail } });
  if (emailTaken) return { contactLoginCreated: false, tempPassword: undefined as string | undefined };

  const role = await prisma.role.findUniqueOrThrow({ where: { key: ROLE_KEY.ERECTION_ENGINEER } });
  const tempPassword = Math.random().toString(36).slice(2, 10);
  const passwordHash = await bcrypt.hash(tempPassword, 10);
  await prisma.user.create({
    data: {
      name: vendor.contactName,
      email: vendor.contactEmail,
      phone: vendor.contactPhone,
      roleId: role.id,
      vendorId: vendor.id,
      passwordHash,
      mustChangePassword: true,
      title: "Erection Engineer",
      createdById,
    },
  });
  return { contactLoginCreated: true, tempPassword };
}

/**
 * PUBLIC: an external erection subcontractor self-registers. No auth - this is how a vendor
 * the company has never met gets into the system. Lands in "pending" for management's due
 * diligence. Defined before the authenticate guard below so it stays open.
 */
vendorsRouter.post("/register", async (req, res) => {
  const parsed = registerVendorSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const existing = await prisma.vendor.findUnique({ where: { contactEmail: parsed.data.contactEmail } });
  if (existing) return res.status(400).json({ error: "A vendor with that contact email is already registered" });

  const vendor = await prisma.vendor.create({
    data: {
      name: parsed.data.name,
      contactName: parsed.data.contactName,
      contactEmail: parsed.data.contactEmail,
      contactPhone: parsed.data.contactPhone,
      address: parsed.data.address,
      status: VENDOR_STATUS.PENDING,
    },
  });
  res.status(201).json({ id: vendor.id, name: vendor.name, status: vendor.status });
});

// Everything below requires a logged-in user with the manage_vendors permission (Super Admin / Management).
vendorsRouter.use(authenticate);

vendorsRouter.get("/", requirePermission(PERMISSION_KEY.MANAGE_VENDORS), async (_req, res) => {
  const vendors = await prisma.vendor.findMany({
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    include: { _count: { select: { members: true, sites: true } } },
  });
  res.json(vendors);
});

/**
 * Staff directly adding a known vendor - skips the self-registration/due-diligence pending
 * state entirely, since a Super Admin/Owner/Management user adding it is the due diligence.
 * Created pre-approved, with the same contact-login side effect as approving one.
 */
vendorsRouter.post("/", requirePermission(PERMISSION_KEY.MANAGE_VENDORS), async (req: AuthenticatedRequest, res) => {
  const parsed = registerVendorSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const existing = await prisma.vendor.findUnique({ where: { contactEmail: parsed.data.contactEmail } });
  if (existing) return res.status(400).json({ error: "A vendor with that contact email is already registered" });

  const vendor = await prisma.vendor.create({
    data: {
      name: parsed.data.name,
      contactName: parsed.data.contactName,
      contactEmail: parsed.data.contactEmail,
      contactPhone: parsed.data.contactPhone,
      address: parsed.data.address,
      status: VENDOR_STATUS.APPROVED,
      approvedById: req.auth!.userId,
      approvedAt: new Date(),
    },
  });

  const { contactLoginCreated, tempPassword } = await createVendorContactLogin(vendor, req.auth!.userId);

  res.status(201).json({
    id: vendor.id,
    name: vendor.name,
    status: vendor.status,
    contactLoginCreated,
    contactEmail: vendor.contactEmail,
    tempPassword,
  });
});

vendorsRouter.post("/:id/approve", requirePermission(PERMISSION_KEY.MANAGE_VENDORS), async (req: AuthenticatedRequest, res) => {
  const id = asString(req.params.id);
  const vendor = await prisma.vendor.findUnique({ where: { id } });
  if (!vendor) return res.status(404).json({ error: "Vendor not found" });
  if (vendor.status === VENDOR_STATUS.APPROVED) return res.status(400).json({ error: "Vendor is already approved" });

  await prisma.vendor.update({
    where: { id },
    data: { status: VENDOR_STATUS.APPROVED, approvedById: req.auth!.userId, approvedAt: new Date() },
  });

  // On approval the vendor's primary contact becomes a vendor-scoped erection-engineer login,
  // so "once approved, they can be added to the users list" happens automatically.
  const { contactLoginCreated, tempPassword } = await createVendorContactLogin(vendor, req.auth!.userId);

  res.json({
    id: vendor.id,
    status: VENDOR_STATUS.APPROVED,
    contactLoginCreated,
    contactEmail: vendor.contactEmail,
    tempPassword,
  });
});

vendorsRouter.post("/:id/reject", requirePermission(PERMISSION_KEY.MANAGE_VENDORS), async (req: AuthenticatedRequest, res) => {
  const id = asString(req.params.id);
  const vendor = await prisma.vendor.findUnique({ where: { id } });
  if (!vendor) return res.status(404).json({ error: "Vendor not found" });
  await prisma.vendor.update({ where: { id }, data: { status: VENDOR_STATUS.REJECTED } });
  res.json({ id, status: VENDOR_STATUS.REJECTED });
});

/**
 * Deactivates a vendor that was approved and doing real work (e.g. malpractice discovered
 * later) - unlike /reject, this never touches its history: every site and complaint it was
 * ever tied to stays exactly as it was, still attributed to this vendor by name.
 * Archiving just drops it out of every active selection (new site assignment, new engineer
 * login) and
 * deactivates its member logins outright (belt-and-suspenders: the plain password-login route
 * doesn't itself re-check vendor status, only user.isActive, so this is what actually stops an
 * archived vendor's engineer from signing back in).
 *
 * Optionally moves its currently-assigned sites to another approved vendor first, so ongoing
 * erection work doesn't stall on a vendor that's being removed mid-project.
 */
vendorsRouter.post("/:id/archive", requirePermission(PERMISSION_KEY.MANAGE_VENDORS), async (req: AuthenticatedRequest, res) => {
  const id = asString(req.params.id);
  const parsed = archiveVendorSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const vendor = await prisma.vendor.findUnique({ where: { id } });
  if (!vendor) return res.status(404).json({ error: "Vendor not found" });
  if (vendor.status === VENDOR_STATUS.ARCHIVED) return res.status(400).json({ error: "Vendor is already archived" });

  let reassignToId: string | null = null;
  if (parsed.data.reassignSitesToVendorId) {
    if (parsed.data.reassignSitesToVendorId === id) {
      return res.status(400).json({ error: "Cannot reassign a vendor's sites to itself" });
    }
    const target = await prisma.vendor.findUnique({ where: { id: parsed.data.reassignSitesToVendorId } });
    if (!target) return res.status(400).json({ error: "Unknown reassignment vendor" });
    if (target.status !== VENDOR_STATUS.APPROVED) {
      return res.status(400).json({ error: "Reassignment target must be an approved vendor" });
    }
    reassignToId = target.id;
  }

  const sitesReassigned = await prisma.$transaction(async (tx) => {
    let count = 0;
    if (reassignToId) {
      const result = await tx.site.updateMany({ where: { vendorId: id }, data: { vendorId: reassignToId } });
      count = result.count;
    }
    await tx.user.updateMany({ where: { vendorId: id }, data: { isActive: false } });
    await tx.vendor.update({
      where: { id },
      data: { status: VENDOR_STATUS.ARCHIVED, archivedById: req.auth!.userId, archivedAt: new Date() },
    });
    return count;
  });

  res.json({ id, status: VENDOR_STATUS.ARCHIVED, sitesReassignedTo: reassignToId, sitesReassignedCount: sitesReassigned });
});
