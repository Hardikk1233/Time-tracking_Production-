import { Router, type IRouter } from "express";
import { and, eq, sql } from "drizzle-orm";
import {
  db,
  clientsTable,
  productsTable,
  productAssignmentsTable,
  usersTable,
} from "@workspace/db";
import { principal, requireRole } from "../middlewares/auth";
import { isClientVisible } from "../lib/scope";
import { parseId } from "../lib/validation";

const router: IRouter = Router();

/**
 * Products — deliverables a client buys, defined firm-wide and handed to
 * somebody to produce.
 *
 * Defining and allocating are both Associate or above, gated by rank rather
 * than by naming roles, so AVP and MD are included without listing them.
 */

/** The catalog. Readable by anyone signed in: analysts need to see what exists. */
router.get("/products", async (_req, res): Promise<void> => {
  const rows = await db
    .select({
      id: productsTable.id,
      name: productsTable.name,
      description: productsTable.description,
      createdAt: productsTable.createdAt,
      createdById: productsTable.createdById,
      createdByName: usersTable.name,
    })
    .from(productsTable)
    .innerJoin(usersTable, eq(productsTable.createdById, usersTable.id))
    .orderBy(productsTable.name);

  res.json(rows);
});

router.post(
  "/products",
  requireRole("associate"),
  async (req, res): Promise<void> => {
    const me = principal(req);
    const { name, description } = req.body as {
      name?: string;
      description?: string;
    };

    const trimmed = name?.trim();
    if (!trimmed) {
      res.status(400).json({ error: "Name is required" });
      return;
    }

    const [existing] = await db
      .select({ id: productsTable.id })
      .from(productsTable)
      .where(sql`lower(${productsTable.name}) = lower(${trimmed})`);

    if (existing) {
      res.status(409).json({ error: "A product with that name already exists" });
      return;
    }

    const [created] = await db
      .insert(productsTable)
      .values({
        name: trimmed,
        description: description?.trim() || null,
        createdById: me.id,
      })
      .returning();

    res.status(201).json(created);
  },
);

router.patch(
  "/products/:id",
  requireRole("associate"),
  async (req, res): Promise<void> => {
    const id = parseId(req.params.id);
    if (!id) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }

    const { name, description } = req.body as {
      name?: string;
      description?: string;
    };

    const updates: Record<string, unknown> = {};
    if (name !== undefined) {
      const trimmed = name.trim();
      if (!trimmed) {
        res.status(400).json({ error: "Name cannot be empty" });
        return;
      }
      updates.name = trimmed;
    }
    if (description !== undefined) {
      updates.description = description.trim() || null;
    }

    if (Object.keys(updates).length === 0) {
      res.status(400).json({ error: "Nothing to update" });
      return;
    }

    const [updated] = await db
      .update(productsTable)
      .set(updates)
      .where(eq(productsTable.id, id))
      .returning();

    if (!updated) {
      res.status(404).json({ error: "Product not found" });
      return;
    }

    res.json(updated);
  },
);

/**
 * Deleting a product removes its assignments with it, by cascade. That is the
 * intent: an assignment to a deliverable that no longer exists is not worth
 * keeping around to be puzzled over.
 */
router.delete(
  "/products/:id",
  requireRole("associate"),
  async (req, res): Promise<void> => {
    const id = parseId(req.params.id);
    if (!id) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }

    const [deleted] = await db
      .delete(productsTable)
      .where(eq(productsTable.id, id))
      .returning({ id: productsTable.id });

    if (!deleted) {
      res.status(404).json({ error: "Product not found" });
      return;
    }

    res.status(204).send();
  },
);

// ─── Allocation ──────────────────────────────────────────────────────────────

