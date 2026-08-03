import { pgTable, serial, text, integer, timestamp } from "drizzle-orm/pg-core";
import { clientsTable } from "./clients";

export const projectsTable = pgTable("projects", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id")
    .notNull()
    .references(() => clientsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type Project = typeof projectsTable.$inferSelect;
export type InsertProject = typeof projectsTable.$inferInsert;
