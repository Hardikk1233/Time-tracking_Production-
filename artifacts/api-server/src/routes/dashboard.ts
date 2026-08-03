import { Router, type IRouter } from "express";
import { eq, gte, lte, sql, and } from "drizzle-orm";
import { format, getISOWeek } from "date-fns";
import {
  db,
  timeEntriesTable,
  usersTable,
  tasksTable,
  projectsTable,
  clientsTable,
} from "@workspace/db";

const router: IRouter = Router();

// ─── Working days calculation ─────────────────────────────────────────────────

function countWorkingDays(startDate?: string, endDate?: string): number {
  const now = new Date();
  const start = startDate
    ? new Date(startDate)
    : new Date(now.getFullYear(), now.getMonth(), 1);
  const end = endDate
    ? new Date(endDate)
    : new Date(now.getFullYear(), now.getMonth() + 1, 0);

  let count = 0;
  const cur = new Date(start);
  while (cur <= end) {
    const d = cur.getDay();
    if (d > 0 && d < 6) count++;
    cur.setDate(cur.getDate() + 1);
  }
  return Math.max(count, 1); // avoid divide-by-zero
}

// ─── Summary (always scoped to the current user) ─────────────────────────────

router.get("/dashboard/summary", async (req, res): Promise<void> => {
  const currentUserId = req.session.userId!;
  const { startDate, endDate } = req.query as {
    startDate?: string;
    endDate?: string;
  };

  const conditions = [eq(timeEntriesTable.userId, currentUserId)];
  if (startDate) conditions.push(gte(timeEntriesTable.date, startDate));
  if (endDate) conditions.push(lte(timeEntriesTable.date, endDate));

  const [result] = await db
    .select({
      totalHours: sql<number>`COALESCE(SUM(${timeEntriesTable.hours}), 0)`,
      billableHours: sql<number>`COALESCE(SUM(COALESCE(${timeEntriesTable.billableHours}, 0)), 0)`,
      nonBillableHours: sql<number>`COALESCE(SUM(${timeEntriesTable.hours} - COALESCE(${timeEntriesTable.billableHours}, 0)), 0)`,
      pendingApprovalCount: sql<number>`COUNT(CASE WHEN ${timeEntriesTable.status} = 'pending' THEN 1 END)`,
      approvedHours: sql<number>`COALESCE(SUM(CASE WHEN ${timeEntriesTable.status} = 'approved' THEN ${timeEntriesTable.hours} ELSE 0 END), 0)`,
    })
    .from(timeEntriesTable)
    .where(and(...conditions));

  res.json({
    totalHours: Number(result?.totalHours ?? 0),
    billableHours: Number(result?.billableHours ?? 0),
    nonBillableHours: Number(result?.nonBillableHours ?? 0),
    pendingApprovalCount: Number(result?.pendingApprovalCount ?? 0),
    approvedHours: Number(result?.approvedHours ?? 0),
  });
});

// ─── Client hours (aggregate per-client totals, kept for compatibility) ───────

router.get("/dashboard/client-hours", async (req, res): Promise<void> => {
  const { startDate, endDate } = req.query as {
    startDate?: string;
    endDate?: string;
  };

  const entryConditions = [];
  if (startDate) entryConditions.push(gte(timeEntriesTable.date, startDate));
  if (endDate) entryConditions.push(lte(timeEntriesTable.date, endDate));
  const entryWhere =
    entryConditions.length > 0 ? and(...entryConditions) : undefined;

  const rows = await db
    .select({
      clientId: clientsTable.id,
      clientName: clientsTable.name,
      totalHours: sql<number>`COALESCE(SUM(${timeEntriesTable.hours}), 0)`,
      billableHours: sql<number>`COALESCE(SUM(COALESCE(${timeEntriesTable.billableHours}, 0)), 0)`,
      nonBillableHours: sql<number>`COALESCE(SUM(${timeEntriesTable.hours} - COALESCE(${timeEntriesTable.billableHours}, 0)), 0)`,
    })
    .from(clientsTable)
    .leftJoin(projectsTable, eq(projectsTable.clientId, clientsTable.id))
    .leftJoin(tasksTable, eq(tasksTable.projectId, projectsTable.id))
    .leftJoin(
      timeEntriesTable,
      and(eq(timeEntriesTable.taskId, tasksTable.id), entryWhere),
    )
    .groupBy(clientsTable.id, clientsTable.name)
    .orderBy(sql`COALESCE(SUM(${timeEntriesTable.hours}), 0) DESC`);

  res.json(
    rows.map((r) => ({
      clientId: r.clientId,
      clientName: r.clientName,
      totalHours: Number(r.totalHours),
      billableHours: Number(r.billableHours),
      nonBillableHours: Number(r.nonBillableHours),
    })),
  );
});

