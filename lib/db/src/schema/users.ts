import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  boolean,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

export const usersTable = pgTable("users", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  /**
   * Microsoft Entra object id — the stable identifier for a person in the
   * tenant. Email can be renamed; this cannot. Null until an account first
   * signs in through Entra.
   */
  entraOid: text("entra_oid").unique(),
  /**
   * Nullable: accounts provisioned through Entra never have a password, and
   * existing passwords are dropped at cutover.
   */
  passwordHash: text("password_hash"),
  role: text("role", { enum: ["analyst", "associate", "avp", "md"] })
    .notNull()
    .default("analyst"),
  /**
   * Overrides the role's default label — e.g. VP and SVP both hold the avp
   * permission rank (same access, same authorization checks) but should not
   * appear to have signed in as "AVP". Null shows the ordinary role label.
   */
  title: text("title"),
  // Real foreign key: a dangling manager id silently corrupts approval scoping
  // and the reporting-line queries the reports build on.
  reportingToId: integer("reporting_to_id").references(
    (): AnyPgColumn => usersTable.id,
    { onDelete: "set null" },
  ),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type User = typeof usersTable.$inferSelect;
export type InsertUser = typeof usersTable.$inferInsert;
