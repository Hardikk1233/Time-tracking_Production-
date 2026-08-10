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
  FileText,
  TrendingUp,
} from 'lucide-react';
import {
  ComposedChart,
  Bar,
  Line,
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

interface SelectOption { id: number; name: string; }

function MultiSelect({ label, options, selected, onChange }: {
  label: string; options: SelectOption[]; selected: number[]; onChange: (ids: number[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);
  const toggle = (id: number) => onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  const labelText = selected.length === 0 ? `All ${label}` : selected.length === 1 ? (options.find((o) => o.id === selected[0])?.name ?? '1 selected') : `${selected.length} selected`;
  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 h-9 px-3 rounded-md border border-input bg-background text-sm w-full min-w-[160px] justify-between hover:bg-accent transition-colors">
        <span className="truncate text-left">{labelText}</span>
        <ChevronDown className="w-3.5 h-3.5 opacity-50 shrink-0" />
      </button>
      {open && (
        <div className="absolute z-50 mt-1 w-full min-w-[200px] rounded-md border bg-popover shadow-md py-1 max-h-56 overflow-y-auto">
          {options.length === 0 && <p className="px-3 py-2 text-sm text-muted-foreground">No options</p>}
          {options.map((o) => (
            <label key={o.id} className="flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-accent cursor-pointer">
              <input type="checkbox" checked={selected.includes(o.id)} onChange={() => toggle(o.id)} className="rounded" />
              <span className="truncate">{o.name}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── SingleSelect ─────────────────────────────────────────────────────────────

function SingleSelect({ label, options, value, onChange }: {
  label: string; options: SelectOption[]; value: number | null; onChange: (id: number | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);
  const display = value ? (options.find((o) => o.id === value)?.name ?? label) : label;
  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 h-9 px-3 rounded-md border border-input bg-background text-sm w-full min-w-[200px] justify-between hover:bg-accent transition-colors">
        <span className={`truncate text-left ${!value ? 'text-muted-foreground' : ''}`}>{display}</span>
        <ChevronDown className="w-3.5 h-3.5 opacity-50 shrink-0" />
      </button>
      {open && (
        <div className="absolute z-50 mt-1 w-full min-w-[200px] rounded-md border bg-popover shadow-md py-1 max-h-56 overflow-y-auto">
          <button className="w-full text-left px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent" onClick={() => { onChange(null); setOpen(false); }}>— {label}</button>
          {options.map((o) => (
            <button key={o.id} className={`w-full text-left px-3 py-1.5 text-sm hover:bg-accent ${value === o.id ? 'font-medium text-primary' : ''}`} onClick={() => { onChange(o.id); setOpen(false); }}>{o.name}</button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const fmt = (n: number) => n.toFixed(1);
const pct = (n: number) => `${n.toFixed(1)}%`;

function roleLabel(role: string) {
  const map: Record<string, string> = { analyst: 'Analyst', associate: 'Associate', avp: 'AVP', md: 'MD' };
  return map[role] ?? role;
}

function utilizationColor(u: number) {
  if (u >= 85) return 'text-emerald-600';
  if (u >= 60) return 'text-amber-600';
  return 'text-red-500';
}

// ─── Export helpers ───────────────────────────────────────────────────────────

async function exportTableExcel(filename: string, headers: string[], rows: (string | number)[][]) {
  const { utils, writeFile } = await import('xlsx');
  const ws = utils.aoa_to_sheet([headers, ...rows]);
  const wb = utils.book_new();
  utils.book_append_sheet(wb, ws, 'Report');
  writeFile(wb, `${filename}.xlsx`);
}

async function exportTablePDF(filename: string, title: string, headers: string[], rows: (string | number)[][]) {
  const { default: jsPDF } = await import('jspdf');
  const { default: autoTable } = await import('jspdf-autotable');
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  doc.setFontSize(14);
  doc.text(title, 14, 16);
  doc.setFontSize(9);
  doc.text(`Generated: ${format(new Date(), 'dd MMM yyyy HH:mm')}`, 14, 23);
  autoTable(doc, {
    head: [headers],
    body: rows.map((r) => r.map(String)),
    startY: 28,
    styles: { fontSize: 8 },
    headStyles: { fillColor: [30, 41, 59] },
  });
  doc.save(`${filename}.pdf`);
}

// ─── Client Summary Table ─────────────────────────────────────────────────────

interface ClientSummaryRow {
  clientId: number;
  clientName: string;
  fteCount: number;
  selectedRange: { billableHours: number; contractedHours: number; utilization: number };
  last3m:  { billableHours: number; contractedHours: number; utilization: number };
  last6m:  { billableHours: number; contractedHours: number; utilization: number };
  last12m: { billableHours: number; contractedHours: number; utilization: number };
}

function ClientSummaryTable({
  rows,
  onSelect,
  selectedClientId,
  rangeLabel,
}: {
  rows: ClientSummaryRow[];
  onSelect: (id: number) => void;
  selectedClientId: number | null;
  rangeLabel: string;
}) {
  if (rows.length === 0) return <p className="text-sm text-muted-foreground py-8 text-center">No clients in scope.</p>;

  function UtilCell({ stats }: { stats: { billableHours: number; contractedHours: number; utilization: number } }) {
    return (
      <div className="text-right">
        <div className={`font-semibold tabular-nums ${utilizationColor(stats.utilization)}`}>{pct(stats.utilization)}</div>
        <div className="text-xs text-muted-foreground tabular-nums">{fmt(stats.billableHours)}h / {fmt(stats.contractedHours)}h</div>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b bg-muted/50">
            <th className="text-left px-4 py-2.5 font-medium text-muted-foreground">Client</th>
            <th className="text-center px-3 py-2.5 font-medium text-muted-foreground">FTEs</th>
            <th className="text-right px-4 py-2.5 font-medium text-muted-foreground">{rangeLabel}</th>
            <th className="text-right px-4 py-2.5 font-medium text-muted-foreground">Last 3 Months</th>
            <th className="text-right px-4 py-2.5 font-medium text-muted-foreground">Last 6 Months</th>
            <th className="text-right px-4 py-2.5 font-medium text-muted-foreground">Last 12 Months</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.clientId}
              className={`border-b cursor-pointer transition-colors ${selectedClientId === r.clientId ? 'bg-primary/5 border-l-2 border-l-primary' : 'hover:bg-muted/30'}`}
              onClick={() => onSelect(r.clientId)}
            >
              <td className="px-4 py-3">
                <div className="font-medium">{r.clientName}</div>
                <div className="text-xs text-muted-foreground">Click to view monthly chart</div>
              </td>
              <td className="px-3 py-3 text-center">{r.fteCount}</td>
              <td className="px-4 py-3"><UtilCell stats={r.selectedRange} /></td>
              <td className="px-4 py-3"><UtilCell stats={r.last3m} /></td>
              <td className="px-4 py-3"><UtilCell stats={r.last6m} /></td>
              <td className="px-4 py-3"><UtilCell stats={r.last12m} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Team Report grouped table ────────────────────────────────────────────────

interface TeamRow {
  userId: number; userName: string; userRole: string;
  clientId: number; clientName: string;
  projectId: number; projectName: string;
  taskId: number; taskName: string;
  totalHours: number; billableHours: number; nonBillableHours: number; efficiency: number;
}

function TeamTable({ rows }: { rows: TeamRow[] }) {
  if (rows.length === 0) return <p className="text-sm text-muted-foreground py-8 text-center">No data for this selection.</p>;

  let lastUserId: number | null = null;
  let lastClientId: number | null = null;
  let lastProjectId: number | null = null;

  // Per-user totals
  const userTotals = new Map<number, { total: number; billable: number }>();
  for (const r of rows) {
    const cur = userTotals.get(r.userId) ?? { total: 0, billable: 0 };
    userTotals.set(r.userId, { total: cur.total + r.totalHours, billable: cur.billable + r.billableHours });
  }

  const tableRows: React.ReactNode[] = [];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const showUser    = r.userId    !== lastUserId;
    const showClient  = showUser || r.clientId  !== lastClientId;
    const showProject = showClient || r.projectId !== lastProjectId;

    // User header row
    if (showUser) {
      const ut = userTotals.get(r.userId)!;
      const eff = ut.total > 0 ? (ut.billable / ut.total * 100).toFixed(1) : '0.0';
      tableRows.push(
        <tr key={`user-${r.userId}`} className="bg-slate-50 dark:bg-slate-900 border-b border-t-2">
          <td colSpan={4} className="px-4 py-2.5">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-foreground">{r.userName}</span>
              <Badge variant="outline" className="text-xs">{roleLabel(r.userRole)}</Badge>
            </div>
          </td>
          <td className="px-4 py-2.5 text-right tabular-nums font-semibold">{fmt(ut.total)}h</td>
          <td className="px-4 py-2.5 text-right tabular-nums font-semibold text-emerald-600">{fmt(ut.billable)}h</td>
          <td className="px-4 py-2.5 text-right tabular-nums font-semibold text-amber-600">{fmt(ut.total - ut.billable)}h</td>
          <td className="px-4 py-2.5 text-right tabular-nums font-semibold">{eff}%</td>
        </tr>
      );
    }

    tableRows.push(
      <tr key={`${r.userId}-${r.projectId}-${r.taskId}`} className="border-b hover:bg-muted/20 transition-colors">
        <td className="pl-8 pr-4 py-2 text-muted-foreground text-xs">
          {showClient ? <span className="text-foreground font-medium">{r.clientName}</span> : ''}
        </td>
        <td className="pl-6 pr-4 py-2 text-muted-foreground text-xs">
          {showProject ? <span className="text-foreground/80">{r.projectName}</span> : ''}
        </td>
        <td className="px-4 py-2 text-muted-foreground text-xs">{r.taskName}</td>
        <td className="px-4 py-2" />
        <td className="px-4 py-2 text-right tabular-nums text-sm">{fmt(r.totalHours)}h</td>
        <td className="px-4 py-2 text-right tabular-nums text-sm text-emerald-600">{fmt(r.billableHours)}h</td>
        <td className="px-4 py-2 text-right tabular-nums text-sm text-amber-600">{fmt(r.nonBillableHours)}h</td>
        <td className="px-4 py-2 text-right tabular-nums text-sm">{pct(r.efficiency)}</td>
      </tr>
    );

    lastUserId    = r.userId;
    lastClientId  = r.clientId;
    lastProjectId = r.projectId;
  }

  const grand = rows.reduce((a, r) => ({ t: a.t + r.totalHours, b: a.b + r.billableHours }), { t: 0, b: 0 });

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b bg-muted/50">
            <th className="text-left px-4 py-2.5 font-medium text-muted-foreground">Client</th>
            <th className="text-left px-4 py-2.5 font-medium text-muted-foreground">Project</th>
            <th className="text-left px-4 py-2.5 font-medium text-muted-foreground">Task</th>
            <th className="w-8" />
            <th className="text-right px-4 py-2.5 font-medium text-muted-foreground">Total</th>
            <th className="text-right px-4 py-2.5 font-medium text-muted-foreground">Billable</th>
            <th className="text-right px-4 py-2.5 font-medium text-muted-foreground">Non-Billable</th>
            <th className="text-right px-4 py-2.5 font-medium text-muted-foreground">Efficiency</th>
          </tr>
        </thead>
        <tbody>{tableRows}</tbody>
        <tfoot>
          <tr className="bg-muted/50 font-semibold border-t-2">
            <td colSpan={4} className="px-4 py-2.5">Grand Total</td>
            <td className="px-4 py-2.5 text-right tabular-nums">{fmt(grand.t)}h</td>
            <td className="px-4 py-2.5 text-right tabular-nums text-emerald-600">{fmt(grand.b)}h</td>
            <td className="px-4 py-2.5 text-right tabular-nums text-amber-600">{fmt(grand.t - grand.b)}h</td>
            <td className="px-4 py-2.5 text-right tabular-nums">{grand.t > 0 ? pct(grand.b / grand.t * 100) : '—'}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

// ─── My Report grouped table ──────────────────────────────────────────────────

interface MyRow {
  clientId: number; clientName: string;
  projectId: number; projectName: string;
  taskId: number; taskName: string;
  totalHours: number; billableHours: number; nonBillableHours: number;
}

function MyTable({ rows }: { rows: MyRow[] }) {
  if (rows.length === 0) return <p className="text-sm text-muted-foreground py-8 text-center">No hours logged in this period.</p>;
  let lastClientId: number | null = null;
  let lastProjectId: number | null = null;
  const grand = rows.reduce((a, r) => ({ t: a.t + r.totalHours, b: a.b + r.billableHours }), { t: 0, b: 0 });
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b bg-muted/50">
            <th className="text-left px-4 py-2.5 font-medium text-muted-foreground w-1/4">Client</th>
            <th className="text-left px-4 py-2.5 font-medium text-muted-foreground w-1/4">Project</th>
            <th className="text-left px-4 py-2.5 font-medium text-muted-foreground">Task</th>
            <th className="text-right px-4 py-2.5 font-medium text-muted-foreground">Total</th>
            <th className="text-right px-4 py-2.5 font-medium text-muted-foreground">Billable</th>
            <th className="text-right px-4 py-2.5 font-medium text-muted-foreground">Non-Billable</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const sc = r.clientId !== lastClientId;
            const sp = sc || r.projectId !== lastProjectId;
            lastClientId = r.clientId; lastProjectId = r.projectId;
            return (
              <tr key={`${r.projectId}-${r.taskId}-${i}`} className="border-b hover:bg-muted/30 transition-colors">
                <td className="px-4 py-2.5">{sc ? <span className="font-medium">{r.clientName}</span> : <span className="text-muted-foreground/20">↳</span>}</td>
                <td className="px-4 py-2.5">{sp ? r.projectName : <span className="text-muted-foreground/20">↳</span>}</td>
                <td className="px-4 py-2.5 text-muted-foreground">{r.taskName}</td>
                <td className="px-4 py-2.5 text-right tabular-nums">{fmt(r.totalHours)}h</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-emerald-600">{fmt(r.billableHours)}h</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-amber-600">{fmt(r.nonBillableHours)}h</td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr className="bg-muted/50 font-semibold border-t-2">
            <td colSpan={3} className="px-4 py-2.5">Total</td>
            <td className="px-4 py-2.5 text-right tabular-nums">{fmt(grand.t)}h</td>
            <td className="px-4 py-2.5 text-right tabular-nums text-emerald-600">{fmt(grand.b)}h</td>
            <td className="px-4 py-2.5 text-right tabular-nums text-amber-600">{fmt(grand.t - grand.b)}h</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

// ─── Main Reports Component ───────────────────────────────────────────────────

export default function Reports() {
  const { user } = useAuth();
  const today     = format(new Date(), 'yyyy-MM-dd');
  const monthStart = format(startOfMonth(new Date()), 'yyyy-MM-dd');

  const [section, setSection] = useState<Section>('client');

  // Shared date range
  const [startDate, setStartDate] = useState(monthStart);
  const [endDate, setEndDate]     = useState(today);

  // Client Reports
  const [chartClientId, setChartClientId] = useState<number | null>(null);
  const [appliedClientParams, setAppliedClientParams] = useState<{ start: string; end: string }>({ start: monthStart, end: today });

  // Team Reports
  const [teamUserIds,   setTeamUserIds]   = useState<number[]>([]);
  const [teamClientIds, setTeamClientIds] = useState<number[]>([]);
  const [appliedTeamParams, setAppliedTeamParams] = useState<{
    userIds?: string; clientIds?: string; start: string; end: string;
  } | null>(null);

  // My Reports
  const [appliedMyParams, setAppliedMyParams] = useState<{ start: string; end: string } | null>(null);

  // Filter options
  const { data: filterOptions } = useGetReportFilterOptions();
  const allUsers   = filterOptions?.users   ?? [];
  const allClients = filterOptions?.clients ?? [];

  // ── Client Report: auto-load on mount / date change ────────────────────────
  const { data: clientReportData, isFetching: clientFetching } = useGetClientReport(
    { startDate: appliedClientParams.start, endDate: appliedClientParams.end, clientId: chartClientId ?? undefined },
    { query: { enabled: true } as any },
  );

  // ── Team Report ────────────────────────────────────────────────────────────
  const { data: teamReportData, isFetching: teamFetching } = useGetTeamReport(
    { userIds: appliedTeamParams?.userIds, clientIds: appliedTeamParams?.clientIds, startDate: appliedTeamParams?.start, endDate: appliedTeamParams?.end },
    { query: { enabled: !!appliedTeamParams } as any },
  );

  // ── My Report ──────────────────────────────────────────────────────────────
  const { data: myReportData, isFetching: myFetching } = useGetMyReport(
    { startDate: appliedMyParams?.start, endDate: appliedMyParams?.end },
    { query: { enabled: !!appliedMyParams } as any },
  );

  // ── Chart data ─────────────────────────────────────────────────────────────
  const chartData = useMemo(
    () => (clientReportData?.monthlySummary ?? []).map((m) => ({
      month: m.month,
      'Billable Hours': Number(m.billableHours.toFixed(1)),
      'Contracted Hours': Number(m.contractedHours.toFixed(1)),
      'Utilization %': Number(m.utilization.toFixed(1)),
    })),
    [clientReportData],
  );

  const clientSummary = clientReportData?.clientSummary ?? [];
  const rangeLabel = `${appliedClientParams.start} – ${appliedClientParams.end}`;

  function applyClientDates() {
    setAppliedClientParams({ start: startDate, end: endDate });
  }

  // ── Export helpers ─────────────────────────────────────────────────────────
  async function exportClientExcel() {
    await exportTableExcel('Client Utilization Report',
      ['Client', 'FTEs', `${rangeLabel} Util%`, `${rangeLabel} Billable`, `${rangeLabel} Contracted`, 'L3M Util%', 'L6M Util%', 'L12M Util%'],
      clientSummary.map((r) => [r.clientName, r.fteCount, r.selectedRange.utilization, r.selectedRange.billableHours, r.selectedRange.contractedHours, r.last3m.utilization, r.last6m.utilization, r.last12m.utilization]));
  }
  async function exportClientPDF() {
    await exportTablePDF('Client Utilization Report', 'Client Utilization Report',
      ['Client', 'FTEs', 'Selected Util%', 'Billable', 'Contracted', 'L3M Util%', 'L6M Util%', 'L12M Util%'],
      clientSummary.map((r) => [r.clientName, r.fteCount, `${r.selectedRange.utilization}%`, `${r.selectedRange.billableHours}h`, `${r.selectedRange.contractedHours}h`, `${r.last3m.utilization}%`, `${r.last6m.utilization}%`, `${r.last12m.utilization}%`]));
  }
  async function exportTeamExcel() {
    if (!teamReportData) return;
    await exportTableExcel('Team Report',
      ['Member', 'Role', 'Client', 'Project', 'Task', 'Total', 'Billable', 'Non-Billable', 'Efficiency%'],
      teamReportData.map((r) => [r.userName, roleLabel(r.userRole), r.clientName, r.projectName, r.taskName, r.totalHours, r.billableHours, r.nonBillableHours, r.efficiency]));
  }
  async function exportMyExcel() {
    if (!myReportData) return;
    await exportTableExcel('My Hours Report',
      ['Client', 'Project', 'Task', 'Total', 'Billable', 'Non-Billable'],
      myReportData.entries.map((r) => [r.clientName, r.projectName, r.taskName, r.totalHours, r.billableHours, r.nonBillableHours]));
  }

  const tabs: { id: Section; label: string; icon: React.ReactNode }[] = [
    { id: 'client', label: 'Client Reports', icon: <Building2 className="w-4 h-4" /> },
    { id: 'team',   label: 'Team Reports',   icon: <Users    className="w-4 h-4" /> },
    { id: 'my',     label: 'My Reports',     icon: <User     className="w-4 h-4" /> },
  ];

  if (!user) return null;

  const DateFilters = () => (
    <div className="flex items-center gap-2 flex-wrap">
      <div className="flex items-center gap-2">
        <label className="text-xs text-muted-foreground whitespace-nowrap">From</label>
        <input type="date" value={startDate} max={endDate}
          onChange={(e) => setStartDate(e.target.value)}
          className="h-9 px-3 rounded-md border border-input bg-background text-sm" />
      </div>
      <div className="flex items-center gap-2">
        <label className="text-xs text-muted-foreground whitespace-nowrap">To</label>
        <input type="date" value={endDate} min={startDate} max={today}
          onChange={(e) => setEndDate(e.target.value)}
          className="h-9 px-3 rounded-md border border-input bg-background text-sm" />
      </div>
    </div>
  );

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="p-2 rounded-lg bg-primary/10">
          <BarChart2 className="w-5 h-5 text-primary" />
        </div>
        <div>
          <h1 className="text-xl font-semibold">Reports</h1>
          <p className="text-sm text-muted-foreground">Analyse hours by client, team, and individual</p>
        </div>
      </div>

      {/* Section tabs */}
      <div className="flex gap-1 p-1 bg-muted rounded-lg w-fit">
        {tabs.map((tab) => (
          <button key={tab.id} onClick={() => setSection(tab.id)}
            className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-all ${section === tab.id ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'}`}>
            {tab.icon}{tab.label}
          </button>
        ))}
      </div>

      {/* ── CLIENT REPORTS ─────────────────────────────────────────────────── */}
      {section === 'client' && (
        <div className="space-y-5">
          {/* Filter bar */}
          <Card>
            <CardContent className="pt-5">
              <div className="flex items-end gap-3 flex-wrap">
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">Date Range</label>
                  <DateFilters />
                </div>
                <Button onClick={applyClientDates} disabled={clientFetching} className="gap-2 self-end">
                  {clientFetching ? <RefreshCw className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                  Apply
                </Button>
                {clientSummary.length > 0 && (
                  <div className="flex gap-2 self-end ml-auto">
                    <Button variant="outline" size="sm" onClick={exportClientExcel} className="gap-2">
                      <Download className="w-4 h-4" />Excel
                    </Button>
                    <Button variant="outline" size="sm" onClick={exportClientPDF} className="gap-2">
                      <FileText className="w-4 h-4" />PDF
                    </Button>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Client utilization summary table */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Client Utilization Summary</CardTitle>
              <p className="text-xs text-muted-foreground">
                Utilization = Billable Hours ÷ Contracted Hours (FTEs × Working Days × 8h).
                {clientFetching && <span className="ml-2 text-primary animate-pulse">Loading…</span>}
                {!clientFetching && <span className="ml-2">Click a row to see its monthly chart.</span>}
              </p>
            </CardHeader>
            <CardContent className="p-0">
              <ClientSummaryTable
                rows={clientSummary}
                onSelect={(id) => setChartClientId(id === chartClientId ? null : id)}
                selectedClientId={chartClientId}
                rangeLabel={`${appliedClientParams.start} – ${appliedClientParams.end}`}
              />
            </CardContent>
          </Card>

          {/* Monthly chart — shown when a client row is selected */}
          {chartClientId && (
            <Card>
              <CardHeader className="pb-2">
                <div className="flex items-center gap-2">
                  <TrendingUp className="w-4 h-4 text-primary" />
                  <CardTitle className="text-base">
                    {allClients.find((c) => c.id === chartClientId)?.name ?? 'Client'} — Monthly Trend
                  </CardTitle>
                </div>
                <p className="text-xs text-muted-foreground">{appliedClientParams.start} to {appliedClientParams.end}</p>
              </CardHeader>
              <CardContent>
                {chartData.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-8">No hours logged for this client in the selected period.</p>
                ) : (
                  <ResponsiveContainer width="100%" height={280}>
                    <ComposedChart data={chartData} margin={{ top: 4, right: 40, left: 0, bottom: 4 }}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                      <XAxis dataKey="month" tick={{ fontSize: 12 }} tickLine={false} axisLine={false} />
                      <YAxis yAxisId="hours" tick={{ fontSize: 12 }} tickLine={false} axisLine={false} unit="h" />
                      <YAxis yAxisId="pct" orientation="right" tick={{ fontSize: 12 }} tickLine={false} axisLine={false} unit="%" domain={[0, 120]} />
                      <Tooltip contentStyle={{ borderRadius: 8, fontSize: 12 }} formatter={(v: number, name: string) => [name.endsWith('%') ? `${v}%` : `${v}h`, name]} />
                      <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12 }} />
                      <Bar yAxisId="hours" dataKey="Contracted Hours" fill="hsl(var(--muted-foreground)/0.2)" radius={[3, 3, 0, 0]} />
                      <Bar yAxisId="hours" dataKey="Billable Hours"   fill="hsl(var(--primary))"            radius={[3, 3, 0, 0]} />
                      <Line yAxisId="pct" type="monotone" dataKey="Utilization %" stroke="hsl(var(--primary)/0.6)" strokeWidth={2} dot={{ r: 3 }} />
                    </ComposedChart>
                  </ResponsiveContainer>
                )}
              </CardContent>
            </Card>
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
                  <MultiSelect label="team members" options={allUsers.map((u) => ({ id: u.id, name: u.name }))} selected={teamUserIds} onChange={setTeamUserIds} />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">Clients</label>
                  <MultiSelect label="clients" options={allClients} selected={teamClientIds} onChange={setTeamClientIds} />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">Date Range</label>
                  <DateFilters />
                </div>
                <Button onClick={() => setAppliedTeamParams({ userIds: teamUserIds.length ? teamUserIds.join(',') : undefined, clientIds: teamClientIds.length ? teamClientIds.join(',') : undefined, start: startDate, end: endDate })}
                  disabled={teamFetching} className="gap-2 self-end">
                  {teamFetching ? <RefreshCw className="w-4 h-4 animate-spin" /> : null}
                  Run Report
                </Button>
                {teamReportData && teamReportData.length > 0 && (
                  <Button variant="outline" size="sm" onClick={exportTeamExcel} className="gap-2 self-end">
                    <Download className="w-4 h-4" />Excel
                  </Button>
                )}
              </div>
              <p className="text-xs text-muted-foreground mt-2">Leaving filters empty shows all team members and clients within your access scope.</p>
            </CardContent>
          </Card>

          {appliedTeamParams && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Hours by Member → Client → Project → Task</CardTitle>
                <p className="text-xs text-muted-foreground">
                  {appliedTeamParams.start} to {appliedTeamParams.end}
                  {teamFetching && <span className="ml-2 text-primary animate-pulse">Loading…</span>}
                </p>
              </CardHeader>
              <CardContent className="p-0">
                <TeamTable rows={teamReportData ?? []} />
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
                <Button onClick={() => setAppliedMyParams({ start: startDate, end: endDate })} disabled={myFetching} className="gap-2 self-end">
                  {myFetching ? <RefreshCw className="w-4 h-4 animate-spin" /> : null}
                  Run Report
                </Button>
                {myReportData && myReportData.entries.length > 0 && (
                  <Button variant="outline" size="sm" onClick={exportMyExcel} className="gap-2 self-end">
                    <Download className="w-4 h-4" />Excel
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>

          {appliedMyParams && (
            <>
              {myReportData?.summary && (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  {[
                    { label: 'Total Hours',    value: `${fmt(myReportData.summary.totalHours)}h`,    sub: `${myReportData.summary.availableDays} available days` },
                    { label: 'Billable Hours', value: `${fmt(myReportData.summary.billableHours)}h`, sub: `of ${fmt(myReportData.summary.targetHours)}h target`, color: 'text-emerald-600' },
                    { label: 'Utilization',    value: `${myReportData.summary.utilization}%`,         sub: 'billable ÷ target',  color: utilizationColor(myReportData.summary.utilization) },
                    { label: 'Efficiency',     value: `${myReportData.summary.efficiency}%`,          sub: 'billable ÷ total',   color: utilizationColor(myReportData.summary.efficiency) },
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
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">My Hours by Project &amp; Task</CardTitle>
                  <p className="text-xs text-muted-foreground">
                    {appliedMyParams.start} to {appliedMyParams.end}
                    {myFetching && <span className="ml-2 text-primary animate-pulse">Loading…</span>}
                  </p>
                </CardHeader>
                <CardContent className="p-0">
                  <MyTable rows={myReportData?.entries ?? []} />
                </CardContent>
              </Card>
            </>
          )}
        </div>
      )}
    </div>
  );
}
