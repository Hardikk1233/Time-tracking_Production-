import { Router, type IRouter, type Request, type Response } from "express";
import { eq, and, inArray } from "drizzle-orm";
import {
  db,
  clientsTable,
  clientUsersTable,
  clientFteHistoryTable,
  usersTable,
} from "@workspace/db";
import { principal, requireRole, type Principal } from "../middlewares/auth";
import { visibleClientIds } from "../lib/scope";
import { parseId } from "../lib/validation";

const router: IRouter = Router();

// ─── Scope ───────────────────────────────────────────────────────────────────

/**
 * Clients this person is assigned to. `null` means unrestricted (MD).
 *
 * This is the *management* view — who owns the relationship — which is why it
 * reads client assignments rather than reaching through projects the way the
 * dashboard's data-visibility scope does.
 */
/**
 * The commercial arrangements a client can be on.
 *
 * Kept as a literal list checked here rather than trusting the request body:
 * the column is a text enum, so an unrecognised value would otherwise reach
 * Postgres and fail as a constraint violation instead of a clear 400.
 */
const ENGAGEMENT_TYPES = ["fte", "block_hours", "product"] as const;
type EngagementType = (typeof ENGAGEMENT_TYPES)[number];

const ENGAGEMENT_TYPE_ERROR = `engagementType must be one of: ${ENGAGEMENT_TYPES.join(", ")}`;

function isEngagementType(value: unknown): value is EngagementType {
  return (
    typeof value === "string" &&
    (ENGAGEMENT_TYPES as readonly string[]).includes(value)
  );
}

// Which clients the caller may see is answered by visibleClientIds in
// lib/scope, and only there. This file used to keep its own copy that counted
// client assignments alone, and the two answers drifting apart produced a bug
// in each direction: first an associate who could list a client but not create
// its first project, then an analyst on a project team whose Log Time dialog
// offered no clients at all. Write access is unaffected - every mutating route
// here is gated at requireRole("avp") regardless of visibility.

/**
 * Resolves the client id and confirms the caller is entitled to it, answering
 * the request itself when they are not.
 *
 * The sub-resource routes below previously performed no check at all, so any
 * signed-in person could read a client's staffing or its commercial FTE
 * history; the write routes checked role but never scope, so an AVP could edit
 * an account belonging to another AVP.
 */
async function resolveClient(
  req: Request,
  res: Response,
): Promise<number | null> {
  const clientId = parseId(req.params.clientId);
  if (!clientId) {
    res.status(400).json({ error: "Invalid client ID" });
    return null;
  }

  const allowed = await visibleClientIds(principal(req));
  if (allowed !== null && !allowed.includes(clientId)) {
    // 404 rather than 403 — existence is not something to disclose.
    res.status(404).json({ error: "Client not found" });
    return null;
  }
  return clientId;
}

// ─── Clients ─────────────────────────────────────────────────────────────────

router.get("/clients", async (req, res): Promise<void> => {
  const visibleIds = await visibleClientIds(principal(req));

  type ClientRow = typeof clientsTable.$inferSelect;
  let clients: ClientRow[];
  if (visibleIds === null) {
    clients = await db.select().from(clientsTable).orderBy(clientsTable.name);
  } else if (visibleIds.length === 0) {
    clients = [];
  } else {
    clients = await db
      .select()
      .from(clientsTable)
      .where(inArray(clientsTable.id, visibleIds))
      .orderBy(clientsTable.name);
  }

  res.json(clients);
});

router.post("/clients", requireRole("avp"), async (req, res): Promise<void> => {
  const me = principal(req);
  const { name, description, fteCount, engagementType, associateIds } =
    req.body as {
      name?: string;
      description?: string;
      fteCount?: number;
      engagementType?: string;
      associateIds?: number[];
    };

  if (!name?.trim()) {
    res.status(400).json({ error: "name is required" });
    return;
  }

  const fte =
    typeof fteCount === "number" && fteCount >= 0.1 && fteCount <= 100
      ? fteCount
      : 1;

  if (engagementType !== undefined && !isEngagementType(engagementType)) {
    res.status(400).json({ error: ENGAGEMENT_TYPE_ERROR });
    return;
  }

  const [client] = await db
    .insert(clientsTable)
    .values({
      name: name.trim(),
      description: description ?? null,
      fteCount: fte,
      // Omitted rather than defaulted here, so the column default stays the
      // single place "fte" is decided.
      ...(engagementType ? { engagementType } : {}),
    })
    .returning();

  // The creator is assigned so the client stays visible to them.
  const assignees = new Set<number>([me.id]);
  if (Array.isArray(associateIds)) {
    associateIds.forEach((id) => typeof id === "number" && assignees.add(id));
  }

  await db
    .insert(clientUsersTable)
    .values([...assignees].map((userId) => ({ clientId: client.id, userId })))
    .onConflictDoNothing();

  res.status(201).json(client);
});

