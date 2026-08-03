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
      billableHours: sql<number>`COALESCE(SUM(CASE WHEN ${timeEntriesTable.billable} = true THEN ${timeEntriesTable.hours} ELSE 0 END), 0)`,
      nonBillableHours: sql<number>`COALESCE(SUM(CASE WHEN ${timeEntriesTable.billable} = false THEN ${timeEntriesTable.hours} ELSE 0 END), 0)`,
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
      billableHours: sql<number>`COALESCE(SUM(CASE WHEN ${timeEntriesTable.billable} = true THEN ${timeEntriesTable.hours} ELSE 0 END), 0)`,
      nonBillableHours: sql<number>`COALESCE(SUM(CASE WHEN ${timeEntriesTable.billable} = false THEN ${timeEntriesTable.hours} ELSE 0 END), 0)`,
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
      billableHours: sql<number>`COALESCE(SUM(CASE WHEN ${timeEntriesTable.billable} = true THEN ${timeEntriesTable.hours} ELSE 0 END), 0)`,
      nonBillableHours: sql<number>`COALESCE(SUM(CASE WHEN ${timeEntriesTable.billable} = false THEN ${timeEntriesTable.hours} ELSE 0 END), 0)`,
      pendingHours: sql<number>`COALESCE(SUM(CASE WHEN ${timeEntriesTable.status} = 'pending' THEN ${timeEntriesTable.hours} ELSE 0 END), 0)`,
    })
    .from(usersTable)
    .leftJoin(
      timeEntriesTable,
      and(eq(timeEntriesTable.userId, usersTable.id), entryWhere),
    )
    .groupBy(usersTable.id, usersTable.name, usersTable.role)
    .orderBy(sql`COALESCE(SUM(${timeEntriesTable.hours}), 0) DESC`);

  res.json(
    rows.map((r) => ({
      userId: r.userId,
      userName: r.userName,
      role: r.role,
      totalHours: Number(r.totalHours),
      billableHours: Number(r.billableHours),
      nonBillableHours: Number(r.nonBillableHours),
      pendingHours: Number(r.pendingHours),
    })),
  );
});

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
    .orderBy(sql`${timeEntriesTable.createdAt} DESC`)
    .limit(limitNum);

  res.json(
    rows.map((r) => ({
      ...r,
      approvedByName: null,
    })),
  );
});

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
    .where(eq(timeEntriesTable.status, "pending"))
    .orderBy(sql`${timeEntriesTable.createdAt} ASC`);

  res.json(
    rows.map((r) => ({
      ...r,
      approvedByName: null,
    })),
  );
});

export default router;
