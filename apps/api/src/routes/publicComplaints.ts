import { Router } from "express";
import { randomUUID } from "crypto";
import { Prisma } from "@prisma/client";
import {
  publicOtpRequestSchema,
  publicOtpVerifySchema,
  publicComplaintSchema,
  COMPLAINT_SOURCE,
  COMPLAINT_EVENT,
  COMPLAINT_STATUS,
  COMPLAINT_CATEGORY,
  ISSUE_CATEGORY,
  ISSUE_CATEGORY_LABELS,
  PUBLIC_OTP,
} from "@recd/shared";
import { prisma } from "../lib/prisma";
import { logComplaintEventStrict } from "../lib/ticketEvents";
import { notifyMany, ticketRecipients } from "../lib/ticketNotify";
import { rateLimit } from "../middleware/rateLimit";
import {
  checkOtpAttemptable,
  decideOtpRequest,
  generateOtpCode,
  generateSessionToken,
  hashOtpCode,
  hashSessionToken,
  verifyOtpCode,
} from "../lib/publicOtp";
import { devEchoAllowed, getOtpDelivery } from "../lib/otpDelivery";

/**
 * PUBLIC (no login). Lets anyone holding a RECD's serial number - the owner, a reseller, a
 * re-reseller - raise a service ticket after proving control of a mobile number with an OTP.
 *
 * Deliberately reveals nothing about customers or sites, and answers "does this serial exist?"
 * identically for real and unknown serials.
 */
export const publicComplaintsRouter = Router();

// Coarse per-instance backstop on top of the database-backed per-mobile/serial/IP limits below.
publicComplaintsRouter.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 60, keyPrefix: "public-complaints" }));

const CLOSED: string[] = [COMPLAINT_STATUS.RESOLVED, COMPLAINT_STATUS.CLOSED];
const GENERIC_BAD_OTP = "That code is invalid or has expired. Request a new one.";
const HOUR_MS = 60 * 60 * 1000;

