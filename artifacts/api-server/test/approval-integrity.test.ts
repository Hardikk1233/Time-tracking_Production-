import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { db, timeEntriesTable, timeEntryEventsTable } from "@workspace/db";
import app from "../src/app";
import {
  resetDatabase,
  seedEntry,
  signIn,
  type Fixtures,
} from "./fixtures";

/**
 * Asserts a query is refused by the database with a message matching `pattern`.
 *
 * Drizzle wraps driver errors, so the trigger's own message arrives on `cause`
 * rather than on the thrown error itself.
 */
async function expectRejectedByDatabase(
  query: Promise<unknown>,
  pattern: RegExp,
): Promise<void> {
  try {
    await query;
  } catch (err) {
    const message = String(
      (err as { cause?: { message?: string }; message?: string })?.cause
        ?.message ??
        (err as { message?: string })?.message ??
        err,
    );
    expect(message).toMatch(pattern);
    return;
  }
  throw new Error(`Expected the database to reject this query (${pattern})`);
}

/**
 * The guarantee the firm is buying: once an Associate or above approves hours,
 * nobody changes them — and every write is attributable.
 */
describe("approval integrity", () => {
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

  describe("an approved entry is final", () => {
    let entryId: number;

    beforeEach(async () => {
      entryId = await seedEntry({
        userId: f.analyst,
        projectId: f.auditProjectId,
        taskId: f.taskId,
        hours: 6,
        billableHours: 6,
        status: "approved",
        approvedById: f.associate,
      });
    });

    it("refuses an hours edit, even from an MD", async () => {
      const res = await md.patch(`/api/time-entries/${entryId}`).send({ hours: 1 });
      expect(res.status).toBe(409);

      const [row] = await db
        .select()
        .from(timeEntriesTable)
        .where(eq(timeEntriesTable.id, entryId));
      expect(row.hours).toBe(6);
    });

    it("refuses deletion, even from an MD", async () => {
      expect((await md.delete(`/api/time-entries/${entryId}`)).status).toBe(409);

      const [row] = await db
        .select()
        .from(timeEntriesTable)
        .where(eq(timeEntriesTable.id, entryId));
      expect(row).toBeDefined();
    });

    it("refuses a rewrite of the billable split", async () => {
      const res = await associate
        .post(`/api/time-entries/${entryId}/split`)
        .send({ billableHours: 0 });
      expect(res.status).toBe(409);

      const [row] = await db
        .select()
        .from(timeEntriesTable)
        .where(eq(timeEntriesTable.id, entryId));
      expect(row.billableHours).toBe(6);
    });

    it("cannot be approved or rejected a second time", async () => {
      expect((await md.post(`/api/time-entries/${entryId}/approve`)).status).toBe(409);
      expect((await md.post(`/api/time-entries/${entryId}/reject`)).status).toBe(409);
    });

    it("holds even against direct SQL, not just the API", async () => {
      await expectRejectedByDatabase(
        db
          .update(timeEntriesTable)
          .set({ hours: 99 })
          .where(eq(timeEntriesTable.id, entryId)),
        /immutable/i,
      );

      await expectRejectedByDatabase(
        db.delete(timeEntriesTable).where(eq(timeEntriesTable.id, entryId)),
        /cannot be deleted/i,
      );
    });

    it("can only be reopened by an MD", async () => {
      expect((await avp.post(`/api/time-entries/${entryId}/reopen`)).status).toBe(403);
      expect((await associate.post(`/api/time-entries/${entryId}/reopen`)).status).toBe(403);
      expect((await md.post(`/api/time-entries/${entryId}/reopen`)).status).toBe(200);
    });

    it("becomes editable again once reopened", async () => {
      await md.post(`/api/time-entries/${entryId}/reopen`);

      const res = await md.patch(`/api/time-entries/${entryId}`).send({ hours: 7 });
      expect(res.status).toBe(200);
      expect(res.body.hours).toBe(7);
    });

    it("still refuses to strand the billable split after a reopen", async () => {
      // Approved at 6 hours, all billable. Reopening does not clear that split,
      // so dropping to 2 hours has to be refused until the split is revised —
      // otherwise the entry would claim more billable hours than it has.
      await md.post(`/api/time-entries/${entryId}/reopen`);

      const res = await md.patch(`/api/time-entries/${entryId}`).send({ hours: 2 });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/billable/i);

      // Revising the split first makes the correction go through.
      expect(
        (await associate.post(`/api/time-entries/${entryId}/split`).send({ billableHours: 2 })).status,
      ).toBe(200);
      expect((await md.patch(`/api/time-entries/${entryId}`).send({ hours: 2 })).status).toBe(200);
    });
  });

  describe("who may decide", () => {
    let entryId: number;

    beforeEach(async () => {
      entryId = await seedEntry({
        userId: f.analyst,
        projectId: f.auditProjectId,
        taskId: f.taskId,
      });
    });

    it("refuses an analyst", async () => {
      expect((await analyst.post(`/api/time-entries/${entryId}/approve`)).status).toBe(403);
      expect((await analyst.post(`/api/time-entries/${entryId}/reject`)).status).toBe(403);
    });

    it("refuses an Associate on a project they are not assigned to", async () => {
      const res = await otherAssociate.post(`/api/time-entries/${entryId}/approve`);
      expect(res.status).toBe(403);
    });

    it("allows the in-scope Associate, and records who signed off", async () => {
      const res = await associate.post(`/api/time-entries/${entryId}/approve`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("approved");
      expect(res.body.approvedByName).toBe("Asha Rao");
      expect(res.body.approvedAt).toBeTruthy();
    });

    it("refuses self-approval at any rank", async () => {
      const ownEntry = await seedEntry({
        userId: f.associate,
        projectId: f.auditProjectId,
        taskId: f.taskId,
      });
      expect((await associate.post(`/api/time-entries/${ownEntry}/approve`)).status).toBe(403);

      const mdEntry = await seedEntry({
        userId: f.md,
        projectId: f.auditProjectId,
        taskId: f.taskId,
      });
      expect((await md.post(`/api/time-entries/${mdEntry}/approve`)).status).toBe(403);
    });

    it("defaults unreviewed hours to fully billable on approval", async () => {
      const res = await associate.post(`/api/time-entries/${entryId}/approve`);
      expect(res.body.billableHours).toBe(res.body.hours);
    });
  });

  describe("the audit ledger", () => {
    it("records the whole life of an entry, with the person behind each step", async () => {
      const created = await analyst.post("/api/time-entries").send({
        projectId: f.auditProjectId,
        taskId: f.taskId,
        hours: 4,
        date: "2026-08-10",
      });
      expect(created.status).toBe(201);
      const id = created.body.id;

      await associate.post(`/api/time-entries/${id}/split`).send({ billableHours: 3 });
      await associate.post(`/api/time-entries/${id}/approve`);
      await md.post(`/api/time-entries/${id}/reopen`);

      const events = await db
        .select()
        .from(timeEntryEventsTable)
        .where(eq(timeEntryEventsTable.timeEntryId, id))
        .orderBy(timeEntryEventsTable.id);

      expect(events.map((e) => e.action)).toEqual([
        "created",
        "updated",
        "approved",
        "reopened",
      ]);
      expect(events.map((e) => e.actorId)).toEqual([
        f.analyst,
        f.associate,
        f.associate,
        f.md,
      ]);
      // Before/after values are captured, not just the fact of a change.
      expect((events[2].previous as { status: string }).status).toBe("pending");
      expect((events[2].next as { status: string }).status).toBe("approved");
    });

    it("survives deletion of the entry it describes", async () => {
      const id = await seedEntry({
        userId: f.analyst,
        projectId: f.auditProjectId,
        taskId: f.taskId,
      });
      expect((await analyst.delete(`/api/time-entries/${id}`)).status).toBe(200);

      const events = await db
        .select()
        .from(timeEntryEventsTable)
        .where(eq(timeEntryEventsTable.timeEntryId, id));
      expect(events.map((e) => e.action)).toContain("deleted");
    });

    it("cannot be rewritten", async () => {
      const id = await seedEntry({
        userId: f.analyst,
        projectId: f.auditProjectId,
        taskId: f.taskId,
      });
      await associate.post(`/api/time-entries/${id}/approve`);

      await expectRejectedByDatabase(
        db
          .update(timeEntryEventsTable)
          .set({ actorId: f.md })
          .where(eq(timeEntryEventsTable.timeEntryId, id)),
        /append-only/i,
      );

      await expectRejectedByDatabase(
        db
          .delete(timeEntryEventsTable)
          .where(eq(timeEntryEventsTable.timeEntryId, id)),
        /append-only/i,
      );
    });
  });

  describe("editing before approval", () => {
    it("lets the owner correct their own pending entry", async () => {
      const id = await seedEntry({
        userId: f.analyst,
        projectId: f.auditProjectId,
        taskId: f.taskId,
      });
      const res = await analyst.patch(`/api/time-entries/${id}`).send({ hours: 7 });
      expect(res.status).toBe(200);
      expect(res.body.hours).toBe(7);
    });

    it("refuses edits to someone else's entry from an unrelated colleague", async () => {
      const id = await seedEntry({
        userId: f.analyst,
        projectId: f.auditProjectId,
        taskId: f.taskId,
      });
      expect((await otherAssociate.patch(`/api/time-entries/${id}`).send({ hours: 7 })).status).toBe(403);
    });

    it("returns a rejected entry to the queue when its owner corrects it", async () => {
      const id = await seedEntry({
        userId: f.analyst,
        projectId: f.auditProjectId,
        taskId: f.taskId,
        status: "rejected",
        approvedById: f.associate,
      });
      const res = await analyst.patch(`/api/time-entries/${id}`).send({ hours: 3 });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("pending");
      expect(res.body.approvedById).toBeNull();
    });

    it("will not leave a billable split stranded above the hours", async () => {
      const id = await seedEntry({
        userId: f.analyst,
        projectId: f.auditProjectId,
        taskId: f.taskId,
        hours: 8,
        billableHours: 6,
      });
      const res = await analyst.patch(`/api/time-entries/${id}`).send({ hours: 2 });
      expect(res.status).toBe(400);
    });
  });
});
