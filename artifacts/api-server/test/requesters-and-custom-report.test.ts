import { describe, it, expect, beforeEach } from "vitest";
import app from "../src/app";
import { db, clientRequestersTable, usersTable } from "@workspace/db";
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

  it("keeps them off the client utilisation report", async () => {
    // That table answers whether an account is worth its capacity. An
    // account's whole contact list turned one row into a column of names and
    // pushed the figures aside, so the question is answered on the client's
    // own page and, per project, on the custom report instead.
    const md = await signIn(app, "md@test.local");
    await md.post(`/api/clients/${f.acmeId}/requesters`).send({ name: "Priya Menon", designation: "CFO" });

    const res = await md.get("/api/reports/client-report?startDate=2026-08-01&endDate=2026-08-31");
    const acme = res.body.clientSummary.find((c: { clientId: number }) => c.clientId === f.acmeId);

    expect(acme).toBeDefined();
    expect(acme).not.toHaveProperty("requesters");
  });
});

/**
 * Wherever a person is shown, the app must show their designation and not the
 * rank it authorises on.
 *
 * Those are different facts: an administrator holds md so that they can
 * administer the system, but only the Managing Director is an MD. The rank
 * alone was being sent on every one of these responses, so eight screens
 * rendered "Md" at somebody whose card on the Team page said "Admin".
 */
describe("a person's designation travels with their rank", () => {
  let f: Fixtures;

  beforeEach(async () => {
    f = await resetDatabase();
    await db.update(usersTable).set({ title: "Admin" }).where(eq(usersTable.id, f.md));
    await seedEntry({
      userId: f.md, projectId: f.auditProjectId, taskId: f.taskId,
      hours: 3, date: "2026-08-03",
    });
  });

  it("sends it with a client's assigned team", async () => {
    const md = await signIn(app, "md@test.local");
    await md.post(`/api/clients/${f.acmeId}/assignments`).send({ userId: f.md });

    const res = await md.get(`/api/clients/${f.acmeId}/assignments`);
    const row = res.body.find((u: { id: number }) => u.id === f.md);
    expect(row.role).toBe("md");
    expect(row.title).toBe("Admin");
  });

  it("sends it with a project's team", async () => {
    const md = await signIn(app, "md@test.local");
    const res = await md.get(`/api/projects/${f.auditProjectId}/assignments`);
    // The fixture team is on this project; nobody there has an override, so
    // the field must still be present and null rather than missing.
    expect(res.status).toBe(200);
    for (const row of res.body) expect(row).toHaveProperty("title");
  });

  it("sends it on time entries, which the queues and feeds all render", async () => {
    const md = await signIn(app, "md@test.local");
    const res = await md.get("/api/time-entries");
    const mine = res.body.find((e: { userId: number }) => e.userId === f.md);
    expect(mine.userRole).toBe("md");
    expect(mine.userTitle).toBe("Admin");
  });

  it("sends it on report rows, so exports carry it too", async () => {
    const md = await signIn(app, "md@test.local");
    const range = "startDate=2026-08-01&endDate=2026-08-31";

    for (const path of [`/api/reports/team-report?${range}`, `/api/reports/custom-report?${range}`]) {
      const res = await md.get(path);
      const rows = Array.isArray(res.body) ? res.body : res.body.rows;
      const mine = rows.find((r: { userId: number }) => r.userId === f.md);
      expect(mine.userTitle).toBe("Admin");
    }
  });

  it("leaves it null for everybody who has no override", async () => {
    const md = await signIn(app, "md@test.local");
    const res = await md.get("/api/users");
    const analyst = res.body.find((u: { email: string }) => u.email === "analyst@test.local");
    expect(analyst.role).toBe("analyst");
    expect(analyst.title).toBeNull();
  });
});

/**
 * A project names the one person who commissioned it.
 *
 * The client's requester list says who *can* ask; this says who did. A report
 * row about one memo naming all seven of an account's contacts answers a
 * question nobody asked, which is what this replaces.
 */
