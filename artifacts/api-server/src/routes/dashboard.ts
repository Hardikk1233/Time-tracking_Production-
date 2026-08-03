import { Router, type IRouter } from "express";
import { eq, gte, lte, sql, and } from "drizzle-orm";
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

// ─── Summary ─────────────────────────────────────────────────────────────────

router.get("/dashboard/summary", async (req, res): Promise<void> => {
  const { startDate, endDate } = req.query as {
    startDate?: string;
    endDate?: string;
  };

  const conditions = [];
  if (startDate) conditions.push(gte(timeEntriesTable.date, startDate));
  if (endDate) conditions.push(lte(timeEntriesTable.date, endDate));
  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const [result] = await db
    .select({
      totalHours: sql<number>`COALESCE(SUM(${timeEntriesTable.hours}), 0)`,
      billableHours: sql<number>`COALESCE(SUM(COALESCE(${timeEntriesTable.billableHours}, 0)), 0)`,
      nonBillableHours: sql<number>`COALESCE(SUM(${timeEntriesTable.hours} - COALESCE(${timeEntriesTable.billableHours}, 0)), 0)`,
      pendingApprovalCount: sql<number>`COUNT(CASE WHEN ${timeEntriesTable.status} = 'pending' THEN 1 END)`,
      approvedHours: sql<number>`COALESCE(SUM(CASE WHEN ${timeEntriesTable.status} = 'approved' THEN ${timeEntriesTable.hours} ELSE 0 END), 0)`,
    })
    .from(timeEntriesTable)
    .where(whereClause);

  res.json({
    totalHours: Number(result?.totalHours ?? 0),
    billableHours: Number(result?.billableHours ?? 0),
    nonBillableHours: Number(result?.nonBillableHours ?? 0),
    pendingApprovalCount: Number(result?.pendingApprovalCount ?? 0),
    approvedHours: Number(result?.approvedHours ?? 0),
  });
});

// ─── Client hours ─────────────────────────────────────────────────────────────

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

// ─── Team utilization ─────────────────────────────────────────────────────────

router.get("/dashboard/utilization", async (req, res): Promise<void> => {
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
        utilization: Math.round((total / capacityHours) * 100),
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
