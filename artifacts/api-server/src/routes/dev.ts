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
import {
  recordMetric,
  normaliseRoute,
  isExcludedRoute,
  clearMetrics,
} from "../lib/telemetry";
import {
  metricsOverview,
  metricsRequests,
  parseWindow,
} from "../lib/telemetry-reports";
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

// ─── Browser timings (any signed-in user) ────────────────────────────────────

export const clientMetricsRouter: IRouter = Router();

/** How many samples one batch may carry; the client flushes well under this. */
const MAX_SAMPLES = 50;
const MAX_DURATION_MS = 10 * 60 * 1000;

/** One timing as the browser sends it. Anything malformed is skipped, never rejected. */
interface ClientSample {
  kind?: unknown;
  method?: unknown;
  path?: unknown;
  status?: unknown;
  durationMs?: unknown;
  page?: unknown;
  ttfbMs?: unknown;
  loadMs?: unknown;
  effectiveType?: unknown;
}

function finiteMs(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 0 || n > MAX_DURATION_MS) return null;
  return Math.round(n * 10) / 10;
}

function statusCode(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  // 0 is a real value here: the browser never got a response at all.
  return Number.isInteger(n) && n >= 0 && n <= 599 ? n : null;
}

/**
 * Accepts a batch of timings the browser observed, the other half of every
 * server row. Authenticated, unlike crash intake: a page that cannot sign in
 * has no timings worth keeping that the crash reporter does not already
 * carry, and requiring a token is what keeps a script from filling the table
 * with fiction about other people's experience.
 *
 * 204 whatever the body contains. This is fed by a background flush that
 * nobody is watching; a 400 would be reported to no one.
 */
clientMetricsRouter.post("/dev/client-metrics", (req, res): void => {
  const me = principal(req);
  const body = req.body as { samples?: unknown };
  const samples = Array.isArray(body?.samples) ? body.samples : [];

  for (const raw of samples.slice(0, MAX_SAMPLES)) {
    if (!raw || typeof raw !== "object") continue;
    const sample = raw as ClientSample;
    const durationMs = finiteMs(sample.durationMs);
    const path = clamp(sample.path, 1_000);
    if (durationMs === null || !path) continue;

    if (sample.kind === "page") {
      recordMetric({
        source: "client",
        kind: "page",
        route: normaliseRoute(path),
        durationMs,
        userId: me.id,
        userEmail: me.email,
        extra: {
          ttfbMs: finiteMs(sample.ttfbMs),
          loadMs: finiteMs(sample.loadMs),
          effectiveType: clamp(sample.effectiveType, 20),
        },
      });
      continue;
    }

    const route = normaliseRoute(path);
    // Only the API's own calls are comparable with the server's rows, and the
    // console watching itself is as uninteresting from this side as the other.
    if (!route.startsWith("/api/") || isExcludedRoute(route)) continue;

    recordMetric({
      source: "client",
      kind: "api",
      method: clamp(sample.method, 10)?.toUpperCase() ?? null,
      route,
      statusCode: statusCode(sample.status),
      durationMs,
      userId: me.id,
      userEmail: me.email,
      page: stripQuery(sample.page),
    });
  }

  res.status(204).end();
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

// ─── Performance ─────────────────────────────────────────────────────────────

/** Everything the Performance tab draws, for one window ending now. */
devConsoleRouter.get("/metrics/overview", async (req, res): Promise<void> => {
  res.json(await metricsOverview(parseWindow(req.query["window"])));
});

/**
 * The individual calls behind the summaries. Defaults to only the ones that
 * went wrong; `problems=0` with a `userId` shows one person's recent activity.
 */
devConsoleRouter.get("/metrics/requests", async (req, res): Promise<void> => {
  const q = req.query;
  const userId = parseId(q["userId"] as string | undefined);
  const minMs = Number(q["minMs"]);
  const source = q["source"];
  const route = clamp(q["route"], 300);

  res.json({
    requests: await metricsRequests({
      window: parseWindow(q["window"]),
      problems: q["problems"] !== "0",
      ...(userId ? { userId } : {}),
      ...(source === "server" || source === "client" ? { source } : {}),
      ...(route ? { route } : {}),
      ...(Number.isFinite(minMs) && minMs > 0 ? { minMs } : {}),
      limit: parseLimit(q["limit"]),
    }),
  });
});

devConsoleRouter.delete("/metrics", async (_req, res): Promise<void> => {
  await clearMetrics();
  res.status(204).end();
});
