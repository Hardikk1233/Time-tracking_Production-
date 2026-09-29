/**
 * Request timing and replica health capture for the /dev console.
 *
 * Two rules shape everything here, and they are the same two the crash
 * reporter lives by:
 *
 *   1. Measuring a request must not slow it down. Nothing is written on the
 *      request path. A finished request costs one object pushed onto an
 *      array; the database sees one batched insert every few seconds.
 *   2. Measuring must never break anything. Every write swallows its own
 *      failure, and the buffer has a ceiling so a database outage produces a
 *      gap in the graphs rather than a process that grows until it is killed.
 *
 * Temporary, like the console that reads it - see docs/dev-console.md.
 */
import { monitorEventLoopDelay } from "node:perf_hooks";
import type { NextFunction, Request, Response } from "express";
import { lt, sql } from "drizzle-orm";
import {
  db,
  pool,
  requestMetricsTable,
  replicaSamplesTable,
  type InsertRequestMetric,
} from "@workspace/db";
import { config } from "../config";
import { logger } from "./logger";

// ─── Route normalisation ─────────────────────────────────────────────────────

const MAX_ROUTE = 300;

/**
 * Collapses a concrete path to the route it was served by, so calls for
 * different records aggregate together: `/api/time-entries/412` and
 * `/api/time-entries/9` are both `/api/time-entries/:id`.
 *
 * Done by pattern rather than by asking Express for `req.route.path`, because
 * the browser has no Express to ask and the two sides have to agree for a
 * client row and a server row to be laid side by side. Numeric segments are
 * the only identifiers the API uses in paths; UUIDs and slugs would need a
 * second rule if that ever changed.
 */
