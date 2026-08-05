import { pgTable, integer, primaryKey } from "drizzle-orm/pg-core";
import { projectsTable } from "./projects";
import { tasksTable } from "./tasks";

// Many-to-many: which global tasks are enabled for a given project.
export const projectTasksTable = pgTable(
  "project_tasks",
  {
    projectId: integer("project_id")
      .notNull()
      .references(() => projectsTable.id, { onDelete: "cascade" }),
    taskId: integer("task_id")
      .notNull()
      .references(() => tasksTable.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.projectId, table.taskId] })],
);
