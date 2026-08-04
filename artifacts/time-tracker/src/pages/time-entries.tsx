import React, { useState } from 'react';
import { useAuth } from '@/lib/auth';
import {
  useListTimeEntries,
  useCreateTimeEntry,
  useApproveTimeEntry,
  useRejectTimeEntry,
  useSplitTimeEntry,
  useListClients,
  useListProjects,
  useListTasks,
  useLogLeavesBulk,
  useListLeaves,
  useDeleteLeave,
  getListTimeEntriesQueryKey,
  getListLeavesQueryKey,
} from '@workspace/api-client-react';
import type { TimeEntry } from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { useToast } from '@/hooks/use-toast';

import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Calendar } from '@/components/ui/calendar';
import { Plus, Check, X, Filter, Scissors, CalendarOff, Trash2 } from 'lucide-react';

// ─── Schemas ─────────────────────────────────────────────────────────────────

const timeEntrySchema = z.object({
  clientId: z.coerce.number().min(1, 'Client is required'),
  projectId: z.coerce.number().min(1, 'Project is required'),
  taskId: z.coerce.number().min(1, 'Task is required'),
  hours: z.coerce.number().min(0.25, 'Min 0.25h').max(24, 'Max 24h'),
  date: z.string().min(1, 'Date is required'),
  description: z.string().optional(),
});
type TimeEntryForm = z.infer<typeof timeEntrySchema>;

const splitSchema = z.object({
  billableHours: z.coerce.number().min(0, 'Must be ≥ 0'),
});

const leaveSchema = z.object({
  date: z.string().min(1, 'Date is required'),
  note: z.string().optional(),
});
type LeaveForm = z.infer<typeof leaveSchema>;

// ─── Main page ────────────────────────────────────────────────────────────────

