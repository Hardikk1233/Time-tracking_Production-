import { Router, type IRouter } from "express";
import { principal } from "../middlewares/auth";
import { eq, and, gte, lte, sql, inArray, isNull, or } from "drizzle-orm";
import { format, subMonths, startOfMonth, endOfMonth, eachMonthOfInterval } from "date-fns";
import { productivity, percent, HOURS_PER_DAY } from "../lib/metrics";
import {
  db,
  timeEntriesTable,
  usersTable,
  projectsTable,
  clientsTable,
  publicHolidaysTable,
  leavesTable,
  clientUsersTable,
  clientFteHistoryTable,
  tasksTable,
} from "@workspace/db";

const router: IRouter = Router();

// ─── Shared helpers ────────────────────────────────────────────────────────────

async function fetchHolidaySet(startDate: string, endDate: string): Promise<Set<string>> {
  const rows = await db
    .select({ date: publicHolidaysTable.date })
    .from(publicHolidaysTable)
    .where(and(gte(publicHolidaysTable.date, startDate), lte(publicHolidaysTable.date, endDate)));
  return new Set(rows.map((r) => r.date));
}

function countWorkingDays(start: string, end: string, holidaySet: Set<string>): number {
  const endDate = new Date(end);
  let count = 0;
  const cur = new Date(start);
  while (cur <= endDate) {
    const d = cur.getDay();
    if (d > 0 && d < 6 && !holidaySet.has(format(cur, "yyyy-MM-dd"))) count++;
    cur.setDate(cur.getDate() + 1);
  }
  return count;
}

function resolveRange(startDate?: string, endDate?: string): { start: string; end: string } {
  const now = new Date();
  return {
    start: startDate ?? format(startOfMonth(now), "yyyy-MM-dd"),
    end: endDate ?? format(now, "yyyy-MM-dd"),
  };
}

function parseIds(param: string | string[] | undefined): number[] | null {
  if (!param) return null;
  const raw = Array.isArray(param) ? param.join(",") : param;
  const ids = raw.split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n) && n > 0);
  return ids.length > 0 ? ids : null;
}

function intersect(scopedIds: number[] | null, filterIds: number[] | null): number[] | null {
  if (scopedIds === null) return filterIds;
  if (filterIds === null) return scopedIds;
  const set = new Set(filterIds);
  return scopedIds.filter((id) => set.has(id));
}

async function getSubordinateUserIds(avpId: number): Promise<number[]> {
  const direct = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.reportingToId, avpId));
  const directIds = direct.map((r) => r.id);
  let indirectIds: number[] = [];
  if (directIds.length > 0) {
    const indirect = await db.select({ id: usersTable.id }).from(usersTable).where(inArray(usersTable.reportingToId, directIds));
    indirectIds = indirect.map((r) => r.id);
  }
  return [avpId, ...directIds, ...indirectIds];
}

async function getUserClientIds(userId: number): Promise<number[]> {
  const rows = await db.selectDistinct({ clientId: clientUsersTable.clientId }).from(clientUsersTable).where(eq(clientUsersTable.userId, userId));
  return rows.map((r) => r.clientId);
}

type Scope = { scopedUserIds: number[] | null; scopedClientIds: number[] | null };

async function resolveScope(currentUserId: number, currentRole: string): Promise<Scope> {
  if (currentRole === "md") return { scopedUserIds: null, scopedClientIds: null };
  if (currentRole === "avp") {
    const [subIds, clientIds] = await Promise.all([getSubordinateUserIds(currentUserId), getUserClientIds(currentUserId)]);
    return { scopedUserIds: subIds, scopedClientIds: clientIds };
  }
  const clientIds = await getUserClientIds(currentUserId);
  return { scopedUserIds: [currentUserId], scopedClientIds: clientIds };
}

