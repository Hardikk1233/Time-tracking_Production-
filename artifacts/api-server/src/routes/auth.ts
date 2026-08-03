import { Router, type IRouter } from "express";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";

const router: IRouter = Router();

router.post("/auth/login", async (req, res): Promise<void> => {
  const { email, password } = req.body as { email?: string; password?: string };
  if (!email || !password) {
    res.status(400).json({ error: "Email and password are required" });
    return;
  }

  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.email, email.toLowerCase().trim()));

  if (!user || !bcrypt.compareSync(password, user.passwordHash)) {
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }

  req.session.userId = user.id;

  let reportingToName: string | null = null;
  if (user.reportingToId) {
    const [manager] = await db
      .select({ name: usersTable.name })
      .from(usersTable)
      .where(eq(usersTable.id, user.reportingToId));
    reportingToName = manager?.name ?? null;
  }

  res.json({
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    reportingToId: user.reportingToId ?? null,
    reportingToName,
    createdAt: user.createdAt,
  });
});

router.post("/auth/logout", async (req, res): Promise<void> => {
  req.session.destroy(() => {});
  res.json({ message: "Logged out successfully" });
});

router.get("/auth/me", async (req, res): Promise<void> => {
  if (!req.session.userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, req.session.userId));

  if (!user) {
    req.session.destroy(() => {});
    res.status(401).json({ error: "User not found" });
    return;
  }

  let reportingToName: string | null = null;
  if (user.reportingToId) {
    const [manager] = await db
      .select({ name: usersTable.name })
      .from(usersTable)
      .where(eq(usersTable.id, user.reportingToId));
    reportingToName = manager?.name ?? null;
  }

  res.json({
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    reportingToId: user.reportingToId ?? null,
    reportingToName,
    createdAt: user.createdAt,
  });
});

export default router;
