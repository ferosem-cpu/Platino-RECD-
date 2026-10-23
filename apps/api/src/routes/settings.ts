import { Router } from "express";
import { prisma } from "../lib/prisma";
import { authenticate, requirePermission, type AuthenticatedRequest } from "../middleware/auth";
import { PERMISSION_KEY, slaSettingsSchema } from "@recd/shared";

export const settingsRouter = Router();

// GET /settings - Authenticated users can retrieve settings
settingsRouter.get("/", authenticate, async (req, res) => {
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
    res.json(settings);
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
