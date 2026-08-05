import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, tasksTable, projectTasksTable, usersTable } from "@workspace/db";

const router: IRouter = Router();

async function getCurrentUserRole(userId: number) {
  const [u] = await db
    .select({ role: usersTable.role })
    .from(usersTable)
    .where(eq(usersTable.id, userId));
  return u?.role ?? "analyst";
}

// ─── Global task catalog ───────────────────────────────────────────────────

router.get("/tasks", async (req, res): Promise<void> => {
  const { projectId } = req.query as { projectId?: string };

  if (projectId) {
    const pId = parseInt(projectId, 10);
    const rows = await db
      .select({
        id: tasksTable.id,
        name: tasksTable.name,
        description: tasksTable.description,
        createdAt: tasksTable.createdAt,
      })
      .from(projectTasksTable)
      .innerJoin(tasksTable, eq(projectTasksTable.taskId, tasksTable.id))
      .where(eq(projectTasksTable.projectId, pId))
      .orderBy(tasksTable.name);

    res.json(rows);
    return;
  }

  const rows = await db.select().from(tasksTable).orderBy(tasksTable.name);
  res.json(rows);
});

router.post("/tasks", async (req, res): Promise<void> => {
  const role = await getCurrentUserRole(req.session.userId!);
  if (!["avp", "md"].includes(role)) {
    res.status(403).json({ error: "Only AVPs and MDs can add tasks to the catalog" });
    return;
  }

  const { name, description } = req.body as {
    name?: string;
    description?: string;
  };

  if (!name) {
    res.status(400).json({ error: "name is required" });
    return;
  }

  try {
    const [task] = await db
      .insert(tasksTable)
      .values({ name, description: description ?? null })
      .returning();
    res.status(201).json(task);
  } catch (err: any) {
    if (err?.code === "23505") {
      res.status(409).json({ error: "A task with this name already exists" });
      return;
    }
    throw err;
  }
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
    .select()
    .from(tasksTable)
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

  const role = await getCurrentUserRole(req.session.userId!);
  if (!["avp", "md"].includes(role)) {
    res.status(403).json({ error: "Only AVPs and MDs can edit tasks" });
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

  try {
    const [task] = await db
      .update(tasksTable)
      .set(updates)
      .where(eq(tasksTable.id, taskId))
      .returning();

    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    res.json(task);
  } catch (err: any) {
    if (err?.code === "23505") {
      res.status(409).json({ error: "A task with this name already exists" });
      return;
    }
    throw err;
  }
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

  const role = await getCurrentUserRole(req.session.userId!);
  if (!["avp", "md"].includes(role)) {
    res.status(403).json({ error: "Only AVPs and MDs can delete tasks" });
    return;
  }

  try {
    const [task] = await db
      .delete(tasksTable)
      .where(eq(tasksTable.id, taskId))
      .returning();

    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    res.json({ message: "Task deleted" });
  } catch (err: any) {
    if (err?.code === "23503") {
      res.status(400).json({
        error: "Cannot delete a task that has logged time entries against it",
      });
      return;
    }
    throw err;
  }
});

export default router;
