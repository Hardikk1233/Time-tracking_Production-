import { Router, type IRouter } from "express";
import { eq, and, gte, lte, sql, inArray } from "drizzle-orm";
import {
  db,
  withActor,
  timeEntriesTable,
  timeEntryEventsTable,
  usersTable,
  tasksTable,
  projectsTable,
  clientsTable,
  projectTasksTable,
} from "@workspace/db";
import { principal, requireRole } from "../middlewares/auth";
import { atLeast } from "../lib/roles";
import { isInApprovalScope, canLogToProject, visibleUserIds } from "../lib/scope";
import {
  parseId,
  validateHours,
  validateDate,
  isRestrictViolation,
} from "../lib/validation";

const router: IRouter = Router();

// ─── Row builder ─────────────────────────────────────────────────────────────

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
      approvedAt: timeEntriesTable.approvedAt,
      createdAt: timeEntriesTable.createdAt,
      updatedAt: timeEntriesTable.updatedAt,
    })
    .from(timeEntriesTable)
    .innerJoin(usersTable, eq(timeEntriesTable.userId, usersTable.id))
    .innerJoin(tasksTable, eq(timeEntriesTable.taskId, tasksTable.id))
    // Left joins: legacy entries logged before tasks became a global catalog
    // may have a null projectId (the original per-task project link is gone).
    .leftJoin(projectsTable, eq(timeEntriesTable.projectId, projectsTable.id))
    .leftJoin(clientsTable, eq(projectsTable.clientId, clientsTable.id))
    .where(whereClause)
    .orderBy(sql`${timeEntriesTable.createdAt} DESC`);

  // Resolve approver names in one extra query. The installed drizzle-orm does
  // not export alias(), so the approver cannot be self-joined onto the query
  // above — but leaving the field permanently null (as it was) hides who
  // signed off on an entry, which is exactly what the audit needs to show.
  const approverIds = [
    ...new Set(rows.map((r) => r.approvedById).filter((id): id is number => id != null)),
  ];
  const approverNames = new Map<number, string>();
  if (approverIds.length > 0) {
    const approvers = await db
      .select({ id: usersTable.id, name: usersTable.name })
      .from(usersTable)
      .where(inArray(usersTable.id, approverIds));
    approvers.forEach((a) => approverNames.set(a.id, a.name));
  }

  return rows.map((r) => ({
    ...r,
    billableHours: r.billableHours ?? null,
    nonBillableHours:
      r.billableHours !== null && r.billableHours !== undefined
        ? r.hours - r.billableHours
        : 0,
    approvedByName:
      r.approvedById != null ? approverNames.get(r.approvedById) ?? null : null,
  }));
}

// ─── Read ────────────────────────────────────────────────────────────────────

router.get("/time-entries", async (req, res): Promise<void> => {
  const me = principal(req);
  const visible = await visibleUserIds(me);

  const { userId, taskId, projectId, clientId, startDate, endDate, status } =
    req.query as Record<string, string | undefined>;

  const conditions: ReturnType<typeof eq>[] = [];

  if (visible !== null) {
    if (visible.length === 0) {
      res.json([]);
      return;
    }
    conditions.push(inArray(timeEntriesTable.userId, visible) as any);
  }

  if (userId) {
    const id = parseId(userId);
    if (id) conditions.push(eq(timeEntriesTable.userId, id));
  }
  if (taskId) {
    const id = parseId(taskId);
    if (id) conditions.push(eq(timeEntriesTable.taskId, id));
  }
  if (projectId) {
    const id = parseId(projectId);
    if (id) conditions.push(eq(timeEntriesTable.projectId, id));
  }
  if (clientId) {
    const id = parseId(clientId);
    if (id) conditions.push(eq(clientsTable.id, id));
  }
  if (startDate) conditions.push(gte(timeEntriesTable.date, startDate));
  if (endDate) conditions.push(lte(timeEntriesTable.date, endDate));
  if (status && ["pending", "approved", "rejected"].includes(status)) {
    conditions.push(
      eq(timeEntriesTable.status, status as "pending" | "approved" | "rejected"),
    );
  }

  res.json(await buildEntryRows(conditions));
});

router.get("/time-entries/:entryId", async (req, res): Promise<void> => {
  const me = principal(req);
  const entryId = parseId(req.params.entryId);
  if (!entryId) {
    res.status(400).json({ error: "Invalid entry ID" });
    return;
  }

  const [row] = await buildEntryRows([eq(timeEntriesTable.id, entryId)]);
  if (!row) {
    res.status(404).json({ error: "Time entry not found" });
    return;
  }

  // Without this any authenticated user could read any entry by guessing ids.
  const visible = await visibleUserIds(me);
  if (visible !== null && !visible.includes(row.userId)) {
    res.status(404).json({ error: "Time entry not found" });
    return;
  }

  res.json(row);
});

