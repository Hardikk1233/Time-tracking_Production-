import { Router, type IRouter, type Request, type Response } from "express";
import { eq, and, inArray, or } from "drizzle-orm";
import {
  db,
  projectsTable,
  clientsTable,
  projectUsersTable,
  clientUsersTable,
  projectTasksTable,
  tasksTable,
  usersTable,
} from "@workspace/db";
import { principal, requireRole } from "../middlewares/auth";
import {
  isProjectVisible,
  isClientVisible,
  visibleClientIds,
} from "../lib/scope";
import { parseId } from "../lib/validation";

const router: IRouter = Router();

/**
 * Resolves the project id and confirms the caller may act on it.
 *
 * Returns null having already answered the request when it may not — every
 * project route below funnels through this, because a role check alone let an
 * Associate rename, delete or assign themselves to any project by id.
 */
async function resolveProject(
  req: Request,
  res: Response,
): Promise<number | null> {
  const projectId = parseId(req.params.projectId);
  if (!projectId) {
    res.status(400).json({ error: "Invalid project ID" });
    return null;
  }
  if (!(await isProjectVisible(principal(req), projectId))) {
    // 404 rather than 403: existence itself is not something to leak.
    res.status(404).json({ error: "Project not found" });
    return null;
  }
  return projectId;
}

// ─── Read ────────────────────────────────────────────────────────────────────

router.get("/projects", async (req, res): Promise<void> => {
  const me = principal(req);
  const { clientId } = req.query as { clientId?: string };

  const [clientRows, projectRows] =
    me.role === "md"
      ? [null, null]
      : await Promise.all([
          db
            .select({ clientId: clientUsersTable.clientId })
            .from(clientUsersTable)
            .where(eq(clientUsersTable.userId, me.id)),
          db
            .select({ projectId: projectUsersTable.projectId })
            .from(projectUsersTable)
            .where(eq(projectUsersTable.userId, me.id)),
        ]);

  let visibilityClause;
  if (clientRows !== null && projectRows !== null) {
    const clientIds = clientRows.map((r) => r.clientId);
    const projectIds = projectRows.map((r) => r.projectId);
    if (clientIds.length === 0 && projectIds.length === 0) {
      res.json([]);
      return;
    }
    const clauses = [];
    if (clientIds.length > 0) {
      clauses.push(inArray(projectsTable.clientId, clientIds));
    }
    if (projectIds.length > 0) {
      clauses.push(inArray(projectsTable.id, projectIds));
    }
    visibilityClause = or(...clauses);
  }

  let whereClause = visibilityClause;
  const filterClientId = clientId ? parseId(clientId) : null;
  if (filterClientId) {
    whereClause = visibilityClause
      ? and(eq(projectsTable.clientId, filterClientId), visibilityClause)
      : eq(projectsTable.clientId, filterClientId);
  }

  const rows = await db
    .select({
      id: projectsTable.id,
      clientId: projectsTable.clientId,
      clientName: clientsTable.name,
      name: projectsTable.name,
      description: projectsTable.description,
      isActive: projectsTable.isActive,
      createdAt: projectsTable.createdAt,
    })
    .from(projectsTable)
    .innerJoin(clientsTable, eq(projectsTable.clientId, clientsTable.id))
    .where(whereClause)
    .orderBy(projectsTable.name);

  res.json(rows);
});

router.get("/projects/:projectId", async (req, res): Promise<void> => {
  const projectId = await resolveProject(req, res);
  if (!projectId) return;

  const [row] = await db
    .select({
      id: projectsTable.id,
      clientId: projectsTable.clientId,
      clientName: clientsTable.name,
      name: projectsTable.name,
      description: projectsTable.description,
      isActive: projectsTable.isActive,
      createdAt: projectsTable.createdAt,
    })
    .from(projectsTable)
    .innerJoin(clientsTable, eq(projectsTable.clientId, clientsTable.id))
    .where(eq(projectsTable.id, projectId));

  if (!row) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  res.json(row);
});

