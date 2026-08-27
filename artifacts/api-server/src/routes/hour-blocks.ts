import { Router, type IRouter } from "express";
import { and, eq, ne, sql } from "drizzle-orm";
import {
  db,
  clientsTable,
  hourBlocksTable,
  projectsTable,
  timeEntriesTable,
  usersTable,
} from "@workspace/db";
import { principal, requireRole } from "../middlewares/auth";
import { isClientVisible } from "../lib/scope";
import { parseId } from "../lib/validation";

const router: IRouter = Router();

/**
 * Blocks of hours bought by a client, and what is left of them.
 *
 * The balance is derived on read rather than stored, so a correction to a
 * purchase or a deleted time entry cannot leave a stale total behind.
 */

/**
 * Hours drawn down against a client.
 *
 * Rejected entries do not consume the block — the work was not accepted — but
 * pending ones do, because the hours have been worked and a client's remaining
 * balance that ignores unapproved time reads high for as long as approval lags.
 *
 * Time entries carry a nullable projectId (tasks became a global catalog and
 * older rows lost that link), and an entry with no project cannot be
 * attributed to a client, so it is invisible to this sum.
 */
async function consumedHours(clientId: number): Promise<{
  consumed: number;
  approved: number;
}> {
  const [row] = await db
    .select({
      consumed: sql<number>`coalesce(sum(${timeEntriesTable.hours}), 0)`,
      approved: sql<number>`coalesce(sum(case when ${timeEntriesTable.status} = 'approved' then ${timeEntriesTable.hours} else 0 end), 0)`,
    })
    .from(timeEntriesTable)
    .innerJoin(projectsTable, eq(timeEntriesTable.projectId, projectsTable.id))
    .where(
      and(
        eq(projectsTable.clientId, clientId),
        ne(timeEntriesTable.status, "rejected"),
      ),
    );

  return {
    consumed: Number(row?.consumed ?? 0),
    approved: Number(row?.approved ?? 0),
  };
}

async function purchasedHours(clientId: number): Promise<number> {
  const [row] = await db
    .select({
      total: sql<number>`coalesce(sum(${hourBlocksTable.hours}), 0)`,
    })
    .from(hourBlocksTable)
    .where(eq(hourBlocksTable.clientId, clientId));

  return Number(row?.total ?? 0);
}

/** Every block bought by this client, newest purchase first, plus the balance. */
router.get(
  "/clients/:clientId/hour-blocks",
  async (req, res): Promise<void> => {
    const clientId = parseId(req.params.clientId);
    if (!clientId) {
      res.status(400).json({ error: "Invalid client id" });
      return;
    }

    const me = principal(req);
    if (!(await isClientVisible(me, clientId))) {
      res.status(404).json({ error: "Client not found" });
      return;
    }

    const [client] = await db
      .select({
        id: clientsTable.id,
        name: clientsTable.name,
        engagementType: clientsTable.engagementType,
      })
      .from(clientsTable)
      .where(eq(clientsTable.id, clientId));

    if (!client) {
      res.status(404).json({ error: "Client not found" });
      return;
    }

    const [blocks, purchased, used] = await Promise.all([
      db
        .select({
          id: hourBlocksTable.id,
          hours: hourBlocksTable.hours,
          purchasedOn: hourBlocksTable.purchasedOn,
          note: hourBlocksTable.note,
          createdAt: hourBlocksTable.createdAt,
          createdById: hourBlocksTable.createdById,
          createdByName: usersTable.name,
        })
        .from(hourBlocksTable)
        .innerJoin(usersTable, eq(hourBlocksTable.createdById, usersTable.id))
        .where(eq(hourBlocksTable.clientId, clientId))
        .orderBy(sql`${hourBlocksTable.purchasedOn} desc, ${hourBlocksTable.id} desc`),
      purchasedHours(clientId),
      consumedHours(clientId),
    ]);

    res.json({
      clientId: client.id,
      clientName: client.name,
      engagementType: client.engagementType,
      blocks,
      purchasedHours: purchased,
      consumedHours: used.consumed,
      approvedHours: used.approved,
      remainingHours: purchased - used.consumed,
    });
  },
);

/** Record a purchase. Top-ups are additional blocks, never edits to an old one. */
router.post(
  "/clients/:clientId/hour-blocks",
  requireRole("associate"),
  async (req, res): Promise<void> => {
    const clientId = parseId(req.params.clientId);
    if (!clientId) {
      res.status(400).json({ error: "Invalid client id" });
      return;
    }

    const me = principal(req);
    if (!(await isClientVisible(me, clientId))) {
      res.status(404).json({ error: "Client not found" });
      return;
    }

    const { hours, purchasedOn, note } = req.body as {
      hours?: unknown;
      purchasedOn?: string;
      note?: string;
    };

    const parsedHours = typeof hours === "number" ? hours : Number(hours);
    if (!Number.isFinite(parsedHours) || parsedHours <= 0) {
      res.status(400).json({ error: "Hours must be a number greater than zero" });
      return;
    }

    if (!purchasedOn || !/^\d{4}-\d{2}-\d{2}$/.test(purchasedOn)) {
      res.status(400).json({ error: "purchasedOn must be a YYYY-MM-DD date" });
      return;
    }

    const [client] = await db
      .select({ id: clientsTable.id })
      .from(clientsTable)
      .where(eq(clientsTable.id, clientId));

    if (!client) {
      res.status(404).json({ error: "Client not found" });
      return;
    }

    const [created] = await db
      .insert(hourBlocksTable)
      .values({
        clientId,
        hours: parsedHours,
        purchasedOn,
        note: note?.trim() || null,
        createdById: me.id,
      })
      .returning();

    res.status(201).json(created);
  },
);

/** Remove a block recorded in error. Corrections are deletions, not edits. */
router.delete(
  "/hour-blocks/:id",
  requireRole("associate"),
  async (req, res): Promise<void> => {
    const id = parseId(req.params.id);
    if (!id) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }

    const [block] = await db
      .select({ id: hourBlocksTable.id, clientId: hourBlocksTable.clientId })
      .from(hourBlocksTable)
      .where(eq(hourBlocksTable.id, id));

    if (!block) {
      res.status(404).json({ error: "Hour block not found" });
      return;
    }

    if (!(await isClientVisible(principal(req), block.clientId))) {
      res.status(404).json({ error: "Hour block not found" });
      return;
    }

    await db.delete(hourBlocksTable).where(eq(hourBlocksTable.id, id));
    res.status(204).send();
  },
);

export default router;
