import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import usersRouter from "./users";
import clientsRouter from "./clients";
import hourBlocksRouter from "./hour-blocks";
import productsRouter from "./products";
import projectsRouter from "./projects";
import taskAssignmentsRouter from "./task-assignments";
import tasksRouter from "./tasks";
import timeEntriesRouter from "./time-entries";
import dashboardRouter from "./dashboard";
import holidaysRouter from "./holidays";
import leavesRouter from "./leaves";
import reportsRouter from "./reports";
import { devIngestRouter, feedbackRouter, devConsoleRouter } from "./dev";
import { requireAuth } from "../middlewares/auth";
import { requireDevConsole } from "../middlewares/dev-console";
import { devIngestLimiter } from "../middlewares/rate-limit";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);

// Crash reports are taken before authentication on purpose: a browser that
// failed to sign in is exactly the case worth capturing, and demanding a valid
// token would discard the evidence for the bug being reported.
//
// The limiter is bound to that one path. Passed to router.use without a path
// it applied to every request through this router instead, so the whole API
// ran on the crash-report budget of 30 a minute per address - and with the
// office behind one address, that was 30 a minute for the firm. A dashboard
// load is roughly eight calls, so ordinary use exhausted it in seconds and the
// client's retries kept it exhausted: the "too many requests" toasts and the
// app feeling frozen were both this line.
router.use("/dev/client-events", devIngestLimiter);
router.use(devIngestRouter);

// All routes below require authentication
router.use(requireAuth);

router.use(usersRouter);
router.use(clientsRouter);
router.use(hourBlocksRouter);
router.use(productsRouter);
router.use(projectsRouter);
router.use(taskAssignmentsRouter);
router.use(tasksRouter);
router.use(timeEntriesRouter);
router.use(dashboardRouter);
router.use(holidaysRouter);
router.use(leavesRouter);
router.use("/reports", reportsRouter);

// Temporary rollout tooling. Anyone signed in may send feedback; only the
// DEV_CONSOLE_EMAILS allowlist may read what has been collected.
router.use(feedbackRouter);
router.use("/dev", requireDevConsole, devConsoleRouter);

export default router;
