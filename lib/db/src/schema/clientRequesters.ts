import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { clientsTable } from "./clients";

/**
 * The people on the client's own side who ask for the work.
 *
 * Not users of this app and never will be: they have no login, no role and no
 * hours. They are the answer to "who asked for this?" - the name that belongs
 * on a report when the firm is deciding whether an engagement is worth what it
 * costs to serve. A memo requested by the CFO and a memo requested by an
 * analyst are different facts about the relationship, and until now the app
 * held neither.
 *
 * Kept against the client rather than against each project because the client
 * is the relationship: requesters come and go as people join and leave, and
 * the list has to be maintainable in one place rather than re-entered on every
 * new project.
 */
export const clientRequestersTable = pgTable(
  "client_requesters",
  {
    id: serial("id").primaryKey(),
    clientId: integer("client_id")
      .notNull()
      .references(() => clientsTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Their title at the client - "CFO", "Head of Treasury". */
    designation: text("designation").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("client_requesters_client_id_idx").on(table.clientId)],
);

export type ClientRequester = typeof clientRequestersTable.$inferSelect;
export type InsertClientRequester = typeof clientRequestersTable.$inferInsert;
