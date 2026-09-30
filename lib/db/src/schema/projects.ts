import { pgTable, serial, text, integer, timestamp, boolean } from "drizzle-orm/pg-core";
import { clientsTable } from "./clients";
import { clientRequestersTable } from "./clientRequesters";

export const projectsTable = pgTable("projects", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id")
    .notNull()
    .references(() => clientsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  /**
   * Which of the client's people asked for this particular piece of work.
   *
   * The client's requester list says who *can* ask; this says who did. A
   * report row for one project should name that person and not everybody at
   * the account, which is the difference between "the CFO commissioned this
   * memo" and "the client has seven contacts".
   *
   * Nullable, and set null rather than cascading when a requester is removed:
   * every project that predates this column has none, a client may have
   * nobody recorded yet, and losing the person must never take the project's
   * hours with it. Constrained in the API to a requester of the project's own
   * client - the database cannot express that across two tables.
   */
  requesterId: integer("requester_id").references(
    () => clientRequestersTable.id,
    { onDelete: "set null" },
  ),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type Project = typeof projectsTable.$inferSelect;
export type InsertProject = typeof projectsTable.$inferInsert;
