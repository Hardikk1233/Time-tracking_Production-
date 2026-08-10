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
} from "@workspace/db";

const router: IRouter = Router();

// ─── Shared helpers ───────────────────────────────────────────────────────────

async function fetchHolidaySet(startDate: string, endDate: string): Promise<Set<string>> {
  const rows = await db
    .select({ date: publicHolidaysTable.date })
    .from(publicHolidaysTable)
    .where(and(gte(publicHolidaysTable.date, startDate), lte(publicHolidaysTable.date, endDate)));
  return new Set(rows.map((r) => r.date));
}

function countWorkingDaysEffective(
  startDate: string,
  endDate: string,
  holidaySet: Set<string>,
): number {
  const start = new Date(startDate);
  const end = new Date(endDate);
  let count = 0;
  const cur = new Date(start);
  while (cur <= end) {
    const d = cur.getDay();
    const dateStr = format(cur, "yyyy-MM-dd");
    if (d > 0 && d < 6 && !holidaySet.has(dateStr)) count++;
    cur.setDate(cur.getDate() + 1);
  }
  return count;
}

/** Resolve start/end to current-month defaults when not supplied. */
function resolveRange(startDate?: string, endDate?: string): { start: string; end: string } {
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

  // Include the AVP themselves
  return [avpId, ...directIds, ...indirectIds];
}