/** Who is producing what, for one client. */
router.get(
  "/clients/:clientId/product-assignments",
  async (req, res): Promise<void> => {
    const clientId = parseId(req.params.clientId);
    if (!clientId) {
      res.status(400).json({ error: "Invalid client id" });
      return;
    }

    if (!(await isClientVisible(principal(req), clientId))) {
      res.status(404).json({ error: "Client not found" });
      return;
    }

    const assignee = usersTable;
    const rows = await db
      .select({
        id: productAssignmentsTable.id,
        productId: productAssignmentsTable.productId,
        productName: productsTable.name,
        assigneeUserId: productAssignmentsTable.assigneeUserId,
        assigneeName: assignee.name,
        assigneeRole: assignee.role,
        assignedById: productAssignmentsTable.assignedById,
        assignedAt: productAssignmentsTable.assignedAt,
      })
      .from(productAssignmentsTable)
      .innerJoin(
        productsTable,
        eq(productAssignmentsTable.productId, productsTable.id),
      )
      .innerJoin(assignee, eq(productAssignmentsTable.assigneeUserId, assignee.id))
      .where(eq(productAssignmentsTable.clientId, clientId))
      .orderBy(sql`${productAssignmentsTable.assignedAt} desc`);

    res.json(rows);
  },
);

/** What this caller has been asked to produce, across every client. */
router.get("/my-product-assignments", async (req, res): Promise<void> => {
  const me = principal(req);

  const rows = await db
    .select({
      id: productAssignmentsTable.id,
      productId: productAssignmentsTable.productId,
      productName: productsTable.name,
      productDescription: productsTable.description,
      clientId: productAssignmentsTable.clientId,
      clientName: clientsTable.name,
      assignedAt: productAssignmentsTable.assignedAt,
    })
    .from(productAssignmentsTable)
    .innerJoin(
      productsTable,
      eq(productAssignmentsTable.productId, productsTable.id),
    )
    .innerJoin(clientsTable, eq(productAssignmentsTable.clientId, clientsTable.id))
    .where(eq(productAssignmentsTable.assigneeUserId, me.id))
    .orderBy(sql`${productAssignmentsTable.assignedAt} desc`);

  res.json(rows);
});

router.post(
  "/clients/:clientId/product-assignments",
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

    const { productId, assigneeUserId } = req.body as {
      productId?: unknown;
      assigneeUserId?: unknown;
    };

    const pid = Number(productId);
    const uid = Number(assigneeUserId);
    if (!Number.isInteger(pid) || !Number.isInteger(uid)) {
      res
        .status(400)
        .json({ error: "productId and assigneeUserId are required" });
      return;
    }

    const [[product], [assignee]] = await Promise.all([
      db
        .select({ id: productsTable.id })
        .from(productsTable)
        .where(eq(productsTable.id, pid)),
      db
        .select({ id: usersTable.id, isActive: usersTable.isActive })
        .from(usersTable)
        .where(eq(usersTable.id, uid)),
    ]);

    if (!product) {
      res.status(404).json({ error: "Product not found" });
      return;
    }
    if (!assignee || !assignee.isActive) {
      res.status(400).json({ error: "Assignee is not an active user" });
      return;
    }

    const [already] = await db
      .select({ id: productAssignmentsTable.id })
      .from(productAssignmentsTable)
      .where(
        and(
          eq(productAssignmentsTable.productId, pid),
          eq(productAssignmentsTable.clientId, clientId),
          eq(productAssignmentsTable.assigneeUserId, uid),
        ),
      );

    if (already) {
      res
        .status(409)
        .json({ error: "That product is already assigned to this person" });
      return;
    }

    const [created] = await db
      .insert(productAssignmentsTable)
      .values({
        productId: pid,
        clientId,
        assigneeUserId: uid,
        assignedById: me.id,
      })
      .returning();

    res.status(201).json(created);
  },
);

router.delete(
  "/product-assignments/:id",
  requireRole("associate"),
  async (req, res): Promise<void> => {
    const id = parseId(req.params.id);
    if (!id) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }

    const [row] = await db
      .select({ clientId: productAssignmentsTable.clientId })
      .from(productAssignmentsTable)
      .where(eq(productAssignmentsTable.id, id));

    if (!row) {
      res.status(404).json({ error: "Assignment not found" });
      return;
    }

    if (!(await isClientVisible(principal(req), row.clientId))) {
      res.status(404).json({ error: "Assignment not found" });
      return;
    }

    await db
      .delete(productAssignmentsTable)
      .where(eq(productAssignmentsTable.id, id));

    res.status(204).send();
  },
);

export default router;
