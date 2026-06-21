import { Router } from "express";
import { prisma } from "../lib/prisma";
import { authenticate } from "../middleware/auth";

/**
 * Read-only lookups for every data-driven table (stages, status options, photo
 * checkpoints, roles). The whole point of modeling these as rows instead of
 * hardcoded enums is that client apps populate pickers from here - add a new
 * row in the database and it shows up everywhere with no app release.
 */
export const lookupsRouter = Router();
lookupsRouter.use(authenticate);

lookupsRouter.get("/stages", async (_req, res) => {
  const stages = await prisma.stageDefinition.findMany({ orderBy: { sequenceOrder: "asc" } });
  res.json(stages);
});

lookupsRouter.get("/status-options", async (req, res) => {
  const domain = typeof req.query.domain === "string" ? req.query.domain : "site_stage";
  const options = await prisma.statusOption.findMany({ where: { domain }, orderBy: { sequenceOrder: "asc" } });
  res.json(options);
});

lookupsRouter.get("/photo-checkpoints", async (_req, res) => {
  const checkpoints = await prisma.photoCheckpoint.findMany({ orderBy: { sequenceOrder: "asc" } });
  res.json(checkpoints);
});

lookupsRouter.get("/roles", async (_req, res) => {
  const roles = await prisma.role.findMany({ select: { id: true, key: true, name: true, description: true } });
  res.json(roles);
});
