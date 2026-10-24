import { Router } from "express";
import { prisma } from "../lib/prisma";
import { authenticate, requirePermission, type AuthenticatedRequest } from "../middleware/auth";
import { PERMISSION_KEY, amcSettingsSchema, reminderPolicySchema, slaSettingsSchema, warrantySettingsSchema } from "@recd/shared";

export const settingsRouter = Router();

// GET /settings - Authenticated users can retrieve settings
/** What a caller may read: staff get the row (the assistant's custom instructions only with manage_settings); a customer or vendor login only gets branding, contact details and which roles see the assistant - never internal SLA / reminder policies or instructions. */
export function settingsViewFor(settings: Record<string, unknown>, who: { customerId?: string | null; vendorId?: string | null; permissions: Set<string> }) {
  const { agentCustomInstructions, ...rest } = settings;
  const withInstructions = who.permissions.has(PERMISSION_KEY.MANAGE_SETTINGS) ? settings : rest;
  if (!who.customerId && !who.vendorId) return withInstructions;
  const PUBLIC_FIELDS = ["id", "logoDataUrl", "themeKey", "customColors", "legalName", "address", "city", "pinCode", "email", "website", "phone", "documentFooterNote", "agentVisibleRoleKeys"];
  return Object.fromEntries(PUBLIC_FIELDS.filter((k) => k in rest).map((k) => [k, rest[k]]));
}

settingsRouter.get("/", authenticate, async (req: AuthenticatedRequest, res) => {
  try {
    const settings = await prisma.companySettings.findUnique({
      where: { id: "singleton" },
    });
    if (!settings) {
      return res.json({
        themeKey: "emerald",
        logoDataUrl: null,
        customColors: null,
      });
    }
    res.json(settingsViewFor(settings as unknown as Record<string, unknown>, req.auth!));
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch settings" });
  }
});

// PUT /settings/sla - ticket SLA windows (hours). Separate from the company-details PUT so the
// two forms on the Settings page cannot overwrite each other.
settingsRouter.put("/sla", authenticate, requirePermission(PERMISSION_KEY.MANAGE_SETTINGS), async (req, res) => {
  const parsed = slaSettingsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const settings = await prisma.companySettings.upsert({
    where: { id: "singleton" },
    update: parsed.data,
    create: { id: "singleton", ...parsed.data },
  });
  res.json({ slaRegionalManagerHours: settings.slaRegionalManagerHours, slaManagementHours: settings.slaManagementHours });
});

// PUT /settings/reminders - reminder policy (Requirement 6). Both values null = reminders and their escalation are OFF.
settingsRouter.put("/reminders", authenticate, requirePermission(PERMISSION_KEY.MANAGE_SETTINGS), async (req, res) => {
  const parsed = reminderPolicySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  if (parsed.data.reminderLeadDays == null && parsed.data.reminderEscalationHours != null) {
    return res.status(400).json({ error: "Escalation needs reminders switched on: set the lead time first." });
  }
  const settings = await prisma.companySettings.upsert({
    where: { id: "singleton" },
    update: parsed.data,
    create: { id: "singleton", ...parsed.data },
  });
  res.json({ reminderLeadDays: settings.reminderLeadDays, reminderEscalationHours: settings.reminderEscalationHours });
});

// PUT /settings/amc - AMC default duration and expiry-reminder timing (Requirement 7). null = the compatible default.
settingsRouter.put("/amc", authenticate, requirePermission(PERMISSION_KEY.MANAGE_SETTINGS), async (req, res) => {
  const parsed = amcSettingsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const settings = await prisma.companySettings.upsert({
    where: { id: "singleton" },
    update: parsed.data,
    create: { id: "singleton", ...parsed.data },
  });
  res.json({ amcDefaultDurationMonths: settings.amcDefaultDurationMonths, amcReminderLeadDays: settings.amcReminderLeadDays, amcReminderRepeatDays: settings.amcReminderRepeatDays });
});

// PUT /settings/warranty - warranty reminder timing (Requirement 8), separate from the AMC settings. null = default (30 days, every 3 days).
settingsRouter.put("/warranty", authenticate, requirePermission(PERMISSION_KEY.MANAGE_SETTINGS), async (req, res) => {
  const parsed = warrantySettingsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const settings = await prisma.companySettings.upsert({
    where: { id: "singleton" },
    update: parsed.data,
    create: { id: "singleton", ...parsed.data },
  });
  res.json({ warrantyReminderLeadDays: settings.warrantyReminderLeadDays, warrantyReminderRepeatDays: settings.warrantyReminderRepeatDays });
});

// PUT /settings - Gated with MANAGE_SETTINGS
settingsRouter.put("/", authenticate, requirePermission(PERMISSION_KEY.MANAGE_SETTINGS), async (req: AuthenticatedRequest, res) => {
  const {
    logoDataUrl,
    themeKey,
    customColors,
    legalName,
    address,
    city,
    pinCode,
    email,
    website,
    phone,
    documentFooterNote,
    agentVisibleRoleKeys,
    agentCustomInstructions,
  } = req.body;

  // Shared by both the update and create branches of the upsert - keeping one object means a
  // new settings field can't silently be applied on update but dropped on first-ever create.
  const fields = {
    logoDataUrl,
    themeKey,
    customColors,
    legalName,
    address,
    city,
    pinCode,
    email,
    website,
    phone,
    documentFooterNote,
    agentVisibleRoleKeys,
    agentCustomInstructions,
  };

  try {
    const settings = await prisma.companySettings.upsert({
      where: { id: "singleton" },
      update: fields,
      create: { id: "singleton", ...fields },
    });
    res.json(settings);
  } catch (error) {
    res.status(500).json({ error: "Failed to update settings" });
  }
});
