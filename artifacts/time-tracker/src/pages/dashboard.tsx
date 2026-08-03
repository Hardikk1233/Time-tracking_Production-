import React, { useState, useMemo } from 'react';
import {
  useGetDashboardSummary,
  useGetClientHoursTrend,
  useGetTeamUtilization,
  useGetRecentActivity,
  useGetPendingApprovals,
  useListClients,
} from '@workspace/api-client-react';
import { useAuth } from '@/lib/auth';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid,
  Tooltip as RechartsTooltip, ResponsiveContainer, Legend,
} from 'recharts';
import { Clock, Briefcase, AlertCircle, Activity, User, BarChart2 } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { format, startOfMonth, differenceInCalendarDays } from 'date-fns';
import { Link } from 'wouter';
import { Badge } from '@/components/ui/badge';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function todayStr() {
  return format(new Date(), 'yyyy-MM-dd');
}

function monthStartStr() {
  return format(startOfMonth(new Date()), 'yyyy-MM-dd');
}

/** Determine granularity from the date range span */
function getGranularity(startDate: string, endDate: string): 'week' | 'month' {
  const diff = differenceInCalendarDays(new Date(endDate), new Date(startDate));
  return diff <= 56 ? 'week' : 'month';
}

// ─── Dashboard ────────────────────────────────────────────────────────────────

