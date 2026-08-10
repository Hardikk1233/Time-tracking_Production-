import { Router, type IRouter } from "express";
import { eq, and, gte, lte, sql, inArray } from "drizzle-orm";
import { format } from "date-fns";
import {
  db,
  timeEntriesTable,
  usersTable,
  projectsTable,
  clientsTable,
  publicHolidaysTable,
  leavesTable,
  clientUsersTable,
  tasksTable,
} from "@workspace/db";

const router: IRouter = Router();

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function fetchHolidaySet(startDate: string, endDate: string): Promise<Set<string>> {
  const rows = await db
    .select({ date: publicHolidaysTable.date })
    .from(publicHolidaysTable)
    .where(and(gte(publicHolidaysTable.date, startDate), lte(publicHolidaysTable.date, endDate)));
  return new Set(rows.map((r) => r.date));
}

function countWorkingDays(
  startDate: string,
  endDate: string,
  holidaySet: Set<string>,
): number {
  const end = new Date(endDate);
  let count = 0;
  const cur = new Date(startDate);
  while (cur <= end) {
    const d = cur.getDay();
    const dateStr = format(cur, "yyyy-MM-dd");
    if (d > 0 && d < 6 && !holidaySet.has(dateStr)) count++;
    cur.setDate(cur.getDate() + 1);
  }
  return count;
}

function resolveRange(
  startDate?: string,
  endDate?: string,
): { start: string; end: string } {
  const now = new Date();
  const start =
    startDate ?? format(new Date(now.getFullYear(), now.getMonth(), 1), "yyyy-MM-dd");
  const end =
    endDate ?? format(new Date(now.getFullYear(), now.getMonth() + 1, 0), "yyyy-MM-dd");
  return { start, end };
}

/** Returns all userIds in the AVP's subordinate tree (direct + indirect reports). */
async function getSubordinateUserIds(avpId: number): Promise<number[]> {
  const direct = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.reportingToId, avpId));
  const directIds = direct.map((r) => r.id);

  let indirectIds: number[] = [];
  if (directIds.length > 0) {
    const indirect = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(inArray(usersTable.reportingToId, directIds));
    indirectIds = indirect.map((r) => r.id);
  }
  return [avpId, ...directIds, ...indirectIds];
}

/** Returns clientIds the user is directly assigned to. */
async function getUserClientIds(userId: number): Promise<number[]> {
  const rows = await db
    .selectDistinct({ clientId: clientUsersTable.clientId })
    .from(clientUsersTable)
    .where(eq(clientUsersTable.userId, userId));
  return rows.map((r) => r.clientId);
}

/** Parse comma-separated or repeated query param into numbers. Returns null when absent. */
function parseIds(param: string | string[] | undefined): number[] | null {
  if (!param) return null;
  const raw = Array.isArray(param) ? param.join(",") : param;
  const ids = raw
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => !isNaN(n) && n > 0);
  return ids.length > 0 ? ids : null;
}

/**
 * Intersect a scope list with a caller-supplied filter list.
 * null scope = unrestricted (MD) — apply filterIds as-is.
 * null filterIds = no filter — return scope as-is.
 * [] either side = empty result.
 */
function intersect(
  scopedIds: number[] | null,
  filterIds: number[] | null,
): number[] | null {
  if (scopedIds === null) return filterIds;
  if (filterIds === null) return scopedIds;
  const set = new Set(filterIds);
  return scopedIds.filter((id) => set.has(id));
}

type Scope = {
  scopedUserIds: number[] | null; // null = unrestricted
  scopedClientIds: number[] | null; // null = unrestricted
};

/** Resolve data-access scope for the current user. */
async function resolveScope(currentUserId: number, currentRole: string): Promise<Scope> {
  if (currentRole === "md") {
    return { scopedUserIds: null, scopedClientIds: null };
  }
  if (currentRole === "avp") {
    const [subIds, clientIds] = await Promise.all([
      getSubordinateUserIds(currentUserId),
      getUserClientIds(currentUserId),
    ]);
    return { scopedUserIds: subIds, scopedClientIds: clientIds };
  }
  // analyst or associate: only their own hours, their assigned clients
  const clientIds = await getUserClientIds(currentUserId);
  return { scopedUserIds: [currentUserId], scopedClientIds: clientIds };
}

