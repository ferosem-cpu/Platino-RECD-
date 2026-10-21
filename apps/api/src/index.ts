import "dotenv/config";
import express, { type ErrorRequestHandler } from "express";
import cors from "cors";
import { parseTrustProxy } from "./lib/proxyConfig";
import { buildCorsOptions, parseAllowedOrigins, scrubSecretKeysFromJson, securityHeaders } from "./lib/httpSecurity";
import { authRouter } from "./routes/auth";
import { ordersRouter } from "./routes/orders";
import { sitesRouter } from "./routes/sites";
import { complaintsRouter } from "./routes/complaints";
import { serviceReportsRouter } from "./routes/serviceReports";
import { reminderCronRouter, remindersRouter } from "./routes/reminders";
import { amcVisitsRouter } from "./routes/amcVisits";
import { complaintCronRouter } from "./routes/complaintCron";
import { pendingActionsRouter } from "./routes/pendingActions";
import { dashboardRouter } from "./routes/dashboard";
import { usersRouter } from "./routes/users";
import { lookupsRouter } from "./routes/lookups";
import { settingsRouter } from "./routes/settings";
import { customersRouter } from "./routes/customers";
import { productsRouter } from "./routes/products";
import { vendorsRouter } from "./routes/vendors";
import { amcOrdersRouter } from "./routes/amcOrders";
import { vendorAmcsRouter } from "./routes/vendorAmcs";
import { warrantyAlertsRouter, warrantyCronRouter } from "./routes/warrantyAlerts";
import { amcAlertsRouter } from "./routes/amcAlerts";
import { regionsRouter } from "./routes/regions";
import { publicComplaintsRouter } from "./routes/publicComplaints";
import { recdUnitsRouter } from "./routes/recdUnits";
import { agentTestRouter } from "./routes/agentTest";
import { agentProvidersRouter } from "./routes/agentProviders";
import { agentConversationsRouter } from "./routes/agentConversations";
import { agentCronRouter } from "./routes/agentCron";

const app = express();
// Which proxies may vouch for a client address (this drives req.ip and so every per-IP limiter). Unset = trust none; see lib/proxyConfig.ts.
const trustProxy = parseTrustProxy(process.env.TRUST_PROXY);
if (trustProxy.problem) console.warn(trustProxy.problem);
if (trustProxy.setting === false && process.env.VERCEL) {
  console.warn("TRUST_PROXY is not set on a hosted platform: all visitors may share one rate-limit bucket. The hosting owner must set it to the real number of proxy hops.");
}
app.set("trust proxy", trustProxy.setting);
// Security headers first, so they are on every response including CORS preflights and errors.
app.use(securityHeaders());
// Explicit CORS allowlist (ADMIN_WEB_URL + CORS_ALLOWED_ORIGINS; local dev origins only outside production). CORS is not authentication.
const allowedOrigins = parseAllowedOrigins(process.env);
for (const problem of allowedOrigins.problems) console.warn(problem);
app.use(cors(buildCorsOptions(allowedOrigins)));
app.use(scrubSecretKeysFromJson());
// Raise the body limit so base64 data-URL payloads (site photos, company logo) fit;
// the default 100kb rejects anything but a thumbnail.
app.use(express.json({ limit: "10mb" }));

app.get("/health", (_req, res) => res.json({ ok: true }));

app.use("/auth", authRouter);
app.use("/orders", ordersRouter);
app.use("/customers", customersRouter);
app.use("/products", productsRouter);
app.use("/vendors", vendorsRouter);
app.use("/sites", sitesRouter);
app.use("/complaints/cron", complaintCronRouter); // before the authenticated router
app.use("/complaints", complaintsRouter);
app.use("/service-reports", serviceReportsRouter);
app.use("/reminders/cron", reminderCronRouter); // before the authenticated router
app.use("/reminders", remindersRouter);
app.use("/amc-visits", amcVisitsRouter);
app.use("/pending-actions", pendingActionsRouter);
app.use("/dashboard", dashboardRouter);
app.use("/users", usersRouter);
app.use("/settings", settingsRouter);
app.use("/meta", lookupsRouter);
app.use("/amc-orders", amcOrdersRouter);
app.use("/vendor-amcs", vendorAmcsRouter);
app.use("/amc-alerts", amcAlertsRouter);
app.use("/warranty/cron", warrantyCronRouter); // before any authenticated router
app.use("/warranty-alerts", warrantyAlertsRouter);
app.use("/regions", regionsRouter);
app.use("/public/complaints", publicComplaintsRouter);
app.use("/recd-units", recdUnitsRouter);
app.use("/agent", agentTestRouter);
app.use("/agent", agentProvidersRouter);
app.use("/agent", agentConversationsRouter);
app.use("/agent", agentCronRouter);

// Catches anything a route handler throws or rejects with (Express 5 forwards rejected
// async handlers here automatically) so a downstream failure - like the database being
// unreachable - returns a clean error response instead of crashing the process.
const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
};
app.use(errorHandler);

const port = Number(process.env.PORT) || 4000;
if (process.env.NODE_ENV !== "production" || !process.env.VERCEL) {
  app.listen(port, () => {
    console.log(`API listening on http://localhost:${port}`);
  });
}

export default app;
