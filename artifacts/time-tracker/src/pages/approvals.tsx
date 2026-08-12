import React, { useState } from 'react';
import { useAuth } from '@/lib/auth';
import { 
  useGetPendingApprovals, 
  useApproveTimeEntry, 
  useRejectTimeEntry,
  useSplitTimeEntry,
  getGetPendingApprovalsQueryKey
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import { useToast } from '@/hooks/use-toast';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Check, X, AlertCircle, Scissors } from 'lucide-react';

export default function Approvals() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: entries, isLoading } = useGetPendingApprovals();
  const approveMutation = useApproveTimeEntry();
  const rejectMutation = useRejectTimeEntry();
  const splitMutation = useSplitTimeEntry();

  // entryId → billable hours string being edited
  const [splitState, setSplitState] = useState<Record<number, string>>({});

  const handleApprove = (id: number) => {
    approveMutation.mutate({ entryId: id }, {
      onSuccess: () => {
        toast({ title: 'Entry approved' });
        queryClient.invalidateQueries({ queryKey: getGetPendingApprovalsQueryKey() });
      }
    });
  };

  const handleReject = (id: number) => {
    rejectMutation.mutate({ entryId: id }, {
      onSuccess: () => {
        toast({ title: 'Entry rejected' });
        queryClient.invalidateQueries({ queryKey: getGetPendingApprovalsQueryKey() });
      }
    });
  };

  const handleSplit = (entryId: number, totalHours: number) => {
    const raw = splitState[entryId];
    const billable = parseFloat(raw ?? '');
    if (isNaN(billable) || billable < 0 || billable > totalHours) {
      toast({ title: 'Invalid hours', description: `Must be between 0 and ${totalHours}`, variant: 'destructive' });
      return;
    }
    splitMutation.mutate({ entryId, data: { billableHours: billable } }, {
      onSuccess: () => {
        toast({ title: 'Hours split', description: `${billable.toFixed(1)}h billable / ${(totalHours - billable).toFixed(1)}h non-billable` });
        setSplitState(s => { const n = { ...s }; delete n[entryId]; return n; });
        queryClient.invalidateQueries({ queryKey: getGetPendingApprovalsQueryKey() });
      }
    });
  };

  const isAssociateOrAbove = ['associate', 'avp', 'md'].includes(user?.role || '');

  if (!isAssociateOrAbove) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[50vh] text-center">
        <AlertCircle className="w-12 h-12 text-muted-foreground mb-4 opacity-50" />
        <h2 className="text-xl font-bold">Access Denied</h2>
        <p className="text-muted-foreground mt-2 font-mono text-sm">You do not have permission to view approvals.</p>
      </div>
    );
  }

  // Associates and above can approve any pending entry, including their own
  const pendingEntries = entries?.filter(e => e.status === 'pending') || [];

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">Pending Approvals</h1>
          <p className="text-muted-foreground font-mono text-sm mt-1">Review team time submissions</p>
        </div>
        <div className="flex items-center gap-2 bg-amber-500/10 text-amber-600 px-3 py-1.5 rounded-md font-mono text-sm font-bold border border-amber-500/20">
          <AlertCircle className="w-4 h-4 mr-1" />
          {isLoading ? '-' : pendingEntries.length} Pending
        </div>
      </div>

      <Card className="shadow-sm border-border overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/30 text-left text-xs uppercase tracking-wider font-mono text-muted-foreground">
                <th className="px-6 py-4 font-medium">Team Member</th>
                <th className="px-6 py-4 font-medium">Date</th>
                <th className="px-6 py-4 font-medium">Client & Project</th>
                <th className="px-6 py-4 font-medium text-right">Hours</th>
                <th className="px-6 py-4 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/50">
              {isLoading ? (
                Array(5).fill(0).map((_, i) => (
                  <tr key={i}>
                    <td className="px-6 py-4"><Skeleton className="h-4 w-32" /></td>
                    <td className="px-6 py-4"><Skeleton className="h-4 w-24" /></td>
                    <td className="px-6 py-4"><Skeleton className="h-4 w-48" /></td>
                    <td className="px-6 py-4"><Skeleton className="h-4 w-12 ml-auto" /></td>
                    <td className="px-6 py-4"><Skeleton className="h-8 w-32 ml-auto" /></td>
                  </tr>
                ))
              ) : pendingEntries.length > 0 ? (
                pendingEntries.map((entry) => {
                  const isSplitting = splitState[entry.id] !== undefined;
                  const alreadySplit = entry.billableHours !== null && entry.billableHours !== undefined;
                  const busy = approveMutation.isPending || rejectMutation.isPending || splitMutation.isPending;

                  return (
                    <tr key={entry.id} className="hover:bg-muted/10 transition-colors">
                      {/* Team member */}
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-3">
                          <div className="w-8 h-8 rounded-full bg-primary/10 text-primary flex items-center justify-center font-bold text-xs shrink-0">
                            {entry.userName.substring(0, 2).toUpperCase()}
                          </div>
                          <div className="flex flex-col">
                            <span className="font-medium text-foreground">{entry.userName}</span>
                            <span className="text-[10px] uppercase font-mono text-muted-foreground tracking-wider">{entry.userRole}</span>
                          </div>
                        </div>
                      </td>

                      {/* Date */}
                      <td className="px-6 py-4 font-mono text-xs text-muted-foreground whitespace-nowrap">
                        {format(new Date(entry.date), 'MMM dd, yyyy')}
                      </td>

                      {/* Client / project */}
                      <td className="px-6 py-4">
                        <div className="flex flex-col gap-0.5">
                          <span className="font-medium text-foreground text-sm">{entry.clientName}</span>
                          <span className="text-xs text-muted-foreground">{entry.projectName} — {entry.taskName}</span>
                          {entry.description && (
                            <span className="text-xs text-muted-foreground italic truncate max-w-[300px] mt-1 text-primary/70">"{entry.description}"</span>
                          )}
                        </div>
                      </td>

                      {/* Hours */}
                      <td className="px-6 py-4 text-right">
                        <div className="flex flex-col items-end gap-1">
                          <span className="font-mono font-bold text-base">{entry.hours.toFixed(2)}h</span>
                          {alreadySplit ? (
                            <span className="text-[9px] font-mono text-primary">
                              {(entry.billableHours as number).toFixed(1)}h bill / {(entry.hours - (entry.billableHours as number)).toFixed(1)}h non-bill
                            </span>
                          ) : (
                            <span className="text-[9px] font-mono text-muted-foreground/60 italic">not split</span>
                          )}
                        </div>
                      </td>

                      {/* Actions */}
                      <td className="px-6 py-4">
                        <div className="flex flex-col items-end gap-2">
                          {/* Split row — inline when active */}
                          {isSplitting ? (
                            <div className="flex items-center gap-1.5">
                              <div className="relative">
                                <Input
                                  type="number"
                                  min={0}
                                  max={entry.hours}
                                  step={0.5}
                                  placeholder={`0–${entry.hours}`}
                                  value={splitState[entry.id]}
                                  onChange={e => setSplitState(s => ({ ...s, [entry.id]: e.target.value }))}
                                  className="h-7 w-24 text-xs font-mono pr-6"
                                  autoFocus
                                />
                                <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[9px] font-mono text-muted-foreground">h</span>
                              </div>
                              <Button
                                size="sm"
                                className="h-7 px-2 text-xs bg-primary hover:bg-primary/90 font-semibold"
                                onClick={() => handleSplit(entry.id, entry.hours)}
                                disabled={busy}
                              >
                                Save
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-7 px-2 text-xs"
                                onClick={() => setSplitState(s => { const n = { ...s }; delete n[entry.id]; return n; })}
                                disabled={busy}
                              >
                                <X className="w-3 h-3" />
                              </Button>
                            </div>
                          ) : (
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 px-2.5 text-xs border-primary/30 text-primary hover:bg-primary/10 font-semibold"
                              onClick={() => setSplitState(s => ({ ...s, [entry.id]: alreadySplit ? String(entry.billableHours) : '' }))}
                              disabled={busy}
                            >
                              <Scissors className="w-3 h-3 mr-1" />
                              {alreadySplit ? 'Re-split' : 'Split'}
                            </Button>
                          )}

                          {/* Approve / Reject */}
                          <div className="flex items-center gap-1.5">
                            <Button
                              size="sm"
                              className="h-7 bg-emerald-600 hover:bg-emerald-700 text-white shadow-sm font-semibold"
                              onClick={() => handleApprove(entry.id)}
                              disabled={busy}
                            >
                              <Check className="w-3 h-3 mr-1" />
                              Approve
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-7 text-destructive border-destructive/30 hover:bg-destructive/10 font-semibold"
                              onClick={() => handleReject(entry.id)}
                              disabled={busy}
                            >
                              <X className="w-3 h-3 mr-1" />
                              Reject
                            </Button>
                          </div>
                        </div>
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td colSpan={5} className="px-6 py-16 text-center">
                    <div className="flex flex-col items-center justify-center">
                      <Check className="w-12 h-12 text-emerald-500/50 mb-4" />
                      <p className="text-muted-foreground font-mono text-sm font-bold">ALL CAUGHT UP</p>
                      <p className="text-muted-foreground text-xs mt-1">No pending approvals require your attention.</p>
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
