import { Router, type IRouter } from "express";
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

const router: IRouter = Router();

const CAN_MANAGE_PROJECTS = ["associate", "avp", "md"];

async function getCurrentUserRole(userId: number) {
  const [u] = await db
    .select({ role: usersTable.role })
    .from(usersTable)
    .where(eq(usersTable.id, userId));
  return u?.role ?? "analyst";
}

// Projects are visible to: MDs (all), and anyone assigned to the project's
// client OR assigned directly to the project.
async function getVisibleProjectScope(
  userId: number,
): Promise<{ clientIds: number[]; projectIds: number[] } | null> {
  const role = await getCurrentUserRole(userId);
  if (role === "md") return null;

  const [clientRows, projectRows] = await Promise.all([
    db
      .select({ clientId: clientUsersTable.clientId })
      .from(clientUsersTable)
      .where(eq(clientUsersTable.userId, userId)),
    db
      .select({ projectId: projectUsersTable.projectId })
      .from(projectUsersTable)
      .where(eq(projectUsersTable.userId, userId)),
  ]);

  return {
    clientIds: clientRows.map((r) => r.clientId),
    projectIds: projectRows.map((r) => r.projectId),
  };
}

router.get("/projects", async (req, res): Promise<void> => {
  const { clientId } = req.query as { clientId?: string };

  const scope = await getVisibleProjectScope(req.session.userId!);

  let visibilityClause;
  if (scope !== null) {
    if (scope.clientIds.length === 0 && scope.projectIds.length === 0) {
      res.json([]);
      return;
    }
    const clauses = [];
    if (scope.clientIds.length > 0) {
      clauses.push(inArray(projectsTable.clientId, scope.clientIds));
    }
    if (scope.projectIds.length > 0) {
      clauses.push(inArray(projectsTable.id, scope.projectIds));
    }
    visibilityClause = or(...clauses);
  }

  let whereClause = visibilityClause;
  if (clientId) {
    const cId = parseInt(clientId, 10);
    whereClause = visibilityClause
      ? and(eq(projectsTable.clientId, cId), visibilityClause)
      : eq(projectsTable.clientId, cId);
  }

  const rows = await db
    .select({
      id: projectsTable.id,
      clientId: projectsTable.clientId,
      clientName: clientsTable.name,
      name: projectsTable.name,
      description: projectsTable.description,
      createdAt: projectsTable.createdAt,
    })
    .from(projectsTable)
    .innerJoin(clientsTable, eq(projectsTable.clientId, clientsTable.id))
    .where(whereClause)
    .orderBy(projectsTable.name);

  res.json(rows);
});

router.post("/projects", async (req, res): Promise<void> => {
  const role = await getCurrentUserRole(req.session.userId!);
  if (!CAN_MANAGE_PROJECTS.includes(role)) {
    res.status(403).json({ error: "Only Associates and above can create projects" });
    return;
  }

  const { clientId, name, description, taskIds, userIds } = req.body as {
    clientId?: number;
    name?: string;
    description?: string;
    taskIds?: number[];
    userIds?: number[];
  };

  if (!clientId || !name) {
    res.status(400).json({ error: "clientId and name are required" });
    return;
  }

  const [project] = await db
    .insert(projectsTable)
    .values({ clientId, name, description: description ?? null })
    .returning();

  if (Array.isArray(taskIds) && taskIds.length > 0) {
    await db
      .insert(projectTasksTable)
      .values(taskIds.map((taskId) => ({ projectId: project.id, taskId })))
      .onConflictDoNothing();
  }

  // Auto-assign the creator so they can see the project, plus any explicitly chosen users
  const assignees = new Set<number>([req.session.userId!]);
  if (Array.isArray(userIds)) {
    userIds.forEach((id) => typeof id === "number" && assignees.add(id));
  }
  await db
    .insert(projectUsersTable)
    .values([...assignees].map((userId) => ({ projectId: project.id, userId })))
    .onConflictDoNothing();

  const [client] = await db
    .select({ name: clientsTable.name })
    .from(clientsTable)
    .where(eq(clientsTable.id, clientId));

  res.status(201).json({
    ...project,
    clientName: client?.name ?? "",
  });
});

async function assertProjectVisible(
  userId: number,
  projectId: number,
): Promise<boolean> {
  const scope = await getVisibleProjectScope(userId);
  if (scope === null) return true;

  if (scope.projectIds.includes(projectId)) return true;
  if (scope.clientIds.length === 0) return false;

  const [project] = await db
    .select({ clientId: projectsTable.clientId })
    .from(projectsTable)
    .where(eq(projectsTable.id, projectId));

  return !!project && scope.clientIds.includes(project.clientId);
}