/** Sum billable hours per clientId for a time window. */
async function getBillablePerClient(
  clientIds: number[],
  scopedUserIds: number[] | null,
  start: string,
  end: string,
): Promise<Map<number, number>> {
  if (clientIds.length === 0) return new Map();
  const conds: Parameters<typeof and>[0][] = [
    gte(timeEntriesTable.date, start),
    lte(timeEntriesTable.date, end),
    inArray(projectsTable.clientId, clientIds) as any,
  ];
  if (scopedUserIds !== null) {
    if (scopedUserIds.length === 0) return new Map(clientIds.map((id) => [id, 0]));
    conds.push(inArray(timeEntriesTable.userId, scopedUserIds) as any);
  }
  const rows = await db
    .select({
      clientId: projectsTable.clientId,
      // Use fully-qualified column so SELECT and GROUP BY match exactly
      billable: sql<number>`SUM(COALESCE("time_entries"."billable_hours", "time_entries"."hours"))`,
    })
    .from(timeEntriesTable)
    .innerJoin(projectsTable, eq(projectsTable.id, timeEntriesTable.projectId))
    .where(and(...conds))
    .groupBy(projectsTable.clientId);
  return new Map(rows.map((r) => [r.clientId, Number(r.billable)]));
}

type FteHistoryEntry = { fteCount: number; effectiveFrom: string; effectiveTo: string | null };

/** Return the FTE count that applied on a given representative date (YYYY-MM-DD). Falls back to defaultFte. */
function getApplicableFte(repDate: string, history: FteHistoryEntry[], defaultFte: number): number {
  for (const h of history) {
    if (h.effectiveFrom <= repDate && (h.effectiveTo === null || h.effectiveTo >= repDate)) {
      return h.fteCount;
    }
  }
  return defaultFte;
}

/** Compute contracted hours for a date window using per-month FTE from history. */
function calcContractedHours(
  start: string,
  end: string,
  holidaySet: Set<string>,
  history: FteHistoryEntry[],
  defaultFte: number,
): number {
  const months = eachMonthOfInterval({ start: new Date(start + "T12:00:00"), end: new Date(end + "T12:00:00") });
  let total = 0;
  for (const monthDate of months) {
    const mStart = format(startOfMonth(monthDate), "yyyy-MM-dd");
    const mEnd   = format(endOfMonth(monthDate), "yyyy-MM-dd");
    const wStart = mStart < start ? start : mStart;
    const wEnd   = mEnd > end   ? end   : mEnd;
    // Use the 15th as a stable representative date for FTE lookup
    const repDate = format(monthDate, "yyyy-MM") + "-15";
    const fte = getApplicableFte(repDate, history, defaultFte);
    total += fte * countWorkingDays(wStart, wEnd, holidaySet) * 8;
  }
  return total;
}

/** Fetch FTE history for a list of clients, loading only entries that overlap [overallStart, overallEnd]. */
async function fetchFteHistoryForClients(
  clientIds: number[],
  overallStart: string,
  overallEnd: string,
): Promise<Map<number, FteHistoryEntry[]>> {
  if (clientIds.length === 0) return new Map();
  const rows = await db
    .select({
      clientId: clientFteHistoryTable.clientId,
      fteCount: clientFteHistoryTable.fteCount,
      effectiveFrom: clientFteHistoryTable.effectiveFrom,
      effectiveTo: clientFteHistoryTable.effectiveTo,
    })
    .from(clientFteHistoryTable)
    .where(
      and(
        inArray(clientFteHistoryTable.clientId, clientIds),
        lte(clientFteHistoryTable.effectiveFrom, overallEnd),
        or(isNull(clientFteHistoryTable.effectiveTo), gte(clientFteHistoryTable.effectiveTo, overallStart)),
      ),
    )
    .orderBy(clientFteHistoryTable.clientId, clientFteHistoryTable.effectiveFrom);

  const map = new Map<number, FteHistoryEntry[]>();
  for (const r of rows) {
    if (!map.has(r.clientId)) map.set(r.clientId, []);
    map.get(r.clientId)!.push({ fteCount: r.fteCount, effectiveFrom: r.effectiveFrom, effectiveTo: r.effectiveTo });
  }
  return map;
}

