import {
  pgTable,
  serial,
  text,
  integer,
  real,
  timestamp,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { usersTable } from "./users";

export const leavesTable = pgTable(
  "leaves",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    date: text("date").notNull(), // YYYY-MM-DD
    /**
     * How much of the working day is taken: 1 for a full day, 0.5 for a half.
     *
     * Stored as the fraction rather than a boolean so capacity maths is a SUM
     * over this column instead of a COUNT of rows, and so a different fraction
     * could be allowed later without another migration. Defaults to 1, which
     * is what every row meant before the column existed.
     */
    portion: real("portion").notNull().default(1),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  // One leave day per person per date. Replaces a read-then-write check that
  // two concurrent requests could both pass.
  (table) => [
    uniqueIndex("leaves_user_date_unique").on(table.userId, table.date),
    // Only the two fractions the app offers. A stray 0.3 would quietly skew
    // every utilisation figure that sums this column.
    check("leaves_portion_valid", sql`${table.portion} IN (0.5, 1)`),
  ],
);

export type Leave = typeof leavesTable.$inferSelect;
export type InsertLeave = typeof leavesTable.$inferInsert;
