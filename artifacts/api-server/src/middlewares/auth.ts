import { type Request, type Response, type NextFunction } from "express";
import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import { atLeast, type Role } from "../lib/roles";
import {
  verifyEntraToken,
  isEntraConfigured,
  EntraAuthError,
  type EntraIdentity,
} from "../lib/entra";
import { config } from "../config";
import { logger } from "../lib/logger";

/** The authenticated caller, resolved once per request. */
export interface Principal {
  id: number;
  name: string;
  email: string;
  role: Role;
  /** How this request authenticated — useful when auditing the cutover. */
  via: "entra" | "session";
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      principal?: Principal;
    }
  }
}

type UserRow = typeof usersTable.$inferSelect;

function toPrincipal(user: UserRow, via: Principal["via"]): Principal {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    via,
  };
}

/**
 * People whose real designation the four-tier role hierarchy cannot express.
 *
 * Kashif Lone and Rohanjit Das hold the avp permission rank - same access,
 * same authorization checks as every other AVP - but their actual titles are
 * Vice President and Senior Vice President. Entra's app role claim cannot
 * carry this: mapping them to a role of their own would have meant a fifth
 * permission tier for a distinction that is cosmetic. This overrides only
 * what they see themselves signed in as.
 *
 * Keyed by email to match how an existing password account is adopted below.
 */
const TITLE_OVERRIDES: Record<string, string> = {
  "kashif.lone@tristone-partners.com": "VP",
  "rohanjit.das@tristone-partners.com": "SVP",
};

function titleOverrideFor(email: string): string | null {
  return TITLE_OVERRIDES[email.toLowerCase()] ?? null;
}

/**
 * Maps a verified Entra identity onto a local user row, creating it on first
 * sign-in.
 *
 * Entra is the source of truth for who exists and what they may do, so there
 * is no invite flow: being in the right security group *is* the account. Role
 * and name are re-synced whenever the token disagrees with the stored row.
 *
 * Returns null when the account exists but is deactivated locally.
 */
async function resolveEntraUser(
  identity: EntraIdentity,
): Promise<UserRow | null> {
  let [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.entraOid, identity.oid));

  // First Entra sign-in for someone who already has a password account: adopt
  // the existing row so their history stays attached to them.
  if (!user) {
    const [byEmail] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.email, identity.email));

    if (byEmail) {
      [user] = await db
        .update(usersTable)
        .set({ entraOid: identity.oid })
        .where(eq(usersTable.id, byEmail.id))
        .returning();
    }
  }

  if (!user) {
    const inserted = await db
      .insert(usersTable)
      .values({
        name: identity.name,
        email: identity.email,
        entraOid: identity.oid,
        role: identity.role,
        title: titleOverrideFor(identity.email),
        passwordHash: null,
      })
      .onConflictDoNothing()
      .returning();
    user = inserted[0];

    // Lost a race with a concurrent first request; the winner's row is there.
    if (!user) {
      [user] = await db
        .select()
        .from(usersTable)
        .where(eq(usersTable.entraOid, identity.oid));
    }
  }

  if (!user) return null;
  if (!user.isActive) return null;

  // Entra owns role and display name; a change there takes effect on the next
  // token rather than needing a corresponding edit in this app. A title
  // override is filled in once, for a row that predates it, and left alone
  // after - the token carries no such claim, so there is nothing to re-sync.
  const overrideTitle =
    user.title == null ? titleOverrideFor(identity.email) : null;
  if (user.role !== identity.role || user.name !== identity.name || overrideTitle) {
    const [updated] = await db
      .update(usersTable)
      .set({
        role: identity.role,
        name: identity.name,
        ...(overrideTitle ? { title: overrideTitle } : {}),
      })
      .where(eq(usersTable.id, user.id))
      .returning();
    if (updated) user = updated;
  }

  return user;
}

/**
 * Turns a verified Entra identity into a principal, for callers that sit
 * outside the Express middleware chain — currently the MCP endpoint.
 *
 * Deliberately the same path requireAuth takes, so a person reaching the app
 * through a Claude connector is provisioned, adopted and role-synced exactly as
 * they are through the browser. Null means the account exists but is
 * deactivated locally.
 */
export async function resolveEntraPrincipal(
  identity: EntraIdentity,
): Promise<Principal | null> {
  const user = await resolveEntraUser(identity);
  return user ? toPrincipal(user, "entra") : null;
}

function bearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const [scheme, ...rest] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer") return null;
  const token = rest.join(" ").trim();
  return token || null;
}

/**
 * Authenticates the request and resolves the caller's identity and role once,
 * so downstream handlers authorise against `req.principal` instead of each
 * issuing its own lookup.
 *
 * Accepts an Entra bearer token when the tenant is configured, and falls back
 * to the session cookie until ENTRA_ONLY retires it.
 */
export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const token = bearerToken(req);

  if (token && isEntraConfigured()) {
    try {
      const identity = await verifyEntraToken(token);
      const user = await resolveEntraUser(identity);

      if (!user) {
        res.status(403).json({ error: "This account has been deactivated" });
        return;
      }

      req.principal = toPrincipal(user, "entra");
      next();
      return;
    } catch (err) {
      if (err instanceof EntraAuthError) {
        // Logged with the reason; the client is told only that it failed.
        logger.warn({ reason: err.reason }, "Rejected Entra token");
        res.status(401).json({ error: "Not authenticated" });
        return;
      }
      throw err;
    }
  }

  // A bearer token was presented but tokens are not accepted here.
  if (token && !isEntraConfigured()) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  if (config.entraOnly) {
    res.status(401).json({ error: "Sign in with your Microsoft account" });
    return;
  }

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
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  // A deactivated account keeps a valid session cookie until it expires, so
  // this is the only thing that actually revokes access.
  if (!user.isActive) {
    req.session.destroy(() => {});
    res.status(403).json({ error: "This account has been deactivated" });
    return;
  }

  req.principal = toPrincipal(user, "session");
  next();
}

/**
 * Best-effort identification for endpoints that accept anonymous callers.
 *
 * Used by the crash-report intake, where the most valuable reports are the ones
 * thrown *before* sign-in completes — a token that will not verify is the bug
 * being reported, so refusing the report would discard the evidence. Returns
 * null rather than throwing, and never provisions an account: creating users is
 * requireAuth's job on a request that actually authenticated.
 */
export async function optionalPrincipal(
  req: Request,
): Promise<Principal | null> {
  try {
    const token = bearerToken(req);

    if (token && isEntraConfigured()) {
      const identity = await verifyEntraToken(token);
      const [user] = await db
        .select()
        .from(usersTable)
        .where(eq(usersTable.entraOid, identity.oid));
      return user?.isActive ? toPrincipal(user, "entra") : null;
    }

    if (req.session?.userId) {
      const [user] = await db
        .select()
        .from(usersTable)
        .where(eq(usersTable.id, req.session.userId));
      return user?.isActive ? toPrincipal(user, "session") : null;
    }

    return null;
  } catch {
    // An unattributed report is still worth keeping.
    return null;
  }
}

/** Reads the principal established by requireAuth. */
export function principal(req: Request): Principal {
  if (!req.principal) {
    // Only reachable if a route is mounted before requireAuth.
    throw new Error("principal() called on an unauthenticated request");
  }
  return req.principal;
}

/** Gate a route at a minimum rank, e.g. requireRole("associate"). */
export function requireRole(minimum: Role) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const me = principal(req);
    if (!atLeast(me.role, minimum)) {
      res.status(403).json({ error: "You do not have permission to do this" });
      return;
    }
    next();
  };
}
