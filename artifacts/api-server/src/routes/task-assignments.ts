import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import {
  db,
  projectTaskAssignmentsTable,
  projectTasksTable,
  projectsTable,
  projectUsersTable,
  clientsTable,
  tasksTable,
  usersTable,
} from "@workspace/db";
import { principal } from "../middlewares/auth";
import { isProjectVisible } from "../lib/scope";
import { parseId } from "../lib/validation";

const router: IRouter = Router();

/**
 * Who is doing what on a project.
 *
 * An assignment records an intention, not a permission: anybody on the project
 * may still log time against any task enabled there. Making it a gate would
 * turn every unplanned piece of work into a permission error, which is not
 * what a timesheet is for.
 *
 * Analysts may assign only themselves. That keeps the useful half of
 * self-service — picking up work without waiting to be given it — without
 * letting somebody hand work to a colleague from below.
 */

/** Resolves the project and confirms the caller may see it. */
async function resolveProject(
  req: Parameters<Parameters<IRouter["get"]>[1]>[0],
  res: Parameters<Parameters<IRouter["get"]>[1]>[1],
): Promise<number | null> {
  const projectId = parseId(req.params.projectId);
  if (!projectId) {
    res.status(400).json({ error: "Invalid project id" });
    return null;
  }
  if (!(await isProjectVisible(principal(req), projectId))) {
    res.status(404).json({ error: "Project not found" });
    return null;
  }
  return projectId;
}

/** Every assignment on one project, with the task and the person named. */
router.get(
  "/projects/:projectId/task-assignments",
  async (req, res): Promise<void> => {
    const projectId = await resolveProject(req, res);
    if (!projectId) return;

    const rows = await db
      .select({
        id: projectTaskAssignmentsTable.id,
        taskId: projectTaskAssignmentsTable.taskId,
        taskName: tasksTable.name,
        assigneeUserId: projectTaskAssignmentsTable.assigneeUserId,
        assigneeName: usersTable.name,
        assigneeRole: usersTable.role,
        assignedById: projectTaskAssignmentsTable.assignedById,
        assignedAt: projectTaskAssignmentsTable.assignedAt,
      })
      .from(projectTaskAssignmentsTable)
      .innerJoin(tasksTable, eq(projectTaskAssignmentsTable.taskId, tasksTable.id))
      .innerJoin(
        usersTable,
        eq(projectTaskAssignmentsTable.assigneeUserId, usersTable.id),
      )
      .where(eq(projectTaskAssignmentsTable.projectId, projectId))
      .orderBy(tasksTable.name, usersTable.name);

    res.json(rows);
  },
);

/**
 * Assign a task to somebody on this project.
 *
 * Open to analysts as well, but only for themselves — hence no requireRole on
 * the route and an explicit check below, which also keeps the refusal specific
 * enough to act on.
 */
router.post(
  "/projects/:projectId/task-assignments",
  async (req, res): Promise<void> => {
    const projectId = await resolveProject(req, res);
    if (!projectId) return;

    const me = principal(req);
    const { taskId, assigneeUserId } = req.body as {
      taskId?: unknown;
      assigneeUserId?: unknown;
    };

    const tid = Number(taskId);
    // Omitting the assignee means "me", which is the whole of what an analyst
    // can do and the common case for everybody else.
    const uid =
      assigneeUserId === undefined || assigneeUserId === null
        ? me.id
        : Number(assigneeUserId);

    if (!Number.isInteger(tid) || !Number.isInteger(uid)) {
      res.status(400).json({ error: "taskId is required" });
      return;
    }

    if (me.role === "analyst" && uid !== me.id) {
      res
        .status(403)
        .json({ error: "Analysts can only assign work to themselves" });
      return;
    }

    // The task has to be enabled on this project. The composite foreign key
    // enforces it too, but a checked answer beats a constraint violation.
    const [enabled] = await db
      .select({ taskId: projectTasksTable.taskId })
      .from(projectTasksTable)
      .where(
        and(
          eq(projectTasksTable.projectId, projectId),
          eq(projectTasksTable.taskId, tid),
        ),
      );

    if (!enabled) {
      res
        .status(400)
        .json({ error: "That task is not enabled on this project" });
      return;
    }

    // Assigning somebody who is not on the project would show them work they
    // cannot log against, since logging is gated on project membership.
    const [onProject] = await db
      .select({ userId: projectUsersTable.userId })
      .from(projectUsersTable)
      .where(
        and(
          eq(projectUsersTable.projectId, projectId),
          eq(projectUsersTable.userId, uid),
        ),
      );

    if (!onProject) {
      res
        .status(400)
        .json({ error: "Add that person to the project team first" });
      return;
    }

    const [created] = await db
      .insert(projectTaskAssignmentsTable)
      .values({
        projectId,
        taskId: tid,
        assigneeUserId: uid,
        assignedById: me.id,
      })
      .onConflictDoNothing()
      .returning();

    if (!created) {
      res
        .status(409)
        .json({ error: "That task is already assigned to that person" });
      return;
    }

    res.status(201).json(created);
  },
);

/** Withdraw an assignment. Analysts may drop their own. */
router.delete(
  "/task-assignments/:assignmentId",
  async (req, res): Promise<void> => {
    const assignmentId = parseId(req.params.assignmentId);
    if (!assignmentId) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }

    const me = principal(req);

    const [row] = await db
      .select({
        id: projectTaskAssignmentsTable.id,
        projectId: projectTaskAssignmentsTable.projectId,
        assigneeUserId: projectTaskAssignmentsTable.assigneeUserId,
      })
      .from(projectTaskAssignmentsTable)
      .where(eq(projectTaskAssignmentsTable.id, assignmentId));

    if (!row || !(await isProjectVisible(me, row.projectId))) {
      res.status(404).json({ error: "Assignment not found" });
      return;
    }

    if (me.role === "analyst" && row.assigneeUserId !== me.id) {
      res
        .status(403)
        .json({ error: "Analysts can only drop their own work" });
      return;
    }

    await db
      .delete(projectTaskAssignmentsTable)
      .where(eq(projectTaskAssignmentsTable.id, assignmentId));

    res.status(204).send();
  },
);

/** What the caller has been asked to do, across every project. */
router.get("/my-task-assignments", async (req, res): Promise<void> => {
  const me = principal(req);

  const rows = await db
    .select({
      id: projectTaskAssignmentsTable.id,
      taskId: projectTaskAssignmentsTable.taskId,
      taskName: tasksTable.name,
      taskDescription: tasksTable.description,
      projectId: projectTaskAssignmentsTable.projectId,
      projectName: projectsTable.name,
      clientId: projectsTable.clientId,
      clientName: clientsTable.name,
      assignedById: projectTaskAssignmentsTable.assignedById,
      assignedAt: projectTaskAssignmentsTable.assignedAt,
    })
    .from(projectTaskAssignmentsTable)
    .innerJoin(tasksTable, eq(projectTaskAssignmentsTable.taskId, tasksTable.id))
    .innerJoin(
      projectsTable,
      eq(projectTaskAssignmentsTable.projectId, projectsTable.id),
    )
    .innerJoin(clientsTable, eq(projectsTable.clientId, clientsTable.id))
    .where(eq(projectTaskAssignmentsTable.assigneeUserId, me.id))
    .orderBy(clientsTable.name, projectsTable.name, tasksTable.name);

  res.json(rows);
});

export default router;
