import React, { useState } from 'react';
import { useAuth } from '@/lib/auth';
import { 
  useListTimeEntries, 
  useCreateTimeEntry, 
  useApproveTimeEntry, 
  useRejectTimeEntry,
  useListTasks,
  getListTimeEntriesQueryKey,
  TimeEntry
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { useToast } from '@/hooks/use-toast';

import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Plus, Check, X, Filter } from 'lucide-react';

const timeEntrySchema = z.object({
  taskId: z.coerce.number().min(1, 'Task is required'),
  hours: z.coerce.number().min(0.25, 'Min 0.25h').max(24, 'Max 24h'),
  date: z.string().min(1, 'Date is required'),
  description: z.string().optional(),
  billable: z.boolean().default(true),
});

export default function TimeEntries() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [isDialogOpen, setIsDialogOpen] = useState(false);

  const queryParams = { 
    ...(statusFilter !== 'all' ? { status: statusFilter as any } : {}) 
  };
  
  const { data: entries, isLoading } = useListTimeEntries(queryParams);
  const approveMutation = useApproveTimeEntry();
  const rejectMutation = useRejectTimeEntry();

  const handleApprove = (id: number) => {
    approveMutation.mutate({ timeEntryId: id }, {
      onSuccess: () => {
        toast({ title: 'Entry approved' });
        queryClient.invalidateQueries({ queryKey: getListTimeEntriesQueryKey() });
      }
    });
  };

  const handleReject = (id: number) => {
    rejectMutation.mutate({ timeEntryId: id }, {
      onSuccess: () => {
        toast({ title: 'Entry rejected' });
        queryClient.invalidateQueries({ queryKey: getListTimeEntriesQueryKey() });
      }
    });
  };

  const isAssociateOrAbove = ['associate', 'avp', 'md'].includes(user?.role || '');

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">Time Entries</h1>
          <p className="text-muted-foreground font-mono text-sm mt-1">Activity logs and billing records</p>
        </div>
        
        <div className="flex items-center gap-3">
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-[140px] bg-card">
              <Filter className="w-4 h-4 mr-2 text-muted-foreground" />
              <SelectValue placeholder="Filter Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Statuses</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="approved">Approved</SelectItem>
              <SelectItem value="rejected">Rejected</SelectItem>
            </SelectContent>
          </Select>

          <LogTimeDialog open={isDialogOpen} onOpenChange={setIsDialogOpen} userRole={user?.role} />
        </div>
      </div>

      <Card className="shadow-sm border-border overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/30 text-left text-xs uppercase tracking-wider font-mono text-muted-foreground">
                <th className="px-6 py-4 font-medium">Date</th>
                <th className="px-6 py-4 font-medium">User</th>
                <th className="px-6 py-4 font-medium">Client / Project / Task</th>
                <th className="px-6 py-4 font-medium text-right">Hours</th>
                <th className="px-6 py-4 font-medium text-center">Status</th>
                <th className="px-6 py-4 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/50">
              {isLoading ? (
                Array(5).fill(0).map((_, i) => (
                  <tr key={i}>
                    <td className="px-6 py-4"><Skeleton className="h-4 w-24" /></td>
                    <td className="px-6 py-4"><Skeleton className="h-4 w-32" /></td>
                    <td className="px-6 py-4"><Skeleton className="h-4 w-48" /></td>
                    <td className="px-6 py-4"><Skeleton className="h-4 w-12 ml-auto" /></td>
                    <td className="px-6 py-4"><Skeleton className="h-5 w-20 mx-auto rounded-full" /></td>
                    <td className="px-6 py-4"><Skeleton className="h-8 w-16 ml-auto" /></td>
                  </tr>
                ))
              ) : entries && entries.length > 0 ? (
                entries.map((entry: TimeEntry) => (
                  <tr key={entry.id} className="hover:bg-muted/10 transition-colors">
                    <td className="px-6 py-4 font-mono text-xs text-muted-foreground whitespace-nowrap">
                      {format(new Date(entry.date), 'MMM dd, yyyy')}
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex flex-col">
                        <span className="font-medium text-foreground">{entry.userName}</span>
                        <span className="text-xs text-muted-foreground capitalize">{entry.userRole}</span>
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex flex-col gap-0.5">
                        <span className="font-medium text-foreground text-sm">{entry.clientName}</span>
                        <span className="text-xs text-muted-foreground">{entry.projectName} — {entry.taskName}</span>
                        {entry.description && (
                          <span className="text-xs text-muted-foreground italic truncate max-w-[300px] mt-1">"{entry.description}"</span>
                        )}
                      </div>
                    </td>
                    <td className="px-6 py-4 text-right">
                      <div className="flex flex-col items-end gap-1">
                        <span className="font-mono font-bold">{entry.hours.toFixed(2)}h</span>
                        {entry.billable ? (
                          <Badge variant="outline" className="text-[10px] px-1 border-primary/30 text-primary uppercase font-mono">Billable</Badge>
                        ) : (
                          <Badge variant="outline" className="text-[10px] px-1 border-muted text-muted-foreground uppercase font-mono">Non-Bill</Badge>
                        )}
                      </div>
                    </td>
                    <td className="px-6 py-4 text-center">
                      <StatusBadge status={entry.status} />
                    </td>
                    <td className="px-6 py-4 text-right">
                      {entry.status === 'pending' && isAssociateOrAbove && entry.userId !== user?.id && (
                        <div className="flex items-center justify-end gap-2">
                          <Button 
                            variant="ghost" 
                            size="icon" 
                            className="h-8 w-8 text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50 rounded-full"
                            onClick={() => handleApprove(entry.id)}
                            disabled={approveMutation.isPending || rejectMutation.isPending}
                          >
                            <Check className="w-4 h-4" />
                          </Button>
                          <Button 
                            variant="ghost" 
                            size="icon" 
                            className="h-8 w-8 text-destructive hover:text-destructive hover:bg-destructive/10 rounded-full"
                            onClick={() => handleReject(entry.id)}
                            disabled={approveMutation.isPending || rejectMutation.isPending}
                          >
                            <X className="w-4 h-4" />
                          </Button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={6} className="px-6 py-12 text-center text-muted-foreground font-mono text-sm">
                    NO ENTRIES FOUND
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

function StatusBadge({ status }: { status: string }) {
  switch (status) {
    case 'approved':
      return <Badge className="bg-emerald-500/10 text-emerald-600 hover:bg-emerald-500/20 border-emerald-500/20 shadow-none font-mono text-[10px] uppercase tracking-wider">Approved</Badge>;
    case 'rejected':
      return <Badge variant="destructive" className="bg-destructive/10 text-destructive hover:bg-destructive/20 border-destructive/20 shadow-none font-mono text-[10px] uppercase tracking-wider">Rejected</Badge>;
    case 'pending':
    default:
      return <Badge variant="secondary" className="bg-amber-500/10 text-amber-600 hover:bg-amber-500/20 border-amber-500/20 shadow-none font-mono text-[10px] uppercase tracking-wider">Pending</Badge>;
  }
}

function LogTimeDialog({ open, onOpenChange, userRole }: { open: boolean, onOpenChange: (open: boolean) => void, userRole?: string }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const createMutation = useCreateTimeEntry();
  const { data: tasks, isLoading: isLoadingTasks } = useListTasks();
  
  const isAnalyst = userRole === 'analyst';

  const form = useForm<z.infer<typeof timeEntrySchema>>({
    resolver: zodResolver(timeEntrySchema),
    defaultValues: {
      taskId: undefined,
      hours: 1,
      date: format(new Date(), 'yyyy-MM-dd'),
      description: '',
      billable: true,
    },
  });

  const onSubmit = (data: z.infer<typeof timeEntrySchema>) => {
    // Analysts cannot set billable flag, ensure it's removed or kept default (handled by API ideally, but we'll submit what form has)
    createMutation.mutate({ data }, {
      onSuccess: () => {
        toast({ title: 'Time entry logged successfully' });
        queryClient.invalidateQueries({ queryKey: getListTimeEntriesQueryKey() });
        form.reset({
          taskId: undefined,
          hours: 1,
          date: format(new Date(), 'yyyy-MM-dd'),
          description: '',
          billable: true,
        });
        onOpenChange(false);
      },
      onError: (err: any) => {
        toast({
          variant: 'destructive',
          title: 'Failed to log time',
          description: err.error || 'An error occurred.',
        });
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button className="shadow-md font-semibold tracking-tight" data-testid="button-log-time">
          <Plus className="w-4 h-4 mr-2" />
          Log Time
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Log Time Entry</DialogTitle>
          <DialogDescription>Record your hours for a specific task.</DialogDescription>
        </DialogHeader>
        
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 pt-4">
            <FormField
              control={form.control}
              name="taskId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Task</FormLabel>
                  <Select onValueChange={(val) => field.onChange(Number(val))} value={field.value?.toString()}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Select a task" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {isLoadingTasks ? (
                        <div className="p-2 text-sm text-muted-foreground">Loading tasks...</div>
                      ) : tasks?.map(task => (
                        <SelectItem key={task.id} value={task.id.toString()}>
                          {task.clientName} / {task.projectName} / {task.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="date"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Date</FormLabel>
                    <FormControl>
                      <Input type="date" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="hours"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Hours</FormLabel>
                    <FormControl>
                      <Input type="number" step="0.25" min="0.25" max="24" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Description (Optional)</FormLabel>
                  <FormControl>
                    <Input placeholder="What did you work on?" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {!isAnalyst && (
              <FormField
                control={form.control}
                name="billable"
                render={({ field }) => (
                  <FormItem className="flex flex-row items-start space-x-3 space-y-0 rounded-md border p-4 shadow-sm">
                    <FormControl>
                      <Checkbox
                        checked={field.value}
                        onCheckedChange={field.onChange}
                      />
                    </FormControl>
                    <div className="space-y-1 leading-none">
                      <FormLabel>Billable Hours</FormLabel>
                      <p className="text-xs text-muted-foreground">
                        This time will be billed to the client.
                      </p>
                    </div>
                  </FormItem>
                )}
              />
            )}

            <div className="pt-4 flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button type="submit" disabled={createMutation.isPending}>
                {createMutation.isPending ? 'Logging...' : 'Log Time'}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
