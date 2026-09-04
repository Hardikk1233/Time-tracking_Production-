import { describe, it, expect, beforeEach } from "vitest";
import { eq, and } from "drizzle-orm";
import { db, projectUsersTable, usersTable } from "@workspace/db";
import app from "../src/app";
import { resetDatabase, seedEntry, signIn, PASSWORD, type Fixtures } from "./fixtures";

/**
 * Who can see and do what.
 *
 * The audit found role rules living almost entirely in the React UI, so these
 * assertions all go straight at the API — the frontend is not in the loop.
 */
describe("authorization", () => {
  let f: Fixtures;
  let analyst: Awaited<ReturnType<typeof signIn>>;
  let associate: Awaited<ReturnType<typeof signIn>>;
  let otherAssociate: Awaited<ReturnType<typeof signIn>>;
  let avp: Awaited<ReturnType<typeof signIn>>;
  let md: Awaited<ReturnType<typeof signIn>>;

  beforeEach(async () => {
    f = await resetDatabase();
    [analyst, associate, otherAssociate, avp, md] = await Promise.all([
      signIn(app, "analyst@test.local"),
      signIn(app, "associate@test.local"),
      signIn(app, "other-associate@test.local"),
      signIn(app, "avp@test.local"),
      signIn(app, "md@test.local"),
    ]);
  });

  describe("sign-in", () => {
    it("refuses a deactivated account", async () => {
      const res = await (await import("supertest")).default(app)
        .post("/api/auth/login")
        .send({ email: "inactive@test.local", password: PASSWORD });
      expect(res.status).toBe(403);
    });

    it("refuses a wrong password without revealing which part was wrong", async () => {
      const request = (await import("supertest")).default;
      const wrongPassword = await request(app)
        .post("/api/auth/login")
        .send({ email: "analyst@test.local", password: "nope" });
      const noSuchUser = await request(app)
        .post("/api/auth/login")
        .send({ email: "ghost@test.local", password: PASSWORD });

      expect(wrongPassword.status).toBe(401);
      expect(noSuchUser.status).toBe(401);
      expect(wrongPassword.body.error).toBe(noSuchUser.body.error);
    });

    it("requires authentication for everything past /auth", async () => {
      const request = (await import("supertest")).default;
      for (const path of [
        "/api/time-entries",
        "/api/users",
        "/api/clients",
        "/api/projects",
        "/api/dashboard/summary",
      ]) {
        expect((await request(app).get(path)).status).toBe(401);
      }
    });
  });

  describe("user administration", () => {
    it("refuses an analyst every write", async () => {
      expect((await analyst.post("/api/users").send({
        name: "X", email: "x@test.local", password: "a-long-enough-password", role: "md",
      })).status).toBe(403);
      expect((await analyst.patch(`/api/users/${f.analyst}`).send({ role: "md" })).status).toBe(403);
      expect((await analyst.delete(`/api/users/${f.otherAnalyst}`)).status).toBe(403);
    });

    it("refuses an associate every write", async () => {
      expect((await associate.patch(`/api/users/${f.analyst}`).send({ name: "Renamed" })).status).toBe(403);
    });

    it("stops an AVP from touching an MD", async () => {
      expect((await avp.patch(`/api/users/${f.md}`).send({ role: "analyst" })).status).toBe(403);
      expect((await avp.patch(`/api/users/${f.md}`).send({ password: "a-long-enough-password" })).status).toBe(403);
      expect((await avp.delete(`/api/users/${f.md}`)).status).toBe(403);
    });

    it("stops an AVP from minting an MD", async () => {
      const res = await avp.post("/api/users").send({
        name: "Sneaky", email: "sneaky@test.local", password: "a-long-enough-password", role: "md",
      });
      expect(res.status).toBe(403);
    });

    it("lets an AVP manage juniors", async () => {
      const created = await avp.post("/api/users").send({
        name: "New Analyst", email: "new@test.local", password: "a-long-enough-password", role: "analyst",
      });
      expect(created.status).toBe(201);
      expect((await avp.patch(`/api/users/${created.body.id}`).send({ role: "associate" })).status).toBe(200);
    });

    it("refuses a duplicate email rather than failing at the database", async () => {
      const res = await md.post("/api/users").send({
        name: "Clash", email: "analyst@test.local", password: "a-long-enough-password", role: "analyst",
      });
      expect(res.status).toBe(409);
    });

    it("deactivates rather than deleting a user with logged time", async () => {
      await seedEntry({ userId: f.analyst, projectId: f.auditProjectId, taskId: f.taskId });
      const res = await md.delete(`/api/users/${f.analyst}`);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/deactivate/i);
    });

    it("takes effect immediately when an account is deactivated mid-session", async () => {
      expect((await analyst.get("/api/time-entries")).status).toBe(200);
      await md.patch(`/api/users/${f.analyst}`).send({ isActive: false });
      expect((await analyst.get("/api/time-entries")).status).toBe(403);
    });
  });

  describe("projects", () => {
    it("hides a project the caller has no part in", async () => {
      // The Acme associate has nothing to do with the Beta project.
      expect((await associate.get(`/api/projects/${f.betaProjectId}`)).status).toBe(404);
      expect((await associate.get(`/api/projects/${f.betaProjectId}/assignments`)).status).toBe(404);
      expect((await associate.get(`/api/projects/${f.betaProjectId}/tasks`)).status).toBe(404);
    });

    it("refuses edits and deletion of an out-of-scope project", async () => {
      expect((await associate.patch(`/api/projects/${f.betaProjectId}`).send({ name: "Hijacked" })).status).toBe(404);
      expect((await associate.delete(`/api/projects/${f.betaProjectId}`)).status).toBe(404);
    });

    it("refuses self-assignment to an unseen project", async () => {
      // This was the escalation: assigning yourself granted you its data.
      const res = await associate
        .post(`/api/projects/${f.betaProjectId}/assignments`)
        .send({ userId: f.associate });
      expect(res.status).toBe(404);

      const rows = await db
        .select()
        .from(projectUsersTable)
        .where(
          and(
            eq(projectUsersTable.projectId, f.betaProjectId),
            eq(projectUsersTable.userId, f.associate),
          ),
        );
      expect(rows).toHaveLength(0);
    });

    it("refuses creating a project under a client the caller cannot see", async () => {
      const res = await associate
        .post("/api/projects")
        .send({ clientId: f.betaId, name: "Backdoor" });
      expect(res.status).toBe(404);
    });

    it("allows the in-scope associate to manage their own project", async () => {
      expect((await associate.get(`/api/projects/${f.auditProjectId}`)).status).toBe(200);
      expect((await associate.patch(`/api/projects/${f.auditProjectId}`).send({ description: "Updated" })).status).toBe(200);
    });

    it("explains rather than 500s when deleting a project with time logged", async () => {
      await seedEntry({ userId: f.analyst, projectId: f.auditProjectId, taskId: f.taskId });
      const res = await md.delete(`/api/projects/${f.auditProjectId}`);
      // 409: the refusal is about the resource's current state, not the
      // request's shape - nothing about the request could be corrected.
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/time logged/i);
    });

    it("refuses an analyst any project management", async () => {
      expect((await analyst.patch(`/api/projects/${f.auditProjectId}`).send({ name: "No" })).status).toBe(403);
      expect((await analyst.delete(`/api/projects/${f.auditProjectId}`)).status).toBe(403);
      expect((await analyst.post(`/api/projects/${f.auditProjectId}/assignments`).send({ userId: f.analyst })).status).toBe(403);
    });
  });

  describe("clients", () => {
    it("hides staffing and commercial data from an unrelated colleague", async () => {
      expect((await associate.get(`/api/clients/${f.acmeId}/assignments`)).status).toBe(404);
      expect((await analyst.get(`/api/clients/${f.acmeId}/assignments`)).status).toBe(404);
    });

    it("keeps FTE history to AVP and above", async () => {
      expect((await analyst.get(`/api/clients/${f.acmeId}/fte-history`)).status).toBe(403);
      expect((await associate.get(`/api/clients/${f.acmeId}/fte-history`)).status).toBe(403);
      expect((await avp.get(`/api/clients/${f.acmeId}/fte-history`)).status).toBe(200);
    });

    it("stops an AVP editing a client they do not hold", async () => {
      // The fixture AVP holds Acme, not Beta.
      expect((await avp.patch(`/api/clients/${f.betaId}`).send({ name: "Taken" })).status).toBe(404);
      expect((await avp.delete(`/api/clients/${f.betaId}`)).status).toBe(404);
      expect((await avp.post(`/api/clients/${f.betaId}/assignments`).send({ userId: f.avp })).status).toBe(404);
    });

    it("lets the AVP manage their own client", async () => {
      expect((await avp.patch(`/api/clients/${f.acmeId}`).send({ description: "Key account" })).status).toBe(200);
      expect((await avp.get(`/api/clients/${f.acmeId}/assignments`)).status).toBe(200);
    });

    it("refuses an out-of-range FTE count", async () => {
      const res = await avp
        .post(`/api/clients/${f.acmeId}/fte-history`)
        .send({ fteCount: 500, effectiveFrom: "2026-01-01" });
      expect(res.status).toBe(400);
    });
  });

  describe("time-entry visibility", () => {
    beforeEach(async () => {
      await seedEntry({ userId: f.analyst, projectId: f.auditProjectId, taskId: f.taskId });
      await seedEntry({ userId: f.otherAnalyst, projectId: f.betaProjectId, taskId: f.betaTaskId });
    });

    it("shows an analyst only their own entries", async () => {
      const res = await analyst.get("/api/time-entries");
      expect(res.status).toBe(200);
      expect(res.body.every((e: { userId: number }) => e.userId === f.analyst)).toBe(true);
    });

    it("shows an associate their project team but not the other silo", async () => {
      const res = await associate.get("/api/time-entries");
      const names = new Set(res.body.map((e: { userName: string }) => e.userName));
      expect(names.has("Ana Lyst")).toBe(true);
      expect(names.has("Ottilie Analyst")).toBe(false);
    });

    it("shows an MD everything", async () => {
      const res = await md.get("/api/time-entries");
      const names = new Set(res.body.map((e: { userName: string }) => e.userName));
      expect(names.has("Ana Lyst")).toBe(true);
      expect(names.has("Ottilie Analyst")).toBe(true);
    });

    it("refuses to log time against a project the caller is not on", async () => {
      const res = await analyst.post("/api/time-entries").send({
        projectId: f.betaProjectId,
        taskId: f.betaTaskId,
        hours: 4,
        date: "2026-08-10",
      });
      expect(res.status).toBe(403);
    });

    it("logs time as the caller regardless of any userId in the body", async () => {
      const res = await analyst.post("/api/time-entries").send({
        projectId: f.auditProjectId,
        taskId: f.taskId,
        hours: 4,
        date: "2026-08-10",
        userId: f.md,
      });
      expect(res.status).toBe(201);
      expect(res.body.userId).toBe(f.analyst);
    });
  });

  describe("dashboard scoping", () => {
    beforeEach(async () => {
      await seedEntry({
        userId: f.otherAnalyst, projectId: f.betaProjectId, taskId: f.betaTaskId,
        status: "approved", billableHours: 4, approvedById: f.otherAssociate,
      });
    });

    it("keeps another silo's client financials out of the analyst's view", async () => {
      const res = await analyst.get("/api/dashboard/client-hours");
      const names = res.body.map((c: { clientName: string }) => c.clientName);
      expect(names).not.toContain("Beta Industries");
    });

    it("refuses a trend for a client the caller cannot see", async () => {
      const res = await analyst.get(`/api/dashboard/client-hours-trend?clientId=${f.betaId}`);
      expect(res.status).toBe(404);
    });

    it("keeps the activity feed within the caller's remit", async () => {
      const res = await analyst.get("/api/dashboard/recent-activity?limit=100");
      const names = res.body.map((e: { userName: string }) => e.userName);
      expect(names).not.toContain("Ottilie Analyst");
    });

    it("still shows an MD the whole firm", async () => {
      const res = await md.get("/api/dashboard/client-hours");
      const names = res.body.map((c: { clientName: string }) => c.clientName);
      expect(names).toContain("Beta Industries");
      expect(names).toContain("Acme Capital");
    });
  });
});