// ─── Auth middleware ───────────────────────────────────────────────────────────
// Allow all roles; scope is enforced per-endpoint.

router.use(async (req, res, next) => {
  const userId = req.session.userId!;
  const [user] = await db
    .select({ role: usersTable.role })
    .from(usersTable)
    .where(eq(usersTable.id, userId));

  if (!user) {
    res.status(403).json({ error: "User not found" });
    return;
  }
  (req as any)._reporterRole = user.role;
  (req as any)._reporterUserId = userId;
  next();
});

// ─── GET /filter-options ──────────────────────────────────────────────────────

router.get("/filter-options", async (req, res): Promise<void> => {
  const currentRole = (req as any)._reporterRole as string;
  const currentUserId = (req as any)._reporterUserId as number;

  const { scopedUserIds, scopedClientIds } = await resolveScope(currentUserId, currentRole);

  const [usersResult, clientsResult] = await Promise.all([
    scopedUserIds === null
      ? db.select({ id: usersTable.id, name: usersTable.name, role: usersTable.role }).from(usersTable).orderBy(usersTable.name)
      : scopedUserIds.length === 0
      ? []
      : db.select({ id: usersTable.id, name: usersTable.name, role: usersTable.role }).from(usersTable).where(inArray(usersTable.id, scopedUserIds)).orderBy(usersTable.name),
    scopedClientIds === null
      ? db.select({ id: clientsTable.id, name: clientsTable.name }).from(clientsTable).orderBy(clientsTable.name)
      : scopedClientIds.length === 0
      ? []
      : db.select({ id: clientsTable.id, name: clientsTable.name }).from(clientsTable).where(inArray(clientsTable.id, scopedClientIds)).orderBy(clientsTable.name),
  ]);

  const visibleClientIds = scopedClientIds ?? clientsResult.map((c) => c.id);
  const projectsResult =
    visibleClientIds.length === 0
      ? []
      : await db
          .select({ id: projectsTable.id, name: projectsTable.name, clientId: projectsTable.clientId })
          .from(projectsTable)
          .where(inArray(projectsTable.clientId, visibleClientIds))
          .orderBy(projectsTable.name);

  res.json({ users: usersResult, clients: clientsResult, projects: projectsResult });
});

// ─── GET /client-report ───────────────────────────────────────────────────────
// Monthly summary chart data + per-member hours breakdown for a client.

router.get("/client-report", async (req, res): Promise<void> => {
  const currentRole = (req as any)._reporterRole as string;
  const currentUserId = (req as any)._reporterUserId as number;

  const { clientId: rawClientId, startDate, endDate } = req.query as Record<string, string | undefined>;

  const clientId = rawClientId ? parseInt(rawClientId, 10) : null;
  if (!clientId || isNaN(clientId)) {
    res.status(400).json({ error: "clientId is required" });
    return;
  }

  const { start, end } = resolveRange(startDate, endDate);

  const { scopedUserIds, scopedClientIds } = await resolveScope(currentUserId, currentRole);

  // Verify the user can access this client
  if (scopedClientIds !== null && !scopedClientIds.includes(clientId)) {
    res.status(403).json({ error: "Access to this client is not permitted" });
    return;
  }

  // Get all projects for this client
  const clientProjects = await db
    .select({ id: projectsTable.id })
    .from(projectsTable)
    .where(eq(projectsTable.clientId, clientId));
  const projectIds = clientProjects.map((p) => p.id);

  if (projectIds.length === 0) {
    res.json({ monthlySummary: [], memberBreakdown: [] });
    return;
  }

  // Build WHERE for time entries
  const entryConditions: Parameters<typeof and>[0][] = [
    gte(timeEntriesTable.date, start),
    lte(timeEntriesTable.date, end),
    inArray(timeEntriesTable.projectId, projectIds) as any,
  ];
  if (scopedUserIds !== null) {
    if (scopedUserIds.length === 0) {
      res.json({ monthlySummary: [], memberBreakdown: [] });
      return;
    }
    entryConditions.push(inArray(timeEntriesTable.userId, scopedUserIds) as any);
  }
  const entryWhere = and(...entryConditions);

  // Monthly summary
  const monthlySummaryRaw = await db
    .select({
      month: sql<string>`TO_CHAR(${timeEntriesTable.date}, 'YYYY-MM')`,
      totalHours: sql<number>`SUM(${timeEntriesTable.hours})`,
      billableHours: sql<number>`SUM(COALESCE(${timeEntriesTable.billableHours}, 0))`,
    })
    .from(timeEntriesTable)
    .where(entryWhere)
    .groupBy(sql`TO_CHAR(${timeEntriesTable.date}, 'YYYY-MM')`)
    .orderBy(sql`TO_CHAR(${timeEntriesTable.date}, 'YYYY-MM')`);

  // Member breakdown
  const memberBreakdownRaw = await db
    .select({
      userId: usersTable.id,
      userName: usersTable.name,
      role: usersTable.role,
      totalHours: sql<number>`COALESCE(SUM(${timeEntriesTable.hours}), 0)`,
      billableHours: sql<number>`COALESCE(SUM(COALESCE(${timeEntriesTable.billableHours}, 0)), 0)`,
    })
    .from(usersTable)
    .innerJoin(timeEntriesTable, and(eq(timeEntriesTable.userId, usersTable.id), entryWhere))
    .groupBy(usersTable.id, usersTable.name, usersTable.role)
    .orderBy(usersTable.name);

  res.json({
    monthlySummary: monthlySummaryRaw.map((r) => ({
      month: r.month,
      totalHours: Number(r.totalHours),
      billableHours: Number(r.billableHours),
      nonBillableHours: Number(r.totalHours) - Number(r.billableHours),
    })),
    memberBreakdown: memberBreakdownRaw.map((r) => ({
      userId: r.userId,
      userName: r.userName,
      role: r.role,
      totalHours: Number(r.totalHours),
      billableHours: Number(r.billableHours),
      nonBillableHours: Number(r.totalHours) - Number(r.billableHours),
    })),
  });
});

