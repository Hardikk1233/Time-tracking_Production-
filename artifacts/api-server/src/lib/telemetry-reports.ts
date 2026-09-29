/**
 * The read side of request telemetry: what the /dev console's Performance
 * tab asks for.
 *
 * Everything is a window ending now - the last fifteen minutes, hour, day or
 * week - bucketed coarsely enough that a week is a few hundred points rather
 * than a few hundred thousand. Percentiles come from Postgres (`percentile_cont`)
 * rather than being computed here, so the rows never leave the database.
 */
import { sql, type SQL } from "drizzle-orm";
import { db } from "@workspace/db";
import { config } from "../config";
import { liveGauges } from "./telemetry";

export type MetricsWindow = "15m" | "1h" | "24h" | "7d";

const WINDOWS: Record<MetricsWindow, { seconds: number; bucketSeconds: number }> = {
  "15m": { seconds: 15 * 60, bucketSeconds: 30 },
  "1h": { seconds: 60 * 60, bucketSeconds: 60 },
  "24h": { seconds: 24 * 60 * 60, bucketSeconds: 10 * 60 },
  "7d": { seconds: 7 * 24 * 60 * 60, bucketSeconds: 60 * 60 },
};

export function parseWindow(raw: unknown): MetricsWindow {
  return typeof raw === "string" && raw in WINDOWS ? (raw as MetricsWindow) : "1h";
}

// ─── Row helpers ─────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

/** pg hands back bigint counts and numerics as strings; everything here is a plain number. */
function num(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value ?? "");
}

async function query(statement: SQL): Promise<Row[]> {
  const result = await db.execute(statement);
  return result.rows as Row[];
}

/** `date_bin`-style bucketing that works on any Postgres version this runs on. */
function bucket(column: SQL, seconds: number): SQL {
  return sql`to_timestamp(floor(extract(epoch from ${column}) / ${seconds}) * ${seconds})`;
}

// ─── Shapes ──────────────────────────────────────────────────────────────────

