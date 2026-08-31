import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  registerAppTool,
  registerAppResource,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { apiGet } from "./api-client";
import {
  renderView,
  SUMMARY_VIEW,
  BALANCES_VIEW,
  APPROVALS_VIEW,
} from "./ui";
import type { Principal } from "../middlewares/auth";
import { logger } from "../lib/logger";

/**
 * The MCP surface over TimeTrack.
 *
 * A server is built per request and closed over the caller's token, so every
 * tool runs as the person who asked. Nothing here re-implements a visibility
 * rule: the tools call this application's own API with that token, and an MD
 * therefore sees what an MD sees in the browser while an associate sees only
 * their own remit.
 *
 * Read-only by design. Approving time from a chat prompt is a workflow question
 * rather than a technical one, and the role gates that would make it safe
 * already exist whenever that decision is taken.
 */

const UI = {
  summary: "ui://timetrack/summary.html",
  balances: "ui://timetrack/balances.html",
  approvals: "ui://timetrack/approvals.html",
} as const;

interface DashboardSummary {
  totalHours: number;
  billableHours: number;
  nonBillableHours: number;
  pendingApprovalCount: number;
  approvedHours: number;
  workingDays?: number;
  effectiveWorkingDays?: number;
  leaveDays?: number;
  capacityHours?: number;
  utilization?: number;
}

interface TimeEntry {
  id: number;
  userId: number;
  userName: string;
  userRole?: string;
  taskName: string;
  projectName?: string | null;
  clientId?: number | null;
  clientName?: string | null;
  hours: number;
  date: string;
  status: "pending" | "approved" | "rejected";
  description?: string | null;
}

interface Client {
  id: number;
  name: string;
  engagementType?: string;
  isActive?: boolean;
}

interface HourBlockSummary {
  clientId: number;
  clientName: string;
  purchasedHours: number;
  consumedHours: number;
  approvedHours: number;
  remainingHours: number;
  blocks: unknown[];
}

interface TeamReportRow {
  userName: string;
  userRole?: string;
  clientName?: string | null;
  projectName?: string | null;
  totalHours: number;
  billableHours: number;
  efficiency?: number;
}

/** ISO date, N days back from today. */
function daysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

const dateRange = {
  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe("Start of the period, YYYY-MM-DD. Defaults to 30 days ago."),
  endDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe("End of the period, YYYY-MM-DD. Defaults to today."),
};

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }] };
}

/** A tool result carrying both the numbers and the view that displays them. */
function withView(uri: string, summary: string, data: unknown) {
  return {
    content: [{ type: "text" as const, text: summary }],
    structuredContent: data as Record<string, unknown>,
    _meta: { "ui/resourceUri": uri },
  };
}

