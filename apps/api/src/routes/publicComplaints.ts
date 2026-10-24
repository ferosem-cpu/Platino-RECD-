import { Router } from "express";
import { randomInt, randomUUID } from "crypto";
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
import { notifyTicketRaised } from "../lib/ticketNotify";
import { rateLimit } from "../middleware/rateLimit";
import {
  checkOtpAttemptable,
  decideOtpRequest,
  generateOtpCode,
  generateSessionToken,
  hashOtpCode,
  hashSessionToken,
  publicOtpLockKeys,
  PUBLIC_OTP_DELIVERY,
  PUBLIC_OTP_RETENTION_MS,
  PUBLIC_OTP_USABLE_DELIVERY,
  verifyOtpCode,
} from "../lib/publicOtp";
import { lockKeys } from "../lib/advisoryLock";
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

/** Retention: about one request in fifty deletes the rows that are past every limit window and session. Best effort - never affects the answer. */
function purgeOldPublicOtps(): void {
  if (randomInt(0, 50) !== 0) return;
  try {
    void Promise.resolve(prisma.publicOtp.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - PUBLIC_OTP_RETENTION_MS) } } })).catch(() => undefined);
  } catch {
    /* best effort */
  }
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

  const unit = await prisma.recdUnit.findUnique({ where: { serialNo }, select: { id: true, status: true } });
  const known = Boolean(unit && unit.status === "active");
  const id = randomUUID();
  const code = generateOtpCode();

  // The limits are a "count what exists, then insert" decision, so they are made while holding per-phone / per-serial / per-address
  // database locks: parallel requests queue up and each one counts the rows its predecessors committed, so a burst cannot slip past the cap.
  const throttled = await prisma.$transaction(
    async (tx) => {
      await lockKeys(tx, publicOtpLockKeys(phone, serialNo, ip));
      const since = new Date(Date.now() - HOUR_MS);
      const [phoneLastHour, serialLastHour, ipLastHour, lastForPhone] = await Promise.all([
        tx.publicOtp.count({ where: { phone, createdAt: { gte: since } } }),
        tx.publicOtp.count({ where: { serialNorm: serialNo, createdAt: { gte: since } } }),
        ip ? tx.publicOtp.count({ where: { ip, createdAt: { gte: since } } }) : Promise.resolve(0),
        tx.publicOtp.findFirst({ where: { phone }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
      ]);
      const decision = decideOtpRequest({
        phoneLastHour,
        serialLastHour,
        ipLastHour,
        secondsSinceLastForPhone: lastForPhone ? (Date.now() - lastForPhone.createdAt.getTime()) / 1000 : null,
      });
      if (!decision.allowed) return decision;
      await tx.publicOtp.create({
        data: {
          id,
          phone,
          serialNorm: serialNo,
          unitId: known ? unit!.id : null,
          codeHash: hashOtpCode(id, phone, code),
          expiresAt: new Date(Date.now() + PUBLIC_OTP.EXPIRY_SECONDS * 1000),
          deliveryChannel: known ? delivery.name : "none",
          // Not a usable code until the provider accepts it (an unknown serial is never sent anything).
          deliveryStatus: known ? PUBLIC_OTP_DELIVERY.PENDING : PUBLIC_OTP_DELIVERY.SKIPPED,
          ip,
        },
      });
      return null;
    },
    { timeout: 15_000 },
  );
  if (throttled && !throttled.allowed) {
    res.setHeader("Retry-After", String(throttled.retryAfterSeconds));
    return res.status(429).json({
      error:
        throttled.reason === "cooldown"
          ? `Please wait ${throttled.retryAfterSeconds}s before requesting another code.`
          : "Too many code requests. Please try again later.",
      retryAfterSeconds: throttled.retryAfterSeconds,
    });
  }

  let devCode: string | undefined;
  if (known) {
    let result: { ok: boolean; error?: string };
    try {
      result = await delivery.send(phone, code);
    } catch {
      result = { ok: false, error: "provider_threw" };
    }
    // "skipped" for the local-development echo channel: nothing was actually sent to a phone.
    const status = !result.ok ? PUBLIC_OTP_DELIVERY.FAILED : delivery.name === "dev" ? PUBLIC_OTP_DELIVERY.SKIPPED : PUBLIC_OTP_DELIVERY.SENT;
    // A failed delivery also expires the row at once: nobody received that code, and it must never be accepted.
    await prisma.publicOtp.update({ where: { id }, data: { deliveryStatus: status, ...(result.ok ? {} : { expiresAt: new Date() }) } });
    if (!result.ok) console.error(`[otp] delivery failed for OTP ${id} via ${delivery.name}: ${result.error}`);
    if (result.ok && delivery.name === "dev" && devEchoAllowed()) devCode = code;
  }

  // Housekeeping: drop rows nobody can use or count any more (phone numbers and addresses are not kept longer than needed).
  purgeOldPublicOtps();

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
    // Only a code that was actually delivered can be the one in play: a failed or never-sent request must not hide an earlier delivered code.
    where: { phone, serialNorm: serialNo, unitId: { not: null }, deliveryStatus: { in: PUBLIC_OTP_USABLE_DELIVERY } },
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

  // Service desk, Service Managers, Management and the site region's Regional Managers; a missing Regional Manager / region is recorded in the history.
  await notifyTicketRaised({
    complaintId: complaint.id,
    regionId: unit.site?.regionId,
    data: {
      ticketNumber: complaint.ticketNumber,
      serialNo: unit.serialNo,
      source: COMPLAINT_SOURCE.PUBLIC,
      reporterName: d.reporterName,
      reporterType: d.reporterType,
      reporterPhone: otp.phone,
      issue: ISSUE_CATEGORY_LABELS[d.issueCategory],
    },
  });

  res.status(201).json({ ticketNumber: complaint.ticketNumber });
});
