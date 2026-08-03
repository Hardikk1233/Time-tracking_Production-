import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, tasksTable, projectsTable, clientsTable } from "@workspace/db";

const router: IRouter = Router();

router.get("/tasks", async (req, res): Promise<void> => {
  const { projectId } = req.query as { projectId?: string };

  const rows = await db
    .select({
      id: tasksTable.id,
      projectId: tasksTable.projectId,
      projectName: projectsTable.name,
      clientId: projectsTable.clientId,
      clientName: clientsTable.name,
      name: tasksTable.name,
      description: tasksTable.description,
      createdAt: tasksTable.createdAt,
    })
    .from(tasksTable)
    .innerJoin(projectsTable, eq(tasksTable.projectId, projectsTable.id))
    .innerJoin(clientsTable, eq(projectsTable.clientId, clientsTable.id))
    .where(
      projectId ? eq(tasksTable.projectId, parseInt(projectId, 10)) : undefined,
    )
    .orderBy(tasksTable.name);

  res.json(rows);
});

router.post("/tasks", async (req, res): Promise<void> => {
  const { projectId, name, description } = req.body as {
    projectId?: number;
    name?: string;
    description?: string;
  };

  if (!projectId || !name) {
    res.status(400).json({ error: "projectId and name are required" });
    return;
  }

  const [task] = await db
    .insert(tasksTable)
    .values({ projectId, name, description: description ?? null })
    .returning();

  const [proj] = await db
    .select({
      name: projectsTable.name,
      clientId: projectsTable.clientId,
      clientName: clientsTable.name,
    })
    .from(projectsTable)
    .innerJoin(clientsTable, eq(projectsTable.clientId, clientsTable.id))
    .where(eq(projectsTable.id, projectId));

  res.status(201).json({
    ...task,
    projectName: proj?.name ?? "",
    clientId: proj?.clientId ?? 0,
    clientName: proj?.clientName ?? "",
  });
});

router.get("/tasks/:taskId", async (req, res): Promise<void> => {
  const taskId = parseInt(
    Array.isArray(req.params.taskId) ? req.params.taskId[0] : req.params.taskId,
    10,
  );
  if (isNaN(taskId)) {
    res.status(400).json({ error: "Invalid task ID" });
    return;
  }

  const [row] = await db
    .select({
      id: tasksTable.id,
      projectId: tasksTable.projectId,
      projectName: projectsTable.name,
      clientId: projectsTable.clientId,
      clientName: clientsTable.name,
      name: tasksTable.name,
      description: tasksTable.description,
      createdAt: tasksTable.createdAt,
    })
    .from(tasksTable)
    .innerJoin(projectsTable, eq(tasksTable.projectId, projectsTable.id))
    .innerJoin(clientsTable, eq(projectsTable.clientId, clientsTable.id))
    .where(eq(tasksTable.id, taskId));

  if (!row) {
    res.status(404).json({ error: "Task not found" });
    return;
  }

  res.json(row);
});

router.patch("/tasks/:taskId", async (req, res): Promise<void> => {
  const taskId = parseInt(
    Array.isArray(req.params.taskId) ? req.params.taskId[0] : req.params.taskId,
    10,
  );
  if (isNaN(taskId)) {
    res.status(400).json({ error: "Invalid task ID" });
    return;
  }

  const { name, description } = req.body as {
    name?: string;
    description?: string | null;
  };

  const updates: Partial<typeof tasksTable.$inferInsert> = {};
  if (name) updates.name = name;
  if (description !== undefined) updates.description = description;

  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "No fields to update" });
    return;
  }

  const [task] = await db
    .update(tasksTable)
    .set(updates)
    .where(eq(tasksTable.id, taskId))
    .returning();

  if (!task) {
    res.status(404).json({ error: "Task not found" });
    return;
  }

  const [proj] = await db
    .select({
      name: projectsTable.name,
      clientId: projectsTable.clientId,
      clientName: clientsTable.name,
    })
    .from(projectsTable)
    .innerJoin(clientsTable, eq(projectsTable.clientId, clientsTable.id))
    .where(eq(projectsTable.id, task.projectId));

  res.json({
    ...task,
    projectName: proj?.name ?? "",
    clientId: proj?.clientId ?? 0,
    clientName: proj?.clientName ?? "",
  });
});

router.delete("/tasks/:taskId", async (req, res): Promise<void> => {
  const taskId = parseInt(
    Array.isArray(req.params.taskId) ? req.params.taskId[0] : req.params.taskId,
    10,
  );
  if (isNaN(taskId)) {
    res.status(400).json({ error: "Invalid task ID" });
    return;
  }

  const [task] = await db
    .delete(tasksTable)
    .where(eq(tasksTable.id, taskId))
    .returning();

  if (!task) {
    res.status(404).json({ error: "Task not found" });
    return;
  }

  res.json({ message: "Task deleted" });
});

export default router;
