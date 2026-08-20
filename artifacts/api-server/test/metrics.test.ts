import { describe, it, expect, beforeEach } from "vitest";
import app from "../src/app";
import { productivity, percent } from "../src/lib/metrics";
import { resetDatabase, seedEntry, signIn, type Fixtures } from "./fixtures";

/**
 * The productivity measures.
 *
 * These exist because the dashboard and the reports previously disagreed about
 * the same person's utilisation - 18% against 30.5% - by taking opposite views
 * of hours that had been logged but not yet reviewed.
 */
describe("productivity measures", () => {
  describe("the three figures answer different questions", () => {
    it("separates filling your time from billing it", () => {
      // A ten-hour day against an eight-hour capacity, only four of it billable.
      const m = productivity({
        totalHours: 10,
        billableHours: 4,
        availableWorkingDays: 1,
      });

      expect(m.capacityHours).toBe(8);
      expect(m.recordedUtilization).toBe(125); // logged beyond a standard day
      expect(m.billableUtilization).toBe(50); //  half of capacity billed
      expect(m.efficiency).toBe(40); //           40% of what was logged bills
    });

    it("lets recorded utilisation exceed 100% rather than capping it", () => {
      // Capping would hide overtime, which is precisely what this should show.
      const m = productivity({ totalHours: 60, billableHours: 30, availableWorkingDays: 5 });
      expect(m.recordedUtilization).toBe(150);
    });

    it("reports zero rather than dividing by zero when nobody was available", () => {
      const m = productivity({ totalHours: 0, billableHours: 0, availableWorkingDays: 0 });
      expect(m.capacityHours).toBe(0);
      expect(m.recordedUtilization).toBe(0);
      expect(m.billableUtilization).toBe(0);
      expect(m.efficiency).toBe(0);
    });

    it("keeps one decimal place, so the same figure reads the same everywhere", () => {
      expect(percent(1, 3)).toBe(33.3);
      expect(percent(51.25, 168)).toBe(30.5);
    });
  });

  describe("the dashboard and the reports agree", () => {
    let f: Fixtures;

    beforeEach(async () => {
      f = await resetDatabase();
    });

    it("reports the same utilisation on both screens with work still unreviewed", async () => {
      // Half reviewed and split, half still awaiting a decision - the exact
      // shape that used to make the two screens disagree.
      await seedEntry({
        userId: f.analyst, projectId: f.auditProjectId, taskId: f.taskId,
        hours: 8, billableHours: 6, date: "2026-08-03",
        status: "approved", approvedById: f.associate,
      });
      await seedEntry({
        userId: f.analyst, projectId: f.auditProjectId, taskId: f.taskId,
        hours: 8, date: "2026-08-04", status: "pending",
      });

      const analyst = await signIn(app, "analyst@test.local");
      const range = "startDate=2026-08-01&endDate=2026-08-31";

      const dashboard = await analyst.get(`/api/dashboard/summary?${range}`);
      const report = await analyst.get(`/api/reports/my-report?${range}`);

      expect(dashboard.status).toBe(200);
      expect(report.status).toBe(200);

      expect(dashboard.body.billableUtilization).toBe(
        report.body.summary.billableUtilization,
      );
      expect(dashboard.body.efficiency).toBe(report.body.summary.efficiency);
      expect(dashboard.body.billableHours).toBe(report.body.summary.billableHours);
    });

    it("counts unreviewed hours as provisionally billable", async () => {
      await seedEntry({
        userId: f.analyst, projectId: f.auditProjectId, taskId: f.taskId,
        hours: 5, date: "2026-08-05", status: "pending",
      });

      const analyst = await signIn(app, "analyst@test.local");
      const res = await analyst.get(
        "/api/dashboard/summary?startDate=2026-08-01&endDate=2026-08-31",
      );

      // Counting these as zero-billable was what made the dashboard understate.
      expect(res.body.billableHours).toBe(5);
      expect(res.body.pendingHours).toBe(5);
      expect(res.body.efficiency).toBe(100);
    });

    it("surfaces how much of the figure is not yet confirmed", async () => {
      await seedEntry({
        userId: f.analyst, projectId: f.auditProjectId, taskId: f.taskId,
        hours: 4, date: "2026-08-06", status: "approved",
        billableHours: 4, approvedById: f.associate,
      });
      await seedEntry({
        userId: f.analyst, projectId: f.auditProjectId, taskId: f.taskId,
        hours: 6, date: "2026-08-07", status: "pending",
      });

      const analyst = await signIn(app, "analyst@test.local");
      const res = await analyst.get(
        "/api/dashboard/summary?startDate=2026-08-01&endDate=2026-08-31",
      );

      expect(res.body.totalHours).toBe(10);
      expect(res.body.pendingHours).toBe(6);
      expect(res.body.approvedHours).toBe(4);
    });

    it("gives the team table the same three figures as the personal one", async () => {
      await seedEntry({
        userId: f.analyst, projectId: f.auditProjectId, taskId: f.taskId,
        hours: 10, date: "2026-08-10", status: "pending",
      });

      const associate = await signIn(app, "associate@test.local");
      const res = await associate.get(
        "/api/dashboard/utilization?startDate=2026-08-01&endDate=2026-08-31",
      );

      const row = res.body.find((r: { userId: number }) => r.userId === f.analyst);
      expect(row).toBeDefined();
      expect(row).toHaveProperty("recordedUtilization");
      expect(row).toHaveProperty("billableUtilization");
      expect(row).toHaveProperty("efficiency");
      expect(row.totalHours).toBe(10);
    });
  });
});