// ─── Create / update / delete ────────────────────────────────────────────────

router.post(
  "/projects",
  requireRole("associate"),
  async (req, res): Promise<void> => {
    const me = principal(req);
    const { clientId, name, description, taskIds, userIds } = req.body as {
      clientId?: number;
      name?: string;
      description?: string;
      taskIds?: number[];
      userIds?: number[];
    };

    if (!clientId || !name?.trim()) {
      res.status(400).json({ error: "clientId and name are required" });
      return;
    }

    // A project could previously be created under any client — and since the
    // creator is auto-assigned below, that handed out visibility of an account
    // the caller had nothing to do with.
    if (!(await isClientVisible(me, clientId))) {
      res.status(404).json({ error: "Client not found" });
      return;
    }

    const [client] = await db
      .select({ name: clientsTable.name })
      .from(clientsTable)
      .where(eq(clientsTable.id, clientId));
    if (!client) {
      res.status(404).json({ error: "Client not found" });
      return;
    }

    const [project] = await db
      .insert(projectsTable)
      .values({ clientId, name: name.trim(), description: description ?? null })
      .returning();

    if (Array.isArray(taskIds) && taskIds.length > 0) {
      await db
        .insert(projectTasksTable)
        .values(taskIds.map((taskId) => ({ projectId: project.id, taskId })))
        .onConflictDoNothing();
    }

    const assignees = new Set<number>([me.id]);
    if (Array.isArray(userIds)) {
      userIds.forEach((id) => typeof id === "number" && assignees.add(id));
    }
    await db
      .insert(projectUsersTable)
      .values([...assignees].map((userId) => ({ projectId: project.id, userId })))
      .onConflictDoNothing();

    res.status(201).json({ ...project, clientName: client.name });
  },
);

router.patch(
  "/projects/:projectId",
  requireRole("associate"),
  async (req, res): Promise<void> => {
    const projectId = await resolveProject(req, res);
    if (!projectId) return;

    const { name, description, isActive } = req.body as {
      name?: string;
      description?: string | null;
      isActive?: boolean;
    };

    const updates: Partial<typeof projectsTable.$inferInsert> = {};
    if (name !== undefined) {
      if (!name.trim()) {
        res.status(400).json({ error: "name cannot be empty" });
        return;
      }
      updates.name = name.trim();
    }
    if (description !== undefined) updates.description = description;
    if (isActive !== undefined) updates.isActive = isActive;

    if (Object.keys(updates).length === 0) {
      res.status(400).json({ error: "No fields to update" });
      return;
    }

    const [project] = await db
      .update(projectsTable)
      .set(updates)
      .where(eq(projectsTable.id, projectId))
      .returning();

    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    const [client] = await db
      .select({ name: clientsTable.name })
      .from(clientsTable)
      .where(eq(clientsTable.id, project.clientId));

    res.json({ ...project, clientName: client?.name ?? "" });
  },
);

router.delete(
  "/projects/:projectId",
  requireRole("associate"),
  async (req, res): Promise<void> => {
    const projectId = await resolveProject(req, res);
    if (!projectId) return;

    try {
      const [project] = await db
        .delete(projectsTable)
        .where(eq(projectsTable.id, projectId))
        .returning();

      if (!project) {
        res.status(404).json({ error: "Project not found" });
        return;
      }
      res.json({ message: "Project deleted" });
    } catch (err: unknown) {
      // Time entries reference the project without a cascade, so this raised an
      // unhandled 500 rather than explaining the problem.
      const pgCode =
        (err as { code?: string; cause?: { code?: string } })?.code ??
        (err as { cause?: { code?: string } })?.cause?.code;
      if (pgCode === "23503") {
        // The old text said "deactivate it instead" — a feature projects do
        // not have. An error that points at a control that does not exist is
        // worse than no advice at all.
        res.status(409).json({
          error:
            "This project has time logged against it, and those entries are billing records. Delete or move its time entries first, or leave the project in place.",
        });
        return;
      }
      throw err;
    }
  },
);

