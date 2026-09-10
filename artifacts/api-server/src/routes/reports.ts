import { Router, type IRouter } from "express";
import { principal, type Principal } from "../middlewares/auth";
import { eq, and, gte, lte, sql, inArray, isNull, or } from "drizzle-orm";
import { format, subMonths, startOfMonth, endOfMonth, eachMonthOfInterval } from "date-fns";
import { productivity, percent, HOURS_PER_DAY } from "../lib/metrics";
import { visibleClientIds, visibleUserIds } from "../lib/scope";
import {
  db,
  timeEntriesTable,
  usersTable,
  projectsTable,
  clientsTable,
  publicHolidaysTable,
  leavesTable,
  clientFteHistoryTable,
  hourBlocksTable,
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

type Scope = { scopedUserIds: number[] | null; scopedClientIds: number[] | null };

/**
 * Who this report may cover. `null` on either field means unrestricted.
 *
 * Delegates to lib/scope, which is the one answer the rest of the app uses.
 * This module used to decide an AVP's team from users.reporting_to_id - the
 * org chart - while every other route reached it through the projects under
 * that AVP's clients. Nothing populates reporting_to_id on Entra sign-in, and
 * the Team page only offers the field when a person is typed in by hand, so
 * for the whole pilot it was null: Team Reports asked who reported to the AVP,
 * got nobody, and showed them their own hours under a team heading.
 *
 * That was the fourth private copy of this question in the codebase. The other
 * three each produced a live bug before being folded into lib/scope.
 */
async function resolveScope(me: Principal): Promise<Scope> {
  const [scopedUserIds, scopedClientIds] = await Promise.all([
    visibleUserIds(me),
    visibleClientIds(me),
  ]);
  return { scopedUserIds, scopedClientIds };
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

/**
 * One period's figures for a client.
 *
 * `contracted` is null when the engagement has no hours commitment to measure
 * against - a product client buys deliverables, not capacity. Reporting 0
 * there would be a lie the UI cannot tell apart from a real zero, and it is
 * what made Galava Capital show 0.0h / 64.0h and 0.0% in red: the FTE formula
 * ran over a client that had never been on FTE terms.
 */
function buildPeriodStats(billable: number, contracted: number | null) {
  return {
    billableHours: billable,
    contractedHours: contracted,
    contractUtilization: contracted === null ? null : percent(billable, contracted),
    utilization: contracted === null ? null : percent(billable, contracted),
  };
}

// ─── Caller still on the roster (all roles) ────────────────────────────────────

// The role and id come off the principal now, so nothing is stashed on the
// request. What remains is the check that the caller still has a row: a token
// stays valid for its lifetime after somebody is removed, and a report is a
// poor thing to keep serving them.
router.use(async (req, res, next) => {
  const [user] = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.id, principal(req).id));
  if (!user) { res.status(403).json({ error: "User not found" }); return; }
  next();
});

// ─── GET /filter-options ──────────────────────────────────────────────────────

