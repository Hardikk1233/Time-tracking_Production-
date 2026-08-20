import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const leavesTable = pgTable(
  "leaves",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    date: text("date").notNull(), // YYYY-MM-DD
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  // One leave day per person per date. Replaces a read-then-write check that
  // two concurrent requests could both pass.
  (table) => [uniqueIndex("leaves_user_date_unique").on(table.userId, table.date)],
);

export type Leave = typeof leavesTable.$inferSelect;
export type InsertLeave = typeof leavesTable.$inferInsert;
