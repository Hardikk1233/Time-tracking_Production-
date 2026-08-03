import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  real,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { tasksTable } from "./tasks";

export const timeEntriesTable = pgTable("time_entries", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => usersTable.id),
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
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type TimeEntry = typeof timeEntriesTable.$inferSelect;
export type InsertTimeEntry = typeof timeEntriesTable.$inferInsert;
