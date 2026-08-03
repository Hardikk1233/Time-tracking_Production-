import React, { useState } from 'react';
import { 
  useGetDashboardSummary, 
  useGetClientHours, 
  useGetTeamUtilization, 
  useGetRecentActivity,
  useGetPendingApprovals
} from '@workspace/api-client-react';
import { useAuth } from '@/lib/auth';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, ResponsiveContainer, Legend } from 'recharts';
import { Clock, Briefcase, AlertCircle, Activity, User, CheckCircle2, XCircle } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { format, startOfMonth, endOfMonth, subMonths } from 'date-fns';
import { Link } from 'wouter';
import { Badge } from '@/components/ui/badge';

type DateRange = 'this_month' | 'last_month' | 'this_year' | 'all_time';

export default function Dashboard() {
  const { user } = useAuth();
  const [range, setRange] = useState<DateRange>('this_month');

  // Compute dates based on range
  const getDates = () => {
    const today = new Date();
    switch (range) {
      case 'this_month':
        return { startDate: format(startOfMonth(today), 'yyyy-MM-dd'), endDate: format(endOfMonth(today), 'yyyy-MM-dd') };
      case 'last_month':
        const lastMonth = subMonths(today, 1);
        return { startDate: format(startOfMonth(lastMonth), 'yyyy-MM-dd'), endDate: format(endOfMonth(lastMonth), 'yyyy-MM-dd') };
      case 'this_year':
        return { startDate: format(new Date(today.getFullYear(), 0, 1), 'yyyy-MM-dd'), endDate: format(new Date(today.getFullYear(), 11, 31), 'yyyy-MM-dd') };
      case 'all_time':
      default:
        return { startDate: undefined, endDate: undefined };
    }
  };

  const { startDate, endDate } = getDates();
  const queryParams = { query: { queryKey: [startDate, endDate] } };

  const { data: summary, isLoading: isLoadingSummary } = useGetDashboardSummary({ startDate, endDate }, queryParams);
  const { data: clientHours, isLoading: isLoadingClients } = useGetClientHours({ startDate, endDate }, queryParams);
  const { data: teamUtil, isLoading: isLoadingTeam } = useGetTeamUtilization({ startDate, endDate }, queryParams);
  const { data: activity, isLoading: isLoadingActivity } = useGetRecentActivity({ limit: 5 });
  const { data: pendingApprovals, isLoading: isLoadingPending } = useGetPendingApprovals();

  const isManager = user?.role === 'avp' || user?.role === 'md';
  const canApprove = ['associate', 'avp', 'md'].includes(user?.role || '');

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">Command Center</h1>
          <p className="text-muted-foreground font-mono text-sm mt-1">
            {format(new Date(), 'EEEE, MMMM do, yyyy')} // SYSTEM STATUS: ACTIVE
          </p>
        </div>
        
        <div className="flex items-center gap-3">
          {canApprove && !isLoadingPending && pendingApprovals && pendingApprovals.length > 0 && (
            <Link href="/approvals">
              <Button variant="outline" className="border-amber-500/50 bg-amber-500/10 text-amber-600 hover:bg-amber-500/20 shadow-sm" data-testid="link-pending-approvals">
                <AlertCircle className="w-4 h-4 mr-2" />
                {pendingApprovals.length} Pending Approvals
              </Button>
            </Link>
          )}
          
          <Select value={range} onValueChange={(val: DateRange) => setRange(val)}>
            <SelectTrigger className="w-[180px] bg-card border-border shadow-sm font-mono text-xs">
              <SelectValue placeholder="Select range" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="this_month">This Month</SelectItem>
              <SelectItem value="last_month">Last Month</SelectItem>
              <SelectItem value="this_year">This Year</SelectItem>
              <SelectItem value="all_time">All Time</SelectItem>
            </SelectContent>
          </Select>
          
          <Link href="/time-entries">
            <Button className="shadow-md font-semibold tracking-tight" data-testid="button-log-time">
              Log Time
            </Button>
          </Link>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <SummaryCard 
          title="Total Hours" 
          value={summary?.totalHours} 
          icon={Clock} 
          loading={isLoadingSummary} 
          subtext="Logged in period"
        />
        <SummaryCard 
          title="Billable Hours" 
          value={summary?.billableHours} 
          icon={Briefcase} 
          loading={isLoadingSummary} 
          subtext={`${summary?.totalHours ? Math.round((summary.billableHours / summary.totalHours) * 100) : 0}% utilization`}
          highlight
        />
        <SummaryCard 
          title="Non-Billable" 
          value={summary?.nonBillableHours} 
          icon={Activity} 
          loading={isLoadingSummary} 
          subtext="Internal / Admin"
        />
        <SummaryCard 
          title="Pending Approval" 
          value={summary?.pendingApprovalCount} 
          icon={AlertCircle} 
          loading={isLoadingSummary} 
          subtext="Entries waiting"
          alert={summary && summary.pendingApprovalCount > 0}
          valueType="count"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Main Chart - Client Hours */}
        <Card className="lg:col-span-2 shadow-sm border-border">
          <CardHeader className="border-b border-border/50 bg-muted/20">
            <CardTitle className="text-lg font-bold">Client Hours Distribution</CardTitle>
            <CardDescription className="font-mono text-xs">Billable vs Non-Billable by Client</CardDescription>
          </CardHeader>
          <CardContent className="pt-6">
            {isLoadingClients ? (
              <Skeleton className="h-[300px] w-full" />
            ) : clientHours && clientHours.length > 0 ? (
              <div className="h-[300px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={clientHours} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                    <XAxis 
                      dataKey="clientName" 
                      tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 12, fontFamily: 'var(--font-mono)' }} 
                      axisLine={false}
                      tickLine={false}
                    />
                    <YAxis 
                      tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 12, fontFamily: 'var(--font-mono)' }} 
                      axisLine={false}
                      tickLine={false}
                    />
                    <RechartsTooltip 
                      cursor={{ fill: 'hsl(var(--muted))' }}
                      contentStyle={{ backgroundColor: 'hsl(var(--card))', borderColor: 'hsl(var(--border))', borderRadius: '0.5rem', fontFamily: 'var(--font-mono)', fontSize: '12px' }}
                    />
                    <Legend iconType="circle" wrapperStyle={{ fontFamily: 'var(--font-mono)', fontSize: '12px' }} />
                    <Bar dataKey="billableHours" name="Billable" stackId="a" fill="hsl(var(--primary))" radius={[0, 0, 4, 4]} />
                    <Bar dataKey="nonBillableHours" name="Non-Billable" stackId="a" fill="hsl(var(--chart-2))" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <div className="h-[300px] w-full flex items-center justify-center text-muted-foreground font-mono text-sm border border-dashed border-border rounded-md">
                NO DATA AVAILABLE
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
                      <p className="text-muted-foreground text-xs truncate mt-0.5">
                        {entry.clientName} / {entry.projectName}
                      </p>
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
              <div className="h-full flex items-center justify-center text-muted-foreground font-mono text-sm">
                NO ACTIVITY
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Team Utilization */}
      {isManager && (
        <Card className="shadow-sm border-border">
          <CardHeader className="border-b border-border/50 bg-muted/20 flex flex-row items-center justify-between">
            <div>
              <CardTitle className="text-lg font-bold">Team Utilization</CardTitle>
              <CardDescription className="font-mono text-xs mt-1">Resource allocation overview</CardDescription>
            </div>
            <User className="w-5 h-5 text-muted-foreground" />
          </CardHeader>
          <CardContent className="p-0">
            {isLoadingTeam ? (
              <div className="p-6">
                <Skeleton className="h-48 w-full" />
              </div>
            ) : teamUtil && teamUtil.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-xs uppercase tracking-wider font-mono text-muted-foreground bg-muted/30">
                      <th className="px-6 py-4 font-medium">Team Member</th>
                      <th className="px-6 py-4 font-medium">Role</th>
                      <th className="px-6 py-4 font-medium text-right">Total Hours</th>
                      <th className="px-6 py-4 font-medium text-right">Billable</th>
                      <th className="px-6 py-4 font-medium text-right">Utilization</th>
                    </tr>
                  </thead>
                  <tbody>
                    {teamUtil.map((member) => {
                      const utilPercent = member.totalHours > 0 
                        ? Math.round((member.billableHours / member.totalHours) * 100) 
                        : 0;
                      
                      return (
                        <tr key={member.userId} className="border-b border-border/50 last:border-0 hover:bg-muted/20 transition-colors">
                          <td className="px-6 py-3 font-medium text-foreground">{member.userName}</td>
                          <td className="px-6 py-3 text-muted-foreground capitalize text-xs">
                            <Badge variant="outline" className="font-mono font-normal">{member.role}</Badge>
                          </td>
                          <td className="px-6 py-3 text-right font-mono">{member.totalHours.toFixed(1)}h</td>
                          <td className="px-6 py-3 text-right font-mono text-primary">{member.billableHours.toFixed(1)}h</td>
                          <td className="px-6 py-3">
                            <div className="flex items-center justify-end gap-2">
                              <span className="font-mono text-xs w-10 text-right">{utilPercent}%</span>
                              <div className="w-16 h-2 bg-muted rounded-full overflow-hidden">
                                <div 
                                  className="h-full bg-primary rounded-full" 
                                  style={{ width: `${Math.min(100, utilPercent)}%` }}
                                />
                              </div>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="p-8 text-center text-muted-foreground font-mono text-sm">
                NO TEAM DATA AVAILABLE
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function SummaryCard({ 
  title, 
  value, 
  icon: Icon, 
  loading, 
  subtext,
  highlight = false,
  alert = false,
  valueType = 'hours'
}: { 
  title: string; 
  value?: number; 
  icon: any; 
  loading: boolean;
  subtext?: string;
  highlight?: boolean;
  alert?: boolean;
  valueType?: 'hours' | 'count';
}) {
  return (
    <Card className={`shadow-sm border-border ${highlight ? 'bg-primary text-primary-foreground border-primary' : ''} ${alert ? 'border-amber-500/50 bg-amber-500/5' : ''}`}>
      <CardContent className="p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className={`text-sm font-bold tracking-tight ${highlight ? 'text-primary-foreground/90' : 'text-muted-foreground'} ${alert ? 'text-amber-600' : ''}`}>
            {title}
          </h3>
          <div className={`p-2 rounded-md ${highlight ? 'bg-primary-foreground/20' : 'bg-muted'} ${alert ? 'bg-amber-500/20 text-amber-600' : ''}`}>
            <Icon className="w-4 h-4" />
          </div>
        </div>
        
        {loading ? (
          <Skeleton className={`h-8 w-24 mb-2 ${highlight ? 'bg-primary-foreground/20' : ''}`} />
        ) : (
          <div className="flex items-baseline gap-1">
            <span className={`text-3xl font-bold font-mono tracking-tighter ${alert ? 'text-amber-600' : ''}`}>
              {value || 0}
            </span>
            <span className={`text-sm font-medium ${highlight ? 'text-primary-foreground/70' : 'text-muted-foreground'} ${alert ? 'text-amber-600/70' : ''}`}>
              {valueType === 'hours' ? 'h' : ''}
            </span>
          </div>
        )}
        
        {subtext && (
          <p className={`text-xs mt-2 font-mono ${highlight ? 'text-primary-foreground/70' : 'text-muted-foreground'} ${alert ? 'text-amber-600/70' : ''}`}>
            {subtext}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
