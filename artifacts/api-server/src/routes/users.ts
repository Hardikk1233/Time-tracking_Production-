import { Router, type IRouter } from "express";
import bcrypt from "bcryptjs";
import { eq, and } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";

const router: IRouter = Router();

async function formatUser(user: typeof usersTable.$inferSelect) {
  let reportingToName: string | null = null;
  if (user.reportingToId) {
    const [manager] = await db
      .select({ name: usersTable.name })
      .from(usersTable)
      .where(eq(usersTable.id, user.reportingToId));
    reportingToName = manager?.name ?? null;
  }
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    reportingToId: user.reportingToId ?? null,
    reportingToName,
    createdAt: user.createdAt,
  };
}

router.get("/users", async (req, res): Promise<void> => {
  const { role, reportingToId } = req.query as {
    role?: string;
    reportingToId?: string;
  };

  let query = db.select().from(usersTable).$dynamic();

  const conditions = [];
  if (role) {
    conditions.push(
      eq(
        usersTable.role,
        role as "analyst" | "associate" | "avp" | "md",
      ),
    );
  }
  if (reportingToId) {
    conditions.push(
      eq(usersTable.reportingToId, parseInt(reportingToId, 10)),
    );
  }
  if (conditions.length > 0) {
    query = query.where(and(...conditions));
  }

  const users = await query.orderBy(usersTable.name);

  // Build manager name map
  const managerIds = [
    ...new Set(users.map((u) => u.reportingToId).filter(Boolean)),
  ] as number[];
  const managers: Record<number, string> = {};
  if (managerIds.length > 0) {
    const managerRows = await db
      .select({ id: usersTable.id, name: usersTable.name })
      .from(usersTable)
      .where(
        managerIds.length === 1
          ? eq(usersTable.id, managerIds[0])
          : eq(usersTable.id, managerIds[0]), // simplified; handled per-user below
      );
    managerRows.forEach((m) => {
      managers[m.id] = m.name;
    });
  }

  const result = await Promise.all(users.map(formatUser));
  res.json(result);
});

router.post("/users", async (req, res): Promise<void> => {
  const { name, email, password, role, reportingToId } = req.body as {
    name?: string;
    email?: string;
    password?: string;
    role?: string;
    reportingToId?: number | null;
  };

  if (!name || !email || !password || !role) {
    res.status(400).json({ error: "name, email, password, and role are required" });
    return;
  }

  const passwordHash = bcrypt.hashSync(password, 10);

  const [user] = await db
    .insert(usersTable)
    .values({
      name,
      email: email.toLowerCase().trim(),
      passwordHash,
      role: role as "analyst" | "associate" | "avp" | "md",
      reportingToId: reportingToId ?? null,
    })
    .returning();

  res.status(201).json(await formatUser(user));
});

router.get("/users/:userId", async (req, res): Promise<void> => {
  const userId = parseInt(
    Array.isArray(req.params.userId) ? req.params.userId[0] : req.params.userId,
    10,
  );
  if (isNaN(userId)) {
    res.status(400).json({ error: "Invalid user ID" });
    return;
  }

  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, userId));

  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  res.json(await formatUser(user));
});

router.patch("/users/:userId", async (req, res): Promise<void> => {
  const userId = parseInt(
    Array.isArray(req.params.userId) ? req.params.userId[0] : req.params.userId,
    10,
  );
  if (isNaN(userId)) {
    res.status(400).json({ error: "Invalid user ID" });
    return;
  }

  const { name, email, role, reportingToId, password } = req.body as {
    name?: string;
    email?: string;
    role?: string;
    reportingToId?: number | null;
    password?: string;
  };

  const updates: Partial<typeof usersTable.$inferInsert> = {};
  if (name) updates.name = name;
  if (email) updates.email = email.toLowerCase().trim();
  if (role) updates.role = role as "analyst" | "associate" | "avp" | "md";
  if (reportingToId !== undefined) updates.reportingToId = reportingToId;
  if (password) updates.passwordHash = bcrypt.hashSync(password, 10);

  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "No fields to update" });
    return;
  }

  const [user] = await db
    .update(usersTable)
    .set(updates)
    .where(eq(usersTable.id, userId))
    .returning();

  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  res.json(await formatUser(user));
});

router.delete("/users/:userId", async (req, res): Promise<void> => {
  const userId = parseInt(
    Array.isArray(req.params.userId) ? req.params.userId[0] : req.params.userId,
    10,
  );
  if (isNaN(userId)) {
    res.status(400).json({ error: "Invalid user ID" });
    return;
  }

  try {
    const [user] = await db
      .delete(usersTable)
      .where(eq(usersTable.id, userId))
      .returning();

    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    res.json({ message: "User deleted" });
  } catch (err: any) {
    // Drizzle wraps the pg error; the FK violation code is on err.cause
    const pgCode = err?.code ?? err?.cause?.code;
    if (pgCode === "23503") {
      res.status(400).json({
        error: "Cannot delete a user who has logged time entries. Remove their time entries first, or deactivate the account instead.",
      });
      return;
    }
    throw err;
  }
});

export default router;
