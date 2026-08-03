import { Router, type IRouter } from "express";
import { eq, and, gte, lte, sql, inArray } from "drizzle-orm";
import {
  db,
  timeEntriesTable,
  usersTable,
  tasksTable,
  projectsTable,
  clientsTable,
  projectUsersTable,
  clientUsersTable,
} from "@workspace/db";

const router: IRouter = Router();

// ─── Visibility helpers ───────────────────────────────────────────────────────

/** Return the set of userIds whose entries the currentUser may see.
 *  null means "no restriction" (MD can see all). */
async function getVisibleUserIds(
  currentUserId: number,
  role: string,
): Promise<number[] | null> {
  if (role === "md") return null;
  if (role === "analyst") return [currentUserId];

  if (role === "avp") {
    // AVP: own entries + all users assigned to the same clients
    const myClients = await db
      .selectDistinct({ clientId: clientUsersTable.clientId })
      .from(clientUsersTable)
      .where(eq(clientUsersTable.userId, currentUserId));

    const myClientIds = myClients.map((r) => r.clientId);
    if (myClientIds.length === 0) return [currentUserId];

    const coWorkers = await db
      .selectDistinct({ userId: clientUsersTable.userId })
      .from(clientUsersTable)
      .where(inArray(clientUsersTable.clientId, myClientIds));

    const ids = new Set([currentUserId, ...coWorkers.map((r) => r.userId)]);
    return [...ids];
  }

  // Associate: own entries + everyone assigned to the same projects
  const myProjects = await db
    .selectDistinct({ projectId: projectUsersTable.projectId })
    .from(projectUsersTable)
    .where(eq(projectUsersTable.userId, currentUserId));

  const myProjectIds = myProjects.map((r) => r.projectId);
  if (myProjectIds.length === 0) return [currentUserId];

  const teammates = await db
    .selectDistinct({ userId: projectUsersTable.userId })
    .from(projectUsersTable)
    .where(inArray(projectUsersTable.projectId, myProjectIds));

  const ids = new Set([currentUserId, ...teammates.map((r) => r.userId)]);
  return [...ids];
}

// ─── buildEntryRows ──────────────────────────────────────────────────────────

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
      billableHours: timeEntriesTable.billableHours,
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

  return rows.map((r) => ({
    ...r,
    billableHours: r.billableHours ?? null,
    nonBillableHours:
      r.billableHours !== null && r.billableHours !== undefined
        ? r.hours - r.billableHours
        : null,
    approvedByName: null as string | null,
  }));
}

// ─── Routes ──────────────────────────────────────────────────────────────────

router.get("/time-entries", async (req, res): Promise<void> => {
  const currentUserId = req.session.userId!;
  const [currentUser] = await db
    .select({ role: usersTable.role })
    .from(usersTable)
    .where(eq(usersTable.id, currentUserId));

  const visibleIds = await getVisibleUserIds(
    currentUserId,
    currentUser?.role ?? "analyst",
  );

  const { userId, taskId, projectId, clientId, startDate, endDate, status } =
    req.query as Record<string, string | undefined>;

  const conditions: ReturnType<typeof eq>[] = [];

  // Apply role-based visibility
  if (visibleIds !== null) {
    if (visibleIds.length === 0) {
      res.json([]);
      return;
    }
    conditions.push(inArray(timeEntriesTable.userId, visibleIds) as any);
  }

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

  const rows = await buildEntryRows(conditions);
  res.json(rows);
});

router.post("/time-entries", async (req, res): Promise<void> => {
  const { taskId, hours, date, description } = req.body as {
    taskId?: number;
    hours?: number;
    date?: string;
    description?: string;
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
      billableHours: null, // not split until Associate+ sets it
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

  const currentUserId = req.session.userId!;
  const [entry] = await db
    .select()
    .from(timeEntriesTable)
    .where(eq(timeEntriesTable.id, entryId));

  if (!entry) {
    res.status(404).json({ error: "Time entry not found" });
    return;
  }

  // Only the owner can edit their own entry's hours/date/description
  if (entry.userId !== currentUserId) {
    const [cu] = await db
      .select({ role: usersTable.role })
      .from(usersTable)
      .where(eq(usersTable.id, currentUserId));
    if (!["associate", "avp", "md"].includes(cu?.role ?? "")) {
      res.status(403).json({ error: "Cannot edit another user's entry" });
      return;
    }
  }

  const { hours, date, description } = req.body as {
    hours?: number;
    date?: string;
    description?: string | null;
  };

  const updates: Partial<typeof timeEntriesTable.$inferInsert> = {};
  if (hours !== undefined) updates.hours = hours;
  if (date) updates.date = date;
  if (description !== undefined) updates.description = description;

  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "No fields to update" });
    return;
  }

  await db
    .update(timeEntriesTable)
    .set(updates)
    .where(eq(timeEntriesTable.id, entryId));

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

// ─── Split hours (Associate+ sets billableHours on an entry) ─────────────────

router.post(
  "/time-entries/:entryId/split",
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

    const currentUserId = req.session.userId!;
    const [cu] = await db
      .select({ role: usersTable.role })
      .from(usersTable)
      .where(eq(usersTable.id, currentUserId));

    if (!["associate", "avp", "md"].includes(cu?.role ?? "")) {
      res
        .status(403)
        .json({ error: "Only Associates and above can split hours" });
      return;
    }

    const [entry] = await db
      .select()
      .from(timeEntriesTable)
      .where(eq(timeEntriesTable.id, entryId));

    if (!entry) {
      res.status(404).json({ error: "Time entry not found" });
      return;
    }

    const { billableHours } = req.body as { billableHours?: number };

    if (billableHours === undefined || billableHours === null) {
      res.status(400).json({ error: "billableHours is required" });
      return;
    }
    if (billableHours < 0 || billableHours > entry.hours) {
      res
        .status(400)
        .json({ error: `billableHours must be between 0 and ${entry.hours}` });
      return;
    }

    await db
      .update(timeEntriesTable)
      .set({ billableHours })
      .where(eq(timeEntriesTable.id, entryId));

    const [full] = await buildEntryRows([eq(timeEntriesTable.id, entryId)]);
    res.json(full);
  },
);

// ─── Approve / Reject ─────────────────────────────────────────────────────────

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
