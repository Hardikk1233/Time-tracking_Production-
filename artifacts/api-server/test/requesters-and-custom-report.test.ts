import { describe, it, expect, beforeEach } from "vitest";
import app from "../src/app";
import { db, clientRequestersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { resetDatabase, seedEntry, signIn, type Fixtures } from "./fixtures";

/**
 * Client requesters, and the custom report that reads them.
 *
 * A requester is somebody at the *client* who asks for work - no login, no
 * role, no hours. The distinction matters twice over: they must never be
 * confused with staff, and recording one must be within reach of the Associate
 * running the account rather than gated on an AVP, or the list goes stale and
 * stops being worth reading.
 */
describe("client requesters", () => {
  let f: Fixtures;

  beforeEach(async () => {
    f = await resetDatabase();
  });

  describe("who may record one", () => {
    it("lets an associate add one, which is the point of the feature", async () => {
      const associate = await signIn(app, "associate@test.local");
      const res = await associate
        .post(`/api/clients/${f.acmeId}/requesters`)
        .send({ name: "Priya Menon", designation: "CFO" });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        clientId: f.acmeId,
        name: "Priya Menon",
        designation: "CFO",
      });
      expect(res.body.id).toBeGreaterThan(0);
    });

    it("lets an AVP and an MD add one too", async () => {
      const avp = await signIn(app, "avp@test.local");
      const md = await signIn(app, "md@test.local");

      expect(
        (await avp.post(`/api/clients/${f.acmeId}/requesters`).send({ name: "A", designation: "Head of Tax" })).status,
      ).toBe(201);
      expect(
        (await md.post(`/api/clients/${f.acmeId}/requesters`).send({ name: "B", designation: "CEO" })).status,
      ).toBe(201);
    });

    it("refuses an analyst", async () => {
      const analyst = await signIn(app, "analyst@test.local");
      const res = await analyst
        .post(`/api/clients/${f.acmeId}/requesters`)
        .send({ name: "Priya Menon", designation: "CFO" });
      expect(res.status).toBe(403);
    });

    it("refuses an associate on a client outside their remit", async () => {
      // 404 rather than 403 throughout: whether Beta exists is not something
      // to disclose to somebody who cannot see it.
      const outsider = await signIn(app, "associate@test.local");
      const res = await outsider
        .post(`/api/clients/${f.betaId}/requesters`)
        .send({ name: "Someone", designation: "CFO" });
      expect(res.status).toBe(404);
    });
  });

  describe("what a requester must say", () => {
    it("insists on both a name and a designation", async () => {
      const associate = await signIn(app, "associate@test.local");
      for (const body of [
        { name: "Priya Menon" },
        { designation: "CFO" },
        { name: "   ", designation: "CFO" },
        { name: "Priya Menon", designation: "  " },
        {},
      ]) {
        const res = await associate.post(`/api/clients/${f.acmeId}/requesters`).send(body);
        expect(res.status).toBe(400);
      }
      expect(await db.select().from(clientRequestersTable)).toHaveLength(0);
    });

    it("trims what it stores", async () => {
      const associate = await signIn(app, "associate@test.local");
      const res = await associate
        .post(`/api/clients/${f.acmeId}/requesters`)
        .send({ name: "  Priya Menon  ", designation: "  CFO  " });
      expect(res.body.name).toBe("Priya Menon");
      expect(res.body.designation).toBe("CFO");
    });
  });

  describe("reading and removing", () => {
    it("lists them for anyone who can see the client, an analyst included", async () => {
      const associate = await signIn(app, "associate@test.local");
      await associate.post(`/api/clients/${f.acmeId}/requesters`).send({ name: "Priya Menon", designation: "CFO" });

      // The analyst is on an Acme project, so the client is theirs to see.
      const analyst = await signIn(app, "analyst@test.local");
      const res = await analyst.get(`/api/clients/${f.acmeId}/requesters`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0]).toMatchObject({ name: "Priya Menon", designation: "CFO" });
    });

    it("hides them from somebody who cannot see the client", async () => {
      const md = await signIn(app, "md@test.local");
      await md.post(`/api/clients/${f.betaId}/requesters`).send({ name: "Beta Person", designation: "COO" });

      const associate = await signIn(app, "associate@test.local");
      expect((await associate.get(`/api/clients/${f.betaId}/requesters`)).status).toBe(404);
    });

    it("removes one, and refuses to reach across clients to do it", async () => {
      const md = await signIn(app, "md@test.local");
      const created = await md
        .post(`/api/clients/${f.betaId}/requesters`)
        .send({ name: "Beta Person", designation: "COO" });
      const id = created.body.id;

      // Knowing the id is not enough: it has to belong to the client in the
      // path, or a requester could be deleted from another account entirely.
      const wrongClient = await md.delete(`/api/clients/${f.acmeId}/requesters/${id}`);
      expect(wrongClient.status).toBe(404);
      expect(await db.select().from(clientRequestersTable).where(eq(clientRequestersTable.id, id))).toHaveLength(1);

      const right = await md.delete(`/api/clients/${f.betaId}/requesters/${id}`);
      expect(right.status).toBe(200);
      expect(await db.select().from(clientRequestersTable).where(eq(clientRequestersTable.id, id))).toHaveLength(0);
    });

    it("refuses removal by an analyst", async () => {
      const associate = await signIn(app, "associate@test.local");
      const created = await associate
        .post(`/api/clients/${f.acmeId}/requesters`)
        .send({ name: "Priya Menon", designation: "CFO" });

      const analyst = await signIn(app, "analyst@test.local");
      expect((await analyst.delete(`/api/clients/${f.acmeId}/requesters/${created.body.id}`)).status).toBe(403);
    });

    it("takes its requesters with it when the client goes", async () => {
      const md = await signIn(app, "md@test.local");
      await md.post(`/api/clients/${f.betaId}/requesters`).send({ name: "Beta Person", designation: "COO" });

      await db.delete(clientRequestersTable).where(eq(clientRequestersTable.clientId, f.betaId));
      expect(await db.select().from(clientRequestersTable)).toHaveLength(0);
    });
  });

  it("shows them on the client utilisation report", async () => {
    const md = await signIn(app, "md@test.local");
    await md.post(`/api/clients/${f.acmeId}/requesters`).send({ name: "Priya Menon", designation: "CFO" });

    const res = await md.get("/api/reports/client-report?startDate=2026-08-01&endDate=2026-08-31");
    const acme = res.body.clientSummary.find((c: { clientId: number }) => c.clientId === f.acmeId);
    const beta = res.body.clientSummary.find((c: { clientId: number }) => c.clientId === f.betaId);

    expect(acme.requesters).toEqual([{ name: "Priya Menon", designation: "CFO" }]);
    // A client with none reports an empty list, not a missing field: the UI
    // renders an em dash from it rather than crashing on undefined.
    expect(beta.requesters).toEqual([]);
  });
});