router.get("/clients/:clientId", async (req, res): Promise<void> => {
  const clientId = await resolveClient(req, res);
  if (!clientId) return;

  const [client] = await db
    .select()
    .from(clientsTable)
    .where(eq(clientsTable.id, clientId));

  if (!client) {
    res.status(404).json({ error: "Client not found" });
    return;
  }

  res.json(client);
});

router.patch(
  "/clients/:clientId",
  requireRole("avp"),
  async (req, res): Promise<void> => {
    const clientId = await resolveClient(req, res);
    if (!clientId) return;

    const { name, description, fteCount, engagementType, isActive } =
      req.body as {
        name?: string;
        description?: string | null;
        fteCount?: number;
        engagementType?: string;
        isActive?: boolean;
      };

    const updates: Partial<typeof clientsTable.$inferInsert> = {};
    if (name !== undefined) {
      if (!name.trim()) {
        res.status(400).json({ error: "name cannot be empty" });
        return;
      }
      updates.name = name.trim();
    }
    if (description !== undefined) updates.description = description;
    if (fteCount !== undefined) {
      if (typeof fteCount !== "number" || fteCount < 0.1 || fteCount > 100) {
        res.status(400).json({ error: "fteCount must be between 0.1 and 100" });
        return;
      }
      updates.fteCount = fteCount;
    }
    if (engagementType !== undefined) {
      if (!isEngagementType(engagementType)) {
        res.status(400).json({ error: ENGAGEMENT_TYPE_ERROR });
        return;
      }
      // Switching away from block_hours leaves the purchased blocks in place
      // rather than deleting them: the client did buy those hours, and a type
      // changed by mistake should be recoverable by changing it back.
      updates.engagementType = engagementType;
    }
    if (isActive !== undefined) updates.isActive = isActive;

    if (Object.keys(updates).length === 0) {
      res.status(400).json({ error: "No fields to update" });
      return;
    }

    const [client] = await db
      .update(clientsTable)
      .set(updates)
      .where(eq(clientsTable.id, clientId))
      .returning();

    if (!client) {
      res.status(404).json({ error: "Client not found" });
      return;
    }

    res.json(client);
  },
);

router.delete(
  "/clients/:clientId",
  requireRole("avp"),
  async (req, res): Promise<void> => {
    const clientId = await resolveClient(req, res);
    if (!clientId) return;

    try {
      const [client] = await db
        .delete(clientsTable)
        .where(eq(clientsTable.id, clientId))
        .returning();

      if (!client) {
        res.status(404).json({ error: "Client not found" });
        return;
      }
      res.json({ message: "Client deleted" });
    } catch (err: unknown) {
      // Projects cascade, but the time entries beneath them do not — this
      // previously surfaced as an unexplained 500.
      const pgCode =
        (err as { code?: string; cause?: { code?: string } })?.code ??
        (err as { cause?: { code?: string } })?.cause?.code;
      if (pgCode === "23503") {
        res.status(400).json({
          error:
            "Cannot delete a client whose projects have time entries logged against them. Deactivate it instead.",
        });
        return;
      }
      throw err;
    }
  },
);

// ─── Assignments ─────────────────────────────────────────────────────────────

router.get("/clients/:clientId/assignments", async (req, res): Promise<void> => {
  const clientId = await resolveClient(req, res);
  if (!clientId) return;

  const rows = await db
    .select({
      id: usersTable.id,
      name: usersTable.name,
      email: usersTable.email,
      role: usersTable.role,
      reportingToId: usersTable.reportingToId,
      createdAt: usersTable.createdAt,
    })
    .from(clientUsersTable)
    .innerJoin(usersTable, eq(clientUsersTable.userId, usersTable.id))
    .where(eq(clientUsersTable.clientId, clientId));

  res.json(rows);
});