export function buildMcpServer(token: string, me: Principal): McpServer {
  const server = new McpServer(
    { name: "timetrack", version: "1.0.0" },
    {
      instructions:
        "TimeTrack is the firm's time tracking system. Tools run as the " +
        "signed-in person, so results are already limited to what they are " +
        "permitted to see. Hours are decimal. All tools are read-only.",
    },
  );

  // ─── Views ─────────────────────────────────────────────────────────────────

  registerAppResource(server, "Time summary", UI.summary, {}, async (uri) => ({
    contents: [
      {
        uri: uri.href,
        mimeType: RESOURCE_MIME_TYPE,
        text: renderView("Time summary", {}, SUMMARY_VIEW),
      },
    ],
  }));

  registerAppResource(server, "Hour blocks", UI.balances, {}, async (uri) => ({
    contents: [
      {
        uri: uri.href,
        mimeType: RESOURCE_MIME_TYPE,
        text: renderView("Hour blocks", {}, BALANCES_VIEW),
      },
    ],
  }));

  registerAppResource(server, "Awaiting approval", UI.approvals, {}, async (uri) => ({
    contents: [
      {
        uri: uri.href,
        mimeType: RESOURCE_MIME_TYPE,
        text: renderView("Awaiting approval", {}, APPROVALS_VIEW),
      },
    ],
  }));

  // ─── Tools ─────────────────────────────────────────────────────────────────

  registerAppTool(
    server,
    "get_time_summary",
    {
      title: "Time summary",
      description:
        "Hours logged over a period against available capacity, with " +
        "utilisation. Capacity already excludes public holidays and booked " +
        "leave. Scoped to what the caller may see.",
      inputSchema: dateRange,
      _meta: { ui: { resourceUri: UI.summary } },
    },
    async ({ startDate, endDate }) => {
      const from = startDate ?? daysAgo(30);
      const to = endDate ?? today();
      const summary = await apiGet<DashboardSummary>(
        "/api/dashboard/summary",
        token,
        { startDate: from, endDate: to },
      );

      const data = { ...summary, label: `Time logged, ${from} to ${to}` };
      const lines = [
        `${from} to ${to}`,
        `Logged ${summary.totalHours}h, of which ${summary.billableHours}h billable.`,
        summary.capacityHours != null
          ? `Capacity ${summary.capacityHours}h across ${summary.effectiveWorkingDays ?? "?"} working days after holidays and leave.`
          : "",
        summary.utilization != null
          ? `Utilisation ${Math.round(summary.utilization * 10) / 10}%.`
          : "",
        summary.pendingApprovalCount
          ? `${summary.pendingApprovalCount} entries awaiting approval.`
          : "Nothing awaiting approval.",
      ].filter(Boolean);

      return withView(UI.summary, lines.join("\n"), data);
    },
  );

  registerAppTool(
    server,
    "list_pending_approvals",
    {
      title: "Awaiting approval",
      description:
        "Time entries waiting to be approved, within the caller's remit. " +
        "Analysts approve nothing, so this is empty for them.",
      inputSchema: {},
      _meta: { ui: { resourceUri: UI.approvals } },
    },
    async () => {
      const entries = await apiGet<TimeEntry[]>(
        "/api/dashboard/pending-approvals",
        token,
      );

      const totalHours = entries.reduce((sum, e) => sum + Number(e.hours || 0), 0);
      const oldest = entries.reduce<string | null>(
        (acc, e) => (acc === null || e.date < acc ? e.date : acc),
        null,
      );
      const oldestDays =
        oldest === null
          ? null
          : Math.max(
              0,
              Math.round(
                (Date.parse(today()) - Date.parse(oldest)) / 86_400_000,
              ),
            );

      const data = { entries, totalHours, oldestDays };
      const summary = entries.length
        ? [
            `${entries.length} entries awaiting approval, ${Math.round(totalHours * 10) / 10}h in total.`,
            oldestDays != null ? `Oldest is ${oldestDays} days old.` : "",
            ...entries
              .slice(0, 10)
              .map(
                (e) =>
                  `- ${e.userName}, ${e.clientName ?? "internal"}, ${e.date}, ${e.hours}h`,
              ),
          ]
            .filter(Boolean)
            .join("\n")
        : "Nothing is awaiting approval.";

      return withView(UI.approvals, summary, data);
    },
  );

  registerAppTool(
    server,
    "get_hour_block_balances",
    {
      title: "Hour block balances",
      description:
        "For every client on a block-of-hours engagement: hours bought, used " +
        "and remaining. Hours awaiting approval already count as used. A " +
        "negative balance means more time was logged than was bought.",
      inputSchema: {},
      _meta: { ui: { resourceUri: UI.balances } },
    },
    async () => {
      const clients = await apiGet<Client[]>("/api/clients", token);
      const blockClients = clients.filter(
        (c) => c.engagementType === "block_hours",
      );

      const balances: HourBlockSummary[] = [];
      for (const client of blockClients) {
        try {
          balances.push(
            await apiGet<HourBlockSummary>(
              `/api/clients/${client.id}/hour-blocks`,
              token,
            ),
          );
        } catch (err) {
          // A client the caller cannot see is not an error worth failing the
          // whole tool for; it simply does not appear.
          logger.debug(
            { clientId: client.id, err: String(err) },
            "Skipped a client while collecting hour blocks",
          );
        }
      }

      balances.sort((a, b) => a.remainingHours - b.remainingHours);

      const data = { clients: balances, label: "Hour blocks" };
      const summary = balances.length
        ? balances
            .map((b) => {
              const state =
                b.remainingHours < 0
                  ? "OVERRUN"
                  : b.purchasedHours > 0 &&
                      b.remainingHours <= b.purchasedHours * 0.1
                    ? "low"
                    : "ok";
              return `- ${b.clientName}: ${b.remainingHours}h left of ${b.purchasedHours}h (${state})`;
            })
            .join("\n")
        : "No clients are on a block-of-hours engagement.";

      return withView(UI.balances, summary, data);
    },
  );

  server.registerTool(
    "get_team_report",
    {
      title: "Team report",
      description:
        "Hours per person over a period, broken down by client and project. " +
        "Limited to the team the caller may see.",
      inputSchema: dateRange,
    },
    async ({ startDate, endDate }) => {
      const from = startDate ?? daysAgo(30);
      const to = endDate ?? today();
      const rows = await apiGet<TeamReportRow[]>(
        "/api/reports/team-report",
        token,
        { startDate: from, endDate: to },
      );

      if (!rows.length) {
        return text(`No time recorded between ${from} and ${to}.`);
      }

      const byPerson = new Map<string, { hours: number; billable: number }>();
      for (const row of rows) {
        const current = byPerson.get(row.userName) ?? { hours: 0, billable: 0 };
        current.hours += Number(row.totalHours || 0);
        current.billable += Number(row.billableHours || 0);
        byPerson.set(row.userName, current);
      }

      const lines = [...byPerson.entries()]
        .sort((a, b) => b[1].hours - a[1].hours)
        .map(
          ([name, v]) =>
            `- ${name}: ${Math.round(v.hours * 10) / 10}h (${Math.round(v.billable * 10) / 10}h billable)`,
        );

      return {
        content: [
          {
            type: "text" as const,
            text: `${from} to ${to}, ${byPerson.size} people:\n${lines.join("\n")}`,
          },
        ],
        structuredContent: { rows } as Record<string, unknown>,
      };
    },
  );

  server.registerTool(
    "find_time_entries",
    {
      title: "Find time entries",
      description:
        "Search time entries by person, client, project or status over a " +
        "period. Returns at most 100, newest first.",
      inputSchema: {
        ...dateRange,
        userId: z.number().int().positive().optional().describe("Filter to one person."),
        clientId: z.number().int().positive().optional().describe("Filter to one client."),
        projectId: z.number().int().positive().optional().describe("Filter to one project."),
        status: z
          .enum(["pending", "approved", "rejected"])
          .optional()
          .describe("Filter to one status."),
      },
    },
    async ({ startDate, endDate, userId, clientId, projectId, status }) => {
      const entries = await apiGet<TimeEntry[]>("/api/time-entries", token, {
        startDate: startDate ?? daysAgo(30),
        endDate: endDate ?? today(),
        userId,
        clientId,
        projectId,
        status,
      });

      if (!entries.length) {
        return text("No time entries match those filters.");
      }

      const capped = entries.slice(0, 100);
      const total = capped.reduce((sum, e) => sum + Number(e.hours || 0), 0);
      const lines = capped
        .slice(0, 40)
        .map(
          (e) =>
            `- ${e.date} · ${e.userName} · ${e.clientName ?? "internal"} · ${e.taskName} · ${e.hours}h · ${e.status}`,
        );

      const note =
        entries.length > capped.length
          ? `\nShowing the first ${capped.length} of ${entries.length}.`
          : capped.length > 40
            ? `\nListing 40 of ${capped.length}; totals cover all of them.`
            : "";

      return {
        content: [
          {
            type: "text" as const,
            text:
              `${capped.length} entries, ${Math.round(total * 10) / 10}h in total.\n` +
              lines.join("\n") +
              note,
          },
        ],
        structuredContent: { entries: capped } as Record<string, unknown>,
      };
    },
  );

  server.registerTool(
    "whoami",
    {
      title: "Who am I",
      description:
        "The identity and role the tools are running as. Useful when a result " +
        "looks narrower than expected — scope follows the role.",
      inputSchema: {},
    },
    async () =>
      text(
        `${me.name} <${me.email}>, role ${me.role}, authenticated via ${me.via}.`,
      ),
  );

  return server;
}