export default function TimeEntries() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [isLeaveDialogOpen, setIsLeaveDialogOpen] = useState(false);
  const [splitEntry, setSplitEntry] = useState<TimeEntry | null>(null);

  const queryParams = statusFilter !== 'all' ? { status: statusFilter as 'pending' | 'approved' | 'rejected' } : {};
  const { data: entries, isLoading } = useListTimeEntries(queryParams);

  const approveMutation = useApproveTimeEntry();
  const rejectMutation = useRejectTimeEntry();

  const isAssociateOrAbove = ['associate', 'avp', 'md'].includes(user?.role ?? '');

  const handleApprove = (id: number) => {
    approveMutation.mutate({ entryId: id }, {
      onSuccess: () => {
        toast({ title: 'Entry approved' });
        queryClient.invalidateQueries({ queryKey: getListTimeEntriesQueryKey() });
      },
    });
  };

  const handleReject = (id: number) => {
    rejectMutation.mutate({ entryId: id }, {
      onSuccess: () => {
        toast({ title: 'Entry rejected' });
        queryClient.invalidateQueries({ queryKey: getListTimeEntriesQueryKey() });
      },
    });
  };

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">Time Entries</h1>
          <p className="text-muted-foreground font-mono text-sm mt-1">Activity logs and billing records</p>
        </div>
        <div className="flex items-center gap-3">
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-[140px] bg-card">
              <Filter className="w-4 h-4 mr-2 text-muted-foreground" />
              <SelectValue placeholder="Filter" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Statuses</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="approved">Approved</SelectItem>
              <SelectItem value="rejected">Rejected</SelectItem>
            </SelectContent>
          </Select>

          <LogLeaveDialog open={isLeaveDialogOpen} onOpenChange={setIsLeaveDialogOpen} />
          <LogTimeDialog open={isDialogOpen} onOpenChange={setIsDialogOpen} />
        </div>
      </div>

      {/* Table */}
      <Card className="shadow-sm border-border overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/30 text-left text-xs uppercase tracking-wider font-mono text-muted-foreground">
                <th className="px-6 py-4 font-medium">Date</th>
                <th className="px-6 py-4 font-medium">User</th>
                <th className="px-6 py-4 font-medium">Client / Project / Task</th>
                <th className="px-6 py-4 font-medium text-right">Hours</th>
                <th className="px-6 py-4 font-medium text-center">Billable Split</th>
                <th className="px-6 py-4 font-medium text-center">Status</th>
                <th className="px-6 py-4 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/50">
              {isLoading ? (
                Array(5).fill(0).map((_, i) => (
                  <tr key={i}>
                    {Array(7).fill(0).map((__, j) => (
                      <td key={j} className="px-6 py-4"><Skeleton className="h-4 w-full" /></td>
                    ))}
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
                        <span className="font-medium">{entry.userName}</span>
                        <span className="text-xs text-muted-foreground capitalize">{entry.userRole}</span>
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex flex-col gap-0.5">
                        <span className="font-medium text-sm">{entry.clientName}</span>
                        <span className="text-xs text-muted-foreground">{entry.projectName} — {entry.taskName}</span>
                        {entry.description && (
                          <span className="text-xs text-muted-foreground/60 italic truncate max-w-[280px] mt-0.5">"{entry.description}"</span>
                        )}
                      </div>
                    </td>
                    <td className="px-6 py-4 text-right font-mono font-bold">{entry.hours.toFixed(2)}h</td>
                    <td className="px-6 py-4 text-center">
                      <BillableSplitDisplay entry={entry} />
                    </td>
                    <td className="px-6 py-4 text-center">
                      <StatusBadge status={entry.status} />
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex items-center justify-end gap-1">
                        {isAssociateOrAbove && (
                          <Button
                            variant="ghost" size="icon"
                            className="h-8 w-8 text-blue-500 hover:text-blue-600 hover:bg-blue-50 rounded-full"
                            title="Split billable/non-billable"
                            onClick={() => setSplitEntry(entry)}
                          >
                            <Scissors className="w-4 h-4" />
                          </Button>
                        )}
                        {entry.status === 'pending' && isAssociateOrAbove && entry.userId !== user?.id && (
                          <>
                            <Button variant="ghost" size="icon"
                              className="h-8 w-8 text-emerald-600 hover:bg-emerald-50 rounded-full"
                              onClick={() => handleApprove(entry.id)}
                              disabled={approveMutation.isPending || rejectMutation.isPending}
                            ><Check className="w-4 h-4" /></Button>
                            <Button variant="ghost" size="icon"
                              className="h-8 w-8 text-destructive hover:bg-destructive/10 rounded-full"
                              onClick={() => handleReject(entry.id)}
                              disabled={approveMutation.isPending || rejectMutation.isPending}
                            ><X className="w-4 h-4" /></Button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={7} className="px-6 py-12 text-center text-muted-foreground font-mono text-sm">
                    NO ENTRIES FOUND
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Split dialog */}
      {splitEntry && (
        <SplitHoursDialog
          entry={splitEntry}
          open={!!splitEntry}
          onOpenChange={(open) => { if (!open) setSplitEntry(null); }}
        />
      )}
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function BillableSplitDisplay({ entry }: { entry: TimeEntry }) {
  if (entry.billableHours === null || entry.billableHours === undefined) {
    return <span className="text-xs font-mono text-muted-foreground/50 italic">Not split</span>;
  }
  const nonBillable = entry.hours - entry.billableHours;
  return (
    <div className="flex flex-col items-center gap-0.5">
      <span className="text-xs font-mono font-bold text-primary">{entry.billableHours.toFixed(2)}h B</span>
      <span className="text-xs font-mono text-muted-foreground">{nonBillable.toFixed(2)}h NB</span>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    approved: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20',
    rejected: 'bg-destructive/10 text-destructive border-destructive/20',
    pending: 'bg-amber-500/10 text-amber-600 border-amber-500/20',
  };
  return (
    <Badge className={`${styles[status] ?? styles.pending} shadow-none font-mono text-[10px] uppercase tracking-wider hover:opacity-80`}>
      {status}
    </Badge>
  );
}

// ─── Log Leave Dialog (multi-date) ───────────────────────────────────────────

function LogLeaveDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const bulkMutation = useLogLeavesBulk();
  const deleteLeaveMutation = useDeleteLeave();

  const [selectedDates, setSelectedDates] = useState<Date[]>([]);
  const [note, setNote] = useState('');

  // Fetch this month's already-logged leaves so we can show them on the calendar
  const now = new Date();
  const monthStart = format(new Date(now.getFullYear(), now.getMonth(), 1), 'yyyy-MM-dd');
  const monthEnd = format(new Date(now.getFullYear(), now.getMonth() + 1, 0), 'yyyy-MM-dd');

  const { data: myLeaves } = useListLeaves(
    { startDate: monthStart, endDate: monthEnd } as any,
    { query: { enabled: open && !!user?.id } as any }
  );

  // Dates already logged — shown as disabled on the calendar
  const alreadyLoggedDates: Date[] = React.useMemo(() => {
    if (!myLeaves) return [];
    return myLeaves.map((l: any) => {
      const [y, m, d] = l.date.split('-').map(Number);
      return new Date(y, m - 1, d);
    });
  }, [myLeaves]);

  const handleSubmit = () => {
    if (selectedDates.length === 0) return;
    const dates = selectedDates.map(d => format(d, 'yyyy-MM-dd'));
    bulkMutation.mutate(
      { data: { dates, note: note.trim() || undefined } as any },
      {
        onSuccess: (result: any) => {
          const created = result?.created?.length ?? 0;
          const skipped = result?.skipped?.length ?? 0;
          toast({
            title: `${created} day${created !== 1 ? 's' : ''} logged`,
            description: skipped > 0 ? `${skipped} date${skipped !== 1 ? 's' : ''} already had leave and were skipped.` : undefined,
          });
          queryClient.invalidateQueries({ queryKey: getListLeavesQueryKey() });
          setSelectedDates([]);
          setNote('');
        },
        onError: (err: any) => {
          toast({ variant: 'destructive', title: 'Failed to log leave', description: err?.error || 'An error occurred.' });
        },
      }
    );
  };

  const handleDeleteLeave = (id: number) => {
    deleteLeaveMutation.mutate({ id } as any, {
      onSuccess: () => {
        toast({ title: 'Leave removed' });
        queryClient.invalidateQueries({ queryKey: getListLeavesQueryKey() });
      },
    });
  };

  const handleClose = (v: boolean) => {
    if (!v) {
      setSelectedDates([]);
      setNote('');
    }
    onOpenChange(v);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogTrigger asChild>
        <Button variant="outline" className="shadow-sm font-semibold tracking-tight border-amber-500/40 text-amber-600 hover:bg-amber-50 hover:border-amber-500">
          <CalendarOff className="w-4 h-4 mr-2" />
          Log Leave
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[480px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CalendarOff className="w-5 h-5 text-amber-500" />
            Log Leave
          </DialogTitle>
          <DialogDescription>
            Click dates to select them. Already-logged dates are shown in amber and can't be re-selected.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 pt-1">
          {/* Calendar with multi-select */}
          <div className="flex justify-center rounded-lg border border-border bg-muted/20 p-2">
            <Calendar
              mode="multiple"
              selected={selectedDates}
              onSelect={(dates) => setSelectedDates(dates ?? [])}
              disabled={[
                { dayOfWeek: [0, 6] },          // weekends always disabled
                ...alreadyLoggedDates,            // already-logged days disabled
              ]}
              modifiers={{ alreadyLogged: alreadyLoggedDates }}
              modifiersClassNames={{
                alreadyLogged: 'opacity-40 line-through text-amber-600',
              }}
              className="mx-auto"
            />
          </div>

          {/* Selected date chips */}
          {selectedDates.length > 0 && (
            <div>
              <p className="text-xs font-mono uppercase tracking-wider text-muted-foreground mb-2">
                Selected — {selectedDates.length} day{selectedDates.length !== 1 ? 's' : ''}
              </p>
              <div className="flex flex-wrap gap-1.5">
                {[...selectedDates]
                  .sort((a, b) => a.getTime() - b.getTime())
                  .map(d => (
                    <Badge
                      key={d.toISOString()}
                      variant="secondary"
                      className="font-mono text-xs cursor-pointer hover:bg-destructive/10 hover:text-destructive transition-colors"
                      onClick={() => setSelectedDates(prev => prev.filter(x => x.toISOString() !== d.toISOString()))}
                    >
                      {format(d, 'EEE MMM d')} ×
                    </Badge>
                  ))}
              </div>
            </div>
          )}

          {/* Note */}
          <div>
            <label className="text-sm font-medium mb-1.5 block">
              Reason <span className="text-muted-foreground font-normal">(Optional)</span>
            </label>
            <Input
              placeholder="e.g. Sick leave, Personal, Family"
              value={note}
              onChange={e => setNote(e.target.value)}
            />
          </div>

          {/* Actions */}
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="outline" onClick={() => handleClose(false)}>Cancel</Button>
            <Button
              onClick={handleSubmit}
              className="bg-amber-500 hover:bg-amber-600 text-white"
              disabled={selectedDates.length === 0 || bulkMutation.isPending}
            >
              {bulkMutation.isPending
                ? 'Logging...'
                : selectedDates.length === 0
                  ? 'Select dates'
                  : `Log ${selectedDates.length} day${selectedDates.length !== 1 ? 's' : ''}`}
            </Button>
          </div>
        </div>

        {/* Already-logged leaves for this month */}
        {myLeaves && myLeaves.length > 0 && (
          <div className="border-t border-border pt-4 mt-2">
            <p className="text-xs font-mono uppercase tracking-wider text-muted-foreground mb-2">
              Already logged this month
            </p>
            <div className="space-y-1 max-h-32 overflow-y-auto">
              {myLeaves.map((leave: any) => (
                <div key={leave.id} className="flex items-center justify-between gap-2 rounded px-2 py-1.5 bg-muted/40 hover:bg-muted/60">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-sm font-medium font-mono shrink-0">
                      {format(new Date(leave.date + 'T00:00:00'), 'EEE, MMM dd')}
                    </span>
                    {leave.note && (
                      <span className="text-xs text-muted-foreground italic truncate">{leave.note}</span>
                    )}
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 text-muted-foreground hover:text-destructive shrink-0"
                    onClick={() => handleDeleteLeave(leave.id)}
                    disabled={deleteLeaveMutation.isPending}
                  >
                    <Trash2 className="w-3 h-3" />
                  </Button>
                </div>
              ))}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ─── Log Time Dialog (cascading Client → Project → Task) ─────────────────────

function LogTimeDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const createMutation = useCreateTimeEntry();

  const form = useForm<TimeEntryForm>({
    resolver: zodResolver(timeEntrySchema),
    defaultValues: {
      clientId: 0,
      projectId: 0,
      taskId: 0,
      hours: 1,
      date: format(new Date(), 'yyyy-MM-dd'),
      description: '',
    },
  });

  const selectedClientId = form.watch('clientId');
  const selectedProjectId = form.watch('projectId');

  const { data: clients, isLoading: isLoadingClients } = useListClients();
  const { data: projects, isLoading: isLoadingProjects } = useListProjects(
    selectedClientId > 0 ? { clientId: selectedClientId } : undefined,
    { query: { enabled: selectedClientId > 0 } as any }
  );
  const { data: tasks, isLoading: isLoadingTasks } = useListTasks(
    selectedProjectId > 0 ? { projectId: selectedProjectId } : undefined,
    { query: { enabled: selectedProjectId > 0 } as any }
  );

  const handleClientChange = (val: string) => {
    form.setValue('clientId', Number(val));
    form.setValue('projectId', 0);
    form.setValue('taskId', 0);
  };
  const handleProjectChange = (val: string) => {
    form.setValue('projectId', Number(val));
    form.setValue('taskId', 0);
  };

  const onSubmit = (data: TimeEntryForm) => {
    createMutation.mutate(
      { data: { taskId: data.taskId, hours: data.hours, date: data.date, description: data.description || undefined } },
      {
        onSuccess: () => {
          toast({ title: 'Time entry logged successfully' });
          queryClient.invalidateQueries({ queryKey: getListTimeEntriesQueryKey() });
          form.reset({
            clientId: 0, projectId: 0, taskId: 0,
            hours: 1, date: format(new Date(), 'yyyy-MM-dd'), description: '',
          });
          onOpenChange(false);
        },
        onError: (err: any) => {
          toast({ variant: 'destructive', title: 'Failed to log time', description: err?.error || 'An error occurred.' });
        },
      }
    );
  };

  const handleClose = (v: boolean) => {
    if (!v) {
      form.reset({ clientId: 0, projectId: 0, taskId: 0, hours: 1, date: format(new Date(), 'yyyy-MM-dd'), description: '' });
    }
    onOpenChange(v);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogTrigger asChild>
        <Button className="shadow-md font-semibold tracking-tight" data-testid="button-log-time">
          <Plus className="w-4 h-4 mr-2" />
          Log Time
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Log Time Entry</DialogTitle>
          <DialogDescription>Select the client, project, and task — then fill in your hours.</DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 pt-2">
            <FormField control={form.control} name="clientId" render={({ field }) => (
              <FormItem>
                <FormLabel>Client</FormLabel>
                <Select onValueChange={handleClientChange} value={field.value > 0 ? String(field.value) : ''}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder={isLoadingClients ? 'Loading...' : 'Select a client'} />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {clients?.map(c => (
                      <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )} />

            <FormField control={form.control} name="projectId" render={({ field }) => (
              <FormItem>
                <FormLabel>Project</FormLabel>
                <Select
                  onValueChange={handleProjectChange}
                  value={field.value > 0 ? String(field.value) : ''}
                  disabled={!selectedClientId || selectedClientId === 0}
                >
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder={
                        !selectedClientId || selectedClientId === 0 ? 'Select a client first' :
                        isLoadingProjects ? 'Loading...' : 'Select a project'
                      } />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {projects?.map(p => (
                      <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )} />

            <FormField control={form.control} name="taskId" render={({ field }) => (
              <FormItem>
                <FormLabel>Task</FormLabel>
                <Select
                  onValueChange={(v) => form.setValue('taskId', Number(v))}
                  value={field.value > 0 ? String(field.value) : ''}
                  disabled={!selectedProjectId || selectedProjectId === 0}
                >
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder={
                        !selectedProjectId || selectedProjectId === 0 ? 'Select a project first' :
                        isLoadingTasks ? 'Loading...' : 'Select a task'
                      } />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {tasks?.map(t => (
                      <SelectItem key={t.id} value={String(t.id)}>{t.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )} />

            <div className="grid grid-cols-2 gap-4">
              <FormField control={form.control} name="date" render={({ field }) => (
                <FormItem>
                  <FormLabel>Date</FormLabel>
                  <FormControl><Input type="date" {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="hours" render={({ field }) => (
                <FormItem>
                  <FormLabel>Hours</FormLabel>
                  <FormControl><Input type="number" step="0.25" min="0.25" max="24" {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
            </div>

            <FormField control={form.control} name="description" render={({ field }) => (
              <FormItem>
                <FormLabel>Description <span className="text-muted-foreground font-normal">(Optional)</span></FormLabel>
                <FormControl>
                  <Textarea placeholder="Briefly describe what you worked on..." rows={2} className="resize-none" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )} />

            <div className="pt-2 flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => handleClose(false)}>Cancel</Button>
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

// ─── Split Hours Dialog ───────────────────────────────────────────────────────

function SplitHoursDialog({
  entry, open, onOpenChange,
}: {
  entry: TimeEntry;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const splitMutation = useSplitTimeEntry();

  const form = useForm<z.infer<typeof splitSchema>>({
    resolver: zodResolver(splitSchema),
    defaultValues: { billableHours: entry.billableHours ?? entry.hours },
  });

  const billableVal = Number(form.watch('billableHours') ?? 0);
  const nonBillable = Math.max(0, entry.hours - billableVal);

  const onSubmit = (data: z.infer<typeof splitSchema>) => {
    if (data.billableHours > entry.hours) {
      form.setError('billableHours', { message: `Cannot exceed total ${entry.hours}h` });
      return;
    }
    splitMutation.mutate(
      { entryId: entry.id, data: { billableHours: data.billableHours } },
      {
        onSuccess: () => {
          toast({ title: 'Hours split saved' });
          queryClient.invalidateQueries({ queryKey: getListTimeEntriesQueryKey() });
          onOpenChange(false);
        },
        onError: (err: any) => {
          toast({ variant: 'destructive', title: 'Error', description: err?.error || 'Failed to split.' });
        },
      }
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Scissors className="w-5 h-5 text-primary" />
            Split Billable Hours
          </DialogTitle>
          <DialogDescription>
            <span className="font-bold text-foreground">{entry.userName}</span> logged{' '}
            <span className="font-mono font-bold">{entry.hours}h</span> on{' '}
            <span className="font-bold text-foreground">{entry.taskName}</span> ({entry.clientName}).
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5 pt-2">
            <FormField control={form.control} name="billableHours" render={({ field }) => (
              <FormItem>
                <FormLabel>Billable Hours</FormLabel>
                <FormControl>
                  <Input type="number" step="0.25" min="0" max={entry.hours} {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )} />

            <div className="bg-muted/40 rounded-lg p-4 grid grid-cols-2 gap-4 border border-border/50">
              <div className="text-center">
                <p className="text-xs font-mono uppercase tracking-wider text-muted-foreground mb-1">Billable</p>
                <p className="text-2xl font-bold font-mono text-primary">{billableVal.toFixed(2)}h</p>
              </div>
              <div className="text-center">
                <p className="text-xs font-mono uppercase tracking-wider text-muted-foreground mb-1">Non-Billable</p>
                <p className="text-2xl font-bold font-mono text-muted-foreground">{nonBillable.toFixed(2)}h</p>
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button type="submit" disabled={splitMutation.isPending}>
                {splitMutation.isPending ? 'Saving...' : 'Save Split'}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
