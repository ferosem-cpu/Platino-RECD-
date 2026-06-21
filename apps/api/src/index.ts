import "dotenv/config";
import express from "express";
import cors from "cors";
import { authRouter } from "./routes/auth";
import { ordersRouter } from "./routes/orders";
import { sitesRouter } from "./routes/sites";
import { complaintsRouter } from "./routes/complaints";
import { pendingActionsRouter } from "./routes/pendingActions";
import { dashboardRouter } from "./routes/dashboard";
import { usersRouter } from "./routes/users";
import { lookupsRouter } from "./routes/lookups";

const app = express();
app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => res.json({ ok: true }));

app.use("/auth", authRouter);
app.use("/orders", ordersRouter);
app.use("/sites", sitesRouter);
app.use("/complaints", complaintsRouter);
app.use("/pending-actions", pendingActionsRouter);
app.use("/dashboard", dashboardRouter);
app.use("/users", usersRouter);
app.use("/meta", lookupsRouter);

const port = Number(process.env.PORT) || 4000;
app.listen(port, () => {
  console.log(`API listening on http://localhost:${port}`);
});