/** Immutable history of one entry — who changed what, and when. */
router.get(
  "/time-entries/:entryId/events",
  requireRole("associate"),
  async (req, res): Promise<void> => {
    const me = principal(req);
    const entryId = parseId(req.params.entryId);
    if (!entryId) {
      res.status(400).json({ error: "Invalid entry ID" });
      return;
    }

    const [entry] = await db
      .select({ userId: timeEntriesTable.userId, projectId: timeEntriesTable.projectId })
      .from(timeEntriesTable)
      .where(eq(timeEntriesTable.id, entryId));

    // An entry may have been deleted; its history deliberately outlives it, so
    // fall back to approval scope rather than refusing outright.
    if (entry) {
      const visible = await visibleUserIds(me);
      if (visible !== null && !visible.includes(entry.userId)) {
        res.status(404).json({ error: "Time entry not found" });
        return;
      }
    } else if (!atLeast(me.role, "avp")) {
      res.status(404).json({ error: "Time entry not found" });
      return;
    }

    const events = await db
      .select({
        id: timeEntryEventsTable.id,
        action: timeEntryEventsTable.action,
        actorId: timeEntryEventsTable.actorId,
        actorName: usersTable.name,
        previous: timeEntryEventsTable.previous,
        next: timeEntryEventsTable.next,
        createdAt: timeEntryEventsTable.createdAt,
      })
      .from(timeEntryEventsTable)
      .leftJoin(usersTable, eq(timeEntryEventsTable.actorId, usersTable.id))
      .where(eq(timeEntryEventsTable.timeEntryId, entryId))
      .orderBy(timeEntryEventsTable.id);

    res.json(events);
  },
);

// ─── Create ──────────────────────────────────────────────────────────────────

router.post("/time-entries", async (req, res): Promise<void> => {
  const me = principal(req);
  const { projectId, taskId, hours, date, description } = req.body as {
    projectId?: number;
    taskId?: number;
    hours?: number;
    date?: string;
    description?: string;
  };

  if (projectId == null || taskId == null) {
    res.status(400).json({ error: "projectId and taskId are required" });
    return;
  }

  const hoursError = validateHours(hours);
  if (hoursError) {
    res.status(400).json({ error: hoursError });
    return;
  }
  const dateError = validateDate(date);
  if (dateError) {
    res.status(400).json({ error: dateError });
    return;
  }

  if (!(await canLogToProject(me, projectId))) {
    res
      .status(403)
      .json({ error: "You are not assigned to this project" });
    return;
  }

  const [enabled] = await db
    .select()
    .from(projectTasksTable)
    .where(
      and(
        eq(projectTasksTable.projectId, projectId),
        eq(projectTasksTable.taskId, taskId),
      ),
    );
  if (!enabled) {
    res
      .status(400)
      .json({ error: "This task is not enabled for the selected project" });
    return;
  }

  const entry = await withActor(me.id, async (tx) => {
    const [created] = await tx
      .insert(timeEntriesTable)
      .values({
        // Always the caller: nobody logs time on someone else's behalf.
        userId: me.id,
        projectId,
        taskId,
        hours: hours as number,
        date: date as string,
        description: description ?? null,
        billableHours: null, // not split until an Associate+ reviews it
        status: "pending",
      })
      .returning();
    return created;
  });

  const [full] = await buildEntryRows([eq(timeEntriesTable.id, entry.id)]);
  res.status(201).json(full);
});

// ─── Update ──────────────────────────────────────────────────────────────────

