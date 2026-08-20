import { Router, type IRouter } from "express";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import { config } from "../config";
import { isEntraConfigured } from "../lib/entra";

const router: IRouter = Router();

/**
 * Tells the browser how to sign in, so the login screen can offer the Microsoft
 * button without the tenant details being baked into the frontend bundle at
 * build time. Public by design — none of it is secret.
 */
router.get("/auth/config", (_req, res) => {
  res.json({
    passwordSignIn: !config.entraOnly,
    entra: isEntraConfigured()
      ? {
          tenantId: config.entraTenantId,
          clientId: config.entraSpaClientId ?? null,
          scope: config.entraApiScope ?? null,
        }
      : null,
  });
});

router.post("/auth/login", async (req, res): Promise<void> => {
  // Once Entra is the only way in, this endpoint stops accepting credentials
  // rather than being deleted, so a stale client gets a clear answer.
  if (config.entraOnly) {
    res.status(403).json({ error: "Sign in with your Microsoft account" });
    return;
  }

  const { email, password } = req.body as { email?: string; password?: string };
  if (!email || !password) {
    res.status(400).json({ error: "Email and password are required" });
    return;
  }

  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.email, email.toLowerCase().trim()));

  // Accounts provisioned through Entra carry no password hash; they cannot be
  // signed into this way, and the generic message avoids disclosing which
  // accounts those are.
  if (!user || !user.passwordHash || !bcrypt.compareSync(password, user.passwordHash)) {
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }

  // Deactivating an account previously did nothing: the holder could still sign
  // in and keep working.
  if (!user.isActive) {
    res.status(403).json({ error: "This account has been deactivated" });
    return;
  }

  // Prevents session fixation: the pre-login session id is discarded.
  await new Promise<void>((resolve, reject) => {
    req.session.regenerate((err) => (err ? reject(err) : resolve()));
  });

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
