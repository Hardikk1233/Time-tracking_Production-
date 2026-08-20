import {
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const publicHolidaysTable = pgTable(
  "public_holidays",
  {
    id: serial("id").primaryKey(),
    date: text("date").notNull(), // YYYY-MM-DD
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  // A date is a holiday once; duplicates would double-count against capacity.
  (table) => [uniqueIndex("public_holidays_date_unique").on(table.date)],
);

export type PublicHoliday = typeof publicHolidaysTable.$inferSelect;
export type InsertPublicHoliday = typeof publicHolidaysTable.$inferInsert;
