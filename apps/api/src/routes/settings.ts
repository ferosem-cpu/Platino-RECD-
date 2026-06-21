import { Router } from "express";
import { prisma } from "../lib/prisma";
import { authenticate, requirePermission, type AuthenticatedRequest } from "../middleware/auth";
import { PERMISSION_KEY } from "@recd/shared";

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

// PUT /settings - Gated with MANAGE_SETTINGS
settingsRouter.put("/", authenticate, requirePermission(PERMISSION_KEY.MANAGE_SETTINGS), async (req: AuthenticatedRequest, res) => {
  const { logoDataUrl, themeKey, customColors } = req.body;

  try {
    const settings = await prisma.companySettings.upsert({
      where: { id: "singleton" },
      update: {
        logoDataUrl,
        themeKey,
        customColors,
      },
      create: {
        id: "singleton",
        logoDataUrl,
        themeKey,
        customColors,
      },
    });
    res.json(settings);
  } catch (error) {
    res.status(500).json({ error: "Failed to update settings" });
  }
});
