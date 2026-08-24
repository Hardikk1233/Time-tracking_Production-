/**
 * Temporary rollout tooling: crash-report intake, the feedback widget's
 * endpoint, and the /dev console that reads both.
 *
 * Three routers rather than one, because they sit at different points in the
 * auth chain:
 *
 *   devIngestRouter   — before requireAuth; a browser that cannot sign in is
 *                       precisely the case worth capturing
 *   feedbackRouter    — after requireAuth; anyone signed in may send feedback
 *   devConsoleRouter  — after requireAuth *and* the allowlist; reads everything
 *
 * All of this is meant to be deleted once the rollout has settled. Removing
 * this file, its two tables, and the frontend's dev page takes the whole
 * feature out.
 */
import { Router, type IRouter } from "express";
import { and, desc, eq, lt, type SQL } from "drizzle-orm";
import { db, appEventsTable, feedbackTable } from "@workspace/db";
import { principal, optionalPrincipal } from "../middlewares/auth";
import {
  clamp,
  stripQuery,
  recordEvent,
  notifyFeedback,
  unreadFeedbackCount,
} from "../lib/dev-events";
import { parseId } from "../lib/validation";

// ─── Intake (unauthenticated) ────────────────────────────────────────────────

export const devIngestRouter: IRouter = Router();

/** One report as the browser sends it. Everything is optional but the message. */
interface ClientReport {
  message?: unknown;
  stack?: unknown;
  url?: unknown;
  level?: unknown;
  context?: unknown;
}

const LEVELS = new Set(["error", "warn", "info"]);
/** A single flooding page cannot cost more than this per request. */
const MAX_BATCH = 20;

function parseLevel(value: unknown): "error" | "warn" | "info" {
  return typeof value === "string" && LEVELS.has(value)
    ? (value as "error" | "warn" | "info")
    : "error";
}

/**
 * Accepts a batch of browser-side errors.
 *
 * Returns 204 unconditionally — including for a malformed body. The caller is
 * an error handler that has already failed once; answering it with a 400 it
 * will try to report invites exactly the loop this is supposed to observe.
 */
devIngestRouter.post("/dev/client-events", async (req, res): Promise<void> => {
  const body = req.body as { events?: unknown };
  const events = Array.isArray(body?.events) ? body.events : [];

  if (events.length === 0) {
    res.status(204).end();
    return;
  }

  const me = await optionalPrincipal(req);
  const userAgent = req.headers["user-agent"];

  for (const raw of events.slice(0, MAX_BATCH)) {
    const report = raw as ClientReport;
    const message = clamp(report.message, 2_000);
    if (!message) continue;

    recordEvent({
      source: "client",
      level: parseLevel(report.level),
      message,
      stack: clamp(report.stack, 20_000),
      url: stripQuery(report.url),
      userId: me?.id ?? null,
      userEmail: me?.email ?? null,
      userAgent: typeof userAgent === "string" ? userAgent : null,
      requestId: typeof req.id === "string" ? req.id : String(req.id ?? ""),
      context:
        report.context && typeof report.context === "object"
          ? (report.context as Record<string, unknown>)
          : null,
    });
  }

  res.status(204).end();
});

// ─── Feedback (any signed-in user) ───────────────────────────────────────────

export const feedbackRouter: IRouter = Router();

const KINDS = new Set(["bug", "idea", "other"]);
const MAX_FEEDBACK = 4_000;

feedbackRouter.post("/feedback", async (req, res): Promise<void> => {
  const me = principal(req);
  const body = req.body as { message?: unknown; kind?: unknown; pageUrl?: unknown };

  const message = clamp(body?.message, MAX_FEEDBACK);
  if (!message) {
    res.status(400).json({ error: "Tell us what happened first." });
    return;
  }

  const kind =
    typeof body?.kind === "string" && KINDS.has(body.kind)
      ? (body.kind as "bug" | "idea" | "other")
      : "other";
  const pageUrl = stripQuery(body?.pageUrl);
  const userAgent = req.headers["user-agent"];

  // Identity comes from the principal, never the body: otherwise anyone could
  // file feedback under a colleague's name.
  const [saved] = await db
    .insert(feedbackTable)
    .values({
      userId: me.id,
      userEmail: me.email,
      userName: me.name,
      userRole: me.role,
      kind,
      message,
      pageUrl,
      userAgent: clamp(userAgent) ?? null,
    })
    .returning({ id: feedbackTable.id });

  // Detached — the message is committed, and a webhook outage must not turn
  // this into a 500 for the person who just took the trouble to write it.
  notifyFeedback({
    userName: me.name,
    userEmail: me.email,
    userRole: me.role,
    kind,
    message,
    pageUrl,
  });

  res.status(201).json({ id: saved?.id ?? null });
});

// ─── Console (allowlisted only) ──────────────────────────────────────────────

export const devConsoleRouter: IRouter = Router();

const DEFAULT_PAGE = 100;
const MAX_PAGE = 500;

function parseLimit(raw: unknown): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_PAGE;
  return Math.min(parsed, MAX_PAGE);
}

/** Unread counts for the console's header. */
devConsoleRouter.get("/summary", async (_req, res): Promise<void> => {
  const [errors] = await db
    .select({ id: appEventsTable.id })
    .from(appEventsTable)
    .orderBy(desc(appEventsTable.id))
    .limit(1);

  res.json({
    unreadFeedback: await unreadFeedbackCount(),
    latestEventId: errors?.id ?? null,
  });
});

/**
 * Newest-first events, keyset-paginated on id.
 *
 * `before` rather than an offset: the table is written to while it is being
 * read, and an offset would silently skip or repeat rows as new events land.
 */
devConsoleRouter.get("/events", async (req, res): Promise<void> => {
  const filters: SQL[] = [];

  const source = req.query["source"];
  if (source === "client" || source === "server") {
    filters.push(eq(appEventsTable.source, source));
  }

  const before = parseId(req.query["before"] as string | undefined);
  if (before) filters.push(lt(appEventsTable.id, before));

  const rows = await db
    .select()
    .from(appEventsTable)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(appEventsTable.id))
    .limit(parseLimit(req.query["limit"]));

  res.json({ events: rows, nextBefore: rows.at(-1)?.id ?? null });
});

devConsoleRouter.get("/feedback", async (req, res): Promise<void> => {
  const status = req.query["status"];
  const where =
    status === "new" || status === "read"
      ? eq(feedbackTable.status, status)
      : undefined;

  const rows = await db
    .select()
    .from(feedbackTable)
    .where(where)
    .orderBy(desc(feedbackTable.id))
    .limit(parseLimit(req.query["limit"]));

  res.json({ feedback: rows });
});

devConsoleRouter.post("/feedback/:id/read", async (req, res): Promise<void> => {
  const id = parseId(req.params["id"]);
  if (!id) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const [updated] = await db
    .update(feedbackTable)
    .set({ status: "read" })
    .where(eq(feedbackTable.id, id))
    .returning({ id: feedbackTable.id });

  if (!updated) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json({ id: updated.id, status: "read" });
});

/**
 * Clears captured events.
 *
 * Only the event log — feedback is somebody else's words and is not thrown
 * away from here.
 */
devConsoleRouter.delete("/events", async (_req, res): Promise<void> => {
  await db.delete(appEventsTable);
  res.status(204).end();
});
