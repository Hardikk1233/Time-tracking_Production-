import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";

/**
 * Free-text feedback from the people using the app during the rollout.
 *
 * Deliberately not a support-ticket system: one message, who sent it, and what
 * page they were on when they sent it. The page matters more than it looks —
 * "the dates are wrong" means something different on /reports than on
 * /time-entries, and nobody remembers to say which they meant.
 *
 * Temporary, and paired with the widget in the UI. Both come out together.
 */
export const feedbackTable = pgTable(
  "feedback",
  {
    id: serial("id").primaryKey(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /**
     * Set from the authenticated principal, never from the request body —
     * otherwise anyone could file feedback as somebody else.
     */
    userId: integer("user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    userEmail: text("user_email").notNull(),
    userName: text("user_name").notNull(),
    userRole: text("user_role").notNull(),
    /** Whether this reads as a bug or a suggestion, as chosen by the sender. */
    kind: text("kind", { enum: ["bug", "idea", "other"] })
      .notNull()
      .default("other"),
    message: text("message").notNull(),
    /** The page they were on, so a vague report is still actionable. */
    pageUrl: text("page_url"),
    userAgent: text("user_agent"),
    /** Cleared once it has been looked at in the console. */
    status: text("status", { enum: ["new", "read"] })
      .notNull()
      .default("new"),
  },
  (table) => [
    index("feedback_created_at_idx").on(table.createdAt),
    index("feedback_status_idx").on(table.status),
  ],
);

export type Feedback = typeof feedbackTable.$inferSelect;
export type InsertFeedback = typeof feedbackTable.$inferInsert;
