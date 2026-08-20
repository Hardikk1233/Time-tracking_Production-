import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";

/**
 * Append-only ledger of every write to a time entry.
 *
 * Rows are written by a database trigger rather than by application code, so
 * no route — present or future, correct or buggy — can mutate a time entry
 * without leaving a record.
 *
 * `timeEntryId` is deliberately NOT a foreign key: the history of a deleted
 * entry is exactly what an audit trail exists to preserve.
 */
export const timeEntryEventsTable = pgTable(
  "time_entry_events",
  {
    id: serial("id").primaryKey(),
    timeEntryId: integer("time_entry_id").notNull(),
    action: text("action", {
      enum: ["created", "updated", "approved", "rejected", "reopened", "deleted"],
    }).notNull(),
    /** Null only if a write bypassed the application's actor stamping. */
    actorId: integer("actor_id"),
    previous: jsonb("previous"),
    next: jsonb("next"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("time_entry_events_entry_idx").on(table.timeEntryId, table.createdAt),
    index("time_entry_events_actor_idx").on(table.actorId),
  ],
);

export type TimeEntryEvent = typeof timeEntryEventsTable.$inferSelect;