export function normaliseRoute(url: string): string {
  const cut = url.search(/[?#]/);
  const path = cut === -1 ? url : url.slice(0, cut);
  const collapsed = path.replace(/\/\d+(?=\/|$)/g, "/:id");
  return collapsed.length > MAX_ROUTE ? collapsed.slice(0, MAX_ROUTE) : collapsed;
}

/**
 * Paths whose timings would only measure the console watching itself, or the
 * platform's probes. Excluded from capture on both sides.
 */
export function isExcludedRoute(route: string): boolean {
  return (
    route === "/api/healthz" ||
    route === "/api/readyz" ||
    route.startsWith("/api/dev/")
  );
}

// ─── Buffer and flush ────────────────────────────────────────────────────────

/** Rows are inserted when this many have accumulated, or on the timer. */
const BATCH_SIZE = 200;
const FLUSH_INTERVAL_MS = 5_000;
/** One insert statement carries at most this many rows. */
const INSERT_CHUNK = 500;
/**
 * The buffer stops growing here. Reached only when the database has been
 * unreachable for a while, at which point older rows are the ones to lose:
 * the console cares about what is happening now.
 */
const MAX_BUFFER = 5_000;

let buffer: InsertRequestMetric[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushing: Promise<void> | null = null;
let flushesSinceTrim = 0;
const TRIM_EVERY = 50;

function scheduleFlush(): void {
  if (flushTimer !== null) return;
  flushTimer = setTimeout(() => void flushMetrics(), FLUSH_INTERVAL_MS);
  // A pending flush must not keep the process alive on its own; shutdown
  // flushes explicitly.
  flushTimer.unref();
}

/**
 * Queues one row. Never throws, never awaits anything.
 */
export function recordMetric(row: InsertRequestMetric): void {
  if (!config.metricsEnabled) return;
  if (buffer.length >= MAX_BUFFER) buffer.shift();
  buffer.push(row);
  if (buffer.length >= BATCH_SIZE) {
    void flushMetrics();
  } else {
    scheduleFlush();
  }
}

/**
 * Writes everything buffered so far.
 *
 * Concurrent callers share one in-progress flush rather than racing to insert
 * the same rows. Failures are logged and the rows dropped: retrying against a
 * database that just refused a write is how a blip becomes a backlog.
 */
export function flushMetrics(): Promise<void> {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (flushing) return flushing;
  if (buffer.length === 0) return Promise.resolve();

  const rows = buffer;
  buffer = [];

  flushing = (async () => {
    try {
      for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
        await db.insert(requestMetricsTable).values(rows.slice(i, i + INSERT_CHUNK));
      }
      await trimIfDue();
    } catch (err) {
      logger.warn({ err, dropped: rows.length }, "Failed to write request metrics");
    } finally {
      flushing = null;
    }
  })();
  return flushing;
}

/** Number of rows waiting to be written. Exposed for tests and the live gauge. */
export function bufferedMetrics(): number {
  return buffer.length;
}

/**
 * Drops rows older than the retention window, on roughly every fiftieth
 * flush. Age-based rather than count-based: the question the console answers
 * is "what happened this week", and a busy day should not push a quiet one
 * out early.
 */
async function trimIfDue(): Promise<void> {
  flushesSinceTrim += 1;
  if (flushesSinceTrim < TRIM_EVERY) return;
  flushesSinceTrim = 0;

  const cutoff = new Date(Date.now() - config.metricsRetentionDays * 24 * 60 * 60 * 1000);
  await db.delete(requestMetricsTable).where(lt(requestMetricsTable.occurredAt, cutoff));
  await db.delete(replicaSamplesTable).where(lt(replicaSamplesTable.sampledAt, cutoff));
}

/** Exposed so the console can offer an explicit clear. */
export async function clearMetrics(): Promise<void> {
  buffer = [];
  await db.execute(sql`TRUNCATE ${requestMetricsTable}, ${replicaSamplesTable}`);
}

// ─── Live gauges ─────────────────────────────────────────────────────────────

let inFlight = 0;
let requestsSinceSample = 0;

/** What this replica is doing right now. Only this replica - the others report through their own samples. */
export function liveGauges(): { replica: string; inFlight: number; buffered: number } {
  return { replica: config.replicaName, inFlight, buffered: buffer.length };
}

// ─── Middleware ──────────────────────────────────────────────────────────────

/**
 * Times every API request and records it once the response has gone.
 *
 * Mounted ahead of authentication, so a 401 is timed too - but reads the
 * principal at the *end* of the request, by which point requireAuth has
 * resolved it. That is what lets a row carry who made the call without this
 * middleware having to know how authentication works.
 *
 * A request the client abandoned before the response finished is recorded
 * with status 499, nginx's convention for "client closed request". Those are
 * worth seeing: they are people giving up.
 */
export function requestTelemetry(req: Request, res: Response, next: NextFunction): void {
  if (!config.metricsEnabled) {
    next();
    return;
  }

  const route = normaliseRoute(req.originalUrl);
  if (isExcludedRoute(route)) {
    next();
    return;
  }

  const started = process.hrtime.bigint();
  inFlight += 1;
  requestsSinceSample += 1;

  let recorded = false;
  const finish = (aborted: boolean): void => {
    if (recorded) return;
    recorded = true;
    inFlight -= 1;

    const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
    recordMetric({
      source: "server",
      kind: "api",
      method: req.method,
      route,
      statusCode: aborted ? 499 : res.statusCode,
      durationMs: Math.round(durationMs * 10) / 10,
      userId: req.principal?.id ?? null,
      userEmail: req.principal?.email ?? null,
      replica: config.replicaName,
      requestId: typeof req.id === "string" ? req.id : String(req.id ?? ""),
    });
  };

  res.once("finish", () => finish(false));
  res.once("close", () => finish(!res.writableFinished));

  next();
}

// ─── Replica sampler ─────────────────────────────────────────────────────────

const loopDelay = monitorEventLoopDelay({ resolution: 20 });
let sampleTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Records this replica's health once. Runs on the timer below; exported so a
 * test can take a sample without waiting for one.
 */
export async function sampleReplica(): Promise<void> {
  const mem = process.memoryUsage();
  // The histogram reports nanoseconds, and NaN when it has seen no ticks yet.
  const toMs = (ns: number): number =>
    Number.isFinite(ns) ? Math.round(ns / 100_000) / 10 : 0;
  const row = {
    replica: config.replicaName,
    eventLoopLagMs: toMs(loopDelay.mean),
    eventLoopMaxMs: toMs(loopDelay.max),
    rssMb: Math.round(mem.rss / 1_048_576),
    heapUsedMb: Math.round(mem.heapUsed / 1_048_576),
    requests: requestsSinceSample,
    inFlight,
    poolTotal: pool.totalCount,
    poolIdle: pool.idleCount,
    poolWaiting: pool.waitingCount,
  };
  loopDelay.reset();
  requestsSinceSample = 0;

  try {
    await db.insert(replicaSamplesTable).values(row);
  } catch (err) {
    logger.warn({ err }, "Failed to write replica sample");
  }
}

/**
 * Starts the periodic sampler. Idempotent; a no-op when capture is off.
 *
 * The interval is unref'd so it never keeps a process alive that is otherwise
 * done - shutdown does not have to remember to stop it.
 */
export function startReplicaSampler(): void {
  if (!config.metricsEnabled || sampleTimer !== null) return;
  loopDelay.enable();
  sampleTimer = setInterval(() => void sampleReplica(), config.metricsSampleMs);
  sampleTimer.unref();
}

export function stopReplicaSampler(): void {
  if (sampleTimer === null) return;
  clearInterval(sampleTimer);
  sampleTimer = null;
  loopDelay.disable();
}
