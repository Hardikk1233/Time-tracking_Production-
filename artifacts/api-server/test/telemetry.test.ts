import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import app from "../src/app";
import { db, requestMetricsTable, replicaSamplesTable } from "@workspace/db";
import {
  normaliseRoute,
  isExcludedRoute,
  recordMetric,
  flushMetrics,
  clearMetrics,
  sampleReplica,
} from "../src/lib/telemetry";
import { resetDatabase, signIn, type Fixtures } from "./fixtures";

/**
 * Request telemetry: the timings behind the /dev console's Performance tab.
 *
 * The rollout puts a hundred people on a quarter of a vCPU. When somebody
 * says it was slow, these rows are what says whether it was the server, the
 * network, or their browser - and who else it happened to.
 */

/** Everything captured so far, written and read back. */
async function captured() {
  await flushMetrics();
  return db.select().from(requestMetricsTable);
}

/**
 * A minute of traffic across two replicas: three quick calls, one slow one,
 * one failure, one abandoned - plus one browser-side timing for comparison.
 */
function seedTraffic(f: Fixtures): void {
  const analyst = { userId: f.analyst, userEmail: "analyst@test.local" };
  const avp = { userId: f.avp, userEmail: "avp@test.local" };

  for (let i = 0; i < 3; i += 1) {
    recordMetric({
      source: "server", kind: "api", method: "GET", route: "/api/time-entries",
      statusCode: 200, durationMs: 50, replica: "replica-a", ...analyst,
    });
  }
  recordMetric({
    source: "server", kind: "api", method: "GET", route: "/api/reports/team",
    statusCode: 200, durationMs: 1500, replica: "replica-b", ...avp,
  });
  recordMetric({
    source: "server", kind: "api", method: "POST", route: "/api/time-entries",
    statusCode: 500, durationMs: 80, replica: "replica-a", ...analyst,
  });
  recordMetric({
    source: "server", kind: "api", method: "GET", route: "/api/dashboard/summary",
    statusCode: 499, durationMs: 30, replica: "replica-a", ...analyst,
  });
  recordMetric({
    source: "client", kind: "api", method: "GET", route: "/api/time-entries",
    statusCode: 200, durationMs: 200, page: "/time-entries", ...analyst,
  });
}

