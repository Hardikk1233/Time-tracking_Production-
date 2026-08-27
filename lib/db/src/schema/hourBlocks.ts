import {
  pgTable,
  serial,
  integer,
  real,
  text,
  date,
  timestamp,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { clientsTable } from "./clients";
import { usersTable } from "./users";

/**
 * Blocks of hours a client has bought, one row per purchase.
 *
 * Recorded as separate rows rather than a running total on the client so a
 * top-up is an insert instead of an update: the balance is then derived, and
 * how it was arrived at stays auditable. Purchases are never edited down to
 * correct a mistake — add a negative-free correcting row or delete the wrong
 * one, so the history keeps meaning what it says.
 */
export const hourBlocksTable = pgTable(
  "hour_blocks",
  {
    id: serial("id").primaryKey(),
    clientId: integer("client_id")
      .notNull()
      .references(() => clientsTable.id, { onDelete: "cascade" }),
    hours: real("hours").notNull(),
    purchasedOn: date("purchased_on").notNull(),
    note: text("note"),
    createdById: integer("created_by_id")
      .notNull()
      .references(() => usersTable.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("hour_blocks_client_idx").on(table.clientId),
    // A zero or negative purchase is a data-entry error, not a credit note.
    check("hour_blocks_hours_positive", sql`${table.hours} > 0`),
  ],
);

export type HourBlock = typeof hourBlocksTable.$inferSelect;
export type InsertHourBlock = typeof hourBlocksTable.$inferInsert;