router.get("/filter-options", async (req, res): Promise<void> => {
  const { scopedUserIds, scopedClientIds } = await resolveScope(principal(req));

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

  const { startDate, endDate, clientId: rawClientId } = req.query as Record<string, string | undefined>;
  const focusClientId = rawClientId ? parseInt(rawClientId, 10) : null;
  const { start, end } = resolveRange(startDate, endDate);

  const { scopedUserIds, scopedClientIds } = await resolveScope(principal(req));

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
  const clientCols = {
    id: clientsTable.id,
    name: clientsTable.name,
    fteCount: clientsTable.fteCount,
    engagementType: clientsTable.engagementType,
  };
  const clientRows =
    visibleClientIds === null
      ? await db.select(clientCols).from(clientsTable).orderBy(clientsTable.name)
      : await db.select(clientCols).from(clientsTable).where(inArray(clientsTable.id, visibleClientIds)).orderBy(clientsTable.name);

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

  // Hours bought, for the block-hours clients in this set. One query, and
  // skipped entirely when nobody here is on those terms.
  const blockClientIds = clientRows.filter((c) => c.engagementType === "block_hours").map((c) => c.id);
  const purchasedByClient = new Map<number, number>();
  if (blockClientIds.length > 0) {
    const purchased = await db
      .select({
        clientId: hourBlocksTable.clientId,
        hours: sql<number>`SUM(${hourBlocksTable.hours})`,
      })
      .from(hourBlocksTable)
      .where(inArray(hourBlocksTable.clientId, blockClientIds))
      .groupBy(hourBlocksTable.clientId);
    for (const r of purchased) purchasedByClient.set(r.clientId, Number(r.hours));
  }

  // Billable hours per client per window (4 parallel queries)
  const [billableSelected, billable3m, billable6m, billable12m] = await Promise.all([
    getBillablePerClient(allClientIds, scopedUserIds, start, end),
    getBillablePerClient(allClientIds, scopedUserIds, last3mStart, last3mEnd),
    getBillablePerClient(allClientIds, scopedUserIds, last6mStart, last6mEnd),
    getBillablePerClient(allClientIds, scopedUserIds, last12mStart, last12mEnd),
  ]);

  // What each engagement is actually measured against:
  //
  //   fte         - FTEs x working days x 8, from the FTE history. Unchanged.
  //   block_hours - the hours the client has bought. A block is a standing
  //                 balance, not a per-period allowance, so every window is
  //                 measured against the same purchased total.
  //   product     - nothing. The client buys deliverables, so there is no
  //                 hours commitment and no honest utilisation figure.
  const clientSummary = clientRows.map((c) => {
    const history = fteHistoryMap.get(c.id) ?? [];

    const commitment = (from: string, to: string): number | null => {
      if (c.engagementType === "product") return null;
      if (c.engagementType === "block_hours") return purchasedByClient.get(c.id) ?? 0;
      return calcContractedHours(from, to, holidaySet, history, c.fteCount);
    };

    return {
      clientId: c.id,
      clientName: c.name,
      engagementType: c.engagementType,
      // Only meaningful on FTE terms; the UI hides the column for the others.
      fteCount: c.engagementType === "fte" ? c.fteCount : null,
      selectedRange: buildPeriodStats(billableSelected.get(c.id) ?? 0, commitment(start, end)),
      last3m:  buildPeriodStats(billable3m.get(c.id)  ?? 0, commitment(last3mStart, last3mEnd)),
      last6m:  buildPeriodStats(billable6m.get(c.id)  ?? 0, commitment(last6mStart, last6mEnd)),
      last12m: buildPeriodStats(billable12m.get(c.id) ?? 0, commitment(last12mStart, last12mEnd)),
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

      // Use a string literal for the expression so SELECT and GROUP BY
      // generate byte-for-byte identical SQL (avoiding Drizzle's context-dependent
      // table-prefix behaviour which makes PostgreSQL reject the GROUP BY).
      //
      // substr, not TO_CHAR: the date column is text in YYYY-MM-DD form, and
      // to_char(text, unknown) does not exist — every call to this report was
      // answering 500. The first seven characters are the month already.
      const monthExpr = sql<string>`substr("time_entries"."date", 1, 7)`;

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
      // The monthly commitment follows the engagement, as the summary rows do.
      // A product client has none, and a block is a standing balance rather
      // than a monthly allowance, so neither draws a capacity line.
      let contracted: number | null;
      if (focusClient.engagementType === "fte") {
        // Per-month FTE from history, 15th as the representative date.
        const repDate = monthStr + "-15";
        const fte = getApplicableFte(repDate, focusHistory, focusClient.fteCount);
        contracted = fte * countWorkingDays(wStart, wEnd, holidaySet) * HOURS_PER_DAY;
      } else {
        contracted = null;
      }
      const billable = billableByMonth.get(monthStr) ?? 0;
      return {
        month: monthStr,
        billableHours: billable,
        contractedHours: contracted,
        contractUtilization: contracted === null ? null : percent(billable, contracted),
        utilization: contracted === null ? null : percent(billable, contracted),
      };
    });
  }

  res.json({ clientSummary, monthlySummary });
});

// ─── GET /team-report ─────────────────────────────────────────────────────────
// Hours by User → Client → Project → Task

router.get("/team-report", async (req, res): Promise<void> => {

  const { startDate, endDate, userIds: rawUserIds, clientIds: rawClientIds } =
    req.query as Record<string, string | string[] | undefined>;

  const { start, end } = resolveRange(startDate as string | undefined, endDate as string | undefined);
  const filterUserIds   = parseIds(rawUserIds as string | undefined);
  const filterClientIds = parseIds(rawClientIds as string | undefined);

  const { scopedUserIds, scopedClientIds } = await resolveScope(principal(req));

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
  const currentUserId = principal(req).id;
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

  const leaveRows = await db.select({ date: leavesTable.date, portion: leavesTable.portion }).from(leavesTable)
    .where(and(eq(leavesTable.userId, currentUserId), gte(leavesTable.date, start), lte(leavesTable.date, end)));

  const workingDays = countWorkingDays(start, end, holidaySet);
  // Summed over `portion`, so a half day leaves half a day of target standing.
  const leaveDays = leaveRows.reduce((sum, l) => {
    const d = new Date(l.date).getDay();
    return d > 0 && d < 6 && !holidaySet.has(l.date) ? sum + l.portion : sum;
  }, 0);
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
