import { Router } from "express";
import { authenticate, type AuthenticatedRequest } from "../middleware/auth";
import { buildAmcAlerts } from "../lib/amcContracts";

/** Login-time AMC notice: the contracts the CALLER may see that are expiring soon or expired. Read-only; scoping lives in buildAmcAlerts. */
export const amcAlertsRouter = Router();
amcAlertsRouter.use(authenticate);

amcAlertsRouter.get("/", async (req: AuthenticatedRequest, res) => {
  const { permissions, customerId, vendorId } = req.auth!;
  res.json(await buildAmcAlerts({ permissions, customerId, vendorId }));
});
