import { Router, type IRouter } from "express";
import { eq, and, gte, lte, sql } from "drizzle-orm";
import {
  db,
  timeEntriesTable,
  usersTable,
  tasksTable,
  projectsTable,
  clientsTable,
} from "@workspace/db";

const router: IRouter = Router();

async function buildEntryRows(conditions?: ReturnType<typeof eq>[]) {
  const whereClause =
    conditions && conditions.length > 0 ? and(...conditions) : undefined;

  const rows = await db
    .select({
      id: timeEntriesTable.id,
      userId: timeEntriesTable.userId,
      userName: usersTable.name,
      userRole: usersTable.role,
      taskId: timeEntriesTable.taskId,
      taskName: tasksTable.name,
      projectId: projectsTable.id,
      projectName: projectsTable.name,
      clientId: clientsTable.id,
      clientName: clientsTable.name,
      hours: timeEntriesTable.hours,
      date: timeEntriesTable.date,
      description: timeEntriesTable.description,
      billable: timeEntriesTable.billable,
      status: timeEntriesTable.status,
      approvedById: timeEntriesTable.approvedById,
      createdAt: timeEntriesTable.createdAt,
    })
    .from(timeEntriesTable)
    .innerJoin(usersTable, eq(timeEntriesTable.userId, usersTable.id))
    .innerJoin(tasksTable, eq(timeEntriesTable.taskId, tasksTable.id))
    .innerJoin(projectsTable, eq(tasksTable.projectId, projectsTable.id))
    .innerJoin(clientsTable, eq(projectsTable.clientId, clientsTable.id))
    .where(whereClause)
    .orderBy(sql`${timeEntriesTable.createdAt} DESC`);

  return rows.map((r) => ({ ...r, approvedByName: null as string | null }));
}

router.get("/time-entries", async (req, res): Promise<void> => {
  const { userId, taskId, projectId, clientId, startDate, endDate, status, billable } =
    req.query as Record<string, string | undefined>;

  const conditions: ReturnType<typeof eq>[] = [];
  if (userId) conditions.push(eq(timeEntriesTable.userId, parseInt(userId, 10)));
  if (taskId) conditions.push(eq(timeEntriesTable.taskId, parseInt(taskId, 10)));
  if (projectId) conditions.push(eq(projectsTable.id, parseInt(projectId, 10)));
  if (clientId) conditions.push(eq(clientsTable.id, parseInt(clientId, 10)));
  if (startDate) conditions.push(gte(timeEntriesTable.date, startDate));
  if (endDate) conditions.push(lte(timeEntriesTable.date, endDate));
  if (status)
    conditions.push(
      eq(
        timeEntriesTable.status,
        status as "pending" | "approved" | "rejected",
      ),
    );
  if (billable !== undefined)
    conditions.push(
      eq(timeEntriesTable.billable, billable === "true"),
    );

  const rows = await buildEntryRows(conditions);
  res.json(rows);
});

router.post("/time-entries", async (req, res): Promise<void> => {
  const { taskId, hours, date, description, billable } = req.body as {
    taskId?: number;
    hours?: number;
    date?: string;
    description?: string;
    billable?: boolean;
  };

  if (!taskId || !hours || !date) {
    res.status(400).json({ error: "taskId, hours, and date are required" });
    return;
  }

  const userId = req.session.userId!;

  const [entry] = await db
    .insert(timeEntriesTable)
    .values({
      userId,
      taskId,
      hours,
      date,
      description: description ?? null,
      billable: billable ?? false,
    })
    .returning();

  const [full] = await buildEntryRows([eq(timeEntriesTable.id, entry.id)]);
  res.status(201).json(full);
});

router.get("/time-entries/:entryId", async (req, res): Promise<void> => {
  const entryId = parseInt(
    Array.isArray(req.params.entryId)
      ? req.params.entryId[0]
      : req.params.entryId,
    10,
  );
  if (isNaN(entryId)) {
    res.status(400).json({ error: "Invalid entry ID" });
    return;
  }

  const [row] = await buildEntryRows([eq(timeEntriesTable.id, entryId)]);

  if (!row) {
    res.status(404).json({ error: "Time entry not found" });
    return;
  }

  res.json(row);
});

router.patch("/time-entries/:entryId", async (req, res): Promise<void> => {
  const entryId = parseInt(
    Array.isArray(req.params.entryId)
      ? req.params.entryId[0]
      : req.params.entryId,
    10,
  );
  if (isNaN(entryId)) {
    res.status(400).json({ error: "Invalid entry ID" });
    return;
  }

  const { hours, date, description, billable } = req.body as {
    hours?: number;
    date?: string;
    description?: string | null;
    billable?: boolean;
  };

  const updates: Partial<typeof timeEntriesTable.$inferInsert> = {};
  if (hours !== undefined) updates.hours = hours;
  if (date) updates.date = date;
  if (description !== undefined) updates.description = description;
  if (billable !== undefined) updates.billable = billable;

  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "No fields to update" });
    return;
  }

  const [updated] = await db
    .update(timeEntriesTable)
    .set(updates)
    .where(eq(timeEntriesTable.id, entryId))
    .returning();

  if (!updated) {
    res.status(404).json({ error: "Time entry not found" });
    return;
  }

  const [full] = await buildEntryRows([eq(timeEntriesTable.id, entryId)]);
  res.json(full);
});

router.delete("/time-entries/:entryId", async (req, res): Promise<void> => {
  const entryId = parseInt(
    Array.isArray(req.params.entryId)
      ? req.params.entryId[0]
      : req.params.entryId,
    10,
  );
  if (isNaN(entryId)) {
    res.status(400).json({ error: "Invalid entry ID" });
    return;
  }

  const [entry] = await db
    .delete(timeEntriesTable)
    .where(eq(timeEntriesTable.id, entryId))
    .returning();

  if (!entry) {
    res.status(404).json({ error: "Time entry not found" });
    return;
  }

  res.json({ message: "Time entry deleted" });
});

router.post(
  "/time-entries/:entryId/approve",
  async (req, res): Promise<void> => {
    const entryId = parseInt(
      Array.isArray(req.params.entryId)
        ? req.params.entryId[0]
        : req.params.entryId,
      10,
    );
    if (isNaN(entryId)) {
      res.status(400).json({ error: "Invalid entry ID" });
      return;
    }

    const [updated] = await db
      .update(timeEntriesTable)
      .set({ status: "approved", approvedById: req.session.userId })
      .where(eq(timeEntriesTable.id, entryId))
      .returning();

    if (!updated) {
      res.status(404).json({ error: "Time entry not found" });
      return;
    }

    const [full] = await buildEntryRows([eq(timeEntriesTable.id, entryId)]);
    res.json(full);
  },
);

router.post(
  "/time-entries/:entryId/reject",
  async (req, res): Promise<void> => {
    const entryId = parseInt(
      Array.isArray(req.params.entryId)
        ? req.params.entryId[0]
        : req.params.entryId,
      10,
    );
    if (isNaN(entryId)) {
      res.status(400).json({ error: "Invalid entry ID" });
      return;
    }

    const [updated] = await db
      .update(timeEntriesTable)
      .set({ status: "rejected", approvedById: req.session.userId })
      .where(eq(timeEntriesTable.id, entryId))
      .returning();

    if (!updated) {
      res.status(404).json({ error: "Time entry not found" });
      return;
    }

    const [full] = await buildEntryRows([eq(timeEntriesTable.id, entryId)]);
    res.json(full);
  },
);

export default router;