router.patch("/time-entries/:entryId", async (req, res): Promise<void> => {
  const me = principal(req);
  const entryId = parseId(req.params.entryId);
  if (!entryId) {
    res.status(400).json({ error: "Invalid entry ID" });
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

  // Approved hours are final for everyone, including AVP and MD. Correcting
  // one means reopening it first, which is recorded as its own event.
  if (entry.status === "approved") {
    res.status(409).json({
      error:
        "This entry has been approved and can no longer be edited. An MD can reopen it if a correction is needed.",
    });
    return;
  }

  const isOwner = entry.userId === me.id;
  if (!isOwner) {
    if (!atLeast(me.role, "associate")) {
      res.status(403).json({ error: "Cannot edit another user's entry" });
      return;
    }
    if (!(await isInApprovalScope(me, entry))) {
      res.status(403).json({ error: "This entry is outside your remit" });
      return;
    }
  }

  const { hours, date, description, projectId, taskId } = req.body as {
    hours?: number;
    date?: string;
    description?: string | null;
    projectId?: number;
    taskId?: number;
  };

  if (hours !== undefined) {
    const hoursError = validateHours(hours);
    if (hoursError) {
      res.status(400).json({ error: hoursError });
      return;
    }
    // Lowering hours must not strand a larger billable split above it.
    if (entry.billableHours != null && hours < entry.billableHours) {
      res.status(400).json({
        error: `hours cannot be less than the ${entry.billableHours} billable hours already split on this entry`,
      });
      return;
    }
  }
  if (date !== undefined) {
    const dateError = validateDate(date);
    if (dateError) {
      res.status(400).json({ error: dateError });
      return;
    }
  }

  const newProjectId = projectId ?? entry.projectId;
  const newTaskId = taskId ?? entry.taskId;
  if (
    (projectId !== undefined || taskId !== undefined) &&
    newProjectId &&
    newTaskId
  ) {
    if (projectId !== undefined && !(await canLogToProject(me, projectId))) {
      res.status(403).json({ error: "You are not assigned to this project" });
      return;
    }
    const [link] = await db
      .select()
      .from(projectTasksTable)
      .where(
        and(
          eq(projectTasksTable.projectId, newProjectId),
          eq(projectTasksTable.taskId, newTaskId),
        ),
      );
    if (!link) {
      res
        .status(400)
        .json({ error: "This task is not enabled for the selected project" });
      return;
    }
  }

  const updates: Partial<typeof timeEntriesTable.$inferInsert> = {};
  if (hours !== undefined) updates.hours = hours;
  if (date !== undefined) updates.date = date;
  if (description !== undefined) updates.description = description;
  if (projectId !== undefined) updates.projectId = projectId;
  if (taskId !== undefined) updates.taskId = taskId;

  // Editing a rejected entry puts it back in the queue rather than leaving a
  // corrected entry sitting in a terminal state.
  if (entry.status === "rejected") {
    updates.status = "pending";
    updates.approvedById = null;
    updates.approvedAt = null;
  }

  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "No fields to update" });
    return;
  }

  await withActor(me.id, async (tx) => {
    await tx
      .update(timeEntriesTable)
      .set(updates)
      .where(eq(timeEntriesTable.id, entryId));
  });

  const [full] = await buildEntryRows([eq(timeEntriesTable.id, entryId)]);
  res.json(full);
});

// ─── Delete ──────────────────────────────────────────────────────────────────