describe("request telemetry", () => {
  let f: Fixtures;

  beforeEach(async () => {
    // Whatever earlier suites left in the buffer lands now, before the reset
    // truncates it, so it cannot arrive in the middle of a test.
    await flushMetrics();
    f = await resetDatabase();
    await clearMetrics();
  });

  describe("route normalisation", () => {
    it("collapses record ids so calls for different records aggregate together", () => {
      expect(normaliseRoute("/api/time-entries/412?x=1")).toBe("/api/time-entries/:id");
      expect(normaliseRoute("/api/clients/4/projects/17")).toBe("/api/clients/:id/projects/:id");
      expect(normaliseRoute("/api/time-entries/412/reopen")).toBe("/api/time-entries/:id/reopen");
    });

    it("leaves routes without ids alone", () => {
      expect(normaliseRoute("/api/reports/my-report")).toBe("/api/reports/my-report");
      expect(normaliseRoute("/api/time-entries#frag")).toBe("/api/time-entries");
    });

    it("leaves the probes and the console out of the picture", () => {
      expect(isExcludedRoute("/api/healthz")).toBe(true);
      expect(isExcludedRoute("/api/readyz")).toBe(true);
      expect(isExcludedRoute("/api/dev/summary")).toBe(true);
      expect(isExcludedRoute("/api/dev/client-metrics")).toBe(true);
      expect(isExcludedRoute("/api/time-entries")).toBe(false);
    });
  });

  describe("server-side capture", () => {
    it("times a signed-in request and attributes it to the caller", async () => {
      const analyst = await signIn(app, "analyst@test.local");
      await analyst.get("/api/time-entries");

      const row = (await captured()).find(
        (r) => r.route === "/api/time-entries" && r.method === "GET",
      );
      expect(row).toBeDefined();
      expect(row?.source).toBe("server");
      expect(row?.statusCode).toBe(200);
      expect(row?.userId).toBe(f.analyst);
      expect(row?.userEmail).toBe("analyst@test.local");
      expect(row?.replica).toBe("test-replica");
      expect(row?.durationMs).toBeGreaterThanOrEqual(0);
      expect(row?.requestId).toBeTruthy();
    });

    it("records a refused request with its status and no user", async () => {
      await request(app).get("/api/time-entries");

      const row = (await captured()).find((r) => r.route === "/api/time-entries");
      expect(row?.statusCode).toBe(401);
      expect(row?.userId).toBeNull();
    });

    it("does not measure the probes or the console watching itself", async () => {
      await request(app).get("/api/healthz");
      const md = await signIn(app, "md@test.local");
      await md.get("/api/dev/summary");

      const rows = await captured();
      expect(rows.some((r) => r.route === "/api/healthz")).toBe(false);
      expect(rows.some((r) => r.route.startsWith("/api/dev/"))).toBe(false);
    });
  });

  describe("browser-side capture", () => {
    it("accepts the browser's timings and normalises them like the server's", async () => {
      const analyst = await signIn(app, "analyst@test.local");
      const res = await analyst.post("/api/dev/client-metrics").send({
        samples: [
          {
            kind: "api", method: "get", path: "/api/time-entries/42?x=1",
            status: 200, durationMs: 123.4, page: "/time-entries?tab=all",
          },
          {
            kind: "page", path: "/dashboard", durationMs: 900,
            ttfbMs: 120, loadMs: 1500, effectiveType: "4g",
          },
        ],
      });
      expect(res.status).toBe(204);

      const rows = (await captured()).filter((r) => r.source === "client");
      const call = rows.find((r) => r.kind === "api");
      expect(call?.route).toBe("/api/time-entries/:id");
      expect(call?.method).toBe("GET");
      expect(call?.statusCode).toBe(200);
      expect(call?.durationMs).toBeCloseTo(123.4, 1);
      expect(call?.page).toBe("/time-entries");
      expect(call?.userEmail).toBe("analyst@test.local");

      const load = rows.find((r) => r.kind === "page");
      expect(load?.route).toBe("/dashboard");
      expect(load?.durationMs).toBe(900);
      expect(load?.extra).toMatchObject({ ttfbMs: 120, loadMs: 1500, effectiveType: "4g" });
    });

    it("refuses timings from nobody in particular", async () => {
      const res = await request(app)
        .post("/api/dev/client-metrics")
        .send({ samples: [{ kind: "api", path: "/api/time-entries", durationMs: 10 }] });
      expect(res.status).toBe(401);
    });

    it("skips what it cannot use rather than failing the batch", async () => {
      const analyst = await signIn(app, "analyst@test.local");
      const res = await analyst.post("/api/dev/client-metrics").send({
        samples: [
          null,
          42,
          { kind: "api" },
          { kind: "api", path: "/api/x", durationMs: "not a number" },
          // Not the API's own call, so nothing on the server side to compare with.
          { kind: "api", path: "https://login.microsoftonline.com/token", durationMs: 10 },
          // The console's own traffic, excluded on this side as on the other.
          { kind: "api", path: "/api/dev/summary", durationMs: 10 },
          { kind: "api", path: "/api/healthz", durationMs: 5 },
        ],
      });
      expect(res.status).toBe(204);
      expect((await captured()).filter((r) => r.source === "client")).toHaveLength(0);
    });
  });

  describe("the console", () => {
    it("answers 404 to anyone not allowlisted, as the rest of it does", async () => {
      const analyst = await signIn(app, "analyst@test.local");
      expect((await analyst.get("/api/dev/metrics/overview")).status).toBe(404);
      expect((await analyst.get("/api/dev/metrics/requests")).status).toBe(404);
    });

    it("summarises a window: totals, routes, people and replicas", async () => {
      const md = await signIn(app, "md@test.local");
      // The sign-in itself was timed; start the window from a clean table.
      await flushMetrics();
      await clearMetrics();
      seedTraffic(f);
      await flushMetrics();

      const res = await md.get("/api/dev/metrics/overview?window=1h");
      expect(res.status).toBe(200);
      const { totals, routes, users, replicas, series } = res.body;

      expect(totals.requests).toBe(6);
      expect(totals.errors5xx).toBe(1);
      expect(totals.abandoned).toBe(1);
      expect(totals.slow).toBe(1);
      expect(totals.users).toBe(2);
      expect(totals.replicas).toBe(2);
      expect(totals.clientRequests).toBe(1);
      expect(totals.clientP95).toBe(200);

      // The same route seen from both sides, so the gap between them is readable.
      const entries = routes.find(
        (r: { method: string; route: string }) => r.method === "GET" && r.route === "/api/time-entries",
      );
      expect(entries.requests).toBe(3);
      expect(entries.p95).toBe(50);
      expect(entries.clientP95).toBe(200);

      // People are ranked by trouble, not by volume: the AVP made one call and
      // it was slow, the analyst made five and one failed and one was abandoned.
      const analyst = users.find((u: { userId: number }) => u.userId === f.analyst);
      const avp = users.find((u: { userId: number }) => u.userId === f.avp);
      expect(analyst).toMatchObject({ requests: 5, errors: 1, abandoned: 1, clientRequests: 1 });
      expect(avp).toMatchObject({ requests: 1, slow: 1, p95: 1500 });
      expect(analyst.userName).toBe("Ana Lyst");

      expect(replicas).toHaveLength(2);
      const shares = replicas.map((r: { share: number }) => r.share);
      expect(shares.reduce((a: number, b: number) => a + b, 0)).toBe(100);
      expect(replicas.find((r: { replica: string }) => r.replica === "replica-a").requests).toBe(5);

      expect(series.length).toBeGreaterThanOrEqual(1);
      const bucketed = series.reduce((sum: number, p: { requests: number }) => sum + p.requests, 0);
      expect(bucketed).toBe(6);
      expect(Object.values(series[0].byReplica).length).toBeGreaterThanOrEqual(1);
    });

    it("falls back to an hour when the window is not one it knows", async () => {
      const md = await signIn(app, "md@test.local");
      const res = await md.get("/api/dev/metrics/overview?window=forever");
      expect(res.status).toBe(200);
      expect(res.body.window).toBe("1h");
      expect(res.body.slowMs).toBe(1000);
    });

    it("lists the calls that went wrong, and one person's calls on request", async () => {
      const md = await signIn(app, "md@test.local");
      await flushMetrics();
      await clearMetrics();
      seedTraffic(f);
      await flushMetrics();

      const problems = await md.get("/api/dev/metrics/requests?window=1h");
      expect(problems.status).toBe(200);
      const statuses = problems.body.requests.map(
        (r: { statusCode: number; durationMs: number }) => `${r.statusCode}:${r.durationMs}`,
      );
      expect(statuses).toHaveLength(3);
      expect(statuses).toEqual(expect.arrayContaining(["500:80", "499:30", "200:1500"]));

      const theirs = await md.get(`/api/dev/metrics/requests?window=1h&problems=0&userId=${f.avp}`);
      expect(theirs.body.requests).toHaveLength(1);
      expect(theirs.body.requests[0]).toMatchObject({
        route: "/api/reports/team", replica: "replica-b", userEmail: "avp@test.local",
      });
    });

    it("clears both tables when asked", async () => {
      const md = await signIn(app, "md@test.local");
      seedTraffic(f);
      await flushMetrics();
      await sampleReplica();

      expect((await md.delete("/api/dev/metrics")).status).toBe(204);
      expect(await db.select().from(requestMetricsTable)).toHaveLength(0);
      expect(await db.select().from(replicaSamplesTable)).toHaveLength(0);
    });
  });

  describe("replica samples", () => {
    it("records this replica's pool and event-loop figures", async () => {
      await sampleReplica();

      const [row] = await db.select().from(replicaSamplesTable);
      expect(row.replica).toBe("test-replica");
      expect(row.eventLoopLagMs).toBeGreaterThanOrEqual(0);
      expect(row.rssMb).toBeGreaterThan(0);
      expect(row.poolTotal).toBeGreaterThanOrEqual(0);
      expect(row.poolWaiting).toBeGreaterThanOrEqual(0);
    });

    it("shows a replica that has sampled but not yet served anything", async () => {
      // A fresh scale-out looks exactly like this for its first few seconds.
      await sampleReplica();
      const md = await signIn(app, "md@test.local");

      const res = await md.get("/api/dev/metrics/overview?window=15m");
      const mine = res.body.replicas.find((r: { replica: string }) => r.replica === "test-replica");
      expect(mine).toBeDefined();
      expect(mine.latest).not.toBeNull();
      expect(typeof mine.latest.poolTotal).toBe("number");
    });
  });
});
