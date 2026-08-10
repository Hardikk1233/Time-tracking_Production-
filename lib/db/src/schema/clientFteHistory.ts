import { pgTable, serial, integer, real, date, timestamp } from "drizzle-orm/pg-core";
import { clientsTable } from "./clients";

export const clientFteHistoryTable = pgTable("client_fte_history", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id")
    .notNull()
    .references(() => clientsTable.id, { onDelete: "cascade" }),
  fteCount: real("fte_count").notNull(),
  effectiveFrom: date("effective_from").notNull(),
  effectiveTo: date("effective_to"), // null = open-ended (current)
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type ClientFteHistory = typeof clientFteHistoryTable.$inferSelect;
export type InsertClientFteHistory = typeof clientFteHistoryTable.$inferInsert;
