import { Router, type IRouter } from "express";
import { principal } from "../middlewares/auth";
import { db, publicHolidaysTable } from "@workspace/db";
import { eq, asc } from "drizzle-orm";
import { usersTable } from "@workspace/db";

const router: IRouter = Router();

// ─── List public holidays ─────────────────────────────────────────────────────

router.get("/public-holidays", async (_req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(publicHolidaysTable)
    .orderBy(asc(publicHolidaysTable.date));
  res.json(rows);
});

// ─── Create public holiday (MD only) ─────────────────────────────────────────

router.post("/public-holidays", async (req, res): Promise<void> => {
  const [u] = await db
    .select({ role: usersTable.role })
    .from(usersTable)
    .where(eq(usersTable.id, principal(req).id));
  if (u?.role !== "md") {
    res.status(403).json({ error: "Only MDs can manage public holidays" });
    return;
  }

  const { date, name } = req.body as { date?: string; name?: string };
  if (!date || !name) {
    res.status(400).json({ error: "date and name are required" });
    return;
  }

  const [holiday] = await db
    .insert(publicHolidaysTable)
    .values({ date, name })
    .returning();
  res.status(201).json(holiday);
});

// ─── Delete public holiday (MD only) ─────────────────────────────────────────

router.delete("/public-holidays/:id", async (req, res): Promise<void> => {
  const [u] = await db
    .select({ role: usersTable.role })
    .from(usersTable)
    .where(eq(usersTable.id, principal(req).id));
  if (u?.role !== "md") {
    res.status(403).json({ error: "Only MDs can manage public holidays" });
    return;
  }

  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid ID" });
    return;
  }

  await db
    .delete(publicHolidaysTable)
    .where(eq(publicHolidaysTable.id, id));
  res.json({ message: "Holiday deleted" });
});

export default router;