// ─── User assignments ────────────────────────────────────────────────────────

router.get(
  "/projects/:projectId/assignments",
  async (req, res): Promise<void> => {
    const projectId = await resolveProject(req, res);
    if (!projectId) return;

    const rows = await db
      .select({
        id: usersTable.id,
        name: usersTable.name,
        email: usersTable.email,
        role: usersTable.role,
        reportingToId: usersTable.reportingToId,
        createdAt: usersTable.createdAt,
      })
      .from(projectUsersTable)
      .innerJoin(usersTable, eq(projectUsersTable.userId, usersTable.id))
      .where(eq(projectUsersTable.projectId, projectId));

    res.json(rows);
  },
);

router.post(
  "/projects/:projectId/assignments",
  requireRole("associate"),
  async (req, res): Promise<void> => {
    const projectId = await resolveProject(req, res);
    if (!projectId) return;

    const { userId } = req.body as { userId?: number };
    if (!userId) {
      res.status(400).json({ error: "userId is required" });
      return;
    }

    const [target] = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.id, userId));
    if (!target) {
      res.status(400).json({ error: "userId does not match a user" });
      return;
    }

    await db
      .insert(projectUsersTable)
      .values({ projectId, userId })
      .onConflictDoNothing();

    res.json({ message: "User assigned to project" });
  },
);

router.delete(
  "/projects/:projectId/assignments/:userId",
  requireRole("associate"),
  async (req, res): Promise<void> => {
    const projectId = await resolveProject(req, res);
    if (!projectId) return;

    const userId = parseId(req.params.userId);
    if (!userId) {
      res.status(400).json({ error: "Invalid user ID" });
      return;
    }

    await db
      .delete(projectUsersTable)
      .where(
        and(
          eq(projectUsersTable.projectId, projectId),
          eq(projectUsersTable.userId, userId),
        ),
      );

    res.json({ message: "User removed from project" });
  },
);

// ─── Enabled tasks (subset of the global catalog) ────────────────────────────

router.get("/projects/:projectId/tasks", async (req, res): Promise<void> => {
  const projectId = await resolveProject(req, res);
  if (!projectId) return;

  const rows = await db
    .select({
      id: tasksTable.id,
      name: tasksTable.name,
      description: tasksTable.description,
      createdAt: tasksTable.createdAt,
    })
    .from(projectTasksTable)
    .innerJoin(tasksTable, eq(projectTasksTable.taskId, tasksTable.id))
    .where(eq(projectTasksTable.projectId, projectId))
    .orderBy(tasksTable.name);

  res.json(rows);
});

router.post(
  "/projects/:projectId/tasks",
  requireRole("associate"),
  async (req, res): Promise<void> => {
    const projectId = await resolveProject(req, res);
    if (!projectId) return;

    const { taskId } = req.body as { taskId?: number };
    if (!taskId) {
      res.status(400).json({ error: "taskId is required" });
      return;
    }

    const [task] = await db
      .select({ id: tasksTable.id })
      .from(tasksTable)
      .where(eq(tasksTable.id, taskId));
    if (!task) {
      res.status(400).json({ error: "taskId does not match a task" });
      return;
    }

    await db
      .insert(projectTasksTable)
      .values({ projectId, taskId })
      .onConflictDoNothing();

    res.json({ message: "Task enabled for project" });
  },
);

router.delete(
  "/projects/:projectId/tasks/:taskId",
  requireRole("associate"),
  async (req, res): Promise<void> => {
    const projectId = await resolveProject(req, res);
    if (!projectId) return;

    const taskId = parseId(req.params.taskId);
    if (!taskId) {
      res.status(400).json({ error: "Invalid task ID" });
      return;
    }

    await db
      .delete(projectTasksTable)
      .where(
        and(
          eq(projectTasksTable.projectId, projectId),
          eq(projectTasksTable.taskId, taskId),
        ),
      );

    res.json({ message: "Task removed from project" });
  },
);

export default router;
