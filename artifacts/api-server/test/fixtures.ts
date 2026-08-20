import bcrypt from "bcryptjs";
import { sql } from "drizzle-orm";
import request from "supertest";
import type { Express } from "express";
import {
  db,
  usersTable,
  clientsTable,
  projectsTable,
  tasksTable,
  projectTasksTable,
  clientUsersTable,
  projectUsersTable,
  timeEntriesTable,
} from "@workspace/db";

export const PASSWORD = "correct-horse-battery";

/**
 * A deliberately small org that still exercises every scoping rule:
 *
 *   Acme     ─ Audit project ─ avp, associate, analyst        (the in-scope team)
 *   Beta     ─ Beta project  ─ otherAssociate, otherAnalyst   (a separate silo)
 *
 * The two silos are what make "outside your remit" testable.
 */
export interface Fixtures {
  md: number;
  avp: number;
  associate: number;
  analyst: number;
  otherAssociate: number;
  otherAnalyst: number;
  inactive: number;
  acmeId: number;
  betaId: number;
  auditProjectId: number;
  betaProjectId: number;
  taskId: number;
  betaTaskId: number;
}

/** Wipes every table and rebuilds the fixture org. */
export async function resetDatabase(): Promise<Fixtures> {
  await db.execute(sql`
    TRUNCATE time_entry_events, time_entries, project_tasks, project_users,
             client_users, projects, tasks, clients, leaves, public_holidays,
             client_fte_history, users
    RESTART IDENTITY CASCADE
  `);

  const hash = bcrypt.hashSync(PASSWORD, 4); // low cost: these are throwaway

  const [md, avp, associate, analyst, otherAssociate, otherAnalyst, inactive] =
    await db
      .insert(usersTable)
      .values([
        { name: "Morgan Diaz", email: "md@test.local", passwordHash: hash, role: "md" },
        { name: "Avery Patel", email: "avp@test.local", passwordHash: hash, role: "avp" },
        { name: "Asha Rao", email: "associate@test.local", passwordHash: hash, role: "associate" },
        { name: "Ana Lyst", email: "analyst@test.local", passwordHash: hash, role: "analyst" },
        { name: "Otto Assoc", email: "other-associate@test.local", passwordHash: hash, role: "associate" },
        { name: "Ottilie Analyst", email: "other-analyst@test.local", passwordHash: hash, role: "analyst" },
        { name: "Gone Away", email: "inactive@test.local", passwordHash: hash, role: "analyst", isActive: false },
      ])
      .returning();

  const [acme, beta] = await db
    .insert(clientsTable)
    .values([
      { name: "Acme Capital", fteCount: 2 },
      { name: "Beta Industries", fteCount: 1 },
    ])
    .returning();

  const [auditProject, betaProject] = await db
    .insert(projectsTable)
    .values([
      { clientId: acme.id, name: "Q3 Audit" },
      { clientId: beta.id, name: "Beta Review" },
    ])
    .returning();

  const [task, betaTask] = await db
    .insert(tasksTable)
    .values([{ name: "Financial Modeling" }, { name: "Research" }])
    .returning();

  await db.insert(projectTasksTable).values([
    { projectId: auditProject.id, taskId: task.id },
    { projectId: betaProject.id, taskId: betaTask.id },
  ]);

  // The AVP owns Acme; nobody owns Beta at client level.
  await db
    .insert(clientUsersTable)
    .values([{ clientId: acme.id, userId: avp.id }]);

  await db.insert(projectUsersTable).values([
    { projectId: auditProject.id, userId: associate.id },
    { projectId: auditProject.id, userId: analyst.id },
    { projectId: betaProject.id, userId: otherAssociate.id },
    { projectId: betaProject.id, userId: otherAnalyst.id },
  ]);

  return {
    md: md.id,
    avp: avp.id,
    associate: associate.id,
    analyst: analyst.id,
    otherAssociate: otherAssociate.id,
    otherAnalyst: otherAnalyst.id,
    inactive: inactive.id,
    acmeId: acme.id,
    betaId: beta.id,
    auditProjectId: auditProject.id,
    betaProjectId: betaProject.id,
    taskId: task.id,
    betaTaskId: betaTask.id,
  };
}

/** Inserts an entry directly, bypassing the API — for arranging test state. */
export async function seedEntry(values: {
  userId: number;
  projectId: number;
  taskId: number;
  hours?: number;
  date?: string;
  status?: "pending" | "approved" | "rejected";
  billableHours?: number | null;
  approvedById?: number | null;
}): Promise<number> {
  const [row] = await db
    .insert(timeEntriesTable)
    .values({
      userId: values.userId,
      projectId: values.projectId,
      taskId: values.taskId,
      hours: values.hours ?? 4,
      date: values.date ?? "2026-08-10",
      status: values.status ?? "pending",
      billableHours: values.billableHours ?? null,
      approvedById: values.approvedById ?? null,
      approvedAt: values.status === "approved" ? new Date() : null,
    })
    .returning({ id: timeEntriesTable.id });
  return row.id;
}

/** A supertest agent already signed in as `email`. */
export async function signIn(app: Express, email: string) {
  const agent = request.agent(app);
  const res = await agent
    .post("/api/auth/login")
    .send({ email, password: PASSWORD });
  if (res.status !== 200) {
    throw new Error(`Sign-in failed for ${email}: ${res.status} ${res.text}`);
  }
  return agent;
}
