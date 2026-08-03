import { pgTable, integer, primaryKey } from "drizzle-orm/pg-core";
import { clientsTable } from "./clients";
import { projectsTable } from "./projects";
import { usersTable } from "./users";

export const clientUsersTable = pgTable(
  "client_users",
  {
    clientId: integer("client_id")
      .notNull()
      .references(() => clientsTable.id, { onDelete: "cascade" }),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.clientId, table.userId] })],
);

export const projectUsersTable = pgTable(
  "project_users",
  {
    projectId: integer("project_id")
      .notNull()
      .references(() => projectsTable.id, { onDelete: "cascade" }),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.projectId, table.userId] })],
);
