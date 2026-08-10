import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import usersRouter from "./users";
import clientsRouter from "./clients";
import projectsRouter from "./projects";
import tasksRouter from "./tasks";
import timeEntriesRouter from "./time-entries";
import dashboardRouter from "./dashboard";
import holidaysRouter from "./holidays";
import leavesRouter from "./leaves";
import reportsRouter from "./reports";
import { requireAuth } from "../middlewares/auth";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);

// All routes below require authentication
router.use(requireAuth);

router.use(usersRouter);
router.use(clientsRouter);
router.use(projectsRouter);
router.use(tasksRouter);
router.use(timeEntriesRouter);
router.use(dashboardRouter);
router.use(holidaysRouter);
router.use(leavesRouter);
router.use("/reports", reportsRouter);

export default router;
