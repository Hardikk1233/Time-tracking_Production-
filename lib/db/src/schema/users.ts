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
  /**
   * When this person finished or dismissed the guided tour.
   *
   * Null means they have never been shown it, which is what makes the tour
   * open by itself on a first sign-in and stay closed on every one after.
   * A timestamp rather than a boolean so it is possible to tell a long-
   * standing user from somebody who joined this week without them, and to
   * re-run the tour for everyone by clearing rows older than a given date.
   */
  tourCompletedAt: timestamp("tour_completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type User = typeof usersTable.$inferSelect;
export type InsertUser = typeof usersTable.$inferInsert;
