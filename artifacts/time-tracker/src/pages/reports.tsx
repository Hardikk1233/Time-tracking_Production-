import React, { useState, useMemo, useCallback } from 'react';
import { format, startOfMonth } from 'date-fns';
import { useAuth } from '@/lib/auth';
import { useLocation } from 'wouter';
import {
  useGetUtilizationReport,
  useGetEfficiencyReport,
  useGetClientHoursReport,
  useGetReportFilterOptions,
} from '@workspace/api-client-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  BarChart2,
  Download,
  FileText,
  ChevronUp,
  ChevronDown,
  ChevronsUpDown,
  Filter,
  RefreshCw,
} from 'lucide-react';

// ─── Types ────────────────────────────────────────────────────────────────────

type ReportType = 'utilization' | 'efficiency' | 'client-hours';

type SortDir = 'asc' | 'desc' | null;
interface SortState {
  key: string;
  dir: SortDir;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function todayStr() {
  return format(new Date(), 'yyyy-MM-dd');
}
function monthStartStr() {
  return format(startOfMonth(new Date()), 'yyyy-MM-dd');
}

function pct(value: number) {
  return `${value.toFixed(1)}%`;
}
function hrs(value: number) {
  return value % 1 === 0 ? `${value}h` : `${value.toFixed(1)}h`;
}
function roleBadgeColor(role: string) {
  return role === 'md'
    ? 'bg-amber-100 text-amber-800 border-amber-200'
    : role === 'avp'
    ? 'bg-purple-100 text-purple-800 border-purple-200'
    : role === 'associate'
    ? 'bg-blue-100 text-blue-800 border-blue-200'
    : 'bg-slate-100 text-slate-700 border-slate-200';
}
function utilizationColor(u: number) {
  if (u >= 80) return 'text-emerald-600 font-semibold';
  if (u >= 60) return 'text-amber-600 font-semibold';
  return 'text-red-500 font-semibold';
}

// ─── Multi-select dropdown ────────────────────────────────────────────────────

function MultiSelect({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { id: number; name: string }[];
  value: number[];
  onChange: (ids: number[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const toggle = (id: number) => {
    onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);
  };

  const selectedCount = value.length;

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between gap-2 rounded-md border border-input bg-background px-3 py-1.5 text-sm shadow-sm hover:bg-accent transition-colors"
      >
        <span className="truncate text-left">
          {selectedCount === 0 ? `All ${label}` : `${selectedCount} ${label} selected`}
        </span>
        <ChevronDown className="w-3 h-3 shrink-0 text-muted-foreground" />
      </button>
      {open && (
        <div className="absolute z-50 mt-1 w-full min-w-[180px] rounded-md border border-border bg-popover shadow-lg max-h-52 overflow-y-auto">
          {options.length === 0 ? (
            <div className="px-3 py-2 text-sm text-muted-foreground">No options</div>
          ) : (
            <>
              {selectedCount > 0 && (
                <button
                  type="button"
                  className="w-full text-left px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent border-b border-border"
                  onClick={() => onChange([])}
                >
                  Clear selection
                </button>
              )}
              {options.map((opt) => (
                <label
                  key={opt.id}
                  className="flex items-center gap-2 px-3 py-1.5 text-sm cursor-pointer hover:bg-accent"
                >
                  <input
                    type="checkbox"
                    checked={value.includes(opt.id)}
                    onChange={() => toggle(opt.id)}
                    className="h-3.5 w-3.5 accent-primary"
                  />
                  <span className="truncate">{opt.name}</span>
                </label>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Sortable column header ───────────────────────────────────────────────────

function SortHeader({
  label,
  sortKey,
  sort,
  onSort,
  className = '',
}: {
  label: string;
  sortKey: string;
  sort: SortState;
  onSort: (key: string) => void;
  className?: string;
}) {
  const active = sort.key === sortKey;
  return (
    <th
      className={`px-4 py-2 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wide cursor-pointer select-none hover:text-foreground ${className}`}
      onClick={() => onSort(sortKey)}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {active ? (
          sort.dir === 'asc' ? (
            <ChevronUp className="w-3 h-3" />
          ) : (
            <ChevronDown className="w-3 h-3" />
          )
        ) : (
          <ChevronsUpDown className="w-3 h-3 opacity-40" />
        )}
      </span>
    </th>
  );
}

// ─── Export helpers ───────────────────────────────────────────────────────────

async function exportExcel(
  headers: string[],
  rows: (string | number)[][],
  filename: string,
) {
  const XLSX = await import('xlsx');
  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Report');
  XLSX.writeFile(wb, `${filename}.xlsx`);
}

async function exportPdf(
  title: string,
  filterSummary: string,
  generatedBy: string,
  headers: string[],
  rows: (string | number)[][],
  filename: string,
) {
  const { default: jsPDF } = await import('jspdf');
  const { default: autoTable } = await import('jspdf-autotable');

  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
  const margin = 40;
  let y = margin;

  doc.setFontSize(16);
  doc.setFont('helvetica', 'bold');
  doc.text(title, margin, y);
  y += 22;

  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(120);
  doc.text(filterSummary, margin, y);
  y += 14;
  doc.text(`Generated by ${generatedBy} on ${format(new Date(), 'MMMM d, yyyy HH:mm')}`, margin, y);
  doc.setTextColor(0);
  y += 18;

  autoTable(doc, {
    startY: y,
    head: [headers],
    body: rows,
    styles: { fontSize: 8, cellPadding: 4 },
    headStyles: { fillColor: [15, 23, 42], textColor: 255, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: [248, 250, 252] },
    margin: { left: margin, right: margin },
  });

  doc.save(`${filename}.pdf`);
}

// ─── Reports page ─────────────────────────────────────────────────────────────

export default function Reports() {
  const { user } = useAuth();
  const [, setLocation] = useLocation();

  // Gate access
  React.useEffect(() => {
    if (user && !['avp', 'md'].includes(user.role)) {
      setLocation('/dashboard');
    }
  }, [user, setLocation]);

  const [reportType, setReportType] = useState<ReportType>('utilization');
  const [startDate, setStartDate] = useState(monthStartStr());
  const [endDate, setEndDate] = useState(todayStr());
  const [selectedUserIds, setSelectedUserIds] = useState<number[]>([]);
  const [selectedClientIds, setSelectedClientIds] = useState<number[]>([]);
  const [selectedProjectIds, setSelectedProjectIds] = useState<number[]>([]);
  const [selectedRoles, setSelectedRoles] = useState<string[]>([]);
  const [sort, setSort] = useState<SortState>({ key: '', dir: null });

  // Applied params (only updated on Run Report click)
  const [appliedParams, setAppliedParams] = useState<{
    startDate: string;
    endDate: string;
    userIds: string | undefined;
    clientIds: string | undefined;
    projectIds: string | undefined;
    roles: string | undefined;
  }>({
    startDate: monthStartStr(),
    endDate: todayStr(),
    userIds: undefined,
    clientIds: undefined,
    projectIds: undefined,
    roles: undefined,
  });
  const [hasRun, setHasRun] = useState(false);

  const safeEnd = endDate < startDate ? startDate : endDate;

  // Scoped filter options (users/clients/projects restricted to current user's visibility)
  const { data: filterOptions } = useGetReportFilterOptions({
    query: { enabled: !!user && ['avp', 'md'].includes(user.role) } as any,
  });

  const visibleUsers = filterOptions?.users ?? [];
  const allClients = filterOptions?.clients ?? [];
  const allProjects = filterOptions?.projects ?? [];

  const roleOptions = user?.role === 'md'
    ? ['analyst', 'associate', 'avp']
    : ['analyst', 'associate'];

  // Queries — enabled only after first Run Report
  const commonParams = {
    startDate: appliedParams.startDate,
    endDate: appliedParams.endDate,
    ...(appliedParams.userIds ? { userIds: appliedParams.userIds } : {}),
    ...(appliedParams.clientIds ? { clientIds: appliedParams.clientIds } : {}),
    ...(appliedParams.projectIds ? { projectIds: appliedParams.projectIds } : {}),
    ...(appliedParams.roles ? { roles: appliedParams.roles } : {}),
  };

  const { data: utilizationData, isFetching: utilFetching, refetch: refetchUtil } =
    useGetUtilizationReport(commonParams as any, {
      query: { enabled: hasRun && reportType === 'utilization' } as any,
    });

  const { data: efficiencyData, isFetching: effFetching, refetch: refetchEff } =
    useGetEfficiencyReport(commonParams as any, {
      query: { enabled: hasRun && reportType === 'efficiency' } as any,
    });

  const { data: clientHoursData, isFetching: clientFetching, refetch: refetchClient } =
    useGetClientHoursReport(
      {
        startDate: appliedParams.startDate,
        endDate: appliedParams.endDate,
        ...(appliedParams.clientIds ? { clientIds: appliedParams.clientIds } : {}),
        ...(appliedParams.projectIds ? { projectIds: appliedParams.projectIds } : {}),
        ...(appliedParams.userIds ? { userIds: appliedParams.userIds } : {}),
      } as any,
      {
        query: { enabled: hasRun && reportType === 'client-hours' } as any,
      },
    );

  const isFetching = utilFetching || effFetching || clientFetching;

  const handleRunReport = useCallback(() => {
    const params = {
      startDate,
      endDate: safeEnd,
      userIds: selectedUserIds.length > 0 ? selectedUserIds.join(',') : undefined,
      clientIds: selectedClientIds.length > 0 ? selectedClientIds.join(',') : undefined,
      projectIds: selectedProjectIds.length > 0 ? selectedProjectIds.join(',') : undefined,
      roles: selectedRoles.length > 0 ? selectedRoles.join(',') : undefined,
    };
    setAppliedParams(params);
    setHasRun(true);
  }, [startDate, safeEnd, selectedUserIds, selectedClientIds, selectedProjectIds, selectedRoles]);

  // Re-run when report type changes if already run
  React.useEffect(() => {
    if (hasRun) {
      if (reportType === 'utilization') refetchUtil();
      else if (reportType === 'efficiency') refetchEff();
      else refetchClient();
    }
  }, [reportType]);

  // ── Sorting ──────────────────────────────────────────────────────────────
  const handleSort = (key: string) => {
    setSort((prev) => ({
      key,
      dir: prev.key === key ? (prev.dir === 'asc' ? 'desc' : prev.dir === 'desc' ? null : 'asc') : 'asc',
    }));
  };

  function sortRows<T extends Record<string, any>>(rows: T[]): T[] {
    if (!sort.dir || !sort.key) return rows;
    return [...rows].sort((a, b) => {
      const av = a[sort.key];
      const bv = b[sort.key];
      const cmp = typeof av === 'string' ? av.localeCompare(bv) : (av ?? 0) - (bv ?? 0);
      return sort.dir === 'asc' ? cmp : -cmp;
    });
  }

  const sortedUtil = useMemo(() => sortRows(utilizationData ?? []), [utilizationData, sort]);
  const sortedEff = useMemo(() => sortRows(efficiencyData ?? []), [efficiencyData, sort]);
  const sortedClient = useMemo(() => sortRows(clientHoursData ?? []), [clientHoursData, sort]);

  // ── Filter summary ────────────────────────────────────────────────────────
  const filterSummary = useMemo(() => {
    const parts: string[] = [`Period: ${appliedParams.startDate} → ${appliedParams.endDate}`];
    if (appliedParams.roles) parts.push(`Roles: ${appliedParams.roles}`);
    if (appliedParams.userIds) {
      const names = appliedParams.userIds
        .split(',')
        .map((id) => visibleUsers.find((u) => u.id === Number(id))?.name ?? id)
        .join(', ');
      parts.push(`Users: ${names}`);
    }
    if (appliedParams.clientIds) {
      const names = appliedParams.clientIds
        .split(',')
        .map((id) => allClients.find((c) => c.id === Number(id))?.name ?? id)
        .join(', ');
      parts.push(`Clients: ${names}`);
    }
    if (appliedParams.projectIds) {
      const names = appliedParams.projectIds
        .split(',')
        .map((id) => allProjects.find((p) => p.id === Number(id))?.name ?? id)
        .join(', ');
      parts.push(`Projects: ${names}`);
    }
    return parts.join(' | ');
  }, [appliedParams, visibleUsers, allClients, allProjects]);

  // ── Export handlers ───────────────────────────────────────────────────────
  const reportTitle =
    reportType === 'utilization'
      ? 'Utilization Report'
      : reportType === 'efficiency'
      ? 'Billable Efficiency Report'
      : 'Client / Project Hours Report';

  const filename = `${reportTitle.replace(/\s+/g, '-').toLowerCase()}_${appliedParams.startDate}_${appliedParams.endDate}`;

  const handleExcelExport = async () => {
    if (reportType === 'utilization' && sortedUtil.length > 0) {
      await exportExcel(
        ['Name', 'Role', 'Working Days', 'Leave Days', 'Available Days', 'Hours Logged', 'Billable Hours', 'Target Hours', 'Utilization %'],
        sortedUtil.map((r) => [r.userName, r.role, r.workingDays, r.leaveDays, r.availableDays, r.hoursLogged, r.billableHours, r.targetHours, r.utilization]),
        filename,
      );
    } else if (reportType === 'efficiency' && sortedEff.length > 0) {
      await exportExcel(
        ['Name', 'Role', 'Total Hours', 'Billable Hours', 'Non-Billable Hours', 'Approved Hours', 'Billable %'],
        sortedEff.map((r) => [r.userName, r.role, r.totalHours, r.billableHours, r.nonBillableHours, r.approvedHours, r.billablePct]),
        filename,
      );
    } else if (reportType === 'client-hours' && sortedClient.length > 0) {
      await exportExcel(
        ['Client', 'Project', 'Total Hours', 'Billable Hours', 'Non-Billable Hours', '# Contributors'],
        sortedClient.map((r) => [r.clientName, r.projectName, r.totalHours, r.billableHours, r.nonBillableHours, r.contributorCount]),
        filename,
      );
    }
  };

  const handlePdfExport = async () => {
    const generatedBy = user?.name ?? 'Unknown';
    if (reportType === 'utilization' && sortedUtil.length > 0) {
      await exportPdf(
        reportTitle, filterSummary, generatedBy,
        ['Name', 'Role', 'Working Days', 'Leave Days', 'Available Days', 'Hours Logged', 'Billable Hrs', 'Target Hrs', 'Utilization %'],
        sortedUtil.map((r) => [r.userName, r.role, r.workingDays, r.leaveDays, r.availableDays, hrs(r.hoursLogged), hrs(r.billableHours), hrs(r.targetHours), pct(r.utilization)]),
        filename,
      );
    } else if (reportType === 'efficiency' && sortedEff.length > 0) {
      await exportPdf(
        reportTitle, filterSummary, generatedBy,
        ['Name', 'Role', 'Total Hours', 'Billable Hrs', 'Non-Billable Hrs', 'Approved Hrs', 'Billable %'],
        sortedEff.map((r) => [r.userName, r.role, hrs(r.totalHours), hrs(r.billableHours), hrs(r.nonBillableHours), hrs(r.approvedHours), pct(r.billablePct)]),
        filename,
      );
    } else if (reportType === 'client-hours' && sortedClient.length > 0) {
      await exportPdf(
        reportTitle, filterSummary, generatedBy,
        ['Client', 'Project', 'Total Hours', 'Billable Hrs', 'Non-Billable Hrs', '# Contributors'],
        sortedClient.map((r) => [r.clientName, r.projectName, hrs(r.totalHours), hrs(r.billableHours), hrs(r.nonBillableHours), r.contributorCount]),
        filename,
      );
    }
  };

  // ── Summaries ─────────────────────────────────────────────────────────────
  const utilSummary = useMemo(() => {
    if (!sortedUtil.length) return null;
    return {
      hoursLogged: sortedUtil.reduce((s, r) => s + r.hoursLogged, 0),
      billableHours: sortedUtil.reduce((s, r) => s + r.billableHours, 0),
      targetHours: sortedUtil.reduce((s, r) => s + r.targetHours, 0),
      avgUtil: sortedUtil.reduce((s, r) => s + r.utilization, 0) / sortedUtil.length,
    };
  }, [sortedUtil]);

  const effSummary = useMemo(() => {
    if (!sortedEff.length) return null;
    return {
      totalHours: sortedEff.reduce((s, r) => s + r.totalHours, 0),
      billableHours: sortedEff.reduce((s, r) => s + r.billableHours, 0),
      nonBillableHours: sortedEff.reduce((s, r) => s + r.nonBillableHours, 0),
      approvedHours: sortedEff.reduce((s, r) => s + r.approvedHours, 0),
      avgBillablePct: sortedEff.reduce((s, r) => s + r.billablePct, 0) / sortedEff.length,
    };
  }, [sortedEff]);

  const clientSummary = useMemo(() => {
    if (!sortedClient.length) return null;
    return {
      totalHours: sortedClient.reduce((s, r) => s + r.totalHours, 0),
      billableHours: sortedClient.reduce((s, r) => s + r.billableHours, 0),
      nonBillableHours: sortedClient.reduce((s, r) => s + r.nonBillableHours, 0),
    };
  }, [sortedClient]);

  const hasData =
    (reportType === 'utilization' && (sortedUtil?.length ?? 0) > 0) ||
    (reportType === 'efficiency' && (sortedEff?.length ?? 0) > 0) ||
    (reportType === 'client-hours' && (sortedClient?.length ?? 0) > 0);

  if (!user || !['avp', 'md'].includes(user.role)) return null;

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground flex items-center gap-3">
            <BarChart2 className="w-7 h-7 text-primary" />
            Reports
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Generate and export workforce analytics
          </p>
        </div>
        {hasData && (
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={handleExcelExport} className="gap-2">
              <Download className="w-3.5 h-3.5" />
              Export Excel
            </Button>
            <Button variant="outline" size="sm" onClick={handlePdfExport} className="gap-2">
              <FileText className="w-3.5 h-3.5" />
              Export PDF
            </Button>
          </div>
        )}
      </div>

      {/* Report Type Tabs */}
      <div className="flex gap-1 p-1 bg-muted rounded-lg w-fit">
        {([
          { id: 'utilization', label: 'Utilization' },
          { id: 'efficiency', label: 'Billable Efficiency' },
          { id: 'client-hours', label: 'Client / Project Hours' },
        ] as { id: ReportType; label: string }[]).map((tab) => (
          <button
            key={tab.id}
            onClick={() => setReportType(tab.id)}
            className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${
              reportType === tab.id
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Filter Panel */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Filter className="w-4 h-4" />
            Filters
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {/* Date range */}
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Start Date
              </label>
              <Input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="h-8 text-sm font-mono"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                End Date
              </label>
              <Input
                type="date"
                value={safeEnd}
                min={startDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="h-8 text-sm font-mono"
              />
            </div>

            {/* Role filter (not for client-hours report) */}
            {reportType !== 'client-hours' && (
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Role
                </label>
                <div className="flex gap-2 flex-wrap pt-0.5">
                  {roleOptions.map((r) => (
                    <label key={r} className="flex items-center gap-1.5 text-sm cursor-pointer">
                      <input
                        type="checkbox"
                        checked={selectedRoles.includes(r)}
                        onChange={() =>
                          setSelectedRoles((prev) =>
                            prev.includes(r) ? prev.filter((x) => x !== r) : [...prev, r],
                          )
                        }
                        className="h-3.5 w-3.5 accent-primary"
                      />
                      <span className="capitalize">{r}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}

            {/* Users */}
            {reportType !== 'client-hours' && (
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Users
                </label>
                <MultiSelect
                  label="users"
                  options={visibleUsers.map((u) => ({ id: u.id, name: u.name }))}
                  value={selectedUserIds}
                  onChange={setSelectedUserIds}
                />
              </div>
            )}

            {/* Clients */}
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Clients
              </label>
              <MultiSelect
                label="clients"
                options={(allClients ?? []).map((c) => ({ id: c.id, name: c.name }))}
                value={selectedClientIds}
                onChange={setSelectedClientIds}
              />
            </div>

            {/* Projects */}
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Projects
              </label>
              <MultiSelect
                label="projects"
                options={(allProjects ?? []).map((p) => ({ id: p.id, name: p.name }))}
                value={selectedProjectIds}
                onChange={setSelectedProjectIds}
              />
            </div>

            {/* Users for client-hours */}
            {reportType === 'client-hours' && (
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Limit to Users
                </label>
                <MultiSelect
                  label="users"
                  options={visibleUsers.map((u) => ({ id: u.id, name: u.name }))}
                  value={selectedUserIds}
                  onChange={setSelectedUserIds}
                />
              </div>
            )}
          </div>

          <div className="mt-4 flex justify-end">
            <Button onClick={handleRunReport} disabled={isFetching} className="gap-2 font-semibold">
              {isFetching ? (
                <RefreshCw className="w-4 h-4 animate-spin" />
              ) : (
                <BarChart2 className="w-4 h-4" />
              )}
              Run Report
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Results */}
      {hasRun && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base font-semibold">{reportTitle}</CardTitle>
              <span className="text-xs text-muted-foreground font-mono">{filterSummary}</span>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {isFetching ? (
              <div className="flex items-center justify-center py-16 text-muted-foreground gap-2">
                <RefreshCw className="w-4 h-4 animate-spin" />
                Generating report…
              </div>
            ) : !hasData ? (
              <div className="flex flex-col items-center justify-center py-16 text-muted-foreground gap-2">
                <BarChart2 className="w-8 h-8 opacity-30" />
                <p className="text-sm">No data for the selected filters.</p>
              </div>
            ) : reportType === 'utilization' ? (
              <UtilizationTable rows={sortedUtil} sort={sort} onSort={handleSort} summary={utilSummary} />
            ) : reportType === 'efficiency' ? (
              <EfficiencyTable rows={sortedEff} sort={sort} onSort={handleSort} summary={effSummary} />
            ) : (
              <ClientHoursTable rows={sortedClient} sort={sort} onSort={handleSort} summary={clientSummary} />
            )}
          </CardContent>
        </Card>
      )}

      {!hasRun && (
        <div className="flex flex-col items-center justify-center py-20 text-muted-foreground gap-3">
          <BarChart2 className="w-12 h-12 opacity-20" />
          <p className="text-sm">Set your filters and click <strong>Run Report</strong> to generate results.</p>
        </div>
      )}
    </div>
  );
}

// ─── Utilization Table ────────────────────────────────────────────────────────

function UtilizationTable({
  rows,
  sort,
  onSort,
  summary,
}: {
  rows: any[];
  sort: SortState;
  onSort: (k: string) => void;
  summary: any;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-muted/50 border-b border-border">
          <tr>
            <SortHeader label="Name" sortKey="userName" sort={sort} onSort={onSort} className="pl-6" />
            <SortHeader label="Role" sortKey="role" sort={sort} onSort={onSort} />
            <SortHeader label="Working Days" sortKey="workingDays" sort={sort} onSort={onSort} />
            <SortHeader label="Leave Days" sortKey="leaveDays" sort={sort} onSort={onSort} />
            <SortHeader label="Available Days" sortKey="availableDays" sort={sort} onSort={onSort} />
            <SortHeader label="Hours Logged" sortKey="hoursLogged" sort={sort} onSort={onSort} />
            <SortHeader label="Billable Hrs" sortKey="billableHours" sort={sort} onSort={onSort} />
            <SortHeader label="Target Hrs" sortKey="targetHours" sort={sort} onSort={onSort} />
            <SortHeader label="Utilization" sortKey="utilization" sort={sort} onSort={onSort} />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.userId} className="border-b border-border/50 hover:bg-muted/30 transition-colors">
              <td className="px-4 py-2.5 pl-6 font-medium">{r.userName}</td>
              <td className="px-4 py-2.5">
                <span className={`text-xs px-2 py-0.5 rounded-full border font-medium capitalize ${roleBadgeColor(r.role)}`}>
                  {r.role}
                </span>
              </td>
              <td className="px-4 py-2.5 text-muted-foreground">{r.workingDays}</td>
              <td className="px-4 py-2.5 text-muted-foreground">{r.leaveDays}</td>
              <td className="px-4 py-2.5">{r.availableDays}</td>
              <td className="px-4 py-2.5">{hrs(r.hoursLogged)}</td>
              <td className="px-4 py-2.5">{hrs(r.billableHours)}</td>
              <td className="px-4 py-2.5 text-muted-foreground">{hrs(r.targetHours)}</td>
              <td className={`px-4 py-2.5 ${utilizationColor(r.utilization)}`}>{pct(r.utilization)}</td>
            </tr>
          ))}
        </tbody>
        {summary && (
          <tfoot>
            <tr className="bg-muted/60 font-semibold border-t-2 border-border">
              <td className="px-4 py-2.5 pl-6 text-xs uppercase tracking-wide text-muted-foreground">
                Totals / Avg
              </td>
              <td className="px-4 py-2.5" />
              <td className="px-4 py-2.5" />
              <td className="px-4 py-2.5" />
              <td className="px-4 py-2.5" />
              <td className="px-4 py-2.5">{hrs(summary.hoursLogged)}</td>
              <td className="px-4 py-2.5">{hrs(summary.billableHours)}</td>
              <td className="px-4 py-2.5">{hrs(summary.targetHours)}</td>
              <td className={`px-4 py-2.5 ${utilizationColor(summary.avgUtil)}`}>{pct(summary.avgUtil)}</td>
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

// ─── Efficiency Table ─────────────────────────────────────────────────────────

function EfficiencyTable({
  rows,
  sort,
  onSort,
  summary,
}: {
  rows: any[];
  sort: SortState;
  onSort: (k: string) => void;
  summary: any;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-muted/50 border-b border-border">
          <tr>
            <SortHeader label="Name" sortKey="userName" sort={sort} onSort={onSort} className="pl-6" />
            <SortHeader label="Role" sortKey="role" sort={sort} onSort={onSort} />
            <SortHeader label="Total Hours" sortKey="totalHours" sort={sort} onSort={onSort} />
            <SortHeader label="Billable Hrs" sortKey="billableHours" sort={sort} onSort={onSort} />
            <SortHeader label="Non-Billable Hrs" sortKey="nonBillableHours" sort={sort} onSort={onSort} />
            <SortHeader label="Approved Hrs" sortKey="approvedHours" sort={sort} onSort={onSort} />
            <SortHeader label="Billable %" sortKey="billablePct" sort={sort} onSort={onSort} />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.userId} className="border-b border-border/50 hover:bg-muted/30 transition-colors">
              <td className="px-4 py-2.5 pl-6 font-medium">{r.userName}</td>
              <td className="px-4 py-2.5">
                <span className={`text-xs px-2 py-0.5 rounded-full border font-medium capitalize ${roleBadgeColor(r.role)}`}>
                  {r.role}
                </span>
              </td>
              <td className="px-4 py-2.5">{hrs(r.totalHours)}</td>
              <td className="px-4 py-2.5 text-emerald-600">{hrs(r.billableHours)}</td>
              <td className="px-4 py-2.5 text-muted-foreground">{hrs(r.nonBillableHours)}</td>
              <td className="px-4 py-2.5">{hrs(r.approvedHours)}</td>
              <td className={`px-4 py-2.5 ${utilizationColor(r.billablePct)}`}>{pct(r.billablePct)}</td>
            </tr>
          ))}
        </tbody>
        {summary && (
          <tfoot>
            <tr className="bg-muted/60 font-semibold border-t-2 border-border">
              <td className="px-4 py-2.5 pl-6 text-xs uppercase tracking-wide text-muted-foreground">
                Totals / Avg
              </td>
              <td className="px-4 py-2.5" />
              <td className="px-4 py-2.5">{hrs(summary.totalHours)}</td>
              <td className="px-4 py-2.5 text-emerald-600">{hrs(summary.billableHours)}</td>
              <td className="px-4 py-2.5 text-muted-foreground">{hrs(summary.nonBillableHours)}</td>
              <td className="px-4 py-2.5">{hrs(summary.approvedHours)}</td>
              <td className={`px-4 py-2.5 ${utilizationColor(summary.avgBillablePct)}`}>{pct(summary.avgBillablePct)}</td>
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

// ─── Client Hours Table ───────────────────────────────────────────────────────

function ClientHoursTable({
  rows,
  sort,
  onSort,
  summary,
}: {
  rows: any[];
  sort: SortState;
  onSort: (k: string) => void;
  summary: any;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-muted/50 border-b border-border">
          <tr>
            <SortHeader label="Client" sortKey="clientName" sort={sort} onSort={onSort} className="pl-6" />
            <SortHeader label="Project" sortKey="projectName" sort={sort} onSort={onSort} />
            <SortHeader label="Total Hours" sortKey="totalHours" sort={sort} onSort={onSort} />
            <SortHeader label="Billable Hrs" sortKey="billableHours" sort={sort} onSort={onSort} />
            <SortHeader label="Non-Billable Hrs" sortKey="nonBillableHours" sort={sort} onSort={onSort} />
            <SortHeader label="Contributors" sortKey="contributorCount" sort={sort} onSort={onSort} />
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={`${r.clientId}-${r.projectId}-${i}`} className="border-b border-border/50 hover:bg-muted/30 transition-colors">
              <td className="px-4 py-2.5 pl-6 font-medium">{r.clientName}</td>
              <td className="px-4 py-2.5 text-muted-foreground">{r.projectName}</td>
              <td className="px-4 py-2.5">{hrs(r.totalHours)}</td>
              <td className="px-4 py-2.5 text-emerald-600">{hrs(r.billableHours)}</td>
              <td className="px-4 py-2.5 text-muted-foreground">{hrs(r.nonBillableHours)}</td>
              <td className="px-4 py-2.5">
                <Badge variant="secondary">{r.contributorCount}</Badge>
              </td>
            </tr>
          ))}
        </tbody>
        {summary && (
          <tfoot>
            <tr className="bg-muted/60 font-semibold border-t-2 border-border">
              <td className="px-4 py-2.5 pl-6 text-xs uppercase tracking-wide text-muted-foreground">
                Totals
              </td>
              <td className="px-4 py-2.5" />
              <td className="px-4 py-2.5">{hrs(summary.totalHours)}</td>
              <td className="px-4 py-2.5 text-emerald-600">{hrs(summary.billableHours)}</td>
              <td className="px-4 py-2.5 text-muted-foreground">{hrs(summary.nonBillableHours)}</td>
              <td className="px-4 py-2.5" />
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}
