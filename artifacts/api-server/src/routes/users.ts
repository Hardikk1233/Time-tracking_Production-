import { Router, type IRouter } from "express";
import bcrypt from "bcryptjs";
import { eq, and, inArray } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import { principal, requireRole } from "../middlewares/auth";
import { isRole, outranks, type Role } from "../lib/roles";
import { parseId } from "../lib/validation";

const router: IRouter = Router();

const MIN_PASSWORD_LENGTH = 12;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type UserRow = typeof usersTable.$inferSelect;

function formatUser(user: UserRow, managerNames: Map<number, string>) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    reportingToId: user.reportingToId ?? null,
    reportingToName:
      user.reportingToId != null
        ? managerNames.get(user.reportingToId) ?? null
        : null,
    isActive: user.isActive,
    createdAt: user.createdAt,
  };
}

/** Resolves every manager name in one query instead of one per user. */
async function managerNamesFor(users: UserRow[]): Promise<Map<number, string>> {
  const ids = [
    ...new Set(
      users.map((u) => u.reportingToId).filter((id): id is number => id != null),
    ),
  ];
  const names = new Map<number, string>();
  if (ids.length === 0) return names;

  const rows = await db
    .select({ id: usersTable.id, name: usersTable.name })
    .from(usersTable)
    .where(inArray(usersTable.id, ids));
  rows.forEach((r) => names.set(r.id, r.name));
  return names;
}

// ─── Read ────────────────────────────────────────────────────────────────────
// The team directory stays readable to any signed-in colleague: the app needs
// it for approver, assignee and reporting-line pickers.

router.get("/users", async (req, res): Promise<void> => {
  const { role, reportingToId } = req.query as {
    role?: string;
    reportingToId?: string;
  };

  const conditions = [];
  if (role) {
    if (!isRole(role)) {
      res.status(400).json({ error: "Unknown role" });
      return;
    }
    conditions.push(eq(usersTable.role, role));
  }
  if (reportingToId) {
    const managerId = parseId(reportingToId);
    if (!managerId) {
      res.status(400).json({ error: "Invalid reportingToId" });
      return;
    }
    conditions.push(eq(usersTable.reportingToId, managerId));
  }

  const users = await db
    .select()
    .from(usersTable)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(usersTable.name);

  const managerNames = await managerNamesFor(users);
  res.json(users.map((u) => formatUser(u, managerNames)));
});

router.get("/users/:userId", async (req, res): Promise<void> => {
  const userId = parseId(req.params.userId);
  if (!userId) {
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

  res.json(formatUser(user, await managerNamesFor([user])));
});

// ─── Write ───────────────────────────────────────────────────────────────────
// Everything below is AVP+ and additionally rank-limited: you can never grant a
// role above your own, nor touch an account that outranks you. Without these an
// Analyst could PATCH their own role to "md", or reset the MD's password.

router.post("/users", requireRole("avp"), async (req, res): Promise<void> => {
  const me = principal(req);
  const { name, email, password, role, reportingToId } = req.body as {
    name?: string;
    email?: string;
    password?: string;
    role?: string;
    reportingToId?: number | null;
  };

  if (!name?.trim() || !email?.trim() || !password || !role) {
    res
      .status(400)
      .json({ error: "name, email, password, and role are required" });
    return;
  }
  if (!EMAIL_PATTERN.test(email.trim())) {
    res.status(400).json({ error: "email is not a valid address" });
    return;
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    res.status(400).json({
      error: `password must be at least ${MIN_PASSWORD_LENGTH} characters`,
    });
    return;
  }
  if (!isRole(role)) {
    res.status(400).json({ error: "Unknown role" });
    return;
  }
  if (outranks(role, me.role)) {
    res
      .status(403)
      .json({ error: "You cannot create an account senior to your own" });
    return;
  }

  if (reportingToId != null) {
    const [manager] = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.id, reportingToId));
    if (!manager) {
      res.status(400).json({ error: "reportingToId does not match a user" });
      return;
    }
  }

  const normalisedEmail = email.toLowerCase().trim();
  const [existing] = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.email, normalisedEmail));
  if (existing) {
    res.status(409).json({ error: "An account with that email already exists" });
    return;
  }

  const [user] = await db
    .insert(usersTable)
    .values({
      name: name.trim(),
      email: normalisedEmail,
      passwordHash: bcrypt.hashSync(password, 10),
      role,
      reportingToId: reportingToId ?? null,
    })
    .returning();

  res.status(201).json(formatUser(user, await managerNamesFor([user])));
});

