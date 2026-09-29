import { useMemo, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { format, formatDistanceToNowStrict } from 'date-fns';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Activity, AlertTriangle, Gauge, Server, Timer, Users, Trash2, Table2, BarChart3 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import {
  devGet,
  devSend,
  type MetricsOverview,
  type MetricsWindow,
  type RequestRow,
  type SeriesPoint,
} from '@/lib/dev-api';

/**
 * The Performance tab of the /dev console.
 *
 * Everything on it answers one of four questions about the rollout:
 *
 *   Is it under load?       - requests per replica over time, replica health
 *   Is it slow?             - latency as the server measured it and as the
 *                             browser experienced it, and the gap between them
 *   Who was affected?       - people ranked by errors and slow calls
 *   What exactly happened?  - the individual requests behind any of the above
 *
 * One filter row scopes all of it. Refetches hold the previous render at
 * reduced opacity rather than flashing a skeleton, so the frame never jumps.
 */

const WINDOWS: Array<{ value: MetricsWindow; label: string }> = [
  { value: '15m', label: 'Last 15 minutes' },
  { value: '1h', label: 'Last hour' },
  { value: '24h', label: 'Last 24 hours' },
  { value: '7d', label: 'Last 7 days' },
];

const REFRESH_MS = 15_000;

/**
 * Categorical slots, in the validated order (see the dataviz palette). A
 * replica keeps the slot it was first given for the life of the page, so a
 * scale-in never repaints the survivors.
 */
const SLOTS = ['--viz-1', '--viz-2', '--viz-3', '--viz-4', '--viz-5', '--viz-6', '--viz-7', '--viz-8'];
const replicaSlots = new Map<string, string>();

function slotFor(replica: string): string {
  let slot = replicaSlots.get(replica);
  if (!slot) {
    slot = SLOTS[Math.min(replicaSlots.size, SLOTS.length - 1)];
    replicaSlots.set(replica, slot);
  }
  return `var(${slot})`;
}

/** Light values on the chart root, the same hues re-stepped for dark under `.dark`. */
const PALETTE_CSS = `
.perf-viz {
  --viz-1: #2a78d6; --viz-2: #eb6834; --viz-3: #1baf7a; --viz-4: #eda100;
  --viz-5: #e87ba4; --viz-6: #008300; --viz-7: #4a3aa7; --viz-8: #e34948;
  --viz-grid: #e1e0d9; --viz-axis: #c3c2b7; --viz-muted: #898781;
  --viz-surface: hsl(var(--card));
}
.dark .perf-viz {
  --viz-1: #3987e5; --viz-2: #d95926; --viz-3: #199e70; --viz-4: #c98500;
  --viz-5: #d55181; --viz-6: #008300; --viz-7: #9085e9; --viz-8: #e66767;
  --viz-grid: #2c2c2a; --viz-axis: #383835; --viz-muted: #898781;
}
`;

// ─── Formatting ──────────────────────────────────────────────────────────────

function ms(value: number | null | undefined): string {
  if (value == null) return '—';
  return `${Math.round(value).toLocaleString()} ms`;
}

function count(value: number): string {
  return value.toLocaleString();
}

function ago(iso: string): string {
  try {
    return formatDistanceToNowStrict(new Date(iso), { addSuffix: true });
  } catch {
    return iso;
  }
}

function tickFormatter(window: MetricsWindow): (t: string) => string {
  return (t) => {
    try {
      return format(new Date(t), window === '7d' ? 'EEE HH:mm' : 'HH:mm');
    } catch {
      return t;
    }
  };
}

function bucketLabel(t: string, window: MetricsWindow): string {
  try {
    return format(new Date(t), window === '7d' ? 'EEE d MMM HH:mm' : 'HH:mm:ss');
  } catch {
    return t;
  }
}

// ─── Chart chrome ────────────────────────────────────────────────────────────

const AXIS = { stroke: 'var(--viz-axis)', fontSize: 11, tickLine: false as const, axisLine: false as const };

/**
 * One tooltip, every series. Values lead and are the strong element; the
 * series name follows in muted ink, keyed by a short stroke of its colour.
 */
function VizTooltip({
  active,
  payload,
  label,
  window,
  extra,
}: {
  active?: boolean;
  payload?: Array<{ name: string; value: number | null; color: string; payload: Record<string, unknown> }>;
  label?: string;
  window: MetricsWindow;
  extra?: (row: Record<string, unknown>) => Array<[string, string]>;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const row = payload[0].payload;
  return (
    <div className="rounded-md border border-border bg-card px-3 py-2 text-xs shadow-md">
      <div className="text-muted-foreground mb-1">{label ? bucketLabel(label, window) : ''}</div>
      {payload.map((p) => (
        <div key={p.name} className="flex items-center gap-2">
          <span className="inline-block w-3 border-t-2" style={{ borderColor: p.color }} />
          <span className="font-semibold tabular-nums">{p.value == null ? '—' : count(Number(p.value))}</span>
          <span className="text-muted-foreground">{p.name}</span>
        </div>
      ))}
      {extra?.(row).map(([k, v]) => (
        <div key={k} className="flex items-center gap-2 mt-0.5">
          <span className="inline-block w-3" />
          <span className="font-semibold tabular-nums">{v}</span>
          <span className="text-muted-foreground">{k}</span>
        </div>
      ))}
    </div>
  );
}

function ChartCard({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold">{title}</CardTitle>
        <CardDescription className="text-xs">{description}</CardDescription>
      </CardHeader>
      <CardContent className="pt-0">
        {/* Height includes the x-axis band, so the card never grows a nested scrollbar. */}
        <div className="h-[220px]">{children}</div>
      </CardContent>
    </Card>
  );
}

function EmptyChart({ children }: { children: React.ReactNode }) {
  return (
    <div className="h-full flex items-center justify-center text-xs text-muted-foreground">{children}</div>
  );
}

// ─── Stat tiles ──────────────────────────────────────────────────────────────

function StatTile({
  label,
  value,
  sub,
  icon: Icon,
  alert = false,
}: {
  label: string;
  value: string;
  sub?: string;
  icon: typeof Activity;
  alert?: boolean;
}) {
  return (
    <Card className={cn('shadow-sm', alert && 'border-amber-500/50 bg-amber-500/5')}>
      <CardContent className="p-4">
        <div className="flex items-center justify-between mb-2">
          <span className={cn('text-xs font-medium text-muted-foreground', alert && 'text-amber-600')}>{label}</span>
          <Icon className={cn('w-4 h-4 text-muted-foreground', alert && 'text-amber-600')} />
        </div>
        <div className={cn('text-2xl font-semibold tracking-tight', alert && 'text-amber-600')}>{value}</div>
        {sub && <p className="text-xs text-muted-foreground mt-1 tabular-nums">{sub}</p>}
      </CardContent>
    </Card>
  );
}

// ─── The tab ─────────────────────────────────────────────────────────────────

type ProblemSource = 'all' | 'server' | 'client';
type RouteSort = 'requests' | 'p95' | 'errors' | 'slow';

export function DevPerformance() {
  const [window, setWindow] = useState<MetricsWindow>('1h');
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [asTable, setAsTable] = useState(false);
  const [selectedUser, setSelectedUser] = useState<{ id: number; label: string } | null>(null);
  const [problemSource, setProblemSource] = useState<ProblemSource>('all');
  const [routeSort, setRouteSort] = useState<RouteSort>('requests');
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const overview = useQuery({
    queryKey: ['dev', 'metrics', 'overview', window],
    queryFn: () => devGet<MetricsOverview>(`/dev/metrics/overview?window=${window}`),
    retry: false,
    refetchInterval: autoRefresh ? REFRESH_MS : false,
    placeholderData: keepPreviousData,
  });

  const requests = useQuery({
    queryKey: ['dev', 'metrics', 'requests', window, selectedUser?.id ?? null, problemSource],
    queryFn: () => {
      const params = new URLSearchParams({ window, limit: '100' });
      if (selectedUser) {
        params.set('userId', String(selectedUser.id));
        params.set('problems', '0');
      }
      if (problemSource !== 'all') params.set('source', problemSource);
      return devGet<{ requests: RequestRow[] }>(`/dev/metrics/requests?${params.toString()}`);
    },
    retry: false,
    refetchInterval: autoRefresh ? REFRESH_MS : false,
    placeholderData: keepPreviousData,
  });

  const clear = useMutation({
    mutationFn: () => devSend('DELETE', '/dev/metrics'),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['dev', 'metrics'] });
      toast({ title: 'Performance data cleared' });
    },
    onError: (err: Error) => toast({ variant: 'destructive', title: 'Could not clear', description: err.message }),
  });

  const data = overview.data;
  const replicas = useMemo(() => (data ? data.replicas.map((r) => r.replica) : []), [data]);
  // Each replica becomes a series; the map keeps its colour across refetches.
  replicas.forEach(slotFor);

  const loadSeries = useMemo(
    () =>
      (data?.series ?? []).map((p) => {
        const row: Record<string, unknown> = { t: p.t, requests: p.requests, errors: p.errors };
        for (const r of replicas) row[r] = p.byReplica[r] ?? 0;
        return row;
      }),
    [data, replicas],
  );

  const latencySeries = useMemo(
    () => (data?.series ?? []).map((p) => ({ t: p.t, 'server p95': p.p95, 'browser p95': p.clientP95, p50: p.p50, p99: p.p99 })),
    [data],
  );

  // Replica samples arrive as one row per (bucket, replica); the charts want
  // one row per bucket with a column per replica.
  const { lagSeries, poolSeries } = useMemo(() => {
    const lag = new Map<string, Record<string, unknown>>();
    const pool = new Map<string, Record<string, unknown>>();
    for (const s of data?.samples ?? []) {
      const l = lag.get(s.t) ?? { t: s.t };
      l[s.replica] = s.lagMs;
      l[`${s.replica} max`] = s.lagMaxMs;
      lag.set(s.t, l);
      const p = pool.get(s.t) ?? { t: s.t };
      p[s.replica] = s.poolWaiting;
      pool.set(s.t, p);
    }
    const sortByT = (a: Record<string, unknown>, b: Record<string, unknown>) =>
      String(a.t).localeCompare(String(b.t));
    return { lagSeries: [...lag.values()].sort(sortByT), poolSeries: [...pool.values()].sort(sortByT) };
  }, [data]);

  const sortedRoutes = useMemo(() => {
    const rows = [...(data?.routes ?? [])];
    rows.sort((a, b) => b[routeSort] - a[routeSort]);
    return rows;
  }, [data, routeSort]);

  if (overview.isError) {
    return (
      <p className="text-sm text-muted-foreground py-8 text-center">
        Performance data is not available: {(overview.error as Error).message}
      </p>
    );
  }

  const ticks = tickFormatter(window);
  const busy = overview.isFetching && Boolean(data);
  const t = data?.totals;
  const slowMs = data?.slowMs ?? 1000;

  return (
    <div className="perf-viz space-y-6">
      <style>{PALETTE_CSS}</style>

      {/* One filter row scopes everything below it. */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex gap-1">
          {WINDOWS.map((w) => (
            <Button
              key={w.value}
              size="sm"
              variant={window === w.value ? 'default' : 'outline'}
              onClick={() => setWindow(w.value)}
            >
              {w.label}
            </Button>
          ))}
        </div>
        <label className="flex items-center gap-2 text-xs text-muted-foreground ml-2">
          <Switch checked={autoRefresh} onCheckedChange={setAutoRefresh} />
          Refresh every 15s
        </label>
        <Button size="sm" variant="ghost" className="gap-2" onClick={() => setAsTable((v) => !v)}>
          {asTable ? <BarChart3 className="h-4 w-4" /> : <Table2 className="h-4 w-4" />}
          {asTable ? 'Charts' : 'Table'}
        </Button>
        <div className="ml-auto flex items-center gap-3">
          {data && (
            <span className="text-xs text-muted-foreground tabular-nums">
              In flight now on {data.live.replica}: <strong>{data.live.inFlight}</strong>
              {busy && ' · updating…'}
            </span>
          )}
          <Button
            size="sm"
            variant="outline"
            className="gap-2"
            disabled={clear.isPending || !t || t.requests === 0}
            onClick={() => clear.mutate()}
          >
            <Trash2 className="h-4 w-4" />
            Clear
          </Button>
        </div>
      </div>

      {!data ? (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          {Array(6).fill(0).map((_, i) => <Skeleton key={i} className="h-24" />)}
        </div>
      ) : (
        // Refetches keep the previous frame at reduced opacity; nothing jumps.
        <div className={cn('space-y-6 transition-opacity', busy && 'opacity-60')}>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
            <StatTile label="Requests" value={count(t!.requests)} sub={`${t!.rps}/s average`} icon={Activity} />
            <StatTile label="Server p95" value={ms(t!.p95)} sub={`p50 ${ms(t!.p50)} · p99 ${ms(t!.p99)}`} icon={Timer} />
            <StatTile
              label="Browser p95"
              value={ms(t!.clientP95)}
              sub={
                t!.clientP95 != null
                  ? `${ms(Math.max(0, t!.clientP95 - t!.p95))} above the server`
                  : 'no browser timings yet'
              }
              icon={Gauge}
            />
            <StatTile
              label="Errors"
              value={count(t!.errors5xx + t!.abandoned + t!.clientFailures)}
              sub={`${t!.errors5xx} server · ${t!.abandoned} abandoned · ${t!.clientFailures} browser · ${t!.errors4xx} refused`}
              icon={AlertTriangle}
              alert={t!.errors5xx + t!.abandoned + t!.clientFailures > 0}
            />
            <StatTile label={`Slower than ${slowMs} ms`} value={count(t!.slow)} sub={t!.slow > 0 ? 'see routes and people below' : 'none'} icon={Timer} alert={t!.slow > 0} />
            <StatTile label="People" value={count(t!.users)} sub={`${t!.replicas} replica${t!.replicas === 1 ? '' : 's'} serving`} icon={Users} />
          </div>

          {t!.requests === 0 && data.samples.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">
              Nothing recorded in this window yet. Timings appear a few seconds after the first request.
            </p>
          ) : asTable ? (
            <SeriesTable series={data.series} replicas={replicas} window={window} />
          ) : (
            <>
              <div className="grid lg:grid-cols-2 gap-4">
                <ChartCard
                  title="Load per replica"
                  description="Requests in each interval, stacked by the replica that served them. A second colour appearing is a scale-out."
                >
                  {loadSeries.length === 0 ? (
                    <EmptyChart>No requests in this window.</EmptyChart>
                  ) : (
                    <ResponsiveContainer>
                      <BarChart data={loadSeries} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
                        <CartesianGrid stroke="var(--viz-grid)" vertical={false} />
                        <XAxis dataKey="t" tickFormatter={ticks} {...AXIS} />
                        <YAxis {...AXIS} allowDecimals={false} />
                        <Tooltip content={<VizTooltip window={window} />} cursor={{ fill: 'var(--viz-grid)', opacity: 0.4 }} />
                        {replicas.length > 1 && <Legend iconType="rect" wrapperStyle={{ fontSize: 11 }} />}
                        {replicas.map((r, i) => (
                          <Bar
                            key={r}
                            dataKey={r}
                            stackId="load"
                            fill={slotFor(r)}
                            stroke="var(--viz-surface)"
                            strokeWidth={2}
                            maxBarSize={24}
                            radius={i === replicas.length - 1 ? [4, 4, 0, 0] : 0}
                          />
                        ))}
                      </BarChart>
                    </ResponsiveContainer>
                  )}
                </ChartCard>

                <ChartCard
                  title="Latency: server vs browser"
                  description="p95 of the same calls from both ends. The space between the lines is the network and the ingress, not the server."
                >
                  {latencySeries.length === 0 ? (
                    <EmptyChart>No requests in this window.</EmptyChart>
                  ) : (
                    <ResponsiveContainer>
                      <LineChart data={latencySeries} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
                        <CartesianGrid stroke="var(--viz-grid)" vertical={false} />
                        <XAxis dataKey="t" tickFormatter={ticks} {...AXIS} />
                        <YAxis {...AXIS} unit=" ms" width={70} />
                        <Tooltip
                          content={
                            <VizTooltip
                              window={window}
                              extra={(row) => [
                                ['server p50', ms(row.p50 as number)],
                                ['server p99', ms(row.p99 as number)],
                              ]}
                            />
                          }
                        />
                        <Legend iconType="plainline" wrapperStyle={{ fontSize: 11 }} />
                        <Line type="monotone" dataKey="server p95" stroke="var(--viz-1)" strokeWidth={2} dot={false} activeDot={{ r: 4, stroke: 'var(--viz-surface)', strokeWidth: 2 }} isAnimationActive={false} />
                        <Line type="monotone" dataKey="browser p95" stroke="var(--viz-2)" strokeWidth={2} dot={false} connectNulls activeDot={{ r: 4, stroke: 'var(--viz-surface)', strokeWidth: 2 }} isAnimationActive={false} />
                      </LineChart>
                    </ResponsiveContainer>
                  )}
                </ChartCard>

                <ChartCard
                  title="Failures and abandoned calls"
                  description="Server errors (5xx) plus calls the browser gave up on before the answer came back."
                >
                  {loadSeries.length === 0 ? (
                    <EmptyChart>No requests in this window.</EmptyChart>
                  ) : (
                    <ResponsiveContainer>
                      <BarChart data={loadSeries} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
                        <CartesianGrid stroke="var(--viz-grid)" vertical={false} />
                        <XAxis dataKey="t" tickFormatter={ticks} {...AXIS} />
                        <YAxis {...AXIS} allowDecimals={false} />
                        <Tooltip content={<VizTooltip window={window} />} cursor={{ fill: 'var(--viz-grid)', opacity: 0.4 }} />
                        <Bar dataKey="errors" name="failures" fill="var(--viz-8)" maxBarSize={24} radius={[4, 4, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  )}
                </ChartCard>

                <ChartCard
                  title="Event-loop lag per replica"
                  description="How long each replica kept requests waiting for the CPU. On a quarter of a vCPU this rises before latency does."
                >
                  {lagSeries.length === 0 ? (
                    <EmptyChart>No replica samples yet.</EmptyChart>
                  ) : (
                    <ResponsiveContainer>
                      <LineChart data={lagSeries} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
                        <CartesianGrid stroke="var(--viz-grid)" vertical={false} />
                        <XAxis dataKey="t" tickFormatter={ticks} {...AXIS} />
                        <YAxis {...AXIS} unit=" ms" width={70} />
                        <Tooltip
                          content={
                            <VizTooltip
                              window={window}
                              extra={(row) => replicas.map((r) => [`${r} worst`, ms(row[`${r} max`] as number)])}
                            />
                          }
                        />
                        {replicas.length > 1 && <Legend iconType="plainline" wrapperStyle={{ fontSize: 11 }} />}
                        {replicas.map((r) => (
                          <Line key={r} type="monotone" dataKey={r} stroke={slotFor(r)} strokeWidth={2} dot={false} connectNulls activeDot={{ r: 4, stroke: 'var(--viz-surface)', strokeWidth: 2 }} isAnimationActive={false} />
                        ))}
                      </LineChart>
                    </ResponsiveContainer>
                  )}
                </ChartCard>
              </div>

              <div className="grid lg:grid-cols-2 gap-4">
                <ChartCard
                  title="Waiting for a database connection"
                  description="Requests queued for one of the replica's 8 pooled connections. Anything above zero for long is the database tier, not the app."
                >
                  {poolSeries.length === 0 ? (
                    <EmptyChart>No replica samples yet.</EmptyChart>
                  ) : (
                    <ResponsiveContainer>
                      <LineChart data={poolSeries} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
                        <CartesianGrid stroke="var(--viz-grid)" vertical={false} />
                        <XAxis dataKey="t" tickFormatter={ticks} {...AXIS} />
                        <YAxis {...AXIS} allowDecimals={false} />
                        <Tooltip content={<VizTooltip window={window} />} />
                        {replicas.length > 1 && <Legend iconType="plainline" wrapperStyle={{ fontSize: 11 }} />}
                        {replicas.map((r) => (
                          <Line key={r} type="stepAfter" dataKey={r} stroke={slotFor(r)} strokeWidth={2} dot={false} connectNulls activeDot={{ r: 4, stroke: 'var(--viz-surface)', strokeWidth: 2 }} isAnimationActive={false} />
                        ))}
                      </LineChart>
                    </ResponsiveContainer>
                  )}
                </ChartCard>

                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-semibold flex items-center gap-2">
                      <Server className="h-4 w-4" />
                      Replicas now
                    </CardTitle>
                    <CardDescription className="text-xs">
                      Share of the window's traffic and the latest health sample from each. Container Apps scales 1→3 replicas at 40 concurrent requests each.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="pt-0 overflow-x-auto">
                    <table className="w-full text-xs tabular-nums">
                      <thead className="text-muted-foreground">
                        <tr className="text-left">
                          <th className="py-1 pr-3 font-medium">Replica</th>
                          <th className="py-1 pr-3 font-medium text-right">Share</th>
                          <th className="py-1 pr-3 font-medium text-right">p95</th>
                          <th className="py-1 pr-3 font-medium text-right">Lag</th>
                          <th className="py-1 pr-3 font-medium text-right">RSS</th>
                          <th className="py-1 pr-3 font-medium text-right">In flight</th>
                          <th className="py-1 pr-3 font-medium text-right">Pool</th>
                          <th className="py-1 font-medium text-right">Sampled</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.replicas.map((r) => (
                          <tr key={r.replica} className="border-t border-border/50">
                            <td className="py-1.5 pr-3 font-mono flex items-center gap-2">
                              <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: slotFor(r.replica) }} />
                              {r.replica}
                            </td>
                            <td className="py-1.5 pr-3 text-right">{r.share}%</td>
                            <td className="py-1.5 pr-3 text-right">{ms(r.p95)}</td>
                            <td className="py-1.5 pr-3 text-right">{r.latest ? `${r.latest.eventLoopLagMs} / ${r.latest.eventLoopMaxMs} ms` : '—'}</td>
                            <td className="py-1.5 pr-3 text-right">{r.latest ? `${r.latest.rssMb} MB` : '—'}</td>
                            <td className="py-1.5 pr-3 text-right">{r.latest ? r.latest.inFlight : '—'}</td>
                            <td className="py-1.5 pr-3 text-right">
                              {r.latest ? `${r.latest.poolTotal - r.latest.poolIdle}/${r.latest.poolTotal} busy` : '—'}
                              {r.latest && r.latest.poolWaiting > 0 && (
                                <Badge variant="destructive" className="ml-1 text-[10px]">{r.latest.poolWaiting} waiting</Badge>
                              )}
                            </td>
                            <td className="py-1.5 text-right text-muted-foreground">{r.latest ? ago(r.latest.sampledAt) : '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </CardContent>
                </Card>
              </div>
            </>
          )}

          {/* ── Routes ─────────────────────────────────────────────────── */}
          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div>
                  <CardTitle className="text-sm font-semibold">Routes</CardTitle>
                  <CardDescription className="text-xs">
                    Each endpoint as the server timed it and as browsers saw it. A large gap on one route and not others points at payload size, not the network.
                  </CardDescription>
                </div>
                <div className="flex gap-1">
                  {(['requests', 'p95', 'errors', 'slow'] as RouteSort[]).map((s) => (
                    <Button key={s} size="sm" variant={routeSort === s ? 'secondary' : 'ghost'} onClick={() => setRouteSort(s)}>
                      by {s}
                    </Button>
                  ))}
                </div>
              </div>
            </CardHeader>
            <CardContent className="pt-0 overflow-x-auto">
              {sortedRoutes.length === 0 ? (
                <p className="text-xs text-muted-foreground py-4 text-center">No routes in this window.</p>
              ) : (
                <table className="w-full text-xs tabular-nums">
                  <thead className="text-muted-foreground">
                    <tr className="text-left">
                      <th className="py-1 pr-3 font-medium">Route</th>
                      <th className="py-1 pr-3 font-medium text-right">Requests</th>
                      <th className="py-1 pr-3 font-medium text-right">p50</th>
                      <th className="py-1 pr-3 font-medium text-right">p95</th>
                      <th className="py-1 pr-3 font-medium text-right">p99</th>
                      <th className="py-1 pr-3 font-medium text-right">Browser p95</th>
                      <th className="py-1 pr-3 font-medium text-right">Gap</th>
                      <th className="py-1 pr-3 font-medium text-right">Failures</th>
                      <th className="py-1 font-medium text-right">Slow</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedRoutes.map((r) => (
                      <tr key={`${r.method} ${r.route}`} className="border-t border-border/50">
                        <td className="py-1.5 pr-3 font-mono">
                          <span className="text-muted-foreground mr-2">{r.method}</span>
                          {r.route}
                        </td>
                        <td className="py-1.5 pr-3 text-right">{count(r.requests)}</td>
                        <td className="py-1.5 pr-3 text-right">{ms(r.p50)}</td>
                        <td className={cn('py-1.5 pr-3 text-right', r.p95 >= slowMs && 'text-amber-600 font-semibold')}>{ms(r.p95)}</td>
                        <td className="py-1.5 pr-3 text-right">{ms(r.p99)}</td>
                        <td className="py-1.5 pr-3 text-right">{ms(r.clientP95)}</td>
                        <td className="py-1.5 pr-3 text-right text-muted-foreground">
                          {r.clientP95 != null ? ms(Math.max(0, r.clientP95 - r.p95)) : '—'}
                        </td>
                        <td className={cn('py-1.5 pr-3 text-right', r.errors > 0 && 'text-destructive font-semibold')}>{count(r.errors)}</td>
                        <td className={cn('py-1.5 text-right', r.slow > 0 && 'text-amber-600 font-semibold')}>{count(r.slow)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CardContent>
          </Card>

          {/* ── People ─────────────────────────────────────────────────── */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <Users className="h-4 w-4" />
                People
              </CardTitle>
              <CardDescription className="text-xs">
                Ranked by trouble, not by volume: whoever hit the most failures and slow calls is first. "Browser" columns are what their own browser reported.
              </CardDescription>
            </CardHeader>
            <CardContent className="pt-0 overflow-x-auto">
              {data.users.length === 0 ? (
                <p className="text-xs text-muted-foreground py-4 text-center">Nobody signed in during this window.</p>
              ) : (
                <table className="w-full text-xs tabular-nums">
                  <thead className="text-muted-foreground">
                    <tr className="text-left">
                      <th className="py-1 pr-3 font-medium">Person</th>
                      <th className="py-1 pr-3 font-medium text-right">Requests</th>
                      <th className="py-1 pr-3 font-medium text-right">Failures</th>
                      <th className="py-1 pr-3 font-medium text-right">Abandoned</th>
                      <th className="py-1 pr-3 font-medium text-right">Slow</th>
                      <th className="py-1 pr-3 font-medium text-right">p95</th>
                      <th className="py-1 pr-3 font-medium text-right">Worst</th>
                      <th className="py-1 pr-3 font-medium text-right">Browser p95</th>
                      <th className="py-1 pr-3 font-medium text-right">Browser failures</th>
                      <th className="py-1 pr-3 font-medium text-right">Last seen</th>
                      <th className="py-1 font-medium" />
                    </tr>
                  </thead>
                  <tbody>
                    {data.users.map((u) => {
                      const trouble = u.errors + u.slow + u.abandoned + u.clientFailures;
                      return (
                        <tr key={u.userId} className={cn('border-t border-border/50', trouble > 0 && 'bg-amber-500/5')}>
                          <td className="py-1.5 pr-3">
                            <div className="font-medium">{u.userName ?? u.userEmail ?? `#${u.userId}`}</div>
                            {u.userName && <div className="text-muted-foreground">{u.userEmail}</div>}
                          </td>
                          <td className="py-1.5 pr-3 text-right">{count(u.requests)}</td>
                          <td className={cn('py-1.5 pr-3 text-right', u.errors > 0 && 'text-destructive font-semibold')}>{count(u.errors)}</td>
                          <td className={cn('py-1.5 pr-3 text-right', u.abandoned > 0 && 'text-amber-600 font-semibold')}>{count(u.abandoned)}</td>
                          <td className={cn('py-1.5 pr-3 text-right', u.slow > 0 && 'text-amber-600 font-semibold')}>{count(u.slow)}</td>
                          <td className="py-1.5 pr-3 text-right">{ms(u.p95)}</td>
                          <td className="py-1.5 pr-3 text-right">{ms(u.maxMs)}</td>
                          <td className="py-1.5 pr-3 text-right">{ms(u.clientP95)}</td>
                          <td className={cn('py-1.5 pr-3 text-right', u.clientFailures > 0 && 'text-destructive font-semibold')}>{count(u.clientFailures)}</td>
                          <td className="py-1.5 pr-3 text-right text-muted-foreground whitespace-nowrap">{ago(u.lastSeen)}</td>
                          <td className="py-1.5 text-right">
                            <Button
                              size="sm"
                              variant={selectedUser?.id === u.userId ? 'secondary' : 'ghost'}
                              onClick={() =>
                                setSelectedUser(
                                  selectedUser?.id === u.userId
                                    ? null
                                    : { id: u.userId, label: u.userName ?? u.userEmail ?? `#${u.userId}` },
                                )
                              }
                            >
                              {selectedUser?.id === u.userId ? 'Showing' : 'Their calls'}
                            </Button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </CardContent>
          </Card>

          {/* ── Individual requests ────────────────────────────────────── */}
          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div>
                  <CardTitle className="text-sm font-semibold">
                    {selectedUser ? `Recent calls by ${selectedUser.label}` : 'What went wrong'}
                  </CardTitle>
                  <CardDescription className="text-xs">
                    {selectedUser
                      ? 'Everything they did in the window, newest first, from both ends of the wire.'
                      : `Every call that failed, was abandoned, or took longer than ${slowMs} ms - newest first.`}
                  </CardDescription>
                </div>
                <div className="flex gap-1 items-center">
                  {(['all', 'server', 'client'] as ProblemSource[]).map((s) => (
                    <Button key={s} size="sm" variant={problemSource === s ? 'secondary' : 'ghost'} onClick={() => setProblemSource(s)}>
                      {s === 'client' ? 'browser' : s}
                    </Button>
                  ))}
                  {selectedUser && (
                    <Button size="sm" variant="outline" onClick={() => setSelectedUser(null)}>
                      Back to problems
                    </Button>
                  )}
                </div>
              </div>
            </CardHeader>
            <CardContent className="pt-0 overflow-x-auto">
              <RequestsTable rows={requests.data?.requests ?? []} loading={requests.isLoading} slowMs={slowMs} />
            </CardContent>
          </Card>

          {/* ── Page loads ─────────────────────────────────────────────── */}
          {data.pages.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold">Page loads</CardTitle>
                <CardDescription className="text-xs">
                  Full loads of the app, by the page it opened on. Time to first byte is the server and network; the rest is the bundle and the browser.
                </CardDescription>
              </CardHeader>
              <CardContent className="pt-0 overflow-x-auto">
                <table className="w-full text-xs tabular-nums">
                  <thead className="text-muted-foreground">
                    <tr className="text-left">
                      <th className="py-1 pr-3 font-medium">Page</th>
                      <th className="py-1 pr-3 font-medium text-right">Loads</th>
                      <th className="py-1 pr-3 font-medium text-right">Ready p50</th>
                      <th className="py-1 pr-3 font-medium text-right">Ready p95</th>
                      <th className="py-1 font-medium text-right">First byte p95</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.pages.map((p) => (
                      <tr key={p.page} className="border-t border-border/50">
                        <td className="py-1.5 pr-3 font-mono">{p.page}</td>
                        <td className="py-1.5 pr-3 text-right">{count(p.loads)}</td>
                        <td className="py-1.5 pr-3 text-right">{ms(p.p50)}</td>
                        <td className="py-1.5 pr-3 text-right">{ms(p.p95)}</td>
                        <td className="py-1.5 text-right">{ms(p.p95Ttfb)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Sub-tables ──────────────────────────────────────────────────────────────

/** The charts' table twin: one row per interval, every series as a column. */
function SeriesTable({ series, replicas, window }: { series: SeriesPoint[]; replicas: string[]; window: MetricsWindow }) {
  if (series.length === 0) {
    return <p className="text-xs text-muted-foreground py-4 text-center">No requests in this window.</p>;
  }
  return (
    <Card>
      <CardContent className="pt-4 overflow-x-auto">
        <table className="w-full text-xs tabular-nums">
          <thead className="text-muted-foreground">
            <tr className="text-left">
              <th className="py-1 pr-3 font-medium">Interval</th>
              <th className="py-1 pr-3 font-medium text-right">Requests</th>
              {replicas.map((r) => (
                <th key={r} className="py-1 pr-3 font-medium text-right font-mono">{r}</th>
              ))}
              <th className="py-1 pr-3 font-medium text-right">Failures</th>
              <th className="py-1 pr-3 font-medium text-right">p50</th>
              <th className="py-1 pr-3 font-medium text-right">p95</th>
              <th className="py-1 pr-3 font-medium text-right">p99</th>
              <th className="py-1 font-medium text-right">Browser p95</th>
            </tr>
          </thead>
          <tbody>
            {series.map((p) => (
              <tr key={p.t} className="border-t border-border/50">
                <td className="py-1 pr-3 whitespace-nowrap">{bucketLabel(p.t, window)}</td>
                <td className="py-1 pr-3 text-right">{count(p.requests)}</td>
                {replicas.map((r) => (
                  <td key={r} className="py-1 pr-3 text-right">{count(p.byReplica[r] ?? 0)}</td>
                ))}
                <td className="py-1 pr-3 text-right">{count(p.errors)}</td>
                <td className="py-1 pr-3 text-right">{ms(p.p50)}</td>
                <td className="py-1 pr-3 text-right">{ms(p.p95)}</td>
                <td className="py-1 pr-3 text-right">{ms(p.p99)}</td>
                <td className="py-1 text-right">{ms(p.clientP95)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

function statusTone(status: number | null, durationMs: number, slowMs: number): string {
  if (status === null) return '';
  if (status === 0 || status >= 500 || status === 499) return 'text-destructive font-semibold';
  if (status >= 400) return 'text-amber-600';
  if (durationMs >= slowMs) return 'text-amber-600';
  return '';
}

function RequestsTable({ rows, loading, slowMs }: { rows: RequestRow[]; loading: boolean; slowMs: number }) {
  if (loading) return <Skeleton className="h-24" />;
  if (rows.length === 0) {
    return <p className="text-xs text-muted-foreground py-4 text-center">Nothing to show.</p>;
  }
  return (
    <table className="w-full text-xs tabular-nums">
      <thead className="text-muted-foreground">
        <tr className="text-left">
          <th className="py-1 pr-3 font-medium">When</th>
          <th className="py-1 pr-3 font-medium">Side</th>
          <th className="py-1 pr-3 font-medium">Call</th>
          <th className="py-1 pr-3 font-medium text-right">Status</th>
          <th className="py-1 pr-3 font-medium text-right">Took</th>
          <th className="py-1 pr-3 font-medium">Who</th>
          <th className="py-1 pr-3 font-medium">Replica</th>
          <th className="py-1 font-medium">Page</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={`${r.source}-${r.id}`} className="border-t border-border/50">
            <td className="py-1.5 pr-3 whitespace-nowrap text-muted-foreground" title={r.occurredAt}>
              {ago(r.occurredAt)}
            </td>
            <td className="py-1.5 pr-3">
              <Badge variant={r.source === 'server' ? 'outline' : 'secondary'} className="text-[10px]">
                {r.source === 'client' ? 'browser' : 'server'}
              </Badge>
            </td>
            <td className="py-1.5 pr-3 font-mono">
              <span className="text-muted-foreground mr-2">{r.method ?? ''}</span>
              {r.route}
            </td>
            <td className={cn('py-1.5 pr-3 text-right', statusTone(r.statusCode, r.durationMs, slowMs))}>
              {r.statusCode === 0 ? 'no response' : r.statusCode === 499 ? 'abandoned' : (r.statusCode ?? '—')}
            </td>
            <td className={cn('py-1.5 pr-3 text-right', r.durationMs >= slowMs && 'text-amber-600 font-semibold')}>
              {ms(r.durationMs)}
            </td>
            <td className="py-1.5 pr-3">{r.userEmail ?? <span className="text-muted-foreground">anonymous</span>}</td>
            <td className="py-1.5 pr-3 font-mono text-muted-foreground">{r.replica ?? ''}</td>
            <td className="py-1.5 font-mono text-muted-foreground">{r.page ?? ''}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
