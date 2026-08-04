import { Router, type IRouter } from "express";
import { eq, and, gte, lte, inArray } from "drizzle-orm";
import { db, leavesTable, usersTable } from "@workspace/db";

const router: IRouter = Router();

// ─── List leaves ──────────────────────────────────────────────────────────────
// Analysts see only their own; Associates see self + their Analysts;
// AVP/MD see all in their team.

router.get("/leaves", async (req, res): Promise<void> => {
  const currentUserId = req.session.userId!;
  const { startDate, endDate, userId } = req.query as {
    startDate?: string;
    endDate?: string;
    userId?: string;
  };

  const [currentUser] = await db
    .select({ role: usersTable.role })
    .from(usersTable)
    .where(eq(usersTable.id, currentUserId));
  const role = currentUser?.role ?? "analyst";

  const conditions = [];
  if (startDate) conditions.push(gte(leavesTable.date, startDate));
  if (endDate) conditions.push(lte(leavesTable.date, endDate));

  // Determine which user IDs are visible
  let visibleUserIds: number[] | null = null;
  if (role === "analyst") {
    visibleUserIds = [currentUserId];
  } else if (role === "associate") {
    // Self + analysts reporting to this associate
    const reportees = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(and(eq(usersTable.role, "analyst"), eq(usersTable.reportingToId, currentUserId)));
    visibleUserIds = [currentUserId, ...reportees.map((r) => r.id)];
  }
  // avp and md: no restriction on user IDs

  if (userId) {
    const targetId = parseInt(userId, 10);
    if (!isNaN(targetId)) {
      if (visibleUserIds !== null && !visibleUserIds.includes(targetId)) {
        res.status(403).json({ error: "Access denied" });
        return;
      }
      conditions.push(eq(leavesTable.userId, targetId));
    }
  } else if (visibleUserIds !== null) {
    if (visibleUserIds.length === 0) {
      res.json([]);
      return;
    }
    conditions.push(inArray(leavesTable.userId, visibleUserIds));
  }

  const rows = await db
    .select({
      id: leavesTable.id,
      userId: leavesTable.userId,
      userName: usersTable.name,
      userRole: usersTable.role,
      date: leavesTable.date,
      note: leavesTable.note,
      createdAt: leavesTable.createdAt,
    })
    .from(leavesTable)
    .innerJoin(usersTable, eq(leavesTable.userId, usersTable.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(leavesTable.date);

  res.json(rows);
});

// ─── Log a leave day ──────────────────────────────────────────────────────────

router.post("/leaves", async (req, res): Promise<void> => {
  const currentUserId = req.session.userId!;
  const { date, note } = req.body as { date?: string; note?: string };

  if (!date) {
    res.status(400).json({ error: "date is required" });
    return;
  }

  // Validate date format YYYY-MM-DD
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    res.status(400).json({ error: "date must be in YYYY-MM-DD format" });
    return;
  }

  // Prevent duplicate leaves for same user+date
  const [existing] = await db
    .select({ id: leavesTable.id })
    .from(leavesTable)
    .where(and(eq(leavesTable.userId, currentUserId), eq(leavesTable.date, date)));

  if (existing) {
    res.status(409).json({ error: "Leave already logged for this date" });
    return;
  }

  const [leave] = await db
    .insert(leavesTable)
    .values({ userId: currentUserId, date, note: note ?? null })
    .returning();

  const [withUser] = await db
    .select({
      id: leavesTable.id,
      userId: leavesTable.userId,
      userName: usersTable.name,
      userRole: usersTable.role,
      date: leavesTable.date,
      note: leavesTable.note,
      createdAt: leavesTable.createdAt,
    })
    .from(leavesTable)
    .innerJoin(usersTable, eq(leavesTable.userId, usersTable.id))
    .where(eq(leavesTable.id, leave.id));

  res.status(201).json(withUser);
});

// ─── Delete a leave ───────────────────────────────────────────────────────────

router.delete("/leaves/:id", async (req, res): Promise<void> => {
  const currentUserId = req.session.userId!;
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid ID" });
    return;
  }

  // Check ownership (managers can delete any leave in their scope)
  const [leave] = await db
    .select({ userId: leavesTable.userId })
    .from(leavesTable)
    .where(eq(leavesTable.id, id));

  if (!leave) {
    res.status(404).json({ error: "Leave not found" });
    return;
  }

  const [currentUser] = await db
    .select({ role: usersTable.role })
    .from(usersTable)
    .where(eq(usersTable.id, currentUserId));
  const role = currentUser?.role ?? "analyst";

  const canDelete =
    leave.userId === currentUserId || ["avp", "md"].includes(role);
  if (!canDelete) {
    res.status(403).json({ error: "Access denied" });
    return;
  }

  await db.delete(leavesTable).where(eq(leavesTable.id, id));
  res.json({ message: "Leave deleted" });
});

export default router;
