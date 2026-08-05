import { pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// Global, firm-wide catalog of tasks. Any project can enable any subset of
// these (see projectTasksTable) rather than each project defining its own.
export const tasksTable = pgTable(
  "tasks",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("tasks_name_unique_idx").on(sql`lower(${table.name})`),
  ],
);

export type Task = typeof tasksTable.$inferSelect;
export type InsertTask = typeof tasksTable.$inferInsert;
