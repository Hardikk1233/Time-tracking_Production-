import React from 'react';
import { useAuth } from '@/lib/auth';
import { 
  useGetPendingApprovals, 
  useApproveTimeEntry, 
  useRejectTimeEntry,
  getGetPendingApprovalsQueryKey
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import { useToast } from '@/hooks/use-toast';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Check, X, AlertCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

export default function Approvals() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  
  const { data: entries, isLoading } = useGetPendingApprovals();
  const approveMutation = useApproveTimeEntry();
  const rejectMutation = useRejectTimeEntry();

  const handleApprove = (id: number) => {
    approveMutation.mutate({ timeEntryId: id }, {
      onSuccess: () => {
        toast({ title: 'Entry approved' });
        queryClient.invalidateQueries({ queryKey: getGetPendingApprovalsQueryKey() });
      }
    });
  };

  const handleReject = (id: number) => {
    rejectMutation.mutate({ timeEntryId: id }, {
      onSuccess: () => {
        toast({ title: 'Entry rejected' });
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

  // Filter out the user's own entries from the pending approvals queue just to be safe
  const pendingEntries = entries?.filter(e => e.userId !== user?.id) || [];

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
                    <td className="px-6 py-4"><Skeleton className="h-8 w-24 ml-auto" /></td>
                  </tr>
                ))
              ) : pendingEntries.length > 0 ? (
                pendingEntries.map((entry) => (
                  <tr key={entry.id} className="hover:bg-muted/10 transition-colors">
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
                    <td className="px-6 py-4 font-mono text-xs text-muted-foreground whitespace-nowrap">
                      {format(new Date(entry.date), 'MMM dd, yyyy')}
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex flex-col gap-0.5">
                        <span className="font-medium text-foreground text-sm">{entry.clientName}</span>
                        <span className="text-xs text-muted-foreground">{entry.projectName} — {entry.taskName}</span>
                        {entry.description && (
                          <span className="text-xs text-muted-foreground italic truncate max-w-[300px] mt-1 text-primary/70">"{entry.description}"</span>
                        )}
                      </div>
                    </td>
                    <td className="px-6 py-4 text-right">
                      <div className="flex flex-col items-end gap-1">
                        <span className="font-mono font-bold text-base">{entry.hours.toFixed(2)}h</span>
                        {entry.billable ? (
                          <Badge variant="outline" className="text-[9px] px-1 border-primary/30 text-primary uppercase font-mono shadow-none">Billable</Badge>
                        ) : (
                          <Badge variant="outline" className="text-[9px] px-1 border-muted text-muted-foreground uppercase font-mono shadow-none">Non-Bill</Badge>
                        )}
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex items-center justify-end gap-2">
                        <Button 
                          size="sm" 
                          className="bg-emerald-600 hover:bg-emerald-700 text-white shadow-sm font-semibold"
                          onClick={() => handleApprove(entry.id)}
                          disabled={approveMutation.isPending || rejectMutation.isPending}
                        >
                          <Check className="w-4 h-4 mr-1" />
                          Approve
                        </Button>
                        <Button 
                          variant="outline"
                          size="sm" 
                          className="text-destructive border-destructive/30 hover:bg-destructive/10 font-semibold"
                          onClick={() => handleReject(entry.id)}
                          disabled={approveMutation.isPending || rejectMutation.isPending}
                        >
                          <X className="w-4 h-4 mr-1" />
                          Reject
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))
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
