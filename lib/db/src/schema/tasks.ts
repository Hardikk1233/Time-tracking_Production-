import { pgTable, serial, text, integer, timestamp } from "drizzle-orm/pg-core";
import { projectsTable } from "./projects";

export const tasksTable = pgTable("tasks", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id")
    .notNull()
    .references(() => projectsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type Task = typeof tasksTable.$inferSelect;
export type InsertTask = typeof tasksTable.$inferInsert;
