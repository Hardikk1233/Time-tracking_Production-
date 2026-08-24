import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";

/**
 * Errors and warnings captured from the running app, kept so a problem someone
 * hit at 11pm can still be read the next morning.
 *
 * Container Apps already streams stdout to Log Analytics, but that only holds
 * what the *server* printed: a React render crash or a failed fetch in
 * somebody's browser never reaches it. This table is the one place both sides
 * land, which is the whole point of the /dev console.
 *
 * Temporary. It exists to get the rollout debugged, and the migration that
 * removes it should go out once the app is stable.
 */
export const appEventsTable = pgTable(
  "app_events",
  {
    id: serial("id").primaryKey(),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Which half of the app produced this — "client" or "server". */
    source: text("source", { enum: ["client", "server"] }).notNull(),
    level: text("level", { enum: ["error", "warn", "info"] })
      .notNull()
      .default("error"),
    message: text("message").notNull(),
    stack: text("stack"),
    /** Page URL (client) or request path (server). Query strings are stripped. */
    url: text("url"),
    method: text("method"),
    statusCode: integer("status_code"),
    /**
     * Null for anything thrown before sign-in, which is exactly when the
     * interesting Entra failures happen — so this cannot be NOT NULL.
     */
    userId: integer("user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    userEmail: text("user_email"),
    userAgent: text("user_agent"),
    /** pino's per-request id, so a client report can be tied to its server log. */
    requestId: text("request_id"),
    /** Anything else worth keeping: component stack, response body, route params. */
    context: jsonb("context"),
  },
  (table) => [
    // The console reads newest-first and filters by source; everything else is
    // a full scan on a table that only ever gets appended to.
    index("app_events_occurred_at_idx").on(table.occurredAt),
    index("app_events_source_idx").on(table.source),
  ],
);

export type AppEvent = typeof appEventsTable.$inferSelect;
export type InsertAppEvent = typeof appEventsTable.$inferInsert;