// ─── GET /team-report ─────────────────────────────────────────────────────────
// Hours by Project and Task for selected users and clients.

router.get("/team-report", async (req, res): Promise<void> => {
  const currentRole = (req as any)._reporterRole as string;
  const currentUserId = (req as any)._reporterUserId as number;

  const { startDate, endDate, userIds: rawUserIds, clientIds: rawClientIds } =
    req.query as Record<string, string | string[] | undefined>;

  const { start, end } = resolveRange(startDate as string | undefined, endDate as string | undefined);
  const filterUserIds = parseIds(rawUserIds as string | undefined);
  const filterClientIds = parseIds(rawClientIds as string | undefined);

  const { scopedUserIds, scopedClientIds } = await resolveScope(currentUserId, currentRole);

  const effectiveUserIds = intersect(scopedUserIds, filterUserIds);
  const effectiveClientIds = intersect(scopedClientIds, filterClientIds);

  if (effectiveUserIds !== null && effectiveUserIds.length === 0) { res.json([]); return; }
  if (effectiveClientIds !== null && effectiveClientIds.length === 0) { res.json([]); return; }

  // Resolve project IDs from client scope
  let effectiveProjectIds: number[] | null = null;
  if (effectiveClientIds !== null) {
    const projRows = await db
      .select({ id: projectsTable.id })
      .from(projectsTable)
      .where(inArray(projectsTable.clientId, effectiveClientIds));
    if (projRows.length === 0) { res.json([]); return; }
    effectiveProjectIds = projRows.map((r) => r.id);
  }

  const entryConds: Parameters<typeof and>[0][] = [
    gte(timeEntriesTable.date, start),
    lte(timeEntriesTable.date, end),
  ];
  if (effectiveUserIds) entryConds.push(inArray(timeEntriesTable.userId, effectiveUserIds) as any);
  if (effectiveProjectIds) entryConds.push(inArray(timeEntriesTable.projectId, effectiveProjectIds) as any);

  const rows = await db
    .select({
      clientId: clientsTable.id,
      clientName: clientsTable.name,
      projectId: projectsTable.id,
      projectName: projectsTable.name,
      taskId: tasksTable.id,
      taskName: tasksTable.name,
      totalHours: sql<number>`SUM(${timeEntriesTable.hours})`,
      billableHours: sql<number>`SUM(COALESCE(${timeEntriesTable.billableHours}, 0))`,
    })
    .from(timeEntriesTable)
    .innerJoin(projectsTable, eq(projectsTable.id, timeEntriesTable.projectId))
    .innerJoin(clientsTable, eq(clientsTable.id, projectsTable.clientId))
    .innerJoin(tasksTable, eq(tasksTable.id, timeEntriesTable.taskId))
    .where(and(...entryConds))
    .groupBy(clientsTable.id, clientsTable.name, projectsTable.id, projectsTable.name, tasksTable.id, tasksTable.name)
    .orderBy(clientsTable.name, projectsTable.name, tasksTable.name);

  res.json(
    rows.map((r) => ({
      clientId: r.clientId,
      clientName: r.clientName,
      projectId: r.projectId,
      projectName: r.projectName,
      taskId: r.taskId,
      taskName: r.taskName,
      totalHours: Number(r.totalHours),
      billableHours: Number(r.billableHours),
      nonBillableHours: Number(r.totalHours) - Number(r.billableHours),
    })),
  );
});

