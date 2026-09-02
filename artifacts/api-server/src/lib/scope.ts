import { eq, and, inArray, sql } from "drizzle-orm";
import {
  db,
  projectsTable,
  projectUsersTable,
  clientUsersTable,
  type TimeEntry,
} from "@workspace/db";
import type { Principal } from "../middlewares/auth";

/**
 * Whether `me` may approve, reject or split a given entry.
 *
 * Mirrors the scoping the approvals queue already applied when *listing*
 * entries — the write paths previously applied none of it, so anyone could
 * approve anything by calling the endpoint directly.
 *
 *   MD        — the whole firm
 *   AVP       — entries on projects belonging to their assigned clients
 *   Associate — entries on projects they are assigned to
 *   Analyst   — never
 */
export async function isInApprovalScope(
  me: Principal,
  entry: Pick<TimeEntry, "projectId">,
): Promise<boolean> {
  if (me.role === "md") return true;
  if (me.role === "analyst") return false;

  // Internal time carries no project, so only an MD can act on it.
  if (entry.projectId == null) return false;

  if (me.role === "avp") {
    const [row] = await db
      .select({ ok: sql<number>`1` })
      .from(projectsTable)
      .innerJoin(
        clientUsersTable,
        and(
          eq(clientUsersTable.clientId, projectsTable.clientId),
          eq(clientUsersTable.userId, me.id),
        ),
      )
      .where(eq(projectsTable.id, entry.projectId))
      .limit(1);
    return Boolean(row);
  }

  const [row] = await db
    .select({ ok: sql<number>`1` })
    .from(projectUsersTable)
    .where(
      and(
        eq(projectUsersTable.projectId, entry.projectId),
        eq(projectUsersTable.userId, me.id),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/** Whether `me` may log time against `projectId`. */
export async function canLogToProject(
  me: Principal,
  projectId: number,
): Promise<boolean> {
  // AVP and MD oversee whole clients, so they are not restricted to explicit
  // project assignments.
  if (me.role === "avp" || me.role === "md") return true;

  const [row] = await db
    .select({ ok: sql<number>`1` })
    .from(projectUsersTable)
    .where(
      and(
        eq(projectUsersTable.projectId, projectId),
        eq(projectUsersTable.userId, me.id),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/**
 * Whether `me` may see — and therefore act on — a given project.
 *
 * Visible when assigned to the project directly, or assigned to its client.
 * Every project-scoped route must apply this: without it a project could be
 * renamed, deleted, or assigned to simply by knowing its id, and assigning
 * yourself to an unseen project would grant you its data.
 */
export async function isProjectVisible(
  me: Principal,
  projectId: number,
): Promise<boolean> {
  if (me.role === "md") return true;

  const [direct] = await db
    .select({ ok: sql<number>`1` })
    .from(projectUsersTable)
    .where(
      and(
        eq(projectUsersTable.projectId, projectId),
        eq(projectUsersTable.userId, me.id),
      ),
    )
    .limit(1);
  if (direct) return true;

  const [viaClient] = await db
    .select({ ok: sql<number>`1` })
    .from(projectsTable)
    .innerJoin(
      clientUsersTable,
      and(
        eq(clientUsersTable.clientId, projectsTable.clientId),
        eq(clientUsersTable.userId, me.id),
      ),
    )
    .where(eq(projectsTable.id, projectId))
    .limit(1);
  return Boolean(viaClient);
}

/** Whether `me` may see a given client. */
export async function isClientVisible(
  me: Principal,
  clientId: number,
): Promise<boolean> {
  const allowed = await visibleClientIds(me);
  return allowed === null || allowed.includes(clientId);
}

/**
 * Client ids `me` may see. `null` means unrestricted (MD).
 *
 * Analysts and Associates reach clients through their project assignments;
 * AVPs through direct client assignment.
 */
export async function visibleClientIds(
  me: Principal,
): Promise<number[] | null> {
  if (me.role === "md") return null;

  if (me.role === "avp") {
    const rows = await db
      .selectDistinct({ clientId: clientUsersTable.clientId })
      .from(clientUsersTable)
      .where(eq(clientUsersTable.userId, me.id));
    return rows.map((r) => r.clientId);
  }

  // Analysts and associates reach clients two ways, and both have to count.
  //
  // Through their projects, which is the common case. But also through a direct
  // client assignment, because otherwise an associate put on a client cannot
  // act on it until a project exists there — and creating that first project is
  // itself gated on being able to see the client. The client appeared in their
  // list (GET /clients reads client assignments) while every write refused it
  // as "Client not found", which reads as the app being broken rather than as a
  // permission boundary.
  const [viaProjects, viaClient] = await Promise.all([
    db
      .selectDistinct({ clientId: projectsTable.clientId })
      .from(projectUsersTable)
      .innerJoin(
        projectsTable,
        eq(projectsTable.id, projectUsersTable.projectId),
      )
      .where(eq(projectUsersTable.userId, me.id)),
    db
      .selectDistinct({ clientId: clientUsersTable.clientId })
      .from(clientUsersTable)
      .where(eq(clientUsersTable.userId, me.id)),
  ]);

  return [
    ...new Set([
      ...viaProjects.map((r) => r.clientId),
      ...viaClient.map((r) => r.clientId),
    ]),
  ];
}

/**
 * User ids whose entries `me` may read. `null` means unrestricted (MD).
 */
export async function visibleUserIds(me: Principal): Promise<number[] | null> {
  if (me.role === "md") return null;
  if (me.role === "analyst") return [me.id];

  if (me.role === "avp") {
    const myClients = await db
      .selectDistinct({ clientId: clientUsersTable.clientId })
      .from(clientUsersTable)
      .where(eq(clientUsersTable.userId, me.id));

    const clientIds = myClients.map((r) => r.clientId);
    if (clientIds.length === 0) return [me.id];

    // Staff are assigned to projects, not to clients — so an AVP's team has to
    // be reached through the projects under their clients. Looking only at
    // client assignments (as this did) returned just the AVP themselves,
    // leaving them unable to see the team they are meant to oversee.
    const [viaProjects, viaClients] = await Promise.all([
      db
        .selectDistinct({ userId: projectUsersTable.userId })
        .from(projectUsersTable)
        .innerJoin(
          projectsTable,
          eq(projectsTable.id, projectUsersTable.projectId),
        )
        .where(inArray(projectsTable.clientId, clientIds)),
      db
        .selectDistinct({ userId: clientUsersTable.userId })
        .from(clientUsersTable)
        .where(inArray(clientUsersTable.clientId, clientIds)),
    ]);

    return [
      ...new Set([
        me.id,
        ...viaProjects.map((r) => r.userId),
        ...viaClients.map((r) => r.userId),
      ]),
    ];
  }

  const myProjects = await db
    .selectDistinct({ projectId: projectUsersTable.projectId })
    .from(projectUsersTable)
    .where(eq(projectUsersTable.userId, me.id));

  const projectIds = myProjects.map((r) => r.projectId);
  if (projectIds.length === 0) return [me.id];

  const teammates = await db
    .selectDistinct({ userId: projectUsersTable.userId })
    .from(projectUsersTable)
    .where(inArray(projectUsersTable.projectId, projectIds));

  return [...new Set([me.id, ...teammates.map((r) => r.userId)])];
}