export interface SeriesPoint {
  t: string;
  requests: number;
  errors: number;
  p50: number;
  p95: number;
  p99: number;
  /** Browser-observed p95 for calls in the same bucket; null when no browser reported. */
  clientP95: number | null;
  /** Server requests in this bucket, per replica. The load-balancing view. */
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
  live: ReturnType<typeof liveGauges>;
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

// ─── Overview ────────────────────────────────────────────────────────────────

export async function metricsOverview(window: MetricsWindow): Promise<MetricsOverview> {
  const { seconds, bucketSeconds } = WINDOWS[window];
  const since = new Date(Date.now() - seconds * 1000);
  const slowMs = config.metricsSlowMs;

  const server = sql`request_metrics m where m.source = 'server' and m.kind = 'api' and m.occurred_at >= ${since}`;
  const client = sql`request_metrics m where m.source = 'client' and m.kind = 'api' and m.occurred_at >= ${since}`;
  const at = bucket(sql`m.occurred_at`, bucketSeconds);

  const [
    [totals],
    [clientTotals],
    seriesRows,
    replicaSeriesRows,
    clientSeriesRows,
    routeRows,
    clientRouteRows,
    userRows,
    clientUserRows,
    replicaRows,
    latestSampleRows,
    sampleRows,
    pageRows,
  ] = await Promise.all([
    query(sql`
      select count(*)::int as requests,
             coalesce(percentile_cont(0.5) within group (order by m.duration_ms), 0)::float as p50,
             coalesce(percentile_cont(0.95) within group (order by m.duration_ms), 0)::float as p95,
             coalesce(percentile_cont(0.99) within group (order by m.duration_ms), 0)::float as p99,
             count(*) filter (where m.status_code >= 500)::int as errors5xx,
             count(*) filter (where m.status_code between 400 and 498)::int as errors4xx,
             count(*) filter (where m.status_code = 499)::int as abandoned,
             count(*) filter (where m.duration_ms >= ${slowMs})::int as slow,
             count(distinct m.user_id)::int as users,
             count(distinct m.replica)::int as replicas
      from ${server}`),
    query(sql`
      select count(*)::int as requests,
             percentile_cont(0.95) within group (order by m.duration_ms)::float as p95,
             count(*) filter (where m.status_code >= 500 or m.status_code = 0)::int as failures
      from ${client}`),
    query(sql`
      select ${at} as t,
             count(*)::int as requests,
             count(*) filter (where m.status_code >= 500 or m.status_code = 499)::int as errors,
             percentile_cont(0.5) within group (order by m.duration_ms)::float as p50,
             percentile_cont(0.95) within group (order by m.duration_ms)::float as p95,
             percentile_cont(0.99) within group (order by m.duration_ms)::float as p99
      from ${server} group by 1 order by 1`),
    query(sql`
      select ${at} as t, m.replica, count(*)::int as requests
      from ${server} group by 1, 2`),
    query(sql`
      select ${at} as t,
             percentile_cont(0.95) within group (order by m.duration_ms)::float as p95
      from ${client} group by 1`),
    query(sql`
      select m.method, m.route,
             count(*)::int as requests,
             percentile_cont(0.5) within group (order by m.duration_ms)::float as p50,
             percentile_cont(0.95) within group (order by m.duration_ms)::float as p95,
             percentile_cont(0.99) within group (order by m.duration_ms)::float as p99,
             count(*) filter (where m.status_code >= 500 or m.status_code = 499)::int as errors,
             count(*) filter (where m.duration_ms >= ${slowMs})::int as slow
      from ${server} group by 1, 2 order by requests desc limit 30`),
    query(sql`
      select m.method, m.route,
             percentile_cont(0.95) within group (order by m.duration_ms)::float as p95
      from ${client} group by 1, 2`),
    query(sql`
      select m.user_id, max(m.user_email) as user_email, max(u.name) as user_name,
             count(*)::int as requests,
             count(*) filter (where m.status_code >= 500)::int as errors,
             count(*) filter (where m.duration_ms >= ${slowMs})::int as slow,
             count(*) filter (where m.status_code = 499)::int as abandoned,
             percentile_cont(0.95) within group (order by m.duration_ms)::float as p95,
             max(m.duration_ms)::float as max_ms,
             max(m.occurred_at) as last_seen
      from request_metrics m
      left join users u on u.id = m.user_id
      where m.source = 'server' and m.kind = 'api' and m.occurred_at >= ${since}
        and m.user_id is not null
      group by m.user_id
      order by (count(*) filter (where m.status_code >= 500 or m.status_code = 499 or m.duration_ms >= ${slowMs})) desc,
               requests desc
      limit 150`),
    query(sql`
      select m.user_id,
             count(*)::int as requests,
             count(*) filter (where m.status_code >= 500 or m.status_code = 0)::int as failures,
             percentile_cont(0.95) within group (order by m.duration_ms)::float as p95
      from ${client} and m.user_id is not null group by 1`),
    query(sql`
      select m.replica, count(*)::int as requests,
             percentile_cont(0.95) within group (order by m.duration_ms)::float as p95
      from ${server} and m.replica is not null group by 1 order by requests desc`),
    query(sql`
      select distinct on (replica) *
      from replica_samples where sampled_at >= ${since}
      order by replica, sampled_at desc`),
    query(sql`
      select ${bucket(sql`sampled_at`, bucketSeconds)} as t, replica,
             avg(event_loop_lag_ms)::float as lag_ms,
             max(event_loop_max_ms)::float as lag_max_ms,
             max(rss_mb)::float as rss_mb,
             max(in_flight)::int as in_flight,
             max(pool_waiting)::int as pool_waiting,
             sum(requests)::int as requests
      from replica_samples where sampled_at >= ${since}
      group by 1, 2 order by 1, 2`),
    query(sql`
      select m.route as page, count(*)::int as loads,
             percentile_cont(0.5) within group (order by m.duration_ms)::float as p50,
             percentile_cont(0.95) within group (order by m.duration_ms)::float as p95,
             percentile_cont(0.95) within group (order by (m.extra->>'ttfbMs')::float)::float as p95_ttfb
      from request_metrics m
      where m.kind = 'page' and m.occurred_at >= ${since}
      group by 1 order by loads desc limit 20`),
  ]);

  // The three per-bucket queries are merged on the bucket timestamp; the
  // server series is the spine, so a bucket with only browser rows (a call
  // that never reached us) still does not invent a server point.
  const replicaByBucket = new Map<string, Record<string, number>>();
  for (const r of replicaSeriesRows) {
    const key = iso(r["t"]);
    const entry = replicaByBucket.get(key) ?? {};
    entry[str(r["replica"]) ?? "unknown"] = num(r["requests"]);
    replicaByBucket.set(key, entry);
  }
  const clientByBucket = new Map<string, number>();
  for (const r of clientSeriesRows) clientByBucket.set(iso(r["t"]), num(r["p95"]));

  const series: SeriesPoint[] = seriesRows.map((r) => {
    const t = iso(r["t"]);
    return {
      t,
      requests: num(r["requests"]),
      errors: num(r["errors"]),
      p50: round(num(r["p50"])),
      p95: round(num(r["p95"])),
      p99: round(num(r["p99"])),
      clientP95: clientByBucket.has(t) ? round(clientByBucket.get(t)!) : null,
      byReplica: replicaByBucket.get(t) ?? {},
    };
  });

  const clientRouteP95 = new Map<string, number>();
  for (const r of clientRouteRows) {
    clientRouteP95.set(`${str(r["method"])} ${str(r["route"])}`, num(r["p95"]));
  }
  const routes: RouteStat[] = routeRows.map((r) => {
    const key = `${str(r["method"])} ${str(r["route"])}`;
    return {
      method: str(r["method"]) ?? "",
      route: str(r["route"]) ?? "",
      requests: num(r["requests"]),
      p50: round(num(r["p50"])),
      p95: round(num(r["p95"])),
      p99: round(num(r["p99"])),
      errors: num(r["errors"]),
      slow: num(r["slow"]),
      clientP95: clientRouteP95.has(key) ? round(clientRouteP95.get(key)!) : null,
    };
  });

  const clientByUser = new Map<number, Row>();
  for (const r of clientUserRows) clientByUser.set(num(r["user_id"]), r);
  const users: UserStat[] = userRows.map((r) => {
    const id = num(r["user_id"]);
    const c = clientByUser.get(id);
    return {
      userId: id,
      userEmail: str(r["user_email"]),
      userName: str(r["user_name"]),
      requests: num(r["requests"]),
      errors: num(r["errors"]),
      slow: num(r["slow"]),
      abandoned: num(r["abandoned"]),
      p95: round(num(r["p95"])),
      maxMs: round(num(r["max_ms"])),
      clientRequests: c ? num(c["requests"]) : 0,
      clientFailures: c ? num(c["failures"]) : 0,
      clientP95: c && c["p95"] != null ? round(num(c["p95"])) : null,
      lastSeen: iso(r["last_seen"]),
    };
  });

  const totalServer = num(totals?.["requests"]);
  const latestByReplica = new Map<string, Row>();
  for (const r of latestSampleRows) latestByReplica.set(str(r["replica"]) ?? "", r);
  const replicas: ReplicaStat[] = replicaRows.map((r) => {
    const name = str(r["replica"]) ?? "unknown";
    const latest = latestByReplica.get(name);
    return {
      replica: name,
      requests: num(r["requests"]),
      share: totalServer > 0 ? round((100 * num(r["requests"])) / totalServer) : 0,
      p95: round(num(r["p95"])),
      latest: latest
        ? {
            sampledAt: iso(latest["sampled_at"]),
            eventLoopLagMs: num(latest["event_loop_lag_ms"]),
            eventLoopMaxMs: num(latest["event_loop_max_ms"]),
            rssMb: num(latest["rss_mb"]),
            heapUsedMb: num(latest["heap_used_mb"]),
            inFlight: num(latest["in_flight"]),
            poolTotal: num(latest["pool_total"]),
            poolIdle: num(latest["pool_idle"]),
            poolWaiting: num(latest["pool_waiting"]),
          }
        : null,
    };
  });
  // A replica that has sampled but not yet served a request in the window is
  // still a replica - a fresh scale-out looks exactly like this.
  for (const [name, latest] of latestByReplica) {
    if (replicas.some((r) => r.replica === name)) continue;
    replicas.push({
      replica: name,
      requests: 0,
      share: 0,
      p95: 0,
      latest: {
        sampledAt: iso(latest["sampled_at"]),
        eventLoopLagMs: num(latest["event_loop_lag_ms"]),
        eventLoopMaxMs: num(latest["event_loop_max_ms"]),
        rssMb: num(latest["rss_mb"]),
        heapUsedMb: num(latest["heap_used_mb"]),
        inFlight: num(latest["in_flight"]),
        poolTotal: num(latest["pool_total"]),
        poolIdle: num(latest["pool_idle"]),
        poolWaiting: num(latest["pool_waiting"]),
      },
    });
  }

  const samples: SamplePoint[] = sampleRows.map((r) => ({
    t: iso(r["t"]),
    replica: str(r["replica"]) ?? "unknown",
    lagMs: round(num(r["lag_ms"])),
    lagMaxMs: round(num(r["lag_max_ms"])),
    rssMb: num(r["rss_mb"]),
    inFlight: num(r["in_flight"]),
    poolWaiting: num(r["pool_waiting"]),
    requests: num(r["requests"]),
  }));

  const pages: PageStat[] = pageRows.map((r) => ({
    page: str(r["page"]) ?? "",
    loads: num(r["loads"]),
    p50: round(num(r["p50"])),
    p95: round(num(r["p95"])),
    p95Ttfb: r["p95_ttfb"] != null ? round(num(r["p95_ttfb"])) : null,
  }));

  return {
    window,
    since: since.toISOString(),
    bucketSeconds,
    slowMs,
    live: liveGauges(),
    totals: {
      requests: totalServer,
      rps: round(totalServer / seconds, 2),
      p50: round(num(totals?.["p50"])),
      p95: round(num(totals?.["p95"])),
      p99: round(num(totals?.["p99"])),
      errors5xx: num(totals?.["errors5xx"]),
      errors4xx: num(totals?.["errors4xx"]),
      abandoned: num(totals?.["abandoned"]),
      slow: num(totals?.["slow"]),
      users: num(totals?.["users"]),
      replicas: Math.max(num(totals?.["replicas"]), replicas.length),
      clientRequests: num(clientTotals?.["requests"]),
      clientP95: clientTotals?.["p95"] != null ? round(num(clientTotals["p95"])) : null,
      clientFailures: num(clientTotals?.["failures"]),
    },
    series,
    routes,
    users,
    replicas,
    samples,
    pages,
  };
}

function round(value: number, places = 0): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

// ─── Individual requests ─────────────────────────────────────────────────────

export interface RequestFilters {
  window: MetricsWindow;
  /** Only rows that went wrong: an error status, a browser-side failure, or a slow duration. */
  problems: boolean;
  userId?: number;
  source?: "server" | "client";
  route?: string;
  minMs?: number;
  limit: number;
}

export interface RequestRow {
  id: number;
  occurredAt: string;
  source: string;
  kind: string;
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

/**
 * The rows behind the summaries: the actual calls, newest first.
 *
 * With `problems` set this is the console's "what went wrong" list. With a
 * `userId` and `problems` off it is one person's recent activity - what
 * somebody saying "it was slow for me at eleven" can be checked against.
 */
export async function metricsRequests(filters: RequestFilters): Promise<RequestRow[]> {
  const since = new Date(Date.now() - WINDOWS[filters.window].seconds * 1000);
  const conditions: SQL[] = [sql`m.occurred_at >= ${since}`, sql`m.kind = 'api'`];

  if (filters.problems) {
    conditions.push(
      sql`(m.status_code >= 400 or m.status_code = 0 or m.duration_ms >= ${config.metricsSlowMs})`,
    );
  }
  if (filters.userId !== undefined) conditions.push(sql`m.user_id = ${filters.userId}`);
  if (filters.source) conditions.push(sql`m.source = ${filters.source}`);
  if (filters.route) conditions.push(sql`m.route = ${filters.route}`);
  if (filters.minMs !== undefined) conditions.push(sql`m.duration_ms >= ${filters.minMs}`);

  const rows = await query(sql`
    select m.id, m.occurred_at, m.source, m.kind, m.method, m.route, m.status_code,
           m.duration_ms, m.user_id, m.user_email, m.replica, m.request_id, m.page
    from request_metrics m
    where ${sql.join(conditions, sql` and `)}
    order by m.occurred_at desc
    limit ${filters.limit}`);

  return rows.map((r) => ({
    id: num(r["id"]),
    occurredAt: iso(r["occurred_at"]),
    source: str(r["source"]) ?? "server",
    kind: str(r["kind"]) ?? "api",
    method: str(r["method"]),
    route: str(r["route"]) ?? "",
    statusCode: r["status_code"] == null ? null : num(r["status_code"]),
    durationMs: round(num(r["duration_ms"])),
    userId: r["user_id"] == null ? null : num(r["user_id"]),
    userEmail: str(r["user_email"]),
    replica: str(r["replica"]),
    requestId: str(r["request_id"]),
    page: str(r["page"]),
  }));
}
