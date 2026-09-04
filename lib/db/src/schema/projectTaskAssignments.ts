import {
  pgTable,
  serial,
  integer,
  timestamp,
  index,
  uniqueIndex,
  foreignKey,
} from "drizzle-orm/pg-core";
import { projectsTable } from "./projects";
import { tasksTable } from "./tasks";
import { projectTasksTable } from "./projectTasks";
import { usersTable } from "./users";

/**
 * Who is doing which task on which project.
 *
 * Records an intention, not a permission: anyone on a project may still log
 * time against any task enabled there. Gating time entry on an assignment
 * would turn every unplanned piece of work into a permission error, which is
 * not what a timesheet is for.
 *
 * Composite foreign key to project_tasks rather than to projects and tasks
 * separately, so a task cannot be assigned on a project where it was never
 * enabled — and disabling a task on a project takes its assignments with it.
 */
export const projectTaskAssignmentsTable = pgTable(
  "project_task_assignments",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projectsTable.id, { onDelete: "cascade" }),
    taskId: integer("task_id")
      .notNull()
      .references(() => tasksTable.id, { onDelete: "cascade" }),
    /** Who is expected to do the work. */
    assigneeUserId: integer("assignee_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    /** Who handed it over. An analyst may only ever be both. */
    assignedById: integer("assigned_by_id")
      .notNull()
      .references(() => usersTable.id),
    assignedAt: timestamp("assigned_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // The same task may be split across several people, but not handed to one
    // person twice.
    uniqueIndex("project_task_assignments_unique_idx").on(
      table.projectId,
      table.taskId,
      table.assigneeUserId,
    ),
    index("project_task_assignments_assignee_idx").on(table.assigneeUserId),
    index("project_task_assignments_project_idx").on(table.projectId),
    foreignKey({
      columns: [table.projectId, table.taskId],
      foreignColumns: [projectTasksTable.projectId, projectTasksTable.taskId],
      name: "project_task_assignments_project_task_fk",
    }).onDelete("cascade"),
  ],
);

export type ProjectTaskAssignment =
  typeof projectTaskAssignmentsTable.$inferSelect;
export type InsertProjectTaskAssignment =
  typeof projectTaskAssignmentsTable.$inferInsert;
