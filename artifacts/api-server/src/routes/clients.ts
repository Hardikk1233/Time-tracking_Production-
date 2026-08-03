import { Router, type IRouter } from "express";
import { eq, and, inArray } from "drizzle-orm";
import {
  db,
  clientsTable,
  clientUsersTable,
  usersTable,
} from "@workspace/db";

const router: IRouter = Router();

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function getCurrentUserRole(userId: number) {
  const [u] = await db
    .select({ role: usersTable.role })
    .from(usersTable)
    .where(eq(usersTable.id, userId));
  return u?.role ?? "analyst";
}

async function getVisibleClientIds(userId: number, role: string): Promise<number[] | null> {
  if (role === "md") return null; // no restriction

  // AVP, Associate, Analyst — see only clients they are assigned to
  const rows = await db
    .select({ clientId: clientUsersTable.clientId })
    .from(clientUsersTable)
    .where(eq(clientUsersTable.userId, userId));

  return rows.map((r) => r.clientId);
}

// ─── Routes ──────────────────────────────────────────────────────────────────

router.get("/clients", async (req, res): Promise<void> => {
  const role = await getCurrentUserRole(req.session.userId!);
  const visibleIds = await getVisibleClientIds(req.session.userId!, role);

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

router.post("/clients", async (req, res): Promise<void> => {
  const role = await getCurrentUserRole(req.session.userId!);
  if (!["avp", "md"].includes(role)) {
    res.status(403).json({ error: "Only AVPs and MDs can create clients" });
    return;
  }

  const { name, description } = req.body as {
    name?: string;
    description?: string;
  };
  if (!name) {
    res.status(400).json({ error: "name is required" });
    return;
  }

  const [client] = await db
    .insert(clientsTable)
    .values({ name, description: description ?? null })
    .returning();

  // Auto-assign the creating AVP/MD so they can see the client they created
  await db
    .insert(clientUsersTable)
    .values({ clientId: client.id, userId: req.session.userId! })
    .onConflictDoNothing();

  res.status(201).json(client);
});

router.get("/clients/:clientId", async (req, res): Promise<void> => {
  const clientId = parseInt(
    Array.isArray(req.params.clientId)
      ? req.params.clientId[0]
      : req.params.clientId,
    10,
  );
  if (isNaN(clientId)) {
    res.status(400).json({ error: "Invalid client ID" });
    return;
  }

  const role = await getCurrentUserRole(req.session.userId!);
  const visibleIds = await getVisibleClientIds(req.session.userId!, role);

  if (visibleIds !== null && !visibleIds.includes(clientId)) {
    res.status(403).json({ error: "Access denied" });
    return;
  }

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

router.patch("/clients/:clientId", async (req, res): Promise<void> => {
  const clientId = parseInt(
    Array.isArray(req.params.clientId)
      ? req.params.clientId[0]
      : req.params.clientId,
    10,
  );
  if (isNaN(clientId)) {
    res.status(400).json({ error: "Invalid client ID" });
    return;
  }

  const role = await getCurrentUserRole(req.session.userId!);
  if (!["avp", "md"].includes(role)) {
    res.status(403).json({ error: "Only AVPs and MDs can edit clients" });
    return;
  }

  const { name, description } = req.body as {
    name?: string;
    description?: string | null;
  };

  const updates: Partial<typeof clientsTable.$inferInsert> = {};
  if (name) updates.name = name;
  if (description !== undefined) updates.description = description;

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
});

router.delete("/clients/:clientId", async (req, res): Promise<void> => {
  const clientId = parseInt(
    Array.isArray(req.params.clientId)
      ? req.params.clientId[0]
      : req.params.clientId,
    10,
  );
  if (isNaN(clientId)) {
    res.status(400).json({ error: "Invalid client ID" });
    return;
  }

  const role = await getCurrentUserRole(req.session.userId!);
  if (!["avp", "md"].includes(role)) {
    res.status(403).json({ error: "Only AVPs and MDs can delete clients" });
    return;
  }

  const [client] = await db
    .delete(clientsTable)
    .where(eq(clientsTable.id, clientId))
    .returning();

  if (!client) {
    res.status(404).json({ error: "Client not found" });
    return;
  }

  res.json({ message: "Client deleted" });
});

// ─── Client assignments ───────────────────────────────────────────────────────

router.get(
  "/clients/:clientId/assignments",
  async (req, res): Promise<void> => {
    const clientId = parseInt(
      Array.isArray(req.params.clientId)
        ? req.params.clientId[0]
        : req.params.clientId,
      10,
    );
    if (isNaN(clientId)) {
      res.status(400).json({ error: "Invalid client ID" });
      return;
    }

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
  },
);

router.post(
  "/clients/:clientId/assignments",
  async (req, res): Promise<void> => {
    const clientId = parseInt(
      Array.isArray(req.params.clientId)
        ? req.params.clientId[0]
        : req.params.clientId,
      10,
    );
    if (isNaN(clientId)) {
      res.status(400).json({ error: "Invalid client ID" });
      return;
    }

    const role = await getCurrentUserRole(req.session.userId!);
    if (!["avp", "md"].includes(role)) {
      res.status(403).json({ error: "Only AVPs and MDs can assign users to clients" });
      return;
    }

    const { userId } = req.body as { userId?: number };
    if (!userId) {
      res.status(400).json({ error: "userId is required" });
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
  async (req, res): Promise<void> => {
    const clientId = parseInt(
      Array.isArray(req.params.clientId)
        ? req.params.clientId[0]
        : req.params.clientId,
      10,
    );
    const userId = parseInt(
      Array.isArray(req.params.userId)
        ? req.params.userId[0]
        : req.params.userId,
      10,
    );
    if (isNaN(clientId) || isNaN(userId)) {
      res.status(400).json({ error: "Invalid IDs" });
      return;
    }

    const role = await getCurrentUserRole(req.session.userId!);
    if (!["avp", "md"].includes(role)) {
      res.status(403).json({ error: "Only AVPs and MDs can remove users from clients" });
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

export default router;