router.patch(
  "/users/:userId",
  requireRole("avp"),
  async (req, res): Promise<void> => {
    const me = principal(req);
    const userId = parseId(req.params.userId);
    if (!userId) {
      res.status(400).json({ error: "Invalid user ID" });
      return;
    }

    const [target] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, userId));

    if (!target) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    if (outranks(target.role, me.role)) {
      res
        .status(403)
        .json({ error: "You cannot modify an account senior to your own" });
      return;
    }

    const { name, email, role, reportingToId, password, isActive } =
      req.body as {
        name?: string;
        email?: string;
        role?: string;
        reportingToId?: number | null;
        password?: string;
        isActive?: boolean;
      };

    const updates: Partial<typeof usersTable.$inferInsert> = {};

    if (name !== undefined) {
      if (!name.trim()) {
        res.status(400).json({ error: "name cannot be empty" });
        return;
      }
      updates.name = name.trim();
    }

    if (email !== undefined) {
      if (!EMAIL_PATTERN.test(email.trim())) {
        res.status(400).json({ error: "email is not a valid address" });
        return;
      }
      const normalised = email.toLowerCase().trim();
      const [clash] = await db
        .select({ id: usersTable.id })
        .from(usersTable)
        .where(eq(usersTable.email, normalised));
      if (clash && clash.id !== userId) {
        res
          .status(409)
          .json({ error: "An account with that email already exists" });
        return;
      }
      updates.email = normalised;
    }

    if (role !== undefined) {
      if (!isRole(role)) {
        res.status(400).json({ error: "Unknown role" });
        return;
      }
      // Self-promotion is the escalation this endpoint most needs to refuse.
      if (target.id === me.id) {
        res.status(403).json({ error: "You cannot change your own role" });
        return;
      }
      if (outranks(role as Role, me.role)) {
        res
          .status(403)
          .json({ error: "You cannot grant a role senior to your own" });
        return;
      }
      updates.role = role;
    }

    if (reportingToId !== undefined) {
      if (reportingToId != null) {
        if (reportingToId === userId) {
          res.status(400).json({ error: "A user cannot report to themselves" });
          return;
        }
        const [manager] = await db
          .select({ id: usersTable.id })
          .from(usersTable)
          .where(eq(usersTable.id, reportingToId));
        if (!manager) {
          res.status(400).json({ error: "reportingToId does not match a user" });
          return;
        }
      }
      updates.reportingToId = reportingToId;
    }

    if (password !== undefined) {
      if (password.length < MIN_PASSWORD_LENGTH) {
        res.status(400).json({
          error: `password must be at least ${MIN_PASSWORD_LENGTH} characters`,
        });
        return;
      }
      updates.passwordHash = bcrypt.hashSync(password, 10);
    }

    if (isActive !== undefined) {
      if (target.id === me.id && !isActive) {
        res
          .status(400)
          .json({ error: "You cannot deactivate your own account" });
        return;
      }
      updates.isActive = isActive;
    }

    if (Object.keys(updates).length === 0) {
      res.status(400).json({ error: "No fields to update" });
      return;
    }

    const [user] = await db
      .update(usersTable)
      .set(updates)
      .where(eq(usersTable.id, userId))
      .returning();

    res.json(formatUser(user, await managerNamesFor([user])));
  },
);

router.delete(
  "/users/:userId",
  requireRole("avp"),
  async (req, res): Promise<void> => {
    const me = principal(req);
    const userId = parseId(req.params.userId);
    if (!userId) {
      res.status(400).json({ error: "Invalid user ID" });
      return;
    }

    const [target] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, userId));

    if (!target) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    if (target.id === me.id) {
      res.status(400).json({ error: "You cannot delete your own account" });
      return;
    }
    // An AVP deleting an MD would be an escalation by removal.
    if (outranks(target.role, me.role)) {
      res
        .status(403)
        .json({ error: "You cannot delete an account senior to your own" });
      return;
    }

    try {
      await db.delete(usersTable).where(eq(usersTable.id, userId));
      res.json({ message: "User deleted" });
    } catch (err: unknown) {
      const pgCode =
        (err as { code?: string; cause?: { code?: string } })?.code ??
        (err as { cause?: { code?: string } })?.cause?.code;
      if (pgCode === "23503") {
        res.status(400).json({
          error:
            "Cannot delete a user who has logged time entries. Deactivate the account instead.",
        });
        return;
      }
      throw err;
    }
  },
);

export default router;