function isUniqueViolation(err: unknown): err is Prisma.PrismaClientKnownRequestError {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

// ---------------------------------------------------------------------------
// 1. Request an OTP
// ---------------------------------------------------------------------------
publicComplaintsRouter.post("/otp/request", async (req, res) => {
  const delivery = getOtpDelivery();
  if (!delivery) {
    return res.status(503).json({
      error: "Online service requests are not available yet. Please contact Platino service directly.",
      code: "OTP_UNAVAILABLE",
    });
  }

  const parsed = publicOtpRequestSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { serialNo, phone } = parsed.data;
  // req.ip honours X-Forwarded-For only for the proxies named by TRUST_PROXY, so a client cannot choose the address its requests are counted under.
  const ip = req.ip || null;

  const since = new Date(Date.now() - HOUR_MS);
  const [phoneLastHour, serialLastHour, ipLastHour, lastForPhone] = await Promise.all([
    prisma.publicOtp.count({ where: { phone, createdAt: { gte: since } } }),
    prisma.publicOtp.count({ where: { serialNorm: serialNo, createdAt: { gte: since } } }),
    ip ? prisma.publicOtp.count({ where: { ip, createdAt: { gte: since } } }) : Promise.resolve(0),
    prisma.publicOtp.findFirst({ where: { phone }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
  ]);
  const decision = decideOtpRequest({
    phoneLastHour,
    serialLastHour,
    ipLastHour,
    secondsSinceLastForPhone: lastForPhone ? (Date.now() - lastForPhone.createdAt.getTime()) / 1000 : null,
  });
  if (!decision.allowed) {
    res.setHeader("Retry-After", String(decision.retryAfterSeconds));
    return res.status(429).json({
      error:
        decision.reason === "cooldown"
          ? `Please wait ${decision.retryAfterSeconds}s before requesting another code.`
          : "Too many code requests. Please try again later.",
      retryAfterSeconds: decision.retryAfterSeconds,
    });
  }

  const unit = await prisma.recdUnit.findUnique({ where: { serialNo }, select: { id: true, status: true } });
  const known = Boolean(unit && unit.status === "active");

  const id = randomUUID();
  const code = generateOtpCode();
  await prisma.publicOtp.create({
    data: {
      id,
      phone,
      serialNorm: serialNo,
      unitId: known ? unit!.id : null,
      codeHash: hashOtpCode(id, phone, code),
      expiresAt: new Date(Date.now() + PUBLIC_OTP.EXPIRY_SECONDS * 1000),
      deliveryChannel: known ? delivery.name : "none",
      deliveryStatus: "skipped",
      ip,
    },
  });

  let devCode: string | undefined;
  if (known) {
    const result = await delivery.send(phone, code);
    // "skipped" for the local-development echo channel: nothing was actually sent to a phone.
    await prisma.publicOtp.update({ where: { id }, data: { deliveryStatus: !result.ok ? "failed" : delivery.name === "dev" ? "skipped" : "sent" } });
    if (!result.ok) console.error(`[otp] delivery failed for OTP ${id} via ${delivery.name}: ${result.error}`);
    if (result.ok && delivery.name === "dev" && devEchoAllowed()) devCode = code;
  }

  // Identical response whether or not the serial exists (or delivery succeeded).
  res.json({
    ok: true,
    message: "If this serial number is registered, a code has been sent to your WhatsApp number.",
    expiresInSeconds: PUBLIC_OTP.EXPIRY_SECONDS,
    resendAfterSeconds: PUBLIC_OTP.RESEND_COOLDOWN_SECONDS,
    ...(devCode ? { devCode } : {}),
  });
});

// ---------------------------------------------------------------------------
// 2. Verify the OTP -> single-use session token
// ---------------------------------------------------------------------------
publicComplaintsRouter.post("/otp/verify", async (req, res) => {
  const parsed = publicOtpVerifySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { serialNo, phone, code } = parsed.data;

  const row = await prisma.publicOtp.findFirst({
    where: { phone, serialNorm: serialNo, unitId: { not: null } },
    orderBy: { createdAt: "desc" },
  });
  if (!row || checkOtpAttemptable(row) !== "ok") return res.status(400).json({ error: GENERIC_BAD_OTP });

  // Count the attempt BEFORE comparing, atomically and only while still under the cap, so
  // parallel guesses cannot exceed the limit.
  const claimed = await prisma.publicOtp.updateMany({
    where: { id: row.id, verifiedAt: null, attempts: { lt: PUBLIC_OTP.MAX_VERIFY_ATTEMPTS } },
    data: { attempts: { increment: 1 } },
  });
  if (claimed.count === 0) return res.status(400).json({ error: GENERIC_BAD_OTP });

  if (!verifyOtpCode(row.id, row.phone, code, row.codeHash)) {
    return res.status(400).json({ error: GENERIC_BAD_OTP });
  }

  const session = generateSessionToken();
  const marked = await prisma.publicOtp.updateMany({
    where: { id: row.id, verifiedAt: null },
    data: {
      verifiedAt: new Date(),
      sessionHash: session.hash,
      sessionExpiresAt: new Date(Date.now() + PUBLIC_OTP.SESSION_SECONDS * 1000),
    },
  });
  if (marked.count === 0) return res.status(400).json({ error: GENERIC_BAD_OTP });

  const unit = await prisma.recdUnit.findUnique({
    where: { id: row.unitId! },
    select: { product: { select: { name: true, model: true } } },
  });
  res.json({
    sessionToken: session.token,
    expiresInSeconds: PUBLIC_OTP.SESSION_SECONDS,
    // Only the RECD model, so the reporter can confirm they entered the right serial.
    recd: unit ? `${unit.product.name} (${unit.product.model})` : null,
  });
});

// ---------------------------------------------------------------------------
// 3. Submit the ticket
// ---------------------------------------------------------------------------
publicComplaintsRouter.post("/", async (req, res) => {
  const parsed = publicComplaintSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const d = parsed.data;

  if (!(d.issueCategory in ISSUE_CATEGORY_LABELS)) {
    return res.status(400).json({ error: "Choose a valid issue category" });
  }

  const otp = await prisma.publicOtp.findUnique({ where: { sessionHash: hashSessionToken(d.sessionToken) } });
  if (
    !otp ||
    !otp.verifiedAt ||
    otp.sessionUsedAt ||
    !otp.sessionExpiresAt ||
    otp.sessionExpiresAt.getTime() <= Date.now() ||
    !otp.unitId
  ) {
    return res.status(401).json({ error: "Your verification has expired. Please verify your mobile number again." });
  }

  const unit = await prisma.recdUnit.findUnique({
    where: { id: otp.unitId },
    include: { order: { select: { customerId: true } }, site: { select: { id: true, regionId: true, companyName: true } } },
  });
  if (!unit || unit.status !== "active") return res.status(400).json({ error: "This RECD is no longer active" });

  const open = await prisma.complaint.findFirst({
    where: { unitId: unit.id, status: { notIn: CLOSED }, archivedAt: null },
    select: { ticketNumber: true },
  });
  if (open) {
    return res.status(409).json({
      error: `A service ticket (${open.ticketNumber}) is already open for this RECD. Our team is working on it.`,
      ticketNumber: open.ticketNumber,
    });
  }

  // Single-use: claim the session before creating anything.
  const claimed = await prisma.publicOtp.updateMany({
    where: { id: otp.id, sessionUsedAt: null },
    data: { sessionUsedAt: new Date() },
  });
  if (claimed.count === 0) {
    return res.status(401).json({ error: "Your verification has expired. Please verify your mobile number again." });
  }

  const category =
    d.issueCategory === ISSUE_CATEGORY.INSTALLATION_COMMISSIONING_ISSUE
      ? COMPLAINT_CATEGORY.ERECTION_COMMISSIONING
      : COMPLAINT_CATEGORY.NON_PERFORMANCE;

  let complaint;
  for (let attempt = 0; attempt < 3 && !complaint; attempt++) {
    const ticketNumber = `TCK-${new Date().getFullYear()}-${Math.floor(10000 + Math.random() * 90000)}`;
    try {
      // ONE transaction: the ticket and its CREATED history row commit together (a failed history write leaves no ticket behind).
      complaint = await prisma.$transaction(async (tx) => {
        const created = await tx.complaint.create({
          data: {
            ticketNumber,
            customerId: unit.order.customerId,
            siteId: unit.siteId,
            unitId: unit.id,
            category,
            issueCategory: d.issueCategory,
            description: d.description,
            severity: "medium",
            status: COMPLAINT_STATUS.OPEN,
            attachmentUrl: d.attachmentUrl,
            source: COMPLAINT_SOURCE.PUBLIC,
            reporterName: d.reporterName,
            reporterPhone: otp.phone,
            reporterType: d.reporterType,
            reporterVerifiedAt: otp.verifiedAt,
          },
        });
        await logComplaintEventStrict(tx, {
          complaintId: created.id,
          type: COMPLAINT_EVENT.CREATED,
          toValue: created.status,
          actorLabel: `${d.reporterName} (public, ${d.reporterType})`,
          // What was reported, as it was at the time (the ticket's links are cleared if the unit or site is later deleted).
          detail: { source: COMPLAINT_SOURCE.PUBLIC, reporterPhone: otp.phone, serialNo: unit.serialNo, siteName: unit.site?.companyName ?? null, siteId: unit.siteId, unitId: unit.id },
        });
        return created;
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // Either a ticket-number collision (retry) or the one-open-ticket-per-unit index (a
      // concurrent request won): distinguish by looking for the open ticket.
      const raced = await prisma.complaint.findFirst({
        where: { unitId: unit.id, status: { notIn: CLOSED }, archivedAt: null },
        select: { ticketNumber: true },
      });
      if (raced) {
        return res.status(409).json({
          error: `A service ticket (${raced.ticketNumber}) is already open for this RECD. Our team is working on it.`,
          ticketNumber: raced.ticketNumber,
        });
      }
    }
  }
  if (!complaint) return res.status(500).json({ error: "Could not create the ticket. Please try again." });

  // Service desk, Service Managers, Management and the site region's Regional Managers.
  try {
    const recipients = await ticketRecipients("raised", { regionId: unit.site?.regionId });
    await notifyMany(recipients, "complaint_raised", {
      ticketNumber: complaint.ticketNumber,
      serialNo: unit.serialNo,
      source: COMPLAINT_SOURCE.PUBLIC,
      reporterName: d.reporterName,
      reporterType: d.reporterType,
      reporterPhone: otp.phone,
      issue: ISSUE_CATEGORY_LABELS[d.issueCategory],
    });
  } catch (err) {
    console.error("Public complaint notification failed", err);
  }

  res.status(201).json({ ticketNumber: complaint.ticketNumber });
});
