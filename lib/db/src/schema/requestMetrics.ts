import {
  pgTable,
  serial,
  text,
  integer,
  real,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";

/**
 * One row per API call, as seen from one side of the wire.
 *
 * `source` says which side. A "server" row is the API timing itself: the
 * milliseconds between the request arriving and the response finishing, on
 * the replica that served it. A "client" row is the same call as the browser
 * experienced it - from `fetch` starting to the body arriving - and the
 * difference between the two is the network, the ingress, and any queueing in
 * front of the container. Slowness with a small gap is the server's; slowness
 * with a large gap is somewhere between the person and the server, which is a
 * different conversation.
 *
 * "page" rows carry a full page load instead of an API call: `route` is the
 * SPA path and `extra` holds the navigation timings.
 *
 * Written in batches from an in-memory buffer rather than per request, so at
 * a hundred people the cost is one insert every few seconds instead of one
 * per call. Trimmed by age on write. Temporary, like the rest of the /dev
 * console: the rollout is what this exists to watch.
 */
export const requestMetricsTable = pgTable(
  "request_metrics",
  {
    id: serial("id").primaryKey(),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    source: text("source", { enum: ["server", "client"] }).notNull(),
    kind: text("kind", { enum: ["api", "page"] }).notNull().default("api"),
    method: text("method"),
    /**
     * The path with every numeric segment replaced by `:id`, so that
     * `/time-entries/412` and `/time-entries/9` aggregate as one route. Both
     * sides are normalised the same way, which is what lets a server row and
     * a client row for the same call be laid side by side.
     */
    route: text("route").notNull(),
    statusCode: integer("status_code"),
    durationMs: real("duration_ms").notNull(),
    userId: integer("user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    userEmail: text("user_email"),
    /**
     * CONTAINER_APP_REPLICA_NAME on the server; null on client rows, which
     * cannot know which replica answered them. Grouping server rows by this
     * is the whole load-balancing view: whether traffic is being spread, and
     * whether a scale-out happened when it should have.
     */
    replica: text("replica"),
    /** pino's request id on server rows, so a slow call can be found in the log. */
    requestId: text("request_id"),
    /** The SPA page a client call was made from, so "the reports page is slow" is answerable. */
    page: text("page"),
    /** Navigation timings for page rows; connection type where the browser exposes it. */
    extra: jsonb("extra"),
  },
  (table) => [
    // Every read is "the last N minutes", then grouped by route, user or
    // replica within that.
    index("request_metrics_occurred_at_idx").on(table.occurredAt),
    index("request_metrics_user_id_idx").on(table.userId),
  ],
);

export type RequestMetric = typeof requestMetricsTable.$inferSelect;
export type InsertRequestMetric = typeof requestMetricsTable.$inferInsert;

/**
 * A snapshot of one replica's health, taken every few seconds.
 *
 * Request timings say what happened to the people; this says why. On a
 * quarter of a vCPU the first thing to give under load is the event loop -
 * every request queues behind whatever is running - and event-loop lag is the
 * measure of that. Pool waiters say the same thing about the database: a
 * request that wanted a connection and had to wait for one. Both climb before
 * latency does, which is what makes them worth sampling.
 */
export const replicaSamplesTable = pgTable(
  "replica_samples",
  {
    id: serial("id").primaryKey(),
    sampledAt: timestamp("sampled_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    replica: text("replica").notNull(),
    /** Mean event-loop delay over the interval, in milliseconds. */
    eventLoopLagMs: real("event_loop_lag_ms").notNull(),
    /** Worst event-loop delay over the interval. */
    eventLoopMaxMs: real("event_loop_max_ms").notNull(),
    rssMb: real("rss_mb").notNull(),
    heapUsedMb: real("heap_used_mb").notNull(),
    /** Requests started in the interval, so the sampler doubles as a per-replica throughput gauge. */
    requests: integer("requests").notNull(),
    /** Requests still open at the moment of sampling. */
    inFlight: integer("in_flight").notNull(),
    poolTotal: integer("pool_total").notNull(),
    poolIdle: integer("pool_idle").notNull(),
    poolWaiting: integer("pool_waiting").notNull(),
  },
  (table) => [index("replica_samples_sampled_at_idx").on(table.sampledAt)],
);

export type ReplicaSample = typeof replicaSamplesTable.$inferSelect;
export type InsertReplicaSample = typeof replicaSamplesTable.$inferInsert;
