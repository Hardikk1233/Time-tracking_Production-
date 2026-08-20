import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  real,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { usersTable } from "./users";
import { tasksTable } from "./tasks";
import { projectsTable } from "./projects";

export const timeEntriesTable = pgTable(
  "time_entries",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id),
    // Nullable because tasks are now a global catalog decoupled from a single
    // project; the project a time entry was logged against is now explicit.
    // (Existing rows created before this change may have a null projectId —
    // that historical link was lost when tasks stopped being per-project.)
    projectId: integer("project_id").references(() => projectsTable.id),
    taskId: integer("task_id")
      .notNull()
      .references(() => tasksTable.id),
    hours: real("hours").notNull(),
    date: text("date").notNull(), // stored as YYYY-MM-DD string
    description: text("description"),
    // billableHours: null = not yet split by Associate+; 0..hours = explicitly split
    billableHours: real("billable_hours"),
    status: text("status", { enum: ["pending", "approved", "rejected"] })
      .notNull()
      .default("pending"),
    approvedById: integer("approved_by_id").references(() => usersTable.id),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // Every dashboard and report query filters on these; without them the
    // planner falls back to sequential scans as the table grows.
    index("time_entries_user_date_idx").on(table.userId, table.date),
    index("time_entries_project_date_idx").on(table.projectId, table.date),
    index("time_entries_status_idx").on(table.status),

    // Bounds the API also enforces, kept here so they hold regardless of which
    // code path writes the row.
    check("time_entries_hours_range", sql`${table.hours} > 0 AND ${table.hours} <= 24`),
    check(
      "time_entries_billable_range",
      sql`${table.billableHours} IS NULL OR (${table.billableHours} >= 0 AND ${table.billableHours} <= ${table.hours})`,
    ),
  ],
);

export type TimeEntry = typeof timeEntriesTable.$inferSelect;
export type InsertTimeEntry = typeof timeEntriesTable.$inferInsert;