router.post(
  "/clients/:clientId/assignments",
  requireRole("avp"),
  async (req, res): Promise<void> => {
    const clientId = await resolveClient(req, res);
    if (!clientId) return;

    const { userId } = req.body as { userId?: number };
    if (!userId) {
      res.status(400).json({ error: "userId is required" });
      return;
    }

    const [target] = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.id, userId));
    if (!target) {
      res.status(400).json({ error: "userId does not match a user" });
      return;
    }

    await db
      .insert(clientUsersTable)
      .values({ clientId, userId })
      .onConflictDoNothing();

    res.json({ message: "User assigned to client" });
  },
);

router.delete(
  "/clients/:clientId/assignments/:userId",
  requireRole("avp"),
  async (req, res): Promise<void> => {
    const clientId = await resolveClient(req, res);
    if (!clientId) return;

    const userId = parseId(req.params.userId);
    if (!userId) {
      res.status(400).json({ error: "Invalid user ID" });
      return;
    }

    await db
      .delete(clientUsersTable)
      .where(
        and(
          eq(clientUsersTable.clientId, clientId),
          eq(clientUsersTable.userId, userId),
        ),
      );

    res.json({ message: "User removed from client" });
  },
);

// ─── FTE history ─────────────────────────────────────────────────────────────
// Contracted capacity is commercial data and drives billing, so the whole
// resource — reads included — is AVP and above.

router.get(
  "/clients/:clientId/fte-history",
  requireRole("avp"),
  async (req, res): Promise<void> => {
    const clientId = await resolveClient(req, res);
    if (!clientId) return;

    const rows = await db
      .select()
      .from(clientFteHistoryTable)
      .where(eq(clientFteHistoryTable.clientId, clientId))
      .orderBy(clientFteHistoryTable.effectiveFrom);

    res.json(rows);
  },
);

router.post(
  "/clients/:clientId/fte-history",
  requireRole("avp"),
  async (req, res): Promise<void> => {
    const clientId = await resolveClient(req, res);
    if (!clientId) return;

    const { fteCount, effectiveFrom, effectiveTo } = req.body as {
      fteCount?: number;
      effectiveFrom?: string;
      effectiveTo?: string | null;
    };

    if (typeof fteCount !== "number" || fteCount < 0.1 || fteCount > 100) {
      res.status(400).json({ error: "fteCount must be between 0.1 and 100" });
      return;
    }
    if (!effectiveFrom || !/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) {
      res.status(400).json({ error: "effectiveFrom (YYYY-MM-DD) is required" });
      return;
    }
    if (effectiveTo && !/^\d{4}-\d{2}-\d{2}$/.test(effectiveTo)) {
      res.status(400).json({ error: "effectiveTo must be YYYY-MM-DD if provided" });
      return;
    }
    if (effectiveTo && effectiveTo < effectiveFrom) {
      res
        .status(400)
        .json({ error: "effectiveTo must be on or after effectiveFrom" });
      return;
    }

    const [row] = await db
      .insert(clientFteHistoryTable)
      .values({
        clientId,
        fteCount,
        effectiveFrom,
        effectiveTo: effectiveTo ?? null,
      })
      .returning();

    res.status(201).json(row);
  },
);

router.delete(
  "/clients/:clientId/fte-history/:entryId",
  requireRole("avp"),
  async (req, res): Promise<void> => {
    const clientId = await resolveClient(req, res);
    if (!clientId) return;

    const entryId = parseId(req.params.entryId);
    if (!entryId) {
      res.status(400).json({ error: "Invalid entry ID" });
      return;
    }

    const [deleted] = await db
      .delete(clientFteHistoryTable)
      .where(
        and(
          eq(clientFteHistoryTable.id, entryId),
          eq(clientFteHistoryTable.clientId, clientId),
        ),
      )
      .returning();

    if (!deleted) {
      res.status(404).json({ error: "FTE history entry not found" });
      return;
    }
    res.json({ message: "FTE history entry deleted" });
  },
);

export default router;