// ─── Client hours trend (per-week or per-month for a specific client) ─────────

router.get("/dashboard/client-hours-trend", async (req, res): Promise<void> => {
  const { clientId, startDate, endDate, granularity = "month" } = req.query as {
    clientId?: string;
    startDate?: string;
    endDate?: string;
    granularity?: "week" | "month";
  };

  if (!clientId) {
    res.status(400).json({ error: "clientId is required" });
    return;
  }

  const clientIdNum = parseInt(clientId, 10);
  if (isNaN(clientIdNum)) {
    res.status(400).json({ error: "Invalid clientId" });
    return;
  }

  // date_trunc unit must be a SQL literal, not a parameter — build the expression directly
  const periodExpr =
    granularity === "week"
      ? sql`date_trunc('week', ${timeEntriesTable.date}::timestamp)`
      : sql`date_trunc('month', ${timeEntriesTable.date}::timestamp)`;

  const conditions = [eq(clientsTable.id, clientIdNum)];
  if (startDate) conditions.push(gte(timeEntriesTable.date, startDate));
  if (endDate) conditions.push(lte(timeEntriesTable.date, endDate));

  const rows = await db
    .select({
      periodStart: periodExpr,
      billableHours: sql<number>`COALESCE(SUM(COALESCE(${timeEntriesTable.billableHours}, 0)), 0)`,
      nonBillableHours: sql<number>`COALESCE(SUM(${timeEntriesTable.hours} - COALESCE(${timeEntriesTable.billableHours}, 0)), 0)`,
      totalHours: sql<number>`COALESCE(SUM(${timeEntriesTable.hours}), 0)`,
    })
    .from(timeEntriesTable)
    .innerJoin(tasksTable, eq(timeEntriesTable.taskId, tasksTable.id))
    .innerJoin(projectsTable, eq(tasksTable.projectId, projectsTable.id))
    .innerJoin(clientsTable, eq(projectsTable.clientId, clientsTable.id))
    .where(and(...conditions))
    .groupBy(periodExpr)
    .orderBy(periodExpr);

  const result = rows.map((r) => {
    const periodDate = new Date(r.periodStart as unknown as string);

    let periodStart = new Date(periodDate);
    let periodEnd: Date;

    if (granularity === "week") {
      // date_trunc('week') returns the Monday of the week
      periodEnd = new Date(periodDate);
      periodEnd.setDate(periodEnd.getDate() + 6);
    } else {
      periodEnd = new Date(
        periodDate.getFullYear(),
        periodDate.getMonth() + 1,
        0,
      );
    }

    // Clamp period bounds to the requested date range
    if (startDate && periodStart < new Date(startDate)) {
      periodStart = new Date(startDate);
    }
    if (endDate && periodEnd > new Date(endDate)) {
      periodEnd = new Date(endDate);
    }

    const workingDays = countWorkingDays(
      format(periodStart, "yyyy-MM-dd"),
      format(periodEnd, "yyyy-MM-dd"),
    );

    const billable = Number(r.billableHours);
    const capacity = workingDays * 8;

    let period: string;
    let label: string;
    if (granularity === "week") {
      const weekNum = getISOWeek(periodDate);
      const yr = periodDate.getFullYear();
      period = `${yr}-W${String(weekNum).padStart(2, "0")}`;
      label = `W${weekNum} ${format(periodDate, "MMM")}`;
    } else {
      period = format(periodDate, "yyyy-MM");
      label = format(periodDate, "MMM yy");
    }

    return {
      period,
      label,
      billableHours: billable,
      nonBillableHours: Number(r.nonBillableHours),
      totalHours: Number(r.totalHours),
      workingDays,
      utilization: capacity > 0 ? Math.round((billable / capacity) * 100) : 0,
    };
  });

  res.json(result);
});

// ─── Team utilization ─────────────────────────────────────────────────────────

