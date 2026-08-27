import { pgTable, serial, text, real, timestamp, boolean } from "drizzle-orm/pg-core";

export const clientsTable = pgTable("clients", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  fteCount: real("fte_count").notNull().default(1),
  // Which commercial arrangement this client is on. Defaults to "fte" because
  // that is what every client already was before the column existed: fteCount
  // and client_fte_history predate it and remain the FTE implementation.
  engagementType: text("engagement_type", {
    enum: ["fte", "block_hours", "product"],
  })
    .notNull()
    .default("fte"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type Client = typeof clientsTable.$inferSelect;
export type InsertClient = typeof clientsTable.$inferInsert;