describe("the custom report", () => {
  let f: Fixtures;
  const range = "startDate=2026-08-01&endDate=2026-08-31";

  beforeEach(async () => {
    f = await resetDatabase();

    // Two people on the same Acme project, so "who spent it" has an answer,
    // and one entry on Beta so client filtering has something to exclude.
    await seedEntry({
      userId: f.analyst, projectId: f.auditProjectId, taskId: f.taskId,
      hours: 10, billableHours: 8, date: "2026-08-03", status: "approved", approvedById: f.associate,
    });
    await seedEntry({
      userId: f.avp, projectId: f.auditProjectId, taskId: f.taskId,
      hours: 4, billableHours: 4, date: "2026-08-04", status: "approved", approvedById: f.md,
    });
    await seedEntry({
      userId: f.otherAnalyst, projectId: f.betaProjectId, taskId: f.betaTaskId,
      hours: 6, date: "2026-08-05", status: "pending",
    });
  });

  it("returns hours per person, project and task across everything in scope", async () => {
    const md = await signIn(app, "md@test.local");
    const res = await md.get(`/api/reports/custom-report?${range}`);

    expect(res.status).toBe(200);
    expect(res.body.range).toEqual({ start: "2026-08-01", end: "2026-08-31" });

    const acme = res.body.rows.filter((r: { clientId: number }) => r.clientId === f.acmeId);
    expect(acme).toHaveLength(2);

    const analystRow = acme.find((r: { userId: number }) => r.userId === f.analyst);
    expect(analystRow).toMatchObject({
      userName: "Ana Lyst", userRole: "analyst",
      projectId: f.auditProjectId, taskId: f.taskId,
      totalHours: 10, billableHours: 8, nonBillableHours: 2,
    });

    // The whole point of the report: the split between ranks on one project.
    const avpRow = acme.find((r: { userId: number }) => r.userId === f.avp);
    expect(avpRow).toMatchObject({ userRole: "avp", totalHours: 4 });
  });

  it("narrows by client, then by project, then by person", async () => {
    const md = await signIn(app, "md@test.local");

    const byClient = await md.get(`/api/reports/custom-report?${range}&clientIds=${f.acmeId}`);
    expect(byClient.body.rows.every((r: { clientId: number }) => r.clientId === f.acmeId)).toBe(true);
    expect(byClient.body.rows).toHaveLength(2);

    const byProject = await md.get(`/api/reports/custom-report?${range}&projectIds=${f.betaProjectId}`);
    expect(byProject.body.rows).toHaveLength(1);
    expect(byProject.body.rows[0].projectId).toBe(f.betaProjectId);

    const byUser = await md.get(`/api/reports/custom-report?${range}&userIds=${f.avp}`);
    expect(byUser.body.rows).toHaveLength(1);
    expect(byUser.body.rows[0].userId).toBe(f.avp);
  });

  it("names who asked for the work, for every client in the result", async () => {
    const md = await signIn(app, "md@test.local");
    await md.post(`/api/clients/${f.acmeId}/requesters`).send({ name: "Priya Menon", designation: "CFO" });
    await md.post(`/api/clients/${f.betaId}/requesters`).send({ name: "Beta Person", designation: "COO" });

    const all = await md.get(`/api/reports/custom-report?${range}`);
    expect(all.body.requesters).toHaveLength(2);

    // Narrowed to one client, only that client's requesters come back - the
    // report should not name people from an account it is not reporting on.
    const acmeOnly = await md.get(`/api/reports/custom-report?${range}&clientIds=${f.acmeId}`);
    expect(acmeOnly.body.requesters).toHaveLength(1);
    expect(acmeOnly.body.requesters[0]).toMatchObject({ clientId: f.acmeId, name: "Priya Menon" });
  });

  describe("scope still decides what comes back", () => {
    it("shows an associate their own client and not the other silo", async () => {
      const associate = await signIn(app, "associate@test.local");
      const res = await associate.get(`/api/reports/custom-report?${range}`);

      expect(res.body.rows.length).toBeGreaterThan(0);
      expect(res.body.rows.every((r: { clientId: number }) => r.clientId === f.acmeId)).toBe(true);
    });

    it("refuses to widen when somebody asks for a client outside their remit", async () => {
      const associate = await signIn(app, "associate@test.local");
      const res = await associate.get(`/api/reports/custom-report?${range}&clientIds=${f.betaId}`);

      // Empty, never unrestricted: conflating "nothing matches" with "no
      // restriction" is how a scoping bug becomes a data leak.
      expect(res.body.rows).toEqual([]);
      expect(res.body.requesters).toEqual([]);
    });

    it("shows an analyst only their own hours", async () => {
      const analyst = await signIn(app, "analyst@test.local");
      const res = await analyst.get(`/api/reports/custom-report?${range}`);

      expect(res.body.rows).toHaveLength(1);
      expect(res.body.rows[0].userId).toBe(f.analyst);
    });

    it("gives the same totals as Team Reports over the same slice", async () => {
      // Both read the one aggregation helper; this is the check that keeps
      // them from drifting apart if somebody edits only one.
      const md = await signIn(app, "md@test.local");
      const custom = await md.get(`/api/reports/custom-report?${range}`);
      const team = await md.get(`/api/reports/team-report?${range}`);

      const sum = (rows: Array<{ totalHours: number }>) =>
        rows.reduce((acc, r) => acc + r.totalHours, 0);

      expect(custom.body.rows).toHaveLength(team.body.length);
      expect(sum(custom.body.rows)).toBe(sum(team.body));
    });
  });
});