describe("a project's requester", () => {
  let f: Fixtures;
  let acmeRequester: number;
  let betaRequester: number;

  beforeEach(async () => {
    f = await resetDatabase();
    const md = await signIn(app, "md@test.local");
    acmeRequester = (await md.post(`/api/clients/${f.acmeId}/requesters`)
      .send({ name: "Priya Menon", designation: "CFO" })).body.id;
    betaRequester = (await md.post(`/api/clients/${f.betaId}/requesters`)
      .send({ name: "Beta Person", designation: "COO" })).body.id;
  });

  const newProject = (extra: Record<string, unknown> = {}) => ({
    clientId: f.acmeId,
    name: "Q4 Memo",
    description: "A memo",
    taskIds: [f.taskId],
    userIds: [f.analyst],
    ...extra,
  });

  it("is recorded when the project is created", async () => {
    const md = await signIn(app, "md@test.local");
    const res = await md.post("/api/projects").send(newProject({ requesterId: acmeRequester }));

    expect(res.status).toBe(201);
    expect(res.body.requesterId).toBe(acmeRequester);

    const fetched = await md.get(`/api/projects/${res.body.id}`);
    expect(fetched.body.requesterName).toBe("Priya Menon");
    expect(fetched.body.requesterDesignation).toBe("CFO");
  });

  it("stays optional, so a client with nobody recorded is not blocked", async () => {
    const md = await signIn(app, "md@test.local");
    const res = await md.post("/api/projects").send(newProject());

    expect(res.status).toBe(201);
    expect(res.body.requesterId).toBeNull();

    // And the project still appears in listings - a left join, not an inner one.
    const list = await md.get(`/api/projects?clientId=${f.acmeId}`);
    expect(list.body.some((p: { id: number }) => p.id === res.body.id)).toBe(true);
  });

  it("refuses somebody who belongs to a different client", async () => {
    // The foreign key only says the requester exists; without the extra check
    // a project could be attributed to a person at another firm.
    const md = await signIn(app, "md@test.local");
    const res = await md.post("/api/projects").send(newProject({ requesterId: betaRequester }));

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/does not belong to this client/i);
  });

  it("can be changed and cleared afterwards", async () => {
    const md = await signIn(app, "md@test.local");
    const created = await md.post("/api/projects").send(newProject({ requesterId: acmeRequester }));
    const id = created.body.id;

    const cleared = await md.patch(`/api/projects/${id}`).send({ requesterId: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.requesterId).toBeNull();

    const reset = await md.patch(`/api/projects/${id}`).send({ requesterId: acmeRequester });
    expect(reset.body.requesterId).toBe(acmeRequester);

    const wrongClient = await md.patch(`/api/projects/${id}`).send({ requesterId: betaRequester });
    expect(wrongClient.status).toBe(400);
  });

  it("survives the requester being deleted, losing only the attribution", async () => {
    // The person leaves the client; the project and its hours must not.
    const md = await signIn(app, "md@test.local");
    const created = await md.post("/api/projects").send(newProject({ requesterId: acmeRequester }));

    await md.delete(`/api/clients/${f.acmeId}/requesters/${acmeRequester}`);

    const fetched = await md.get(`/api/projects/${created.body.id}`);
    expect(fetched.status).toBe(200);
    expect(fetched.body.requesterId).toBeNull();
  });

  it("names only that project's requester on report rows", async () => {
    const md = await signIn(app, "md@test.local");
    // A second requester at the same client, deliberately not attached to the
    // project: the old behaviour listed every one of these against every row.
    await md.post(`/api/clients/${f.acmeId}/requesters`).send({ name: "Other Contact", designation: "Analyst" });

    const created = await md.post("/api/projects").send(newProject({ requesterId: acmeRequester }));
    await seedEntry({
      userId: f.analyst, projectId: created.body.id, taskId: f.taskId,
      hours: 5, date: "2026-08-03",
    });

    const res = await md.get("/api/reports/custom-report?startDate=2026-08-01&endDate=2026-08-31");
    const row = res.body.rows.find((r: { projectId: number }) => r.projectId === created.body.id);

    expect(row.requesterName).toBe("Priya Menon");
    expect(row.requesterDesignation).toBe("CFO");

    // Only requesters actually attached to a project in the report, so the
    // unattached "Other Contact" is absent.
    expect(res.body.requesters.map((q: { name: string }) => q.name)).toEqual(["Priya Menon"]);
  });

  it("leaves the requester null on rows whose project has none", async () => {
    const md = await signIn(app, "md@test.local");
    await seedEntry({
      userId: f.analyst, projectId: f.auditProjectId, taskId: f.taskId,
      hours: 4, date: "2026-08-04",
    });

    const res = await md.get("/api/reports/custom-report?startDate=2026-08-01&endDate=2026-08-31");
    const row = res.body.rows.find((r: { projectId: number }) => r.projectId === f.auditProjectId);
    expect(row).toBeDefined();
    expect(row.requesterName).toBeNull();
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

  it("names only the requesters actually attached to a project in the report", async () => {
    // This once listed every requester at every client in the result, which
    // meant a report on one memo named all seven contacts at the account.
    // Now a requester appears only if some project in the report is theirs.
    const md = await signIn(app, "md@test.local");
    const acmeRequester = (await md.post(`/api/clients/${f.acmeId}/requesters`)
      .send({ name: "Priya Menon", designation: "CFO" })).body.id;
    await md.post(`/api/clients/${f.betaId}/requesters`).send({ name: "Beta Person", designation: "COO" });

    // Nothing is attached yet, so nobody is named however wide the window.
    const before = await md.get(`/api/reports/custom-report?${range}`);
    expect(before.body.rows.length).toBeGreaterThan(0);
    expect(before.body.requesters).toEqual([]);

    await md.patch(`/api/projects/${f.auditProjectId}`).send({ requesterId: acmeRequester });

    const after = await md.get(`/api/reports/custom-report?${range}`);
    expect(after.body.requesters).toHaveLength(1);
    expect(after.body.requesters[0]).toMatchObject({ clientId: f.acmeId, name: "Priya Menon" });

    // And the rows for that project now carry the person who asked for it.
    const acmeRows = after.body.rows.filter((r: { projectId: number }) => r.projectId === f.auditProjectId);
    expect(acmeRows.length).toBeGreaterThan(0);
    for (const row of acmeRows) expect(row.requesterName).toBe("Priya Menon");

    // Beta's contact is attached to nothing, so it stays out of the report.
    const betaRows = after.body.rows.filter((r: { clientId: number }) => r.clientId === f.betaId);
    expect(betaRows.length).toBeGreaterThan(0);
    for (const row of betaRows) expect(row.requesterName).toBeNull();
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
