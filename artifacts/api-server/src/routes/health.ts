import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { checkDatabase } from "@workspace/db";
import { logger } from "../lib/logger";

const router: IRouter = Router();

/**
 * Liveness — is the process still running?
 *
 * Deliberately does not touch the database: if Postgres is unreachable,
 * restarting this container cannot fix it, and a failing liveness probe would
 * put the app into a restart loop that only slows recovery down.
 */
router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

/**
 * Readiness — should this replica receive traffic?
 *
 * Checks the database, so a replica whose pool cannot connect is taken out of
 * rotation instead of serving errors.
 */
router.get("/readyz", async (_req, res) => {
  try {
    await checkDatabase();
    res.json({ status: "ready" });
  } catch (err) {
    logger.error({ err }, "Readiness check failed: database unreachable");
    res.status(503).json({ status: "unready", reason: "database_unreachable" });
  }
});

export default router;