router.get("/projects/:projectId", async (req, res): Promise<void> => {
  const projectId = parseInt(
    Array.isArray(req.params.projectId)
      ? req.params.projectId[0]
      : req.params.projectId,
    10,
  );
  if (isNaN(projectId)) {
    res.status(400).json({ error: "Invalid project ID" });
    return;
  }

  if (!(await assertProjectVisible(req.session.userId!, projectId))) {
    res.status(403).json({ error: "Access denied" });
    return;
  }

  const [row] = await db
    .select({
      id: projectsTable.id,
      clientId: projectsTable.clientId,
      clientName: clientsTable.name,
      name: projectsTable.name,
      description: projectsTable.description,
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

router.patch("/projects/:projectId", async (req, res): Promise<void> => {
  const projectId = parseInt(
    Array.isArray(req.params.projectId)
      ? req.params.projectId[0]
      : req.params.projectId,
    10,
  );
  if (isNaN(projectId)) {
    res.status(400).json({ error: "Invalid project ID" });
    return;
  }

  const role = await getCurrentUserRole(req.session.userId!);
  if (!CAN_MANAGE_PROJECTS.includes(role)) {
    res.status(403).json({ error: "Only Associates and above can edit projects" });
    return;
  }

  const { name, description } = req.body as {
    name?: string;
    description?: string | null;
  };

  const updates: Partial<typeof projectsTable.$inferInsert> = {};
  if (name) updates.name = name;
  if (description !== undefined) updates.description = description;

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
});

router.delete("/projects/:projectId", async (req, res): Promise<void> => {
  const projectId = parseInt(
    Array.isArray(req.params.projectId)
      ? req.params.projectId[0]
      : req.params.projectId,
    10,
  );
  if (isNaN(projectId)) {
    res.status(400).json({ error: "Invalid project ID" });
    return;
  }

  const role = await getCurrentUserRole(req.session.userId!);
  if (!CAN_MANAGE_PROJECTS.includes(role)) {
    res.status(403).json({ error: "Only Associates and above can delete projects" });
    return;
  }

  const [project] = await db
    .delete(projectsTable)
    .where(eq(projectsTable.id, projectId))
    .returning();

  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  res.json({ message: "Project deleted" });
});

// ─── Project user assignments ──────────────────────────────────────────────

router.get(
  "/projects/:projectId/assignments",
  async (req, res): Promise<void> => {
    const projectId = parseInt(
      Array.isArray(req.params.projectId)
        ? req.params.projectId[0]
        : req.params.projectId,
      10,
    );
    if (isNaN(projectId)) {
      res.status(400).json({ error: "Invalid project ID" });
      return;
    }

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
  async (req, res): Promise<void> => {
    const projectId = parseInt(
      Array.isArray(req.params.projectId)
        ? req.params.projectId[0]
        : req.params.projectId,
      10,
    );
    if (isNaN(projectId)) {
      res.status(400).json({ error: "Invalid project ID" });
      return;
    }

    const role = await getCurrentUserRole(req.session.userId!);
    if (!CAN_MANAGE_PROJECTS.includes(role)) {
      res.status(403).json({ error: "Only Associates and above can assign users to projects" });
      return;
    }

    const { userId } = req.body as { userId?: number };
    if (!userId) {
      res.status(400).json({ error: "userId is required" });
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
  async (req, res): Promise<void> => {
    const projectId = parseInt(
      Array.isArray(req.params.projectId)
        ? req.params.projectId[0]
        : req.params.projectId,
      10,
    );
    const userId = parseInt(
      Array.isArray(req.params.userId)
        ? req.params.userId[0]
        : req.params.userId,
      10,
    );
    if (isNaN(projectId) || isNaN(userId)) {
      res.status(400).json({ error: "Invalid IDs" });
      return;
    }

    const role = await getCurrentUserRole(req.session.userId!);
    if (!CAN_MANAGE_PROJECTS.includes(role)) {
      res.status(403).json({ error: "Only Associates and above can remove users from projects" });
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

// ─── Project task assignments (global catalog subset enabled per project) ──

router.get(
  "/projects/:projectId/tasks",
  async (req, res): Promise<void> => {
    const projectId = parseInt(
      Array.isArray(req.params.projectId)
        ? req.params.projectId[0]
        : req.params.projectId,
      10,
    );
    if (isNaN(projectId)) {
      res.status(400).json({ error: "Invalid project ID" });
      return;
    }

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
  },
);

router.post(
  "/projects/:projectId/tasks",
  async (req, res): Promise<void> => {
    const projectId = parseInt(
      Array.isArray(req.params.projectId)
        ? req.params.projectId[0]
        : req.params.projectId,
      10,
    );
    if (isNaN(projectId)) {
      res.status(400).json({ error: "Invalid project ID" });
      return;
    }

    const role = await getCurrentUserRole(req.session.userId!);
    if (!CAN_MANAGE_PROJECTS.includes(role)) {
      res.status(403).json({ error: "Only Associates and above can manage project tasks" });
      return;
    }

    const { taskId } = req.body as { taskId?: number };
    if (!taskId) {
      res.status(400).json({ error: "taskId is required" });
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
  async (req, res): Promise<void> => {
    const projectId = parseInt(
      Array.isArray(req.params.projectId)
        ? req.params.projectId[0]
        : req.params.projectId,
      10,
    );
    const taskId = parseInt(
      Array.isArray(req.params.taskId) ? req.params.taskId[0] : req.params.taskId,
      10,
    );
    if (isNaN(projectId) || isNaN(taskId)) {
      res.status(400).json({ error: "Invalid IDs" });
      return;
    }

    const role = await getCurrentUserRole(req.session.userId!);
    if (!CAN_MANAGE_PROJECTS.includes(role)) {
      res.status(403).json({ error: "Only Associates and above can manage project tasks" });
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
