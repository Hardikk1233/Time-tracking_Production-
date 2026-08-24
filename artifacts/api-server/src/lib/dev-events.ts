/**
 * Recording side of the temporary /dev console.
 *
 * The one rule here: capturing a problem must never *become* a problem. Every
 * write is fire-and-forget and swallows its own failures — if the database is
 * the thing that broke, an error handler that then throws while trying to
 * record the error turns a 500 into an unhandled rejection and takes the
 * process down with it.
 */
import { count, eq, lt, desc } from "drizzle-orm";
import {
  db,
  appEventsTable,
  feedbackTable,
  type InsertAppEvent,
} from "@workspace/db";
import { config } from "../config";
import { logger } from "./logger";

/** Postgres text columns are unbounded; browsers are not always sensible. */
const MAX_MESSAGE = 2_000;
const MAX_STACK = 20_000;
const MAX_SHORT = 500;

export function clamp(
  value: unknown,
  limit: number = MAX_SHORT,
): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > limit ? trimmed.slice(0, limit) : trimmed;
}

/**
 * Strips the query string from a URL before it is stored.
 *
 * Report ids and date ranges are not secret, but `?token=` and `?email=` turn
 * up in URLs more often than anyone intends, and this table is read by a human
 * in a browser rather than by an access-controlled log pipeline.
 */
export function stripQuery(value: unknown): string | null {
  const raw = clamp(value, 1_000);
  if (!raw) return null;
  const cut = raw.search(/[?#]/);
  return cut === -1 ? raw : raw.slice(0, cut);
}

let writesSinceTrim = 0;
const TRIM_EVERY = 100;

/**
 * Drops the oldest events once the table outgrows its retention.
 *
 * Runs on roughly every hundredth write rather than every one: the delete is a
 * subquery over an indexed column and there is no need to pay for it each time
 * a browser reports a warning.
 */
async function trimIfDue(): Promise<void> {
  writesSinceTrim += 1;
  if (writesSinceTrim < TRIM_EVERY) return;
  writesSinceTrim = 0;

  const [cutoff] = await db
    .select({ id: appEventsTable.id })
    .from(appEventsTable)
    .orderBy(desc(appEventsTable.id))
    .limit(1)
    .offset(config.devEventRetention - 1);

  if (!cutoff) return;
  await db.delete(appEventsTable).where(lt(appEventsTable.id, cutoff.id));
}

/**
 * Persists one event, returning nothing and throwing nothing.
 *
 * Callers should not await this — it is deliberately detached so a slow insert
 * cannot add latency to the response that triggered it.
 */
export function recordEvent(event: InsertAppEvent): void {
  const row: InsertAppEvent = {
    ...event,
    message: clamp(event.message, MAX_MESSAGE) ?? "(no message)",
    stack: clamp(event.stack, MAX_STACK),
    url: stripQuery(event.url),
    userAgent: clamp(event.userAgent),
    userEmail: clamp(event.userEmail),
    requestId: clamp(event.requestId, 100),
  };

  void (async () => {
    try {
      await db.insert(appEventsTable).values(row);
      await trimIfDue();
    } catch (err) {
      // Nowhere left to escalate to: this *is* the error sink. A line in the
      // container log is the last resort, and it must not rethrow.
      logger.error({ err }, "Failed to record app event");
    }
  })();
}

/** Shape posted to the feedback webhook. Teams renders `text` as the message. */
interface WebhookPayload {
  text: string;
}

/**
 * Notifies the configured webhook that feedback arrived.
 *
 * Detached and best-effort for the same reason as recordEvent: a Teams outage
 * must not turn "thanks for the feedback" into a 500 for the person who sent
 * it. Their message is already committed by the time this runs.
 */
export function notifyFeedback(summary: {
  userName: string;
  userEmail: string;
  userRole: string;
  kind: string;
  message: string;
  pageUrl: string | null;
}): void {
  const url = config.feedbackWebhookUrl;
  if (!url) return;

  const lines = [
    `**New TimeTrack feedback** (${summary.kind})`,
    `From: ${summary.userName} <${summary.userEmail}> · ${summary.userRole}`,
    summary.pageUrl ? `Page: ${summary.pageUrl}` : null,
    "",
    summary.message,
  ].filter(Boolean);

  const payload: WebhookPayload = { text: lines.join("\n") };

  void (async () => {
    try {
      // Without a timeout a hung webhook holds a socket open indefinitely.
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        logger.warn(
          { status: response.status },
          "Feedback webhook rejected the notification",
        );
      }
    } catch (err) {
      logger.warn({ err }, "Feedback webhook unreachable");
    }
  })();
}

/** Count of feedback nobody has looked at yet, for the console's badge. */
export async function unreadFeedbackCount(): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(feedbackTable)
    .where(eq(feedbackTable.status, "new"));
  return row?.value ?? 0;
}