export default function Dashboard() {
  const { user } = useAuth();

  const [startDate, setStartDate] = useState(monthStartStr());
  const [endDate, setEndDate] = useState(todayStr());
  const [selectedClientId, setSelectedClientId] = useState<string>('');

  // Clamp end to not go before start
  const safeEnd = endDate < startDate ? startDate : endDate;
  const granularity = getGranularity(startDate, safeEnd);

  const { data: summary, isLoading: isLoadingSummary } = useGetDashboardSummary({ startDate, endDate: safeEnd });
  const { data: clients, isLoading: isLoadingClients } = useListClients();
  const { data: trendData, isLoading: isLoadingTrend } = useGetClientHoursTrend(
    { clientId: selectedClientId ? Number(selectedClientId) : 0, startDate, endDate: safeEnd, granularity },
    { query: { enabled: !!selectedClientId } as any },
  );
  const { data: teamUtil, isLoading: isLoadingTeam } = useGetTeamUtilization({ startDate, endDate: safeEnd });
  const { data: activity, isLoading: isLoadingActivity } = useGetRecentActivity({ limit: 5 });
  const { data: pendingApprovals, isLoading: isLoadingPending } = useGetPendingApprovals();

  const canApprove = ['associate', 'avp', 'md'].includes(user?.role || '');

  // Pre-select first client when list loads and nothing is selected
  const clientsLoaded = !isLoadingClients && clients && clients.length > 0;
  React.useEffect(() => {
    if (clientsLoaded && !selectedClientId) {
      setSelectedClientId(String(clients![0].id));
    }
  }, [clientsLoaded]);

  const selectedClient = clients?.find(c => String(c.id) === selectedClientId);

  // Stats for the utilization callout in the chart area
  const workingDaysInRange = useMemo(() => {
    if (!startDate || !safeEnd) return 0;
    let count = 0;
    const cur = new Date(startDate);
    const end = new Date(safeEnd);
    while (cur <= end) {
      const d = cur.getDay();
      if (d > 0 && d < 6) count++;
      cur.setDate(cur.getDate() + 1);
    }
    return count;
  }, [startDate, safeEnd]);

  const myUtilization = useMemo(() => {
    if (!summary || workingDaysInRange === 0) return 0;
    const capacity = workingDaysInRange * 8;
    return Math.round((summary.billableHours / capacity) * 100);
  }, [summary, workingDaysInRange]);

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">Command Center</h1>
          <p className="text-muted-foreground font-mono text-sm mt-1">
            {format(new Date(), 'EEEE, MMMM do, yyyy')} // SYSTEM STATUS: ACTIVE
          </p>
        </div>

        <div className="flex items-center gap-3 flex-wrap justify-end">
          {canApprove && !isLoadingPending && pendingApprovals && pendingApprovals.length > 0 && (
            <Link href="/approvals">
              <Button variant="outline" className="border-amber-500/50 bg-amber-500/10 text-amber-600 hover:bg-amber-500/20 shadow-sm">
                <AlertCircle className="w-4 h-4 mr-2" />
                {pendingApprovals.length} Pending
              </Button>
            </Link>
          )}

          {/* Custom date range */}
          <div className="flex items-center gap-2 bg-card border border-border rounded-lg px-3 py-1.5 shadow-sm">
            <span className="text-xs font-mono text-muted-foreground uppercase tracking-wide">From</span>
            <Input
              type="date"
              value={startDate}
              onChange={e => setStartDate(e.target.value)}
              className="h-7 w-36 border-0 bg-transparent p-0 text-sm font-mono focus-visible:ring-0 focus-visible:ring-offset-0"
            />
            <span className="text-xs font-mono text-muted-foreground">→</span>
            <Input
              type="date"
              value={safeEnd}
              min={startDate}
              onChange={e => setEndDate(e.target.value)}
              className="h-7 w-36 border-0 bg-transparent p-0 text-sm font-mono focus-visible:ring-0 focus-visible:ring-offset-0"
            />
            <span className="text-[10px] font-mono text-muted-foreground/60 uppercase border border-border rounded px-1.5 py-0.5">
              {granularity === 'week' ? 'Weekly' : 'Monthly'}
            </span>
          </div>

          <Link href="/time-entries">
            <Button className="shadow-md font-semibold tracking-tight" data-testid="button-log-time">
              Log Time
            </Button>
          </Link>
        </div>
      </div>

      {/* Summary Cards — always your own numbers */}
      <div>
        <p className="text-xs font-mono text-muted-foreground uppercase tracking-wider mb-3">
          Your stats · {workingDaysInRange} working days in range · Capacity {workingDaysInRange * 8}h
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <SummaryCard title="Total Hours" value={summary?.totalHours} icon={Clock} loading={isLoadingSummary} subtext="Hours you logged" />
          <SummaryCard
            title="Billable Hours"
            value={summary?.billableHours}
            icon={Briefcase}
            loading={isLoadingSummary}
            subtext={`${myUtilization}% utilization`}
            highlight
          />
          <SummaryCard title="Non-Billable" value={summary?.nonBillableHours} icon={Activity} loading={isLoadingSummary} subtext="Internal / Admin" />
          <SummaryCard
            title="Pending Approval"
            value={summary?.pendingApprovalCount}
            icon={AlertCircle}
            loading={isLoadingSummary}
            subtext="Your entries waiting"
            alert={summary !== undefined && summary.pendingApprovalCount > 0}
            valueType="count"
          />
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Client Hours Trend Chart */}
        <Card className="lg:col-span-2 shadow-sm border-border">
          <CardHeader className="border-b border-border/50 bg-muted/20">
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div>
                <CardTitle className="text-lg font-bold">Client Hours Distribution</CardTitle>
                <CardDescription className="font-mono text-xs mt-0.5">
                  Billable vs Non-Billable · {granularity === 'week' ? 'Weekly' : 'Monthly'} · Utilization = Billable ÷ (8 × working days)
                </CardDescription>
              </div>
              <div className="w-52 shrink-0">
                {isLoadingClients ? (
                  <Skeleton className="h-9 w-full" />
                ) : (
                  <Select value={selectedClientId} onValueChange={setSelectedClientId}>
                    <SelectTrigger className="h-9 text-xs font-mono bg-background">
                      <SelectValue placeholder="Select client…" />
                    </SelectTrigger>
                    <SelectContent>
                      {clients?.map(c => (
                        <SelectItem key={c.id} value={String(c.id)} className="text-xs font-mono">
                          {c.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
            </div>
          </CardHeader>
          <CardContent className="pt-6">
            {!selectedClientId ? (
              <div className="h-[300px] flex items-center justify-center text-muted-foreground font-mono text-sm border border-dashed border-border rounded-md gap-2">
                <BarChart2 className="w-4 h-4" />
                SELECT A CLIENT TO VIEW TREND
              </div>
            ) : isLoadingTrend ? (
              <Skeleton className="h-[300px] w-full" />
            ) : trendData && trendData.length > 0 ? (
              <div className="h-[300px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={trendData} margin={{ top: 10, right: 40, left: -20, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                    <XAxis
                      dataKey="label"
                      tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 11, fontFamily: 'var(--font-mono)' }}
                      axisLine={false} tickLine={false}
                    />
                    <YAxis
                      yAxisId="hours"
                      tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 11, fontFamily: 'var(--font-mono)' }}
                      axisLine={false} tickLine={false}
                      label={{ value: 'hrs', angle: -90, position: 'insideLeft', fill: 'hsl(var(--muted-foreground))', fontSize: 10, fontFamily: 'var(--font-mono)', dy: 20 }}
                    />
                    <YAxis
                      yAxisId="util"
                      orientation="right"
                      tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 11, fontFamily: 'var(--font-mono)' }}
                      axisLine={false} tickLine={false}
                      tickFormatter={v => `${v}%`}
                      domain={[0, 'auto']}
                    />
                    <RechartsTooltip
                      cursor={{ fill: 'hsl(var(--muted))' }}
                      contentStyle={{ backgroundColor: 'hsl(var(--card))', borderColor: 'hsl(var(--border))', borderRadius: '0.5rem', fontFamily: 'var(--font-mono)', fontSize: '12px' }}
                      formatter={(value: number, name: string) => {
                        if (name === 'Utilization') return [`${value}%`, name];
                        return [`${value.toFixed(1)}h`, name];
                      }}
                    />
                    <Legend iconType="circle" wrapperStyle={{ fontFamily: 'var(--font-mono)', fontSize: '11px' }} />
                    <Bar yAxisId="hours" dataKey="billableHours" name="Billable" stackId="a" fill="hsl(var(--primary))" radius={[0, 0, 4, 4]} />
                    <Bar yAxisId="hours" dataKey="nonBillableHours" name="Non-Billable" stackId="a" fill="hsl(var(--chart-2))" radius={[4, 4, 0, 0]} />
                    <Line
                      yAxisId="util"
                      type="monotone"
                      dataKey="utilization"
                      name="Utilization"
                      stroke="hsl(var(--chart-3))"
                      strokeWidth={2}
                      dot={{ r: 3, fill: 'hsl(var(--chart-3))' }}
                      activeDot={{ r: 5 }}
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <div className="h-[300px] flex items-center justify-center text-muted-foreground font-mono text-sm border border-dashed border-border rounded-md">
                NO DATA FOR {selectedClient?.name?.toUpperCase() ?? 'THIS CLIENT'} IN SELECTED PERIOD
              </div>
            )}
          </CardContent>
        </Card>

        {/* Recent Activity */}
        <Card className="shadow-sm border-border flex flex-col">
          <CardHeader className="border-b border-border/50 bg-muted/20 pb-4">
            <div className="flex items-center justify-between">
              <CardTitle className="text-lg font-bold">Activity Feed</CardTitle>
              <Activity className="w-4 h-4 text-muted-foreground" />
            </div>
          </CardHeader>
          <CardContent className="pt-4 flex-1 overflow-y-auto">
            {isLoadingActivity ? (
              <div className="space-y-4">
                {[1, 2, 3, 4].map(i => (
                  <div key={i} className="flex gap-3">
                    <Skeleton className="w-8 h-8 rounded-full shrink-0" />
                    <div className="space-y-2 flex-1">
                      <Skeleton className="h-4 w-full" />
                      <Skeleton className="h-3 w-2/3" />
                    </div>
                  </div>
                ))}
              </div>
            ) : activity && activity.length > 0 ? (
              <div className="space-y-4">
                {activity.map((entry: any) => (
                  <div key={entry.id} className="flex gap-3 text-sm border-b border-border/50 pb-4 last:border-0 last:pb-0">
                    <div className="w-8 h-8 rounded-full bg-primary/10 text-primary flex items-center justify-center shrink-0 font-bold text-xs">
                      {entry.userName.substring(0, 2).toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-foreground font-medium truncate">
                        <span className="font-bold">{entry.userName}</span> logged <span className="font-mono bg-muted px-1 rounded">{entry.hours}h</span>
                      </p>
                      <p className="text-muted-foreground text-xs truncate mt-0.5">{entry.clientName} / {entry.projectName}</p>
                      <div className="flex items-center gap-2 mt-1.5">
                        <Badge variant={entry.status === 'approved' ? 'default' : entry.status === 'rejected' ? 'destructive' : 'secondary'} className="text-[10px] px-1.5 py-0 rounded-sm">
                          {entry.status}
                        </Badge>
                        <span className="text-[10px] text-muted-foreground font-mono">
                          {format(new Date(entry.createdAt), 'MMM d, HH:mm')}
                        </span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="h-full flex items-center justify-center text-muted-foreground font-mono text-sm">NO ACTIVITY</div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Team Utilization — Associate+ only */}
      {canApprove && (
        <Card className="shadow-sm border-border">
          <CardHeader className="border-b border-border/50 bg-muted/20 flex flex-row items-center justify-between">
            <div>
              <CardTitle className="text-lg font-bold">Team Utilization</CardTitle>
              <CardDescription className="font-mono text-xs mt-1">
                Capacity = 8h/day × 5 days/week · Utilization = Billable ÷ (8 × working days)
              </CardDescription>
            </div>
            <User className="w-5 h-5 text-muted-foreground" />
          </CardHeader>
          <CardContent className="p-0">
            {isLoadingTeam ? (
              <div className="p-6"><Skeleton className="h-48 w-full" /></div>
            ) : teamUtil && teamUtil.filter(m => m.totalHours > 0).length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-xs uppercase tracking-wider font-mono text-muted-foreground bg-muted/30">
                      <th className="px-6 py-4 font-medium">Team Member</th>
                      <th className="px-6 py-4 font-medium">Role</th>
                      <th className="px-6 py-4 font-medium text-right">Total</th>
                      <th className="px-6 py-4 font-medium text-right">Billable</th>
                      <th className="px-6 py-4 font-medium text-right">Non-Billable</th>
                      <th className="px-6 py-4 font-medium text-right">Utilization</th>
                      <th className="px-6 py-4 font-medium text-right">Efficiency</th>
                    </tr>
                  </thead>
                  <tbody>
                    {teamUtil
                      .filter(m => m.totalHours > 0)
                      .map((member) => (
                        <tr key={member.userId} className="border-b border-border/50 last:border-0 hover:bg-muted/20 transition-colors">
                          <td className="px-6 py-3 font-medium text-foreground">{member.userName}</td>
                          <td className="px-6 py-3">
                            <Badge variant="outline" className="font-mono font-normal text-[10px] capitalize">{member.role}</Badge>
                          </td>
                          <td className="px-6 py-3 text-right font-mono text-sm">{member.totalHours.toFixed(1)}h</td>
                          <td className="px-6 py-3 text-right font-mono text-sm text-primary">{member.billableHours.toFixed(1)}h</td>
                          <td className="px-6 py-3 text-right font-mono text-sm text-muted-foreground">{member.nonBillableHours.toFixed(1)}h</td>
                          <td className="px-6 py-3 text-right">
                            <PercentBar value={member.utilization} color="primary" />
                          </td>
                          <td className="px-6 py-3 text-right">
                            <PercentBar value={member.efficiency} color={member.efficiency >= 70 ? 'emerald' : member.efficiency >= 40 ? 'amber' : 'red'} />
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="p-8 text-center text-muted-foreground font-mono text-sm">NO TEAM DATA AVAILABLE</div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function PercentBar({ value, color }: { value: number; color: string }) {
  const colorMap: Record<string, string> = {
    primary: 'bg-primary',
    emerald: 'bg-emerald-500',
    amber: 'bg-amber-500',
    red: 'bg-red-500',
  };
  const textMap: Record<string, string> = {
    primary: 'text-primary',
    emerald: 'text-emerald-600',
    amber: 'text-amber-600',
    red: 'text-red-600',
  };
  return (
    <div className="flex items-center justify-end gap-2">
      <span className={`font-mono text-xs w-10 text-right font-bold ${textMap[color] ?? 'text-foreground'}`}>{value}%</span>
      <div className="w-16 h-2 bg-muted rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${colorMap[color] ?? 'bg-primary'}`} style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
      </div>
    </div>
  );
}

function SummaryCard({
  title, value, icon: Icon, loading, subtext, highlight = false, alert = false, valueType = 'hours'
}: {
  title: string; value?: number; icon: any; loading: boolean; subtext?: string;
  highlight?: boolean; alert?: boolean; valueType?: 'hours' | 'count';
}) {
  return (
    <Card className={`shadow-sm border-border ${highlight ? 'bg-primary text-primary-foreground border-primary' : ''} ${alert ? 'border-amber-500/50 bg-amber-500/5' : ''}`}>
      <CardContent className="p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className={`text-sm font-bold tracking-tight ${highlight ? 'text-primary-foreground/90' : 'text-muted-foreground'} ${alert ? 'text-amber-600' : ''}`}>{title}</h3>
          <div className={`p-2 rounded-md ${highlight ? 'bg-primary-foreground/20' : 'bg-muted'} ${alert ? 'bg-amber-500/20 text-amber-600' : ''}`}>
            <Icon className="w-4 h-4" />
          </div>
        </div>
        {loading ? (
          <Skeleton className={`h-8 w-24 mb-2 ${highlight ? 'bg-primary-foreground/20' : ''}`} />
        ) : (
          <div className="flex items-baseline gap-1">
            <span className={`text-3xl font-bold font-mono tracking-tighter ${alert ? 'text-amber-600' : ''}`}>
              {valueType === 'hours' ? (value ?? 0).toFixed(1) : (value ?? 0)}
            </span>
            <span className={`text-sm font-medium ${highlight ? 'text-primary-foreground/70' : 'text-muted-foreground'} ${alert ? 'text-amber-600/70' : ''}`}>
              {valueType === 'hours' ? 'h' : ''}
            </span>
          </div>
        )}
        {subtext && (
          <p className={`text-xs mt-2 font-mono ${highlight ? 'text-primary-foreground/70' : 'text-muted-foreground'} ${alert ? 'text-amber-600/70' : ''}`}>{subtext}</p>
        )}
      </CardContent>
    </Card>
  );
}