/** Returns all clientIds the AVP is directly assigned to. */
async function getAvpClientIds(avpId: number): Promise<number[]> {
  const rows = await db
    .selectDistinct({ clientId: clientUsersTable.clientId })
    .from(clientUsersTable)
    .where(eq(clientUsersTable.userId, avpId));
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
 * null scopedIds = MD (unrestricted) — just apply filterIds.
 * null filterIds = no filter — use scope as-is.
 * [] scopedIds = AVP with no access — return [].
 */
function intersect(
  scopedIds: number[] | null,
  filterIds: number[] | null,
): number[] | null {
  if (scopedIds === null) return filterIds; // MD: no scope restriction
  if (filterIds === null) return scopedIds; // no filter: use scope
  const set = new Set(filterIds);
  return scopedIds.filter((id) => set.has(id));
}

/** Shared scope resolution for the current user. */
async function resolveScope(
  currentUserId: number,
  currentRole: string,
): Promise<{
  scopedUserIds: number[] | null;
  scopedClientIds: number[] | null;
}> {
  if (currentRole === "md") {
    return { scopedUserIds: null, scopedClientIds: null };
  }
  // AVP
  const [subIds, avpClientIds] = await Promise.all([
    getSubordinateUserIds(currentUserId),
    getAvpClientIds(currentUserId),
  ]);
  return { scopedUserIds: subIds, scopedClientIds: avpClientIds };
}

// ─── Auth middleware: attach role to request ──────────────────────────────────

router.use("/reports", async (req, res, next) => {
  const userId = req.session.userId!;
  const [user] = await db
    .select({ role: usersTable.role })
    .from(usersTable)
    .where(eq(usersTable.id, userId));

  if (!user || !["avp", "md"].includes(user.role)) {
    res.status(403).json({ error: "Access restricted to AVP and MD" });
    return;
  }
  (req as any)._reporterRole = user.role;
  (req as any)._reporterUserId = userId;
  next();
});

// ─── GET /reports/filter-options ─────────────────────────────────────────────
// Returns scoped users, clients, and projects the current user may filter by.

router.get("/reports/filter-options", async (req, res): Promise<void> => {
  const currentRole = (req as any)._reporterRole as string;
  const currentUserId = (req as any)._reporterUserId as number;

  const { scopedUserIds, scopedClientIds } = await resolveScope(currentUserId, currentRole);

  // Users
  const usersQuery = db
    .select({ id: usersTable.id, name: usersTable.name, role: usersTable.role })
    .from(usersTable)
    .$dynamic();
  const usersResult =
    scopedUserIds === null
      ? await usersQuery.orderBy(usersTable.name)
      : scopedUserIds.length === 0
      ? []
      : await usersQuery
          .where(inArray(usersTable.id, scopedUserIds))
          .orderBy(usersTable.name);

  // Clients
  const clientsQuery = db
    .select({ id: clientsTable.id, name: clientsTable.name })
    .from(clientsTable)
    .$dynamic();
  const clientsResult =
    scopedClientIds === null
      ? await clientsQuery.orderBy(clientsTable.name)
      : scopedClientIds.length === 0
      ? []
      : await clientsQuery
          .where(inArray(clientsTable.id, scopedClientIds))
          .orderBy(clientsTable.name);

  // Projects scoped to visible clients
  let projectsResult: { id: number; name: string; clientId: number }[] = [];
  if (scopedClientIds === null) {
    projectsResult = await db
      .select({ id: projectsTable.id, name: projectsTable.name, clientId: projectsTable.clientId })
      .from(projectsTable)
      .orderBy(projectsTable.name);
  } else if (scopedClientIds.length > 0) {
    projectsResult = await db
      .select({ id: projectsTable.id, name: projectsTable.name, clientId: projectsTable.clientId })
      .from(projectsTable)
      .where(inArray(projectsTable.clientId, scopedClientIds))
      .orderBy(projectsTable.name);
  }

  res.json({
    users: usersResult,
    clients: clientsResult,
    projects: projectsResult,
  });
});

// ─── GET /reports/utilization ─────────────────────────────────────────────────

router.get("/reports/utilization", async (req, res): Promise<void> => {
  const currentRole = (req as any)._reporterRole as string;
  const currentUserId = (req as any)._reporterUserId as number;

  const {
    startDate,
    endDate,
    userIds: rawUserIds,
    clientIds: rawClientIds,
    projectIds: rawProjectIds,
    roles: rawRoles,
  } = req.query as Record<string, string | string[] | undefined>;

  const { start: resolvedStart, end: resolvedEnd } = resolveRange(
    startDate as string | undefined,
    endDate as string | undefined,
  );

  const filterUserIds = parseIds(rawUserIds as string | undefined);
  const filterClientIds = parseIds(rawClientIds as string | undefined);
  const filterProjectIds = parseIds(rawProjectIds as string | undefined);
  const filterRoles =
    rawRoles
      ? (Array.isArray(rawRoles) ? rawRoles : (rawRoles as string).split(",")).filter(Boolean)
      : null;

  const { scopedUserIds, scopedClientIds } = await resolveScope(currentUserId, currentRole);

  const effectiveUserIds = intersect(scopedUserIds, filterUserIds);
  const effectiveClientIds = intersect(scopedClientIds, filterClientIds);

  // Short-circuit: empty scope = no data
  if (effectiveUserIds !== null && effectiveUserIds.length === 0) {
    res.json([]);
    return;
  }
  if (effectiveClientIds !== null && effectiveClientIds.length === 0) {
    res.json([]);
    return;
  }

  // Resolve project filter (client scope → project IDs to join against)
  let effectiveProjectIds: number[] | null = filterProjectIds;
  if (effectiveClientIds !== null) {
    const projRows = await db
      .select({ id: projectsTable.id })
      .from(projectsTable)
      .where(inArray(projectsTable.clientId, effectiveClientIds));
    const clientProjectIds = projRows.map((r) => r.id);
    if (clientProjectIds.length === 0) {
      res.json([]);
      return;
    }
    // Intersect with explicit project filter
    effectiveProjectIds =
      filterProjectIds
        ? filterProjectIds.filter((id) => clientProjectIds.includes(id))
        : clientProjectIds;
    if (effectiveProjectIds.length === 0) {
      res.json([]);
      return;
    }
  }

  // Always apply resolved date range to entries
  const entryConds: Parameters<typeof and>[0][] = [
    gte(timeEntriesTable.date, resolvedStart),
    lte(timeEntriesTable.date, resolvedEnd),
  ];
  if (effectiveProjectIds) {
    entryConds.push(inArray(timeEntriesTable.projectId, effectiveProjectIds) as any);
  }
  const entryWhere = and(...entryConds);

  // User WHERE
  const userConds: Parameters<typeof and>[0][] = [];
  if (effectiveUserIds) {
    userConds.push(inArray(usersTable.id, effectiveUserIds) as any);
  }
  if (filterRoles && filterRoles.length > 0) {
    userConds.push(inArray(usersTable.role, filterRoles as any[]) as any);
  }

  const [rows, holidaySet] = await Promise.all([
    db
      .select({
        userId: usersTable.id,
        userName: usersTable.name,
        role: usersTable.role,
        totalHours: sql<number>`COALESCE(SUM(${timeEntriesTable.hours}), 0)`,
        billableHours: sql<number>`COALESCE(SUM(COALESCE(${timeEntriesTable.billableHours}, 0)), 0)`,
      })
      .from(usersTable)
      .leftJoin(
        timeEntriesTable,
        and(eq(timeEntriesTable.userId, usersTable.id), entryWhere),
      )
      .where(userConds.length > 0 ? and(...userConds) : undefined)
      .groupBy(usersTable.id, usersTable.name, usersTable.role)
      .orderBy(usersTable.name),
    fetchHolidaySet(resolvedStart, resolvedEnd),
  ]);

  const baseWorkingDays = countWorkingDaysEffective(resolvedStart, resolvedEnd, holidaySet);

  const visibleUserIds = rows.map((r) => r.userId);
  let leavesByUser: Record<number, number> = {};
  if (visibleUserIds.length > 0) {
    const leaveRows = await db
      .select({ userId: leavesTable.userId, date: leavesTable.date })
      .from(leavesTable)
      .where(
        and(
          inArray(leavesTable.userId, visibleUserIds),
          gte(leavesTable.date, resolvedStart),
          lte(leavesTable.date, resolvedEnd),
        ),
      );
    leavesByUser = leaveRows.reduce<Record<number, number>>((acc, l) => {
      const d = new Date(l.date).getDay();
      if (d > 0 && d < 6 && !holidaySet.has(l.date)) {
        acc[l.userId] = (acc[l.userId] ?? 0) + 1;
      }
      return acc;
    }, {});
  }

  res.json(
    rows.map((r) => {
      const leaveDays = leavesByUser[r.userId] ?? 0;
      const availableDays = Math.max(baseWorkingDays - leaveDays, 0);
      const targetHours = availableDays * 8;
      const hoursLogged = Number(r.totalHours);
      const billableHours = Number(r.billableHours);
      return {
        userId: r.userId,
        userName: r.userName,
        role: r.role,
        workingDays: baseWorkingDays,
        leaveDays,
        availableDays,
        hoursLogged,
        billableHours,
        targetHours,
        utilization:
          targetHours > 0 ? Math.round((billableHours / targetHours) * 1000) / 10 : 0,
      };
    }),
  );
});

// ─── GET /reports/efficiency ──────────────────────────────────────────────────

router.get("/reports/efficiency", async (req, res): Promise<void> => {
  const currentRole = (req as any)._reporterRole as string;
  const currentUserId = (req as any)._reporterUserId as number;

  const {
    startDate,
    endDate,
    userIds: rawUserIds,
    clientIds: rawClientIds,
    projectIds: rawProjectIds,
    roles: rawRoles,
  } = req.query as Record<string, string | string[] | undefined>;

  const { start: resolvedStart, end: resolvedEnd } = resolveRange(
    startDate as string | undefined,
    endDate as string | undefined,
  );

  const filterUserIds = parseIds(rawUserIds as string | undefined);
  const filterClientIds = parseIds(rawClientIds as string | undefined);
  const filterProjectIds = parseIds(rawProjectIds as string | undefined);
  const filterRoles =
    rawRoles
      ? (Array.isArray(rawRoles) ? rawRoles : (rawRoles as string).split(",")).filter(Boolean)
      : null;

  const { scopedUserIds, scopedClientIds } = await resolveScope(currentUserId, currentRole);

  const effectiveUserIds = intersect(scopedUserIds, filterUserIds);
  const effectiveClientIds = intersect(scopedClientIds, filterClientIds);

  if (effectiveUserIds !== null && effectiveUserIds.length === 0) {
    res.json([]);
    return;
  }
  if (effectiveClientIds !== null && effectiveClientIds.length === 0) {
    res.json([]);
    return;
  }

  let effectiveProjectIds: number[] | null = filterProjectIds;
  if (effectiveClientIds !== null) {
    const projRows = await db
      .select({ id: projectsTable.id })
      .from(projectsTable)
      .where(inArray(projectsTable.clientId, effectiveClientIds));
    const clientProjectIds = projRows.map((r) => r.id);
    if (clientProjectIds.length === 0) {
      res.json([]);
      return;
    }
    effectiveProjectIds =
      filterProjectIds
        ? filterProjectIds.filter((id) => clientProjectIds.includes(id))
        : clientProjectIds;
    if (effectiveProjectIds.length === 0) {
      res.json([]);
      return;
    }
  }

  const entryConds: Parameters<typeof and>[0][] = [
    gte(timeEntriesTable.date, resolvedStart),
    lte(timeEntriesTable.date, resolvedEnd),
  ];
  if (effectiveProjectIds) {
    entryConds.push(inArray(timeEntriesTable.projectId, effectiveProjectIds) as any);
  }
  const entryWhere = and(...entryConds);

  const userConds: Parameters<typeof and>[0][] = [];
  if (effectiveUserIds) {
    userConds.push(inArray(usersTable.id, effectiveUserIds) as any);
  }
  if (filterRoles && filterRoles.length > 0) {
    userConds.push(inArray(usersTable.role, filterRoles as any[]) as any);
  }

  const rows = await db
    .select({
      userId: usersTable.id,
      userName: usersTable.name,
      role: usersTable.role,
      totalHours: sql<number>`COALESCE(SUM(${timeEntriesTable.hours}), 0)`,
      billableHours: sql<number>`COALESCE(SUM(COALESCE(${timeEntriesTable.billableHours}, 0)), 0)`,
      approvedHours: sql<number>`COALESCE(SUM(CASE WHEN ${timeEntriesTable.status} = 'approved' THEN ${timeEntriesTable.hours} ELSE 0 END), 0)`,
    })
    .from(usersTable)
    .leftJoin(
      timeEntriesTable,
      and(eq(timeEntriesTable.userId, usersTable.id), entryWhere),
    )
    .where(userConds.length > 0 ? and(...userConds) : undefined)
    .groupBy(usersTable.id, usersTable.name, usersTable.role)
    .orderBy(usersTable.name);

  res.json(
    rows.map((r) => {
      const totalHours = Number(r.totalHours);
      const billableHours = Number(r.billableHours);
      const approvedHours = Number(r.approvedHours);
      return {
        userId: r.userId,
        userName: r.userName,
        role: r.role,
        totalHours,
        billableHours,
        nonBillableHours: totalHours - billableHours,
        approvedHours,
        billablePct:
          totalHours > 0 ? Math.round((billableHours / totalHours) * 1000) / 10 : 0,
      };
    }),
  );
});

// ─── GET /reports/client-hours ────────────────────────────────────────────────

router.get("/reports/client-hours", async (req, res): Promise<void> => {
  const currentRole = (req as any)._reporterRole as string;
  const currentUserId = (req as any)._reporterUserId as number;

  const {
    startDate,
    endDate,
    clientIds: rawClientIds,
    projectIds: rawProjectIds,
    userIds: rawUserIds,
  } = req.query as Record<string, string | string[] | undefined>;

  const { start: resolvedStart, end: resolvedEnd } = resolveRange(
    startDate as string | undefined,
    endDate as string | undefined,
  );

  const filterClientIds = parseIds(rawClientIds as string | undefined);
  const filterProjectIds = parseIds(rawProjectIds as string | undefined);
  const filterUserIds = parseIds(rawUserIds as string | undefined);

  const { scopedUserIds, scopedClientIds } = await resolveScope(currentUserId, currentRole);

  const effectiveUserIds = intersect(scopedUserIds, filterUserIds);
  const effectiveClientIds = intersect(scopedClientIds, filterClientIds);

  if (effectiveUserIds !== null && effectiveUserIds.length === 0) {
    res.json([]);
    return;
  }
  if (effectiveClientIds !== null && effectiveClientIds.length === 0) {
    res.json([]);
    return;
  }

  // Always apply resolved date range to entries
  const entryConds: Parameters<typeof and>[0][] = [
    gte(timeEntriesTable.date, resolvedStart),
    lte(timeEntriesTable.date, resolvedEnd),
  ];
  if (effectiveUserIds) {
    entryConds.push(inArray(timeEntriesTable.userId, effectiveUserIds) as any);
  }
  if (filterProjectIds) {
    entryConds.push(inArray(timeEntriesTable.projectId, filterProjectIds) as any);
  }
  const entryWhere = and(...entryConds);

  const clientWhere =
    effectiveClientIds !== null
      ? inArray(clientsTable.id, effectiveClientIds)
      : undefined;

  const rows = await db
    .select({
      clientId: clientsTable.id,
      clientName: clientsTable.name,
      projectId: projectsTable.id,
      projectName: projectsTable.name,
      totalHours: sql<number>`COALESCE(SUM(${timeEntriesTable.hours}), 0)`,
      billableHours: sql<number>`COALESCE(SUM(COALESCE(${timeEntriesTable.billableHours}, 0)), 0)`,
      contributorCount: sql<number>`COUNT(DISTINCT ${timeEntriesTable.userId})`,
    })
    .from(clientsTable)
    .innerJoin(projectsTable, eq(projectsTable.clientId, clientsTable.id))
    .leftJoin(
      timeEntriesTable,
      and(eq(timeEntriesTable.projectId, projectsTable.id), entryWhere),
    )
    .where(clientWhere)
    .groupBy(clientsTable.id, clientsTable.name, projectsTable.id, projectsTable.name)
    .orderBy(clientsTable.name, projectsTable.name);

  res.json(
    rows.map((r) => ({
      clientId: r.clientId,
      clientName: r.clientName,
      projectId: r.projectId,
      projectName: r.projectName,
      totalHours: Number(r.totalHours),
      billableHours: Number(r.billableHours),
      nonBillableHours: Number(r.totalHours) - Number(r.billableHours),
      contributorCount: Number(r.contributorCount),
    })),
  );
});

export default router;