function buildPeriodStats(billable: number, contracted: number) {
  return {
    billableHours: billable,
    contractedHours: contracted,
    // Contract utilisation: measured against what the client engaged, not
    // against staff capacity.
    contractUtilization: percent(billable, contracted),
    utilization: percent(billable, contracted),
  };
}

// ─── Auth middleware (all roles) ───────────────────────────────────────────────

router.use(async (req, res, next) => {
  const userId = principal(req).id;
  const [user] = await db.select({ role: usersTable.role }).from(usersTable).where(eq(usersTable.id, userId));
  if (!user) { res.status(403).json({ error: "User not found" }); return; }
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
// Returns:
//   - clientSummary: per-client utilization table (4 time windows) — always
//   - monthlySummary: monthly chart for selected client — when clientId given

router.get("/client-report", async (req, res): Promise<void> => {
  const currentRole = (req as any)._reporterRole as string;
  const currentUserId = (req as any)._reporterUserId as number;

  const { startDate, endDate, clientId: rawClientId } = req.query as Record<string, string | undefined>;
  const focusClientId = rawClientId ? parseInt(rawClientId, 10) : null;
  const { start, end } = resolveRange(startDate, endDate);

  const { scopedUserIds, scopedClientIds } = await resolveScope(currentUserId, currentRole);

  if (scopedUserIds !== null && scopedUserIds.length === 0) {
    res.json({ clientSummary: [], monthlySummary: null });
    return;
  }

  // Determine visible clients
  const now = new Date();
  const visibleClientIds = scopedClientIds;

  if (visibleClientIds !== null && visibleClientIds.length === 0) {
    res.json({ clientSummary: [], monthlySummary: null });
    return;
  }

  // Fetch client metadata (name, fteCount) for all visible clients
  const clientRows =
    visibleClientIds === null
      ? await db.select({ id: clientsTable.id, name: clientsTable.name, fteCount: clientsTable.fteCount }).from(clientsTable).orderBy(clientsTable.name)
      : await db.select({ id: clientsTable.id, name: clientsTable.name, fteCount: clientsTable.fteCount }).from(clientsTable).where(inArray(clientsTable.id, visibleClientIds)).orderBy(clientsTable.name);

  if (clientRows.length === 0) {
    res.json({ clientSummary: [], monthlySummary: null });
    return;
  }

  const allClientIds = clientRows.map((c) => c.id);

  // Time windows
  const last3mStart = format(startOfMonth(subMonths(now, 3)), "yyyy-MM-dd");
  const last3mEnd   = format(endOfMonth(subMonths(now, 1)), "yyyy-MM-dd");
  const last6mStart = format(startOfMonth(subMonths(now, 6)), "yyyy-MM-dd");
  const last6mEnd   = last3mEnd;
  const last12mStart = format(startOfMonth(subMonths(now, 12)), "yyyy-MM-dd");
  const last12mEnd   = last3mEnd;

  // Fetch all holidays covering the maximum needed window
  const overallStart = [start, last12mStart].sort()[0];
  const overallEnd   = [end, last3mEnd].sort().reverse()[0];
  const holidaySet = await fetchHolidaySet(overallStart, overallEnd);

  // Fetch FTE history for all visible clients (covering the widest possible window)
  const fteHistoryMap = await fetchFteHistoryForClients(allClientIds, overallStart, overallEnd);

  // Billable hours per client per window (4 parallel queries)
  const [billableSelected, billable3m, billable6m, billable12m] = await Promise.all([
    getBillablePerClient(allClientIds, scopedUserIds, start, end),
    getBillablePerClient(allClientIds, scopedUserIds, last3mStart, last3mEnd),
    getBillablePerClient(allClientIds, scopedUserIds, last6mStart, last6mEnd),
    getBillablePerClient(allClientIds, scopedUserIds, last12mStart, last12mEnd),
  ]);

  const clientSummary = clientRows.map((c) => {
    const history = fteHistoryMap.get(c.id) ?? [];
    const cSelected = calcContractedHours(start,       end,        holidaySet, history, c.fteCount);
    const c3m       = calcContractedHours(last3mStart, last3mEnd,  holidaySet, history, c.fteCount);
    const c6m       = calcContractedHours(last6mStart, last6mEnd,  holidaySet, history, c.fteCount);
    const c12m      = calcContractedHours(last12mStart, last12mEnd, holidaySet, history, c.fteCount);
    return {
      clientId: c.id,
      clientName: c.name,
      fteCount: c.fteCount,
      selectedRange: buildPeriodStats(billableSelected.get(c.id) ?? 0, cSelected),
      last3m:  buildPeriodStats(billable3m.get(c.id)  ?? 0, c3m),
      last6m:  buildPeriodStats(billable6m.get(c.id)  ?? 0, c6m),
      last12m: buildPeriodStats(billable12m.get(c.id) ?? 0, c12m),
    };
  });

  // Monthly chart — only when a specific client is requested
  let monthlySummary: object[] | null = null;

  if (focusClientId) {
    // Verify access
    if (visibleClientIds !== null && !visibleClientIds.includes(focusClientId)) {
      res.status(403).json({ error: "Access to this client is not permitted" });
      return;
    }
    const focusClient = clientRows.find((c) => c.id === focusClientId);
    if (!focusClient) { res.json({ clientSummary, monthlySummary: [] }); return; }

    // Fetch billable hours by month for this client (via project join)
    const clientProjects = await db.select({ id: projectsTable.id }).from(projectsTable).where(eq(projectsTable.clientId, focusClientId));
    const projectIds = clientProjects.map((p) => p.id);

    // Build month→billableHours map (stays empty if client has no projects or no entries)
    const billableByMonth = new Map<string, number>();

    if (projectIds.length > 0) {
      const entryConds: Parameters<typeof and>[0][] = [
        gte(timeEntriesTable.date, start),
        lte(timeEntriesTable.date, end),
        inArray(timeEntriesTable.projectId, projectIds) as any,
      ];
      if (scopedUserIds !== null && scopedUserIds.length > 0) {
        entryConds.push(inArray(timeEntriesTable.userId, scopedUserIds) as any);
      }

      // Use a string literal for the TO_CHAR expression so SELECT and GROUP BY
      // generate byte-for-byte identical SQL (avoiding Drizzle's context-dependent
      // table-prefix behaviour which makes PostgreSQL reject the GROUP BY).
      const monthExpr = sql<string>`TO_CHAR("time_entries"."date", 'YYYY-MM')`;

      const monthlyRows = await db
        .select({
          month: monthExpr,
          billableHours: sql<number>`SUM(COALESCE("time_entries"."billable_hours", "time_entries"."hours"))`,
        })
        .from(timeEntriesTable)
        .where(and(...entryConds))
        .groupBy(monthExpr)
        .orderBy(monthExpr);

      for (const r of monthlyRows) billableByMonth.set(r.month, Number(r.billableHours));
    }

    // Always generate the full monthly skeleton so the chart shows contracted-hours
    // capacity even when billable hours are zero (no projects or no logged entries).
    const focusHistory = fteHistoryMap.get(focusClientId) ?? [];
    const months = eachMonthOfInterval({ start: new Date(start + "T12:00:00"), end: new Date(end + "T12:00:00") });
    monthlySummary = months.map((monthDate) => {
      const monthStr = format(monthDate, "yyyy-MM");
      const mStart = format(startOfMonth(monthDate), "yyyy-MM-dd");
      const mEnd   = format(endOfMonth(monthDate), "yyyy-MM-dd");
      // Cap to the requested range
      const wStart = mStart < start ? start : mStart;
      const wEnd   = mEnd > end ? end : mEnd;
      // Use per-month FTE from history (15th as representative date)
      const repDate = monthStr + "-15";
      const fte = getApplicableFte(repDate, focusHistory, focusClient.fteCount);
      const wd = countWorkingDays(wStart, wEnd, holidaySet);
      const contracted = fte * wd * HOURS_PER_DAY;
      const billable = billableByMonth.get(monthStr) ?? 0;
      return {
        month: monthStr,
        billableHours: billable,
        contractedHours: contracted,
        contractUtilization: percent(billable, contracted),
        utilization: percent(billable, contracted),
      };
    });
  }

  res.json({ clientSummary, monthlySummary });
});

// ─── GET /team-report ─────────────────────────────────────────────────────────
// Hours by User → Client → Project → Task

router.get("/team-report", async (req, res): Promise<void> => {
  const currentRole = (req as any)._reporterRole as string;
  const currentUserId = (req as any)._reporterUserId as number;

  const { startDate, endDate, userIds: rawUserIds, clientIds: rawClientIds } =
    req.query as Record<string, string | string[] | undefined>;

  const { start, end } = resolveRange(startDate as string | undefined, endDate as string | undefined);
  const filterUserIds   = parseIds(rawUserIds as string | undefined);
  const filterClientIds = parseIds(rawClientIds as string | undefined);

  const { scopedUserIds, scopedClientIds } = await resolveScope(currentUserId, currentRole);

  const effectiveUserIds   = intersect(scopedUserIds, filterUserIds);
  const effectiveClientIds = intersect(scopedClientIds, filterClientIds);

  if (effectiveUserIds !== null && effectiveUserIds.length === 0) { res.json([]); return; }
  if (effectiveClientIds !== null && effectiveClientIds.length === 0) { res.json([]); return; }

  let effectiveProjectIds: number[] | null = null;
  if (effectiveClientIds !== null) {
    const projRows = await db.select({ id: projectsTable.id }).from(projectsTable).where(inArray(projectsTable.clientId, effectiveClientIds));
    if (projRows.length === 0) { res.json([]); return; }
    effectiveProjectIds = projRows.map((r) => r.id);
  }

  const conds: Parameters<typeof and>[0][] = [
    gte(timeEntriesTable.date, start),
    lte(timeEntriesTable.date, end),
  ];
  if (effectiveUserIds)    conds.push(inArray(timeEntriesTable.userId,    effectiveUserIds) as any);
  if (effectiveProjectIds) conds.push(inArray(timeEntriesTable.projectId, effectiveProjectIds) as any);

  const rows = await db
    .select({
      userId:    usersTable.id,
      userName:  usersTable.name,
      userRole:  usersTable.role,
      clientId:  clientsTable.id,
      clientName: clientsTable.name,
      projectId:  projectsTable.id,
      projectName: projectsTable.name,
      taskId:    tasksTable.id,
      taskName:  tasksTable.name,
      totalHours:   sql<number>`SUM(${timeEntriesTable.hours})`,
      billableHours: sql<number>`SUM(COALESCE(${timeEntriesTable.billableHours}, ${timeEntriesTable.hours}))`,
    })
    .from(timeEntriesTable)
    .innerJoin(usersTable,    eq(usersTable.id,    timeEntriesTable.userId))
    .innerJoin(projectsTable, eq(projectsTable.id, timeEntriesTable.projectId))
    .innerJoin(clientsTable,  eq(clientsTable.id,  projectsTable.clientId))
    .innerJoin(tasksTable,    eq(tasksTable.id,    timeEntriesTable.taskId))
    .where(and(...conds))
    .groupBy(
      usersTable.id, usersTable.name, usersTable.role,
      clientsTable.id, clientsTable.name,
      projectsTable.id, projectsTable.name,
      tasksTable.id, tasksTable.name,
    )
    .orderBy(usersTable.name, clientsTable.name, projectsTable.name, tasksTable.name);

  res.json(rows.map((r) => {
    const total   = Number(r.totalHours);
    const billable = Number(r.billableHours);
    return {
      userId: r.userId, userName: r.userName, userRole: r.userRole,
      clientId: r.clientId, clientName: r.clientName,
      projectId: r.projectId, projectName: r.projectName,
      taskId: r.taskId, taskName: r.taskName,
      totalHours: total,
      billableHours: billable,
      nonBillableHours: total - billable,
      efficiency: percent(billable, total),
    };
  }));
});

// ─── GET /my-report ───────────────────────────────────────────────────────────

router.get("/my-report", async (req, res): Promise<void> => {
  const currentUserId = (req as any)._reporterUserId as number;
  const { startDate, endDate } = req.query as Record<string, string | undefined>;
  const { start, end } = resolveRange(startDate, endDate);

  const [rows, holidaySet] = await Promise.all([
    db
      .select({
        clientId:   clientsTable.id,
        clientName: clientsTable.name,
        projectId:  projectsTable.id,
        projectName: projectsTable.name,
        taskId:   tasksTable.id,
        taskName: tasksTable.name,
        totalHours:   sql<number>`SUM(${timeEntriesTable.hours})`,
        billableHours: sql<number>`SUM(COALESCE(${timeEntriesTable.billableHours}, ${timeEntriesTable.hours}))`,
      })
      .from(timeEntriesTable)
      .innerJoin(projectsTable, eq(projectsTable.id, timeEntriesTable.projectId))
      .innerJoin(clientsTable,  eq(clientsTable.id,  projectsTable.clientId))
      .innerJoin(tasksTable,    eq(tasksTable.id,    timeEntriesTable.taskId))
      .where(and(eq(timeEntriesTable.userId, currentUserId), gte(timeEntriesTable.date, start), lte(timeEntriesTable.date, end)))
      .groupBy(clientsTable.id, clientsTable.name, projectsTable.id, projectsTable.name, tasksTable.id, tasksTable.name)
      .orderBy(clientsTable.name, projectsTable.name, tasksTable.name),
    fetchHolidaySet(start, end),
  ]);

  const leaveRows = await db.select({ date: leavesTable.date }).from(leavesTable)
    .where(and(eq(leavesTable.userId, currentUserId), gte(leavesTable.date, start), lte(leavesTable.date, end)));

  const workingDays = countWorkingDays(start, end, holidaySet);
  const leaveDays = leaveRows.filter((l) => { const d = new Date(l.date).getDay(); return d > 0 && d < 6 && !holidaySet.has(l.date); }).length;
  const availableDays = Math.max(workingDays - leaveDays, 0);
  const targetHours = availableDays * 8;

  const entries = rows.map((r) => ({
    clientId: r.clientId, clientName: r.clientName,
    projectId: r.projectId, projectName: r.projectName,
    taskId: r.taskId, taskName: r.taskName,
    totalHours: Number(r.totalHours),
    billableHours: Number(r.billableHours),
    nonBillableHours: Number(r.totalHours) - Number(r.billableHours),
  }));

  const totalHours   = entries.reduce((s, e) => s + e.totalHours, 0);
  const billableHours = entries.reduce((s, e) => s + e.billableHours, 0);

  const measures = productivity({
    totalHours,
    billableHours,
    availableWorkingDays: availableDays,
  });

  res.json({
    entries,
    summary: {
      workingDays, leaveDays, availableDays, targetHours, totalHours, billableHours,
      nonBillableHours: totalHours - billableHours,
      recordedUtilization: measures.recordedUtilization,
      billableUtilization: measures.billableUtilization,
      efficiency: measures.efficiency,
      utilization: measures.billableUtilization,
    },
  });
});

export default router;
