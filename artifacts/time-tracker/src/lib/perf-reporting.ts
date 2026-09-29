/**
 * Browser-side timing capture for the /dev console's Performance tab.
 *
 * The server times every request it serves. This times the same requests from
 * the other end - `fetch` starting to the response arriving - and ships them
 * to /api/dev/client-metrics, where they land beside the server's rows. The
 * difference between the two readings is everything between this browser and
 * the container: the office network, the ingress, any queue in front of the
 * process. That gap is what separates "the server is slow" from "it is slow
 * for this person", which are different problems with different owners.
 *
 * Same three constraints as the crash reporter, and for the same reasons:
 * never throw (this wraps every API call the app makes), stay bounded, and
 * never report its own failures.
 *
 * Temporary, like the console - see docs/dev-console.md.
 */
import { getAccessToken } from './entra';

interface ApiSample {
  kind: 'api';
  method: string;
  path: string;
  /** 0 when no response arrived at all - a dropped connection, a timeout. */
  status: number;
  durationMs: number;
  /** The SPA page the call was made from, so a slow page can be found by name. */
  page: string;
}

interface PageSample {
  kind: 'page';
  path: string;
  /** Time to DOMContentLoaded: when the app could start rendering. */
  durationMs: number;
  ttfbMs?: number;
  loadMs?: number;
  effectiveType?: string;
}

type Sample = ApiSample | PageSample;

const ENDPOINT = '/api/dev/client-metrics';
const FLUSH_INTERVAL_MS = 10_000;
/** Matches the server's per-batch cap. */
const MAX_BATCH = 50;
/** Beyond this the oldest samples are dropped; the console cares about now. */
const MAX_QUEUE = 200;
/** Hard ceiling per page load. Nobody needs more than this from one tab. */
const MAX_PER_LOAD = 2_000;

let queue: Sample[] = [];
let sent = 0;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushing = false;
let installed = false;
/** The real fetch, kept so the flush itself is never measured or re-entered. */
let originalFetch: typeof window.fetch | null = null;

function round(ms: number): number {
  return Math.round(ms * 10) / 10;
}

/**
 * Only the API's own same-origin calls are worth timing: those are the ones
 * with a server row to compare against. Microsoft's token endpoint, fonts and
 * the console's own traffic all fall outside that.
 */
function apiPath(input: RequestInfo | URL): string | null {
  try {
    const raw =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, window.location.origin);
    if (url.origin !== window.location.origin) return null;
    if (!url.pathname.startsWith('/api/') || url.pathname.startsWith('/api/dev/')) return null;
    return url.pathname;
  } catch {
    return null;
  }
}

function enqueue(sample: Sample): void {
  if (sent + queue.length >= MAX_PER_LOAD) return;
  if (queue.length >= MAX_QUEUE) queue.shift();
  queue.push(sample);
  if (queue.length >= MAX_BATCH) {
    void flush();
  } else {
    scheduleFlush();
  }
}

function scheduleFlush(): void {
  if (flushTimer !== null) return;
  flushTimer = setTimeout(() => void flush(), FLUSH_INTERVAL_MS);
}

async function flush(): Promise<void> {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (flushing || queue.length === 0 || !originalFetch) return;

  const batch = queue.splice(0, MAX_BATCH);
  flushing = true;
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    try {
      const token = await getAccessToken();
      if (token) headers.authorization = `Bearer ${token}`;
    } catch {
      // Fall through; a session cookie may still carry it.
    }
    const response = await originalFetch(ENDPOINT, {
      method: 'POST',
      headers,
      body: JSON.stringify({ samples: batch }),
      // Survives the tab closing, and unlike sendBeacon it can carry the
      // bearer token the endpoint requires.
      keepalive: true,
    });
    sent += batch.length;
    // Not signed in: nothing queued can be attributed to anyone, so stop
    // accumulating it. The next sign-in starts fresh.
    if (response.status === 401) queue = [];
  } catch {
    // Diagnostics, not data. A failed batch is dropped, never retried.
  } finally {
    flushing = false;
    if (queue.length > 0) scheduleFlush();
  }
}

/**
 * One full page load, reported once. Route changes inside the SPA are not
 * page loads and do not appear here; their cost shows up as the API calls
 * they trigger, each tagged with the page that made it.
 */
function reportPageLoad(): void {
  const send = (): void => {
    try {
      const path = window.location.pathname;
      // The sign-in page has nobody to attribute a timing to.
      if (path === '/' || path === '/login') return;
      const [nav] = performance.getEntriesByType('navigation') as PerformanceNavigationTiming[];
      if (!nav) return;
      const connection = (navigator as { connection?: { effectiveType?: string } }).connection;
      enqueue({
        kind: 'page',
        path,
        durationMs: round(nav.domContentLoadedEventEnd),
        ttfbMs: round(nav.responseStart),
        loadMs: round(nav.loadEventEnd || nav.domContentLoadedEventEnd),
        ...(connection?.effectiveType ? { effectiveType: connection.effectiveType } : {}),
      });
    } catch {
      // Navigation timing is a nice-to-have; a browser without it loses nothing else.
    }
  };

  if (document.readyState === 'complete') {
    send();
  } else {
    // loadEventEnd is still zero *during* the load event; read it just after.
    window.addEventListener('load', () => setTimeout(send, 0), { once: true });
  }
}

/**
 * Wraps `fetch` so every API call is timed. Called once, before the app
 * mounts, so the first calls of the session are captured too.
 *
 * The timing runs from the call to the response headers arriving. Reading
 * the body is not included; for this API's payloads that is a rounding
 * error, and it keeps the wrapper from having to clone every response.
 */
export function installPerfReporting(): void {
  if (installed || typeof window === 'undefined' || typeof window.fetch !== 'function') return;
  installed = true;

  const original = window.fetch.bind(window);
  originalFetch = original;

  window.fetch = async function timedFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const path = apiPath(input);
    if (!path) return original(input, init);

    const method = (
      init?.method ?? (input instanceof Request ? input.method : 'GET')
    ).toUpperCase();
    const page = window.location.pathname;
    const started = performance.now();

    try {
      const response = await original(input, init);
      enqueue({
        kind: 'api',
        method,
        path,
        status: response.status,
        durationMs: round(performance.now() - started),
        page,
      });
      return response;
    } catch (err) {
      enqueue({
        kind: 'api',
        method,
        path,
        status: 0,
        durationMs: round(performance.now() - started),
        page,
      });
      throw err;
    }
  };

  reportPageLoad();

  // What is queued when the tab closes is the last thing the person saw -
  // often the slow call they are about to complain about.
  window.addEventListener('pagehide', () => void flush());
}
