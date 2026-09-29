import { getAccessToken } from './entra';

/**
 * Minimal client for the temporary rollout endpoints.
 *
 * Deliberately hand-written rather than added to the OpenAPI spec and
 * regenerated through Orval: this whole feature is scaffolding that comes out
 * once the rollout has settled, and it should not leave a trace in the
 * generated client that someone has to remember to remove.
 *
 * Bearer token where Entra is active, session cookie otherwise — same-origin
 * requests send the cookie by default, so nothing extra is needed for it.
 */
async function authHeaders(): Promise<HeadersInit> {
  const headers: Record<string, string> = { accept: 'application/json' };
  try {
    const token = await getAccessToken();
    if (token) headers.authorization = `Bearer ${token}`;
  } catch {
    // Fall through unauthenticated; the endpoint decides what that means.
  }
  return headers;
}

export async function devGet<T>(path: string): Promise<T> {
  const response = await fetch(`/api${path}`, {
    headers: await authHeaders(),
  });
  if (!response.ok) {
    throw new Error(`GET ${path} responded ${response.status}`);
  }
  return (await response.json()) as T;
}

export async function devSend<T>(
  method: 'POST' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T | null> {
  const headers = new Headers(await authHeaders());
  if (body !== undefined) headers.set('content-type', 'application/json');

  const response = await fetch(`/api${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (!response.ok) {
    // The server's message is the useful half — surface it rather than a status.
    let detail = `${method} ${path} responded ${response.status}`;
    try {
      const parsed = (await response.json()) as { error?: string };
      if (parsed?.error) detail = parsed.error;
    } catch {
      // Non-JSON body; the status line above stands.
    }
    throw new Error(detail);
  }

  if (response.status === 204) return null;
  return (await response.json()) as T;
}

// ─── Shapes returned by the console endpoints ────────────────────────────────

export interface AppEvent {
  id: number;
  occurredAt: string;
  source: 'client' | 'server';
  level: 'error' | 'warn' | 'info';
  message: string;
  stack: string | null;
  url: string | null;
  method: string | null;
  statusCode: number | null;
  userEmail: string | null;
  userAgent: string | null;
  requestId: string | null;
  context: Record<string, unknown> | null;
}

export interface FeedbackItem {
  id: number;
  createdAt: string;
  userEmail: string;
  userName: string;
  userRole: string;
  kind: 'bug' | 'idea' | 'other';
  message: string;
  pageUrl: string | null;
  status: 'new' | 'read';
}

// ─── Shapes returned by the performance endpoints ────────────────────────────

export type MetricsWindow = '15m' | '1h' | '24h' | '7d';

export interface SeriesPoint {
  t: string;
  requests: number;
  errors: number;
  p50: number;
  p95: number;
  p99: number;
  clientP95: number | null;
  byReplica: Record<string, number>;
}

export interface RouteStat {
  method: string;
  route: string;
  requests: number;
  p50: number;
  p95: number;
  p99: number;
  errors: number;
  slow: number;
  clientP95: number | null;
}

export interface UserStat {
  userId: number;
  userEmail: string | null;
  userName: string | null;
  requests: number;
  errors: number;
  slow: number;
  abandoned: number;
  p95: number;
  maxMs: number;
  clientRequests: number;
  clientFailures: number;
  clientP95: number | null;
  lastSeen: string;
}

export interface ReplicaStat {
  replica: string;
  requests: number;
  share: number;
  p95: number;
  latest: {
    sampledAt: string;
    eventLoopLagMs: number;
    eventLoopMaxMs: number;
    rssMb: number;
    heapUsedMb: number;
    inFlight: number;
    poolTotal: number;
    poolIdle: number;
    poolWaiting: number;
  } | null;
}

export interface SamplePoint {
  t: string;
  replica: string;
  lagMs: number;
  lagMaxMs: number;
  rssMb: number;
  inFlight: number;
  poolWaiting: number;
  requests: number;
}

export interface PageStat {
  page: string;
  loads: number;
  p50: number;
  p95: number;
  p95Ttfb: number | null;
}

export interface MetricsOverview {
  window: MetricsWindow;
  since: string;
  bucketSeconds: number;
  slowMs: number;
  live: { replica: string; inFlight: number; buffered: number };
  totals: {
    requests: number;
    rps: number;
    p50: number;
    p95: number;
    p99: number;
    errors5xx: number;
    errors4xx: number;
    abandoned: number;
    slow: number;
    users: number;
    replicas: number;
    clientRequests: number;
    clientP95: number | null;
    clientFailures: number;
  };
  series: SeriesPoint[];
  routes: RouteStat[];
  users: UserStat[];
  replicas: ReplicaStat[];
  samples: SamplePoint[];
  pages: PageStat[];
}

export interface RequestRow {
  id: number;
  occurredAt: string;
  source: 'server' | 'client';
  kind: 'api' | 'page';
  method: string | null;
  route: string;
  statusCode: number | null;
  durationMs: number;
  userId: number | null;
  userEmail: string | null;
  replica: string | null;
  requestId: string | null;
  page: string | null;
}
