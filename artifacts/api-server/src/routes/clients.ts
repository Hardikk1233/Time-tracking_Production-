import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import {
  db,
  clientsTable,
  clientUsersTable,
  usersTable,
} from "@workspace/db";

const router: IRouter = Router();

router.get("/clients", async (_req, res): Promise<void> => {
  const clients = await db
    .select()
    .from(clientsTable)
    .orderBy(clientsTable.name);
  res.json(clients);
});

router.post("/clients", async (req, res): Promise<void> => {
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

// Client assignments
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
      .where(eq(clientUsersTable.clientId, clientId))
      .orderBy(usersTable.name);

    res.json(
      rows.map((u) => ({
        ...u,
        reportingToId: u.reportingToId ?? null,
        reportingToName: null,
      })),
    );
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
