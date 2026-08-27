import {
  pgTable,
  serial,
  integer,
  text,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { clientsTable } from "./clients";
import { usersTable } from "./users";

/**
 * Firm-wide catalog of deliverables a client can buy — an investment memo, for
 * example — defined by an Associate or above.
 *
 * Deliberately separate from the task catalog: a task is a type of work that
 * hours are logged against, a product is a thing sold to a client and handed to
 * someone to produce. They look alike today and are expected to diverge.
 */
export const productsTable = pgTable(
  "products",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description"),
    createdById: integer("created_by_id")
      .notNull()
      .references(() => usersTable.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("products_name_unique_idx").on(sql`lower(${table.name})`),
  ],
);

/**
 * A product handed to somebody to produce, for a given client.
 *
 * assignedById records who did the handing out, because the person allocating
 * is a seniority decision worth being able to answer questions about later.
 */
export const productAssignmentsTable = pgTable(
  "product_assignments",
  {
    id: serial("id").primaryKey(),
    productId: integer("product_id")
      .notNull()
      .references(() => productsTable.id, { onDelete: "cascade" }),
    clientId: integer("client_id")
      .notNull()
      .references(() => clientsTable.id, { onDelete: "cascade" }),
    assigneeUserId: integer("assignee_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    assignedById: integer("assigned_by_id")
      .notNull()
      .references(() => usersTable.id),
    assignedAt: timestamp("assigned_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // The same product for the same client cannot be handed to one person
    // twice, but may be split across several people.
    uniqueIndex("product_assignments_unique_idx").on(
      table.productId,
      table.clientId,
      table.assigneeUserId,
    ),
    index("product_assignments_assignee_idx").on(table.assigneeUserId),
    index("product_assignments_client_idx").on(table.clientId),
  ],
);

export type Product = typeof productsTable.$inferSelect;
export type InsertProduct = typeof productsTable.$inferInsert;
export type ProductAssignment = typeof productAssignmentsTable.$inferSelect;
export type InsertProductAssignment =
  typeof productAssignmentsTable.$inferInsert;
