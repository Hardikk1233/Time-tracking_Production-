import { useState, useMemo, useRef, useEffect } from 'react';
import { format, startOfMonth } from 'date-fns';
import { useAuth } from '@/lib/auth';
import {
  useGetReportFilterOptions,
  useGetClientReport,
  useGetTeamReport,
  useGetMyReport,
} from '@workspace/api-client-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  BarChart2,
  Download,
  ChevronDown,
  Users,
  Building2,
  User,
  RefreshCw,
} from 'lucide-react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';

// ─── Types ────────────────────────────────────────────────────────────────────

type Section = 'client' | 'team' | 'my';

// ─── MultiSelect ─────────────────────────────────────────────────────────────

interface SelectOption {
  id: number;
  name: string;
}

function MultiSelect({
  label,
  options,
  selected,
  onChange,
}: {
  label: string;
  options: SelectOption[];
  selected: number[];
  onChange: (ids: number[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const toggle = (id: number) =>
    onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);

  const label_ =
    selected.length === 0
      ? `All ${label}`
      : selected.length === 1
      ? options.find((o) => o.id === selected[0])?.name ?? '1 selected'
      : `${selected.length} selected`;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 h-9 px-3 rounded-md border border-input bg-background text-sm w-full min-w-[160px] justify-between hover:bg-accent transition-colors"
      >
        <span className="truncate text-left">{label_}</span>
        <ChevronDown className="w-3.5 h-3.5 opacity-50 shrink-0" />
      </button>
      {open && (
        <div className="absolute z-50 mt-1 w-full min-w-[200px] rounded-md border bg-popover shadow-md py-1 max-h-56 overflow-y-auto">
          {options.length === 0 && (
            <p className="px-3 py-2 text-sm text-muted-foreground">No options</p>
          )}
          {options.map((o) => (
            <label
              key={o.id}
              className="flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-accent cursor-pointer"
            >
              <input
                type="checkbox"
                checked={selected.includes(o.id)}
                onChange={() => toggle(o.id)}
                className="rounded"
              />
              <span className="truncate">{o.name}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── SingleSelect ─────────────────────────────────────────────────────────────

function SingleSelect({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: SelectOption[];
  value: number | null;
  onChange: (id: number | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const displayLabel = value ? options.find((o) => o.id === value)?.name ?? label : label;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 h-9 px-3 rounded-md border border-input bg-background text-sm w-full min-w-[200px] justify-between hover:bg-accent transition-colors"
      >
        <span className={`truncate text-left ${!value ? 'text-muted-foreground' : ''}`}>
          {displayLabel}
        </span>
        <ChevronDown className="w-3.5 h-3.5 opacity-50 shrink-0" />
      </button>
      {open && (
        <div className="absolute z-50 mt-1 w-full min-w-[200px] rounded-md border bg-popover shadow-md py-1 max-h-56 overflow-y-auto">
          <button
            className="w-full text-left px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent"
            onClick={() => { onChange(null); setOpen(false); }}
          >
            — {label}
          </button>
          {options.map((o) => (
            <button
              key={o.id}
              className={`w-full text-left px-3 py-1.5 text-sm hover:bg-accent ${value === o.id ? 'font-medium text-primary' : ''}`}
              onClick={() => { onChange(o.id); setOpen(false); }}
            >
              {o.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(n: number) {
  return n.toFixed(1);
}

function roleLabel(role: string) {
  const map: Record<string, string> = { analyst: 'Analyst', associate: 'Associate', avp: 'AVP', md: 'MD' };
  return map[role] ?? role;
}

// ─── Grouped table for Team / Client section entries ─────────────────────────

interface FlatRow {
  clientId: number;
  clientName: string;
  projectId: number;
  projectName: string;
  taskId: number;
  taskName: string;
  totalHours: number;
  billableHours: number;
  nonBillableHours: number;
}

function GroupedTable({ rows }: { rows: FlatRow[] }) {
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground py-6 text-center">No data for this selection.</p>;
  }

  // Compute totals
  const total = rows.reduce(
    (acc, r) => ({
      totalHours: acc.totalHours + r.totalHours,
      billableHours: acc.billableHours + r.billableHours,
      nonBillableHours: acc.nonBillableHours + r.nonBillableHours,
    }),
    { totalHours: 0, billableHours: 0, nonBillableHours: 0 },
  );

  // Track which client/project spans to show headers
  let lastClientId: number | null = null;
  let lastProjectId: number | null = null;

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b bg-muted/50">
            <th className="text-left px-4 py-2.5 font-medium text-muted-foreground w-1/4">Client</th>
            <th className="text-left px-4 py-2.5 font-medium text-muted-foreground w-1/4">Project</th>
            <th className="text-left px-4 py-2.5 font-medium text-muted-foreground w-1/4">Task</th>
            <th className="text-right px-4 py-2.5 font-medium text-muted-foreground">Total</th>
            <th className="text-right px-4 py-2.5 font-medium text-muted-foreground">Billable</th>
            <th className="text-right px-4 py-2.5 font-medium text-muted-foreground">Non-Billable</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const showClient = row.clientId !== lastClientId;
            const showProject = showClient || row.projectId !== lastProjectId;
            lastClientId = row.clientId;
            lastProjectId = row.projectId;
            return (
              <tr key={`${row.projectId}-${row.taskId}-${i}`} className="border-b hover:bg-muted/30 transition-colors">
                <td className="px-4 py-2.5">
                  {showClient ? (
                    <span className="font-medium text-foreground">{row.clientName}</span>
                  ) : (
                    <span className="text-muted-foreground/30">↳</span>
                  )}
                </td>
                <td className="px-4 py-2.5">
                  {showProject ? (
                    <span className="text-foreground">{row.projectName}</span>
                  ) : (
                    <span className="text-muted-foreground/30">↳</span>
                  )}
                </td>
                <td className="px-4 py-2.5 text-muted-foreground">{row.taskName}</td>
                <td className="px-4 py-2.5 text-right tabular-nums">{fmt(row.totalHours)}h</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-emerald-600">{fmt(row.billableHours)}h</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-amber-600">{fmt(row.nonBillableHours)}h</td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr className="bg-muted/50 font-semibold border-t-2">
            <td colSpan={3} className="px-4 py-2.5 text-foreground">Total</td>
            <td className="px-4 py-2.5 text-right tabular-nums">{fmt(total.totalHours)}h</td>
            <td className="px-4 py-2.5 text-right tabular-nums text-emerald-600">{fmt(total.billableHours)}h</td>
            <td className="px-4 py-2.5 text-right tabular-nums text-amber-600">{fmt(total.nonBillableHours)}h</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

// ─── Export helpers ───────────────────────────────────────────────────────────

async function exportExcel(filename: string, sheetName: string, headers: string[], rows: (string | number)[][]) {
  const { utils, writeFile } = await import('xlsx');
  const ws = utils.aoa_to_sheet([headers, ...rows]);
  const wb = utils.book_new();
  utils.book_append_sheet(wb, ws, sheetName);
  writeFile(wb, `${filename}.xlsx`);
}

// ─── Main Reports Component ───────────────────────────────────────────────────

export default function Reports() {
  const { user } = useAuth();

  const today = format(new Date(), 'yyyy-MM-dd');
  const monthStart = format(startOfMonth(new Date()), 'yyyy-MM-dd');

  // Section tabs
  const [section, setSection] = useState<Section>('client');

  // Shared date range
  const [startDate, setStartDate] = useState(monthStart);
  const [endDate, setEndDate] = useState(today);

  // Client Reports filters
  const [selectedClientId, setSelectedClientId] = useState<number | null>(null);
  const [appliedClientParams, setAppliedClientParams] = useState<{
    clientId: number; start: string; end: string;
  } | null>(null);

  // Team Reports filters
  const [teamUserIds, setTeamUserIds] = useState<number[]>([]);
  const [teamClientIds, setTeamClientIds] = useState<number[]>([]);
  const [appliedTeamParams, setAppliedTeamParams] = useState<{
    userIds: string | undefined; clientIds: string | undefined; start: string; end: string;
  } | null>(null);

  // My Reports filters
  const [appliedMyParams, setAppliedMyParams] = useState<{
    start: string; end: string;
  } | null>(null);

  // Filter options (scoped to current user's access)
  const { data: filterOptions } = useGetReportFilterOptions();
  const allUsers = filterOptions?.users ?? [];
  const allClients = filterOptions?.clients ?? [];

  // ── Client Report query ────────────────────────────────────────────────────
  const { data: clientReportData, isFetching: clientFetching } = useGetClientReport(
    {
      clientId: appliedClientParams?.clientId ?? 0,
      startDate: appliedClientParams?.start,
      endDate: appliedClientParams?.end,
    },
    { query: { enabled: !!appliedClientParams } as any },
  );

  // ── Team Report query ──────────────────────────────────────────────────────
  const { data: teamReportData, isFetching: teamFetching } = useGetTeamReport(
    {
      userIds: appliedTeamParams?.userIds,
      clientIds: appliedTeamParams?.clientIds,
      startDate: appliedTeamParams?.start,
      endDate: appliedTeamParams?.end,
    },
    { query: { enabled: !!appliedTeamParams } as any },
  );

  // ── My Report query ────────────────────────────────────────────────────────
  const { data: myReportData, isFetching: myFetching } = useGetMyReport(
    {
      startDate: appliedMyParams?.start,
      endDate: appliedMyParams?.end,
    },
    { query: { enabled: !!appliedMyParams } as any },
  );

  // ── Run handlers ───────────────────────────────────────────────────────────

  function runClientReport() {
    if (!selectedClientId) return;
    setAppliedClientParams({ clientId: selectedClientId, start: startDate, end: endDate });
  }

  function runTeamReport() {
    setAppliedTeamParams({
      userIds: teamUserIds.length > 0 ? teamUserIds.join(',') : undefined,
      clientIds: teamClientIds.length > 0 ? teamClientIds.join(',') : undefined,
      start: startDate,
      end: endDate,
    });
  }

  function runMyReport() {
    setAppliedMyParams({ start: startDate, end: endDate });
  }

  // ── Client report chart data ───────────────────────────────────────────────
  const chartData = useMemo(
    () =>
      (clientReportData?.monthlySummary ?? []).map((m) => ({
        month: m.month,
        'Total Hours': Number(m.totalHours.toFixed(1)),
        'Billable Hours': Number(m.billableHours.toFixed(1)),
        'Non-Billable': Number(m.nonBillableHours.toFixed(1)),
      })),
    [clientReportData],
  );

  // ── Section tab config ─────────────────────────────────────────────────────
  const tabs: { id: Section; label: string; icon: React.ReactNode }[] = [
    { id: 'client', label: 'Client Reports', icon: <Building2 className="w-4 h-4" /> },
    { id: 'team', label: 'Team Reports', icon: <Users className="w-4 h-4" /> },
    { id: 'my', label: 'My Reports', icon: <User className="w-4 h-4" /> },
  ];

  // ── Export ─────────────────────────────────────────────────────────────────

  async function handleExport() {
    if (section === 'client' && clientReportData) {
      const client = allClients.find((c) => c.id === appliedClientParams?.clientId);
      const name = client?.name ?? 'Client';
      await exportExcel(`${name} Report`, 'Member Breakdown', ['Name', 'Role', 'Total', 'Billable', 'Non-Billable'],
        clientReportData.memberBreakdown.map((r) => [r.userName, roleLabel(r.role), r.totalHours, r.billableHours, r.nonBillableHours]));
    } else if (section === 'team' && teamReportData) {
      await exportExcel('Team Report', 'Hours by Project & Task', ['Client', 'Project', 'Task', 'Total', 'Billable', 'Non-Billable'],
        teamReportData.map((r) => [r.clientName, r.projectName, r.taskName, r.totalHours, r.billableHours, r.nonBillableHours]));
    } else if (section === 'my' && myReportData) {
      await exportExcel('My Report', 'My Hours', ['Client', 'Project', 'Task', 'Total', 'Billable', 'Non-Billable'],
        myReportData.entries.map((r) => [r.clientName, r.projectName, r.taskName, r.totalHours, r.billableHours, r.nonBillableHours]));
    }
  }

  const hasExportData =
    (section === 'client' && !!clientReportData) ||
    (section === 'team' && !!teamReportData) ||
    (section === 'my' && !!myReportData);

  if (!user) return null;

  // ── Date range filter shared across tabs ───────────────────────────────────

  const DateFilters = () => (
    <div className="flex items-center gap-2 flex-wrap">
      <div className="flex items-center gap-2">
        <label className="text-xs text-muted-foreground whitespace-nowrap">From</label>
        <input
          type="date"
          value={startDate}
          max={endDate}
          onChange={(e) => setStartDate(e.target.value)}
          className="h-9 px-3 rounded-md border border-input bg-background text-sm"
        />
      </div>
      <div className="flex items-center gap-2">
        <label className="text-xs text-muted-foreground whitespace-nowrap">To</label>
        <input
          type="date"
          value={endDate}
          min={startDate}
          max={today}
          onChange={(e) => setEndDate(e.target.value)}
          className="h-9 px-3 rounded-md border border-input bg-background text-sm"
        />
      </div>
    </div>
  );

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-primary/10">
            <BarChart2 className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h1 className="text-xl font-semibold">Reports</h1>
            <p className="text-sm text-muted-foreground">Analyse hours by client, team, and individual</p>
          </div>
        </div>
        {hasExportData && (
          <Button variant="outline" size="sm" onClick={handleExport} className="gap-2">
            <Download className="w-4 h-4" />
            Export Excel
          </Button>
        )}
      </div>

      {/* Section tabs */}
      <div className="flex gap-1 p-1 bg-muted rounded-lg w-fit">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setSection(tab.id)}
            className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-all ${
              section === tab.id
                ? 'bg-background shadow-sm text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>

      {/* ── CLIENT REPORTS ─────────────────────────────────────────────────── */}
      {section === 'client' && (
        <div className="space-y-5">
          {/* Filters */}
          <Card>
            <CardContent className="pt-5">
              <div className="flex items-end gap-3 flex-wrap">
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">Client</label>
                  <SingleSelect
                    label="Select a client"
                    options={allClients}
                    value={selectedClientId}
                    onChange={setSelectedClientId}
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">Date Range</label>
                  <DateFilters />
                </div>
                <Button
                  onClick={runClientReport}
                  disabled={!selectedClientId || clientFetching}
                  className="gap-2 self-end"
                >
                  {clientFetching ? <RefreshCw className="w-4 h-4 animate-spin" /> : null}
                  Run Report
                </Button>
              </div>
              {!selectedClientId && (
                <p className="text-xs text-amber-600 mt-2">Select a client to generate the report.</p>
              )}
            </CardContent>
          </Card>

          {/* Results */}
          {clientReportData && (
            <>
              {/* Monthly chart */}
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">Monthly Summary</CardTitle>
                  <p className="text-xs text-muted-foreground">
                    {allClients.find((c) => c.id === appliedClientParams?.clientId)?.name} ·{' '}
                    {appliedClientParams?.start} to {appliedClientParams?.end}
                  </p>
                </CardHeader>
                <CardContent>
                  {chartData.length === 0 ? (
                    <p className="text-sm text-muted-foreground text-center py-8">
                      No hours logged for this client in the selected period.
                    </p>
                  ) : (
                    <ResponsiveContainer width="100%" height={260}>
                      <BarChart data={chartData} margin={{ top: 4, right: 16, left: 0, bottom: 4 }}>
                        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                        <XAxis dataKey="month" tick={{ fontSize: 12 }} tickLine={false} axisLine={false} />
                        <YAxis tick={{ fontSize: 12 }} tickLine={false} axisLine={false} unit="h" />
                        <Tooltip
                          formatter={(v: number) => [`${v}h`]}
                          contentStyle={{ borderRadius: 8, fontSize: 12 }}
                        />
                        <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12 }} />
                        <Bar dataKey="Total Hours" fill="hsl(var(--muted-foreground)/0.35)" radius={[3, 3, 0, 0]} />
                        <Bar dataKey="Billable Hours" fill="hsl(var(--primary))" radius={[3, 3, 0, 0]} />
                        <Bar dataKey="Non-Billable" fill="hsl(var(--primary)/0.25)" radius={[3, 3, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  )}
                </CardContent>
              </Card>

              {/* Member breakdown table */}
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">Hours by Team Member</CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  {clientReportData.memberBreakdown.length === 0 ? (
                    <p className="text-sm text-muted-foreground text-center py-8">
                      No hours logged for this client in the selected period.
                    </p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b bg-muted/50">
                            <th className="text-left px-4 py-2.5 font-medium text-muted-foreground">Name</th>
                            <th className="text-left px-4 py-2.5 font-medium text-muted-foreground">Role</th>
                            <th className="text-right px-4 py-2.5 font-medium text-muted-foreground">Total</th>
                            <th className="text-right px-4 py-2.5 font-medium text-muted-foreground">Billable</th>
                            <th className="text-right px-4 py-2.5 font-medium text-muted-foreground">Non-Billable</th>
                          </tr>
                        </thead>
                        <tbody>
                          {clientReportData.memberBreakdown.map((m) => (
                            <tr key={m.userId} className="border-b hover:bg-muted/30 transition-colors">
                              <td className="px-4 py-2.5 font-medium">{m.userName}</td>
                              <td className="px-4 py-2.5">
                                <Badge variant="outline" className="text-xs">{roleLabel(m.role)}</Badge>
                              </td>
                              <td className="px-4 py-2.5 text-right tabular-nums">{fmt(m.totalHours)}h</td>
                              <td className="px-4 py-2.5 text-right tabular-nums text-emerald-600">{fmt(m.billableHours)}h</td>
                              <td className="px-4 py-2.5 text-right tabular-nums text-amber-600">{fmt(m.nonBillableHours)}h</td>
                            </tr>
                          ))}
                        </tbody>
                        <tfoot>
                          {(() => {
                            const totals = clientReportData.memberBreakdown.reduce(
                              (a, r) => ({ t: a.t + r.totalHours, b: a.b + r.billableHours, n: a.n + r.nonBillableHours }),
                              { t: 0, b: 0, n: 0 },
                            );
                            return (
                              <tr className="bg-muted/50 font-semibold border-t-2">
                                <td colSpan={2} className="px-4 py-2.5">Total</td>
                                <td className="px-4 py-2.5 text-right tabular-nums">{fmt(totals.t)}h</td>
                                <td className="px-4 py-2.5 text-right tabular-nums text-emerald-600">{fmt(totals.b)}h</td>
                                <td className="px-4 py-2.5 text-right tabular-nums text-amber-600">{fmt(totals.n)}h</td>
                              </tr>
                            );
                          })()}
                        </tfoot>
                      </table>
                    </div>
                  )}
                </CardContent>
              </Card>
            </>
          )}
        </div>
      )}

      {/* ── TEAM REPORTS ───────────────────────────────────────────────────── */}
      {section === 'team' && (
        <div className="space-y-5">
          <Card>
            <CardContent className="pt-5">
              <div className="flex items-end gap-3 flex-wrap">
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">Team Members</label>
                  <MultiSelect
                    label="team members"
                    options={allUsers.map((u) => ({ id: u.id, name: u.name }))}
                    selected={teamUserIds}
                    onChange={setTeamUserIds}
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">Clients</label>
                  <MultiSelect
                    label="clients"
                    options={allClients}
                    selected={teamClientIds}
                    onChange={setTeamClientIds}
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">Date Range</label>
                  <DateFilters />
                </div>
                <Button onClick={runTeamReport} disabled={teamFetching} className="gap-2 self-end">
                  {teamFetching ? <RefreshCw className="w-4 h-4 animate-spin" /> : null}
                  Run Report
                </Button>
              </div>
              <p className="text-xs text-muted-foreground mt-2">
                Leaving filters empty shows all team members and clients within your access scope.
              </p>
            </CardContent>
          </Card>

          {appliedTeamParams && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Hours by Project &amp; Task</CardTitle>
                <p className="text-xs text-muted-foreground">
                  {appliedTeamParams.start} to {appliedTeamParams.end}
                  {teamFetching && <span className="ml-2 text-primary animate-pulse">Refreshing…</span>}
                </p>
              </CardHeader>
              <CardContent className="p-0">
                <GroupedTable rows={teamReportData ?? []} />
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* ── MY REPORTS ─────────────────────────────────────────────────────── */}
      {section === 'my' && (
        <div className="space-y-5">
          <Card>
            <CardContent className="pt-5">
              <div className="flex items-end gap-3 flex-wrap">
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">Date Range</label>
                  <DateFilters />
                </div>
                <Button onClick={runMyReport} disabled={myFetching} className="gap-2 self-end">
                  {myFetching ? <RefreshCw className="w-4 h-4 animate-spin" /> : null}
                  Run Report
                </Button>
              </div>
            </CardContent>
          </Card>

          {appliedMyParams && (
            <>
              {/* Summary stat cards */}
              {myReportData?.summary && (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  {[
                    { label: 'Total Hours', value: `${fmt(myReportData.summary.totalHours)}h`, sub: `${myReportData.summary.availableDays} available days` },
                    { label: 'Billable Hours', value: `${fmt(myReportData.summary.billableHours)}h`, sub: `of ${fmt(myReportData.summary.targetHours)}h target`, color: 'text-emerald-600' },
                    { label: 'Utilization', value: `${myReportData.summary.utilization}%`, sub: 'billable / target', color: myReportData.summary.utilization >= 80 ? 'text-emerald-600' : 'text-amber-600' },
                    { label: 'Efficiency', value: `${myReportData.summary.efficiency}%`, sub: 'billable / total', color: myReportData.summary.efficiency >= 80 ? 'text-emerald-600' : 'text-amber-600' },
                  ].map((s) => (
                    <Card key={s.label}>
                      <CardContent className="pt-4 pb-4">
                        <p className="text-xs text-muted-foreground">{s.label}</p>
                        <p className={`text-2xl font-bold mt-1 ${s.color ?? ''}`}>{s.value}</p>
                        <p className="text-xs text-muted-foreground mt-0.5">{s.sub}</p>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              )}

              {/* Detail table */}
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">My Hours by Project &amp; Task</CardTitle>
                  <p className="text-xs text-muted-foreground">
                    {appliedMyParams.start} to {appliedMyParams.end}
                    {myFetching && <span className="ml-2 text-primary animate-pulse">Refreshing…</span>}
                  </p>
                </CardHeader>
                <CardContent className="p-0">
                  <GroupedTable rows={myReportData?.entries ?? []} />
                </CardContent>
              </Card>
            </>
          )}
        </div>
      )}
    </div>
  );
}