// ─── GET /my-report ───────────────────────────────────────────────────────────
// Current user's hours by Project and Task with utilization + efficiency summary.

router.get("/my-report", async (req, res): Promise<void> => {
  const currentUserId = (req as any)._reporterUserId as number;

  const { startDate, endDate } = req.query as Record<string, string | undefined>;
  const { start, end } = resolveRange(startDate, endDate);

  const [rows, holidaySet] = await Promise.all([
    db
      .select({
        clientId: clientsTable.id,
        clientName: clientsTable.name,
        projectId: projectsTable.id,
        projectName: projectsTable.name,
        taskId: tasksTable.id,
        taskName: tasksTable.name,
        totalHours: sql<number>`SUM(${timeEntriesTable.hours})`,
        billableHours: sql<number>`SUM(COALESCE(${timeEntriesTable.billableHours}, 0))`,
      })
      .from(timeEntriesTable)
      .innerJoin(projectsTable, eq(projectsTable.id, timeEntriesTable.projectId))
      .innerJoin(clientsTable, eq(clientsTable.id, projectsTable.clientId))
      .innerJoin(tasksTable, eq(tasksTable.id, timeEntriesTable.taskId))
      .where(
        and(
          eq(timeEntriesTable.userId, currentUserId),
          gte(timeEntriesTable.date, start),
          lte(timeEntriesTable.date, end),
        ),
      )
      .groupBy(clientsTable.id, clientsTable.name, projectsTable.id, projectsTable.name, tasksTable.id, tasksTable.name)
      .orderBy(clientsTable.name, projectsTable.name, tasksTable.name),
    fetchHolidaySet(start, end),
  ]);

  const leaveRows = await db
    .select({ date: leavesTable.date })
    .from(leavesTable)
    .where(
      and(
        eq(leavesTable.userId, currentUserId),
        gte(leavesTable.date, start),
        lte(leavesTable.date, end),
      ),
    );

  const workingDays = countWorkingDays(start, end, holidaySet);
  const leaveDays = leaveRows.filter((l) => {
    const d = new Date(l.date).getDay();
    return d > 0 && d < 6 && !holidaySet.has(l.date);
  }).length;
  const availableDays = Math.max(workingDays - leaveDays, 0);
  const targetHours = availableDays * 8;

  const entries = rows.map((r) => ({
    clientId: r.clientId,
    clientName: r.clientName,
    projectId: r.projectId,
    projectName: r.projectName,
    taskId: r.taskId,
    taskName: r.taskName,
    totalHours: Number(r.totalHours),
    billableHours: Number(r.billableHours),
    nonBillableHours: Number(r.totalHours) - Number(r.billableHours),
  }));

  const totalHours = entries.reduce((s, e) => s + e.totalHours, 0);
  const billableHours = entries.reduce((s, e) => s + e.billableHours, 0);

  res.json({
    entries,
    summary: {
      workingDays,
      leaveDays,
      availableDays,
      targetHours,
      totalHours,
      billableHours,
      nonBillableHours: totalHours - billableHours,
      utilization: targetHours > 0 ? Math.round((billableHours / targetHours) * 1000) / 10 : 0,
      efficiency: totalHours > 0 ? Math.round((billableHours / totalHours) * 1000) / 10 : 0,
    },
  });
});

export default router;