router.delete("/time-entries/:entryId", async (req, res): Promise<void> => {
  const me = principal(req);
  const entryId = parseId(req.params.entryId);
  if (!entryId) {
    res.status(400).json({ error: "Invalid entry ID" });
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

  if (entry.status === "approved") {
    res.status(409).json({
      error:
        "This entry has been approved and can no longer be deleted. An MD can reopen it if a correction is needed.",
    });
    return;
  }

  // Your own unapproved time, or an MD tidying up. Nobody else deletes
  // another person's record.
  if (entry.userId !== me.id && me.role !== "md") {
    res.status(403).json({ error: "Cannot delete another user's entry" });
    return;
  }

  try {
    await withActor(me.id, async (tx) => {
      await tx.delete(timeEntriesTable).where(eq(timeEntriesTable.id, entryId));
    });
  } catch (err) {
    if (isRestrictViolation(err)) {
      res.status(409).json({ error: "Approved time entries cannot be deleted" });
      return;
    }
    throw err;
  }

  res.json({ message: "Time entry deleted" });
});

// ─── Billable split ──────────────────────────────────────────────────────────

router.post(
  "/time-entries/:entryId/split",
  requireRole("associate"),
  async (req, res): Promise<void> => {
    const me = principal(req);
    const entryId = parseId(req.params.entryId);
    if (!entryId) {
      res.status(400).json({ error: "Invalid entry ID" });
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

    // The split determines what the client is billed, so it is fixed at
    // approval along with everything else.
    if (entry.status === "approved") {
      res.status(409).json({
        error:
          "This entry has been approved; its billable split can no longer be changed.",
      });
      return;
    }

    if (!(await isInApprovalScope(me, entry))) {
      res.status(403).json({ error: "This entry is outside your remit" });
      return;
    }

    const { billableHours } = req.body as { billableHours?: number };

    if (typeof billableHours !== "number" || !Number.isFinite(billableHours)) {
      res.status(400).json({ error: "billableHours must be a number" });
      return;
    }
    if (billableHours < 0 || billableHours > entry.hours) {
      res
        .status(400)
        .json({ error: `billableHours must be between 0 and ${entry.hours}` });
      return;
    }

    await withActor(me.id, async (tx) => {
      await tx
        .update(timeEntriesTable)
        .set({ billableHours })
        .where(eq(timeEntriesTable.id, entryId));
    });

    const [full] = await buildEntryRows([eq(timeEntriesTable.id, entryId)]);
    res.json(full);
  },
);

// ─── Approve / reject / reopen ───────────────────────────────────────────────

/** Shared guard: Associate+, in scope, never your own, only from pending. */
async function assertCanDecide(
  req: Parameters<Parameters<IRouter["post"]>[1]>[0],
  res: Parameters<Parameters<IRouter["post"]>[1]>[1],
  entryId: number,
): Promise<typeof timeEntriesTable.$inferSelect | null> {
  const me = principal(req as never);

  const [entry] = await db
    .select()
    .from(timeEntriesTable)
    .where(eq(timeEntriesTable.id, entryId));

  if (!entry) {
    res.status(404).json({ error: "Time entry not found" });
    return null;
  }

  // Approving your own hours defeats the point of an approval step. This was
  // previously only filtered out of the queue's *display*, never enforced.
  if (entry.userId === me.id) {
    res.status(403).json({ error: "You cannot decide on your own time entry" });
    return null;
  }

  if (entry.status !== "pending") {
    res.status(409).json({
      error: `This entry is already ${entry.status} and cannot be decided again.`,
    });
    return null;
  }

  if (!(await isInApprovalScope(me, entry))) {
    res.status(403).json({ error: "This entry is outside your remit" });
    return null;
  }

  return entry;
}

router.post(
  "/time-entries/:entryId/approve",
  requireRole("associate"),
  async (req, res): Promise<void> => {
    const me = principal(req);
    const entryId = parseId(req.params.entryId);
    if (!entryId) {
      res.status(400).json({ error: "Invalid entry ID" });
      return;
    }

    const entry = await assertCanDecide(req, res, entryId);
    if (!entry) return;

    await withActor(me.id, async (tx) => {
      await tx
        .update(timeEntriesTable)
        .set({
          status: "approved",
          approvedById: me.id,
          approvedAt: new Date(),
          // Unreviewed hours default to fully billable at approval.
          billableHours: entry.billableHours ?? entry.hours,
        })
        .where(
          // Re-checking the status makes concurrent approvals safe: the second
          // one matches no row instead of overwriting the first.
          and(
            eq(timeEntriesTable.id, entryId),
            eq(timeEntriesTable.status, "pending"),
          ),
        );
    });

    const [full] = await buildEntryRows([eq(timeEntriesTable.id, entryId)]);
    res.json(full);
  },
);

router.post(
  "/time-entries/:entryId/reject",
  requireRole("associate"),
  async (req, res): Promise<void> => {
    const me = principal(req);
    const entryId = parseId(req.params.entryId);
    if (!entryId) {
      res.status(400).json({ error: "Invalid entry ID" });
      return;
    }

    const entry = await assertCanDecide(req, res, entryId);
    if (!entry) return;

    await withActor(me.id, async (tx) => {
      await tx
        .update(timeEntriesTable)
        .set({
          status: "rejected",
          approvedById: me.id,
          approvedAt: new Date(),
        })
        .where(
          and(
            eq(timeEntriesTable.id, entryId),
            eq(timeEntriesTable.status, "pending"),
          ),
        );
    });

    const [full] = await buildEntryRows([eq(timeEntriesTable.id, entryId)]);
    res.json(full);
  },
);

/**
 * The only way an approved entry becomes editable again — MD only, and
 * recorded as a `reopened` event so the correction is visible in the history.
 */
router.post(
  "/time-entries/:entryId/reopen",
  requireRole("md"),
  async (req, res): Promise<void> => {
    const me = principal(req);
    const entryId = parseId(req.params.entryId);
    if (!entryId) {
      res.status(400).json({ error: "Invalid entry ID" });
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
    if (entry.status !== "approved") {
      res
        .status(409)
        .json({ error: "Only approved entries can be reopened" });
      return;
    }

    try {
      await withActor(me.id, async (tx) => {
        await tx
          .update(timeEntriesTable)
          .set({ status: "pending", approvedById: null, approvedAt: null })
          .where(eq(timeEntriesTable.id, entryId));
      });
    } catch (err) {
      if (isRestrictViolation(err)) {
        res.status(409).json({ error: "This entry cannot be reopened" });
        return;
      }
      throw err;
    }

    const [full] = await buildEntryRows([eq(timeEntriesTable.id, entryId)]);
    res.json(full);
  },
);

export default router;