router.get("/dashboard/utilization", async (req, res): Promise<void> => {
  const currentUserId = req.session.userId!;
  const { startDate, endDate } = req.query as {
    startDate?: string;
    endDate?: string;
  };

  const entryConditions = [];
  if (startDate) entryConditions.push(gte(timeEntriesTable.date, startDate));
  if (endDate) entryConditions.push(lte(timeEntriesTable.date, endDate));
  const entryWhere =
    entryConditions.length > 0 ? and(...entryConditions) : undefined;

  // Role-based visibility: MD/AVP see full team; Associate sees self + direct Analysts; Analyst sees only self
  const [currentUser] = await db
    .select({ role: usersTable.role })
    .from(usersTable)
    .where(eq(usersTable.id, currentUserId));

  let userWhereClause;
  const currentRole = currentUser?.role ?? "analyst";

  if (currentRole === "analyst") {
    userWhereClause = eq(usersTable.id, currentUserId);
  } else if (currentRole === "associate") {
    // Self + Analysts who report to this associate
    userWhereClause = sql`(${usersTable.id} = ${currentUserId} OR (${usersTable.role} = 'analyst' AND ${usersTable.reportingToId} = ${currentUserId}))`;
  }
  // avp and md see everyone (no filter)

  const rows = await db
    .select({
      userId: usersTable.id,
      userName: usersTable.name,
      role: usersTable.role,
      totalHours: sql<number>`COALESCE(SUM(${timeEntriesTable.hours}), 0)`,
      billableHours: sql<number>`COALESCE(SUM(COALESCE(${timeEntriesTable.billableHours}, 0)), 0)`,
      nonBillableHours: sql<number>`COALESCE(SUM(${timeEntriesTable.hours} - COALESCE(${timeEntriesTable.billableHours}, 0)), 0)`,
      pendingHours: sql<number>`COALESCE(SUM(CASE WHEN ${timeEntriesTable.status} = 'pending' THEN ${timeEntriesTable.hours} ELSE 0 END), 0)`,
    })
    .from(usersTable)
    .leftJoin(
      timeEntriesTable,
      and(eq(timeEntriesTable.userId, usersTable.id), entryWhere),
    )
    .where(userWhereClause)
    .groupBy(usersTable.id, usersTable.name, usersTable.role)
    .orderBy(sql`COALESCE(SUM(${timeEntriesTable.hours}), 0) DESC`);

  const workingDays = countWorkingDays(startDate, endDate);
  const capacityHours = workingDays * 8;

  res.json(
    rows.map((r) => {
      const total = Number(r.totalHours);
      const billable = Number(r.billableHours);
      return {
        userId: r.userId,
        userName: r.userName,
        role: r.role,
        totalHours: total,
        billableHours: billable,
        nonBillableHours: Number(r.nonBillableHours),
        pendingHours: Number(r.pendingHours),
        utilization: Math.round((billable / capacityHours) * 100),
        efficiency: total > 0 ? Math.round((billable / total) * 100) : 0,
      };
    }),
  );
});

// ─── Recent activity ─────────────────────────────────────────────────────────

router.get("/dashboard/recent-activity", async (req, res): Promise<void> => {
  const { limit } = req.query as { limit?: string };
  const limitNum = Math.min(parseInt(limit ?? "20", 10), 100);

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
    .orderBy(sql`${timeEntriesTable.createdAt} DESC`)
    .limit(limitNum);

  res.json(
    rows.map((r) => ({
      ...r,
      billableHours: r.billableHours ?? null,
      nonBillableHours:
        r.billableHours !== null && r.billableHours !== undefined
          ? r.hours - r.billableHours
          : null,
      approvedByName: null,
    })),
  );
});

// ─── Pending approvals ────────────────────────────────────────────────────────

router.get("/dashboard/pending-approvals", async (req, res): Promise<void> => {
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
    .where(eq(timeEntriesTable.status, "pending"))
    .orderBy(sql`${timeEntriesTable.createdAt} ASC`);

  res.json(
    rows.map((r) => ({
      ...r,
      billableHours: r.billableHours ?? null,
      nonBillableHours:
        r.billableHours !== null && r.billableHours !== undefined
          ? r.hours - r.billableHours
          : null,
      approvedByName: null,
    })),
  );
});

export default router;
