import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import {
  db,
  projectsTable,
  clientsTable,
  projectUsersTable,
  usersTable,
} from "@workspace/db";

const router: IRouter = Router();

router.get("/projects", async (req, res): Promise<void> => {
  const { clientId } = req.query as { clientId?: string };

  const rows = await db
    .select({
      id: projectsTable.id,
      clientId: projectsTable.clientId,
      clientName: clientsTable.name,
      name: projectsTable.name,
      description: projectsTable.description,
      createdAt: projectsTable.createdAt,
    })
    .from(projectsTable)
    .innerJoin(clientsTable, eq(projectsTable.clientId, clientsTable.id))
    .where(
      clientId ? eq(projectsTable.clientId, parseInt(clientId, 10)) : undefined,
    )
    .orderBy(projectsTable.name);

  res.json(rows);
});

router.post("/projects", async (req, res): Promise<void> => {
  const { clientId, name, description } = req.body as {
    clientId?: number;
    name?: string;
    description?: string;
  };

  if (!clientId || !name) {
    res.status(400).json({ error: "clientId and name are required" });
    return;
  }

  const [project] = await db
    .insert(projectsTable)
    .values({ clientId, name, description: description ?? null })
    .returning();

  const [client] = await db
    .select({ name: clientsTable.name })
    .from(clientsTable)
    .where(eq(clientsTable.id, clientId));

  res.status(201).json({
    ...project,
    clientName: client?.name ?? "",
  });
});

router.get("/projects/:projectId", async (req, res): Promise<void> => {
  const projectId = parseInt(
    Array.isArray(req.params.projectId)
      ? req.params.projectId[0]
      : req.params.projectId,
    10,
  );
  if (isNaN(projectId)) {
    res.status(400).json({ error: "Invalid project ID" });
    return;
  }

  const [row] = await db
    .select({
      id: projectsTable.id,
      clientId: projectsTable.clientId,
      clientName: clientsTable.name,
      name: projectsTable.name,
      description: projectsTable.description,
      createdAt: projectsTable.createdAt,
    })
    .from(projectsTable)
    .innerJoin(clientsTable, eq(projectsTable.clientId, clientsTable.id))
    .where(eq(projectsTable.id, projectId));

  if (!row) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  res.json(row);
});

router.patch("/projects/:projectId", async (req, res): Promise<void> => {
  const projectId = parseInt(
    Array.isArray(req.params.projectId)
      ? req.params.projectId[0]
      : req.params.projectId,
    10,
  );
  if (isNaN(projectId)) {
    res.status(400).json({ error: "Invalid project ID" });
    return;
  }

  const { name, description } = req.body as {
    name?: string;
    description?: string | null;
  };

  const updates: Partial<typeof projectsTable.$inferInsert> = {};
  if (name) updates.name = name;
  if (description !== undefined) updates.description = description;

  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "No fields to update" });
    return;
  }

  const [project] = await db
    .update(projectsTable)
    .set(updates)
    .where(eq(projectsTable.id, projectId))
    .returning();

  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const [client] = await db
    .select({ name: clientsTable.name })
    .from(clientsTable)
    .where(eq(clientsTable.id, project.clientId));

  res.json({ ...project, clientName: client?.name ?? "" });
});

router.delete("/projects/:projectId", async (req, res): Promise<void> => {
  const projectId = parseInt(
    Array.isArray(req.params.projectId)
      ? req.params.projectId[0]
      : req.params.projectId,
    10,
  );
  if (isNaN(projectId)) {
    res.status(400).json({ error: "Invalid project ID" });
    return;
  }

  const [project] = await db
    .delete(projectsTable)
    .where(eq(projectsTable.id, projectId))
    .returning();

  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  res.json({ message: "Project deleted" });
});

// Project assignments
router.get(
  "/projects/:projectId/assignments",
  async (req, res): Promise<void> => {
    const projectId = parseInt(
      Array.isArray(req.params.projectId)
        ? req.params.projectId[0]
        : req.params.projectId,
      10,
    );
    if (isNaN(projectId)) {
      res.status(400).json({ error: "Invalid project ID" });
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
      .from(projectUsersTable)
      .innerJoin(usersTable, eq(projectUsersTable.userId, usersTable.id))
      .where(eq(projectUsersTable.projectId, projectId))
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
  "/projects/:projectId/assignments",
  async (req, res): Promise<void> => {
    const projectId = parseInt(
      Array.isArray(req.params.projectId)
        ? req.params.projectId[0]
        : req.params.projectId,
      10,
    );
    if (isNaN(projectId)) {
      res.status(400).json({ error: "Invalid project ID" });
      return;
    }

    const { userId } = req.body as { userId?: number };
    if (!userId) {
      res.status(400).json({ error: "userId is required" });
      return;
    }

    await db
      .insert(projectUsersTable)
      .values({ projectId, userId })
      .onConflictDoNothing();

    res.json({ message: "User assigned to project" });
  },
);

router.delete(
  "/projects/:projectId/assignments/:userId",
  async (req, res): Promise<void> => {
    const projectId = parseInt(
      Array.isArray(req.params.projectId)
        ? req.params.projectId[0]
        : req.params.projectId,
      10,
    );
    const userId = parseInt(
      Array.isArray(req.params.userId)
        ? req.params.userId[0]
        : req.params.userId,
      10,
    );
    if (isNaN(projectId) || isNaN(userId)) {
      res.status(400).json({ error: "Invalid IDs" });
      return;
    }

    await db
      .delete(projectUsersTable)
      .where(
        and(
          eq(projectUsersTable.projectId, projectId),
          eq(projectUsersTable.userId, userId),
        ),
      );

    res.json({ message: "User removed from project" });
  },
);

export default router;
