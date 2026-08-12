import React, { useState, useMemo } from 'react';
import { useAuth } from '@/lib/auth';
import {
  useListTimeEntries,
  useCreateTimeEntry,
  useUpdateTimeEntry,
  useApproveTimeEntry,
  useRejectTimeEntry,
  useSplitTimeEntry,
  useListClients,
  useListProjects,
  useListTasks,
  useLogLeavesBulk,
  useListLeaves,
  useDeleteLeave,
  useListPublicHolidays,
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
import { cn } from '@/lib/utils';

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
import { Checkbox } from '@/components/ui/checkbox';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem } from '@/components/ui/command';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Plus, Check, X, Filter, Scissors, CalendarOff, Trash2, Pencil, ChevronsUpDown, CheckSquare } from 'lucide-react';

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

// ─── Project Combobox ─────────────────────────────────────────────────────────

function ProjectCombobox({
  projects,
  value,
  onChange,
  disabled,
  placeholder,
  isLoading,
}: {
  projects: Array<{ id: number; name: string }> | undefined;
  value: number;
  onChange: (val: string) => void;
  disabled?: boolean;
  placeholder: string;
  isLoading?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const selected = projects?.find(p => p.id === value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className="w-full justify-between font-normal h-10 px-3"
        >
          <span className="truncate text-sm">
            {isLoading ? 'Loading...' : selected ? selected.name : <span className="text-muted-foreground">{placeholder}</span>}
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
        <Command>
          <CommandInput placeholder="Search projects..." />
          <CommandEmpty>No projects found.</CommandEmpty>
          <CommandGroup>
            <ScrollArea className="max-h-52">
              {projects?.filter(p => (p as any).isActive !== false).map(p => (
                <CommandItem
                  key={p.id}
                  value={p.name}
                  onSelect={() => {
                    onChange(String(p.id));
                    setOpen(false);
                  }}
                >
                  <Check className={cn('mr-2 h-4 w-4', value === p.id ? 'opacity-100' : 'opacity-0')} />
                  {p.name}
                </CommandItem>
              ))}
            </ScrollArea>
          </CommandGroup>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function TimeEntries() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [isLeaveDialogOpen, setIsLeaveDialogOpen] = useState(false);
  const [splitEntry, setSplitEntry] = useState<TimeEntry | null>(null);
  const [editEntry, setEditEntry] = useState<TimeEntry | null>(null);

  // Bulk selection state
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  const queryParams = statusFilter !== 'all' ? { status: statusFilter as 'pending' | 'approved' | 'rejected' } : {};
  const { data: entries, isLoading } = useListTimeEntries(queryParams);

  const approveMutation = useApproveTimeEntry();
  const rejectMutation = useRejectTimeEntry();

  const isAssociateOrAbove = ['associate', 'avp', 'md'].includes(user?.role ?? '');
  const isAvpOrAbove = ['avp', 'md'].includes(user?.role ?? '');

  // Associates and above can approve any pending entry, including their own
  const approvableEntries = useMemo(
    () => (entries ?? []).filter(e => e.status === 'pending' && isAssociateOrAbove),
    [entries, isAssociateOrAbove],
  );

  const approvableIds = useMemo(() => new Set(approvableEntries.map(e => e.id)), [approvableEntries]);

  const handleApprove = (id: number) => {
    approveMutation.mutate({ entryId: id }, {
      onSuccess: () => {
        toast({ title: 'Entry approved' });
        queryClient.invalidateQueries({ queryKey: getListTimeEntriesQueryKey() });
        setSelectedIds(prev => { const next = new Set(prev); next.delete(id); return next; });
      },
    });
  };

  const handleReject = (id: number) => {
    rejectMutation.mutate({ entryId: id }, {
      onSuccess: () => {
        toast({ title: 'Entry rejected' });
        queryClient.invalidateQueries({ queryKey: getListTimeEntriesQueryKey() });
        setSelectedIds(prev => { const next = new Set(prev); next.delete(id); return next; });
      },
    });
  };

  // Bulk approve all selected
  const handleBulkApprove = async () => {
    const ids = [...selectedIds].filter(id => approvableIds.has(id));
    if (ids.length === 0) return;
    let approved = 0;
    await Promise.all(
      ids.map(id =>
        new Promise<void>(resolve => {
          approveMutation.mutate({ entryId: id }, {
            onSuccess: () => { approved++; resolve(); },
            onError: () => resolve(),
          });
        }),
      ),
    );
    toast({ title: `${approved} entr${approved !== 1 ? 'ies' : 'y'} approved` });
    queryClient.invalidateQueries({ queryKey: getListTimeEntriesQueryKey() });
    setSelectedIds(new Set());
  };

  const toggleSelect = (id: number) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const selectableIds = useMemo(
    () => isAssociateOrAbove ? [...approvableIds] : [],
    [isAssociateOrAbove, approvableIds],
  );

  const allSelected = selectableIds.length > 0 && selectableIds.every(id => selectedIds.has(id));

  const toggleSelectAll = () => {
    if (allSelected) {
      setSelectedIds(prev => {
        const next = new Set(prev);
        selectableIds.forEach(id => next.delete(id));
        return next;
      });
    } else {
      setSelectedIds(prev => {
        const next = new Set(prev);
        selectableIds.forEach(id => next.add(id));
        return next;
      });
    }
  };

  const selectedApprovable = [...selectedIds].filter(id => approvableIds.has(id));

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">Time Entries</h1>
          <p className="text-muted-foreground font-mono text-sm mt-1">Activity logs and billing records</p>
        </div>
        <div className="flex items-center gap-3">
          {/* Bulk approve button */}
          {selectedApprovable.length > 0 && isAssociateOrAbove && (
            <Button
              variant="outline"
              className="border-emerald-500/40 text-emerald-600 hover:bg-emerald-50 hover:border-emerald-500 font-semibold"
              onClick={handleBulkApprove}
              disabled={approveMutation.isPending}
            >
              <CheckSquare className="w-4 h-4 mr-2" />
              Approve {selectedApprovable.length}
            </Button>
          )}

          <Select value={statusFilter} onValueChange={v => { setStatusFilter(v); setSelectedIds(new Set()); }}>
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
                {isAssociateOrAbove && (
                  <th className="px-4 py-4 w-10">
                    <Checkbox
                      checked={allSelected}
                      onCheckedChange={toggleSelectAll}
                      disabled={selectableIds.length === 0}
                      aria-label="Select all"
                    />
                  </th>
                )}
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
                    {Array(isAssociateOrAbove ? 8 : 7).fill(0).map((__, j) => (
                      <td key={j} className="px-6 py-4"><Skeleton className="h-4 w-full" /></td>
                    ))}
                  </tr>
                ))
              ) : entries && entries.length > 0 ? (
                entries.map((entry: TimeEntry) => {
                  // Associates+ can approve any pending entry (including own)
                  const canApprove = isAssociateOrAbove && entry.status === 'pending';
                  // AVP/MD: edit anything at any status; Associate: any pending; Analyst: own pending only
                  const canEdit = isAvpOrAbove
                    || (entry.status === 'pending' && (entry.userId === user?.id || isAssociateOrAbove));
                  const isChecked = selectedIds.has(entry.id);
                  return (
                    <tr key={entry.id} className={cn('hover:bg-muted/10 transition-colors', isChecked && 'bg-emerald-50/40')}>
                      {isAssociateOrAbove && (
                        <td className="px-4 py-4">
                          {canApprove ? (
                            <Checkbox
                              checked={isChecked}
                              onCheckedChange={() => toggleSelect(entry.id)}
                              aria-label={`Select entry ${entry.id}`}
                            />
                          ) : (
                            <span className="block w-4" />
                          )}
                        </td>
                      )}
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
                          {canEdit && (
                            <Button
                              variant="ghost" size="icon"
                              className="h-8 w-8 text-muted-foreground hover:text-foreground hover:bg-muted rounded-full"
                              title="Edit entry"
                              onClick={() => setEditEntry(entry)}
                            >
                              <Pencil className="w-4 h-4" />
                            </Button>
                          )}
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
                          {canApprove && (
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
                  );
                })
              ) : (
                <tr>
                  <td colSpan={isAssociateOrAbove ? 8 : 7} className="px-6 py-12 text-center text-muted-foreground font-mono text-sm">
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

      {/* Edit dialog */}
      {editEntry && (
        <EditTimeEntryDialog
          entry={editEntry}
          open={!!editEntry}
          onOpenChange={(open) => { if (!open) setEditEntry(null); }}
        />
      )}
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function BillableSplitDisplay({ entry }: { entry: TimeEntry }) {
  // null billableHours = not explicitly split → all hours are billable by default
  if (entry.billableHours === null || entry.billableHours === undefined) {
    return (
      <span className="text-xs font-mono font-semibold text-emerald-600">
        {entry.hours.toFixed(2)}h B
      </span>
    );
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

  const now = new Date();
  const monthStart = format(new Date(now.getFullYear(), now.getMonth(), 1), 'yyyy-MM-dd');
  const monthEnd = format(new Date(now.getFullYear(), now.getMonth() + 1, 0), 'yyyy-MM-dd');

  const { data: myLeaves } = useListLeaves(
    { startDate: monthStart, endDate: monthEnd } as any,
    { query: { enabled: open && !!user?.id } as any }
  );

  const { data: publicHolidays } = useListPublicHolidays(
    { query: { enabled: open } as any }
  );

  const alreadyLoggedDates: Date[] = React.useMemo(() => {
    if (!myLeaves) return [];
    return myLeaves.map((l: any) => {
      const [y, m, d] = l.date.split('-').map(Number);
      return new Date(y, m - 1, d);
    });
  }, [myLeaves]);

  const holidayDates: Date[] = React.useMemo(() => {
    if (!publicHolidays) return [];
    return publicHolidays.map((h: any) => {
      const [y, m, d] = h.date.split('-').map(Number);
      return new Date(y, m - 1, d);
    });
  }, [publicHolidays]);

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
    if (!v) { setSelectedDates([]); setNote(''); }
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
            Click dates to select them. Public holidays are shown in red and can't be selected. Already-logged leave dates are shown in amber.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 pt-1">
          <div className="flex justify-center rounded-lg border border-border bg-muted/20 p-2">
            <Calendar
              mode="multiple"
              selected={selectedDates}
              onSelect={(dates) => setSelectedDates(dates ?? [])}
              disabled={[
                { dayOfWeek: [0, 6] },
                ...holidayDates,
                ...alreadyLoggedDates,
              ]}
              modifiers={{ holiday: holidayDates, alreadyLogged: alreadyLoggedDates }}
              modifiersClassNames={{
                holiday: '!text-red-500 opacity-60 line-through',
                alreadyLogged: '!text-amber-500 opacity-60 line-through',
              }}
              className="mx-auto"
            />
          </div>

          {selectedDates.length > 0 && (
            <div>
              <p className="text-xs font-mono uppercase tracking-wider text-muted-foreground mb-2">
                Selected — {selectedDates.length} day{selectedDates.length !== 1 ? 's' : ''}
              </p>
              <div className="flex flex-wrap gap-1.5">
                {[...selectedDates].sort((a, b) => a.getTime() - b.getTime()).map(d => (
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

          <div>
            <label className="text-sm font-medium mb-1.5 block">
              Reason <span className="text-muted-foreground font-normal">(Optional)</span>
            </label>
            <Input placeholder="e.g. Sick leave, Personal, Family" value={note} onChange={e => setNote(e.target.value)} />
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <Button variant="outline" onClick={() => handleClose(false)}>Cancel</Button>
            <Button
              onClick={handleSubmit}
              className="bg-amber-500 hover:bg-amber-600 text-white"
              disabled={selectedDates.length === 0 || bulkMutation.isPending}
            >
              {bulkMutation.isPending ? 'Logging...' : selectedDates.length === 0 ? 'Select dates' : `Log ${selectedDates.length} day${selectedDates.length !== 1 ? 's' : ''}`}
            </Button>
          </div>
        </div>

        {myLeaves && myLeaves.length > 0 && (
          <div className="border-t border-border pt-4 mt-2">
            <p className="text-xs font-mono uppercase tracking-wider text-muted-foreground mb-2">Already logged this month</p>
            <div className="space-y-1 max-h-32 overflow-y-auto">
              {myLeaves.map((leave: any) => (
                <div key={leave.id} className="flex items-center justify-between gap-2 rounded px-2 py-1.5 bg-muted/40 hover:bg-muted/60">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-sm font-medium font-mono shrink-0">
                      {format(new Date(leave.date + 'T00:00:00'), 'EEE, MMM dd')}
                    </span>
                    {leave.note && <span className="text-xs text-muted-foreground italic truncate">{leave.note}</span>}
                  </div>
                  <Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground hover:text-destructive shrink-0"
                    onClick={() => handleDeleteLeave(leave.id)} disabled={deleteLeaveMutation.isPending}>
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
    defaultValues: { clientId: 0, projectId: 0, taskId: 0, hours: 1, date: format(new Date(), 'yyyy-MM-dd'), description: '' },
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
      { data: { projectId: data.projectId, taskId: data.taskId, hours: data.hours, date: data.date, description: data.description || undefined } },
      {
        onSuccess: () => {
          toast({ title: 'Time entry logged successfully' });
          queryClient.invalidateQueries({ queryKey: getListTimeEntriesQueryKey() });
          form.reset({ clientId: 0, projectId: 0, taskId: 0, hours: 1, date: format(new Date(), 'yyyy-MM-dd'), description: '' });
          onOpenChange(false);
        },
        onError: (err: any) => {
          toast({ variant: 'destructive', title: 'Failed to log time', description: err?.error || 'An error occurred.' });
        },
      }
    );
  };

  const handleClose = (v: boolean) => {
    if (!v) form.reset({ clientId: 0, projectId: 0, taskId: 0, hours: 1, date: format(new Date(), 'yyyy-MM-dd'), description: '' });
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
            {/* Client */}
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

            {/* Project — combobox with search */}
            <FormField control={form.control} name="projectId" render={({ field }) => (
              <FormItem>
                <FormLabel>Project</FormLabel>
                <FormControl>
                  <ProjectCombobox
                    projects={projects}
                    value={field.value}
                    onChange={handleProjectChange}
                    disabled={!selectedClientId || selectedClientId === 0}
                    isLoading={isLoadingProjects}
                    placeholder={
                      !selectedClientId || selectedClientId === 0
                        ? 'Select a client first'
                        : 'Select a project'
                    }
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )} />

            {/* Task */}
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

// ─── Edit Time Entry Dialog ───────────────────────────────────────────────────

function EditTimeEntryDialog({
  entry,
  open,
  onOpenChange,
}: {
  entry: TimeEntry;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { user } = useAuth();
  const isAvpOrAbove = ['avp', 'md'].includes(user?.role ?? '');
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const updateMutation = useUpdateTimeEntry();

  const form = useForm<TimeEntryForm>({
    resolver: zodResolver(timeEntrySchema),
    defaultValues: {
      clientId: entry.clientId ?? 0,
      projectId: entry.projectId ?? 0,
      taskId: entry.taskId ?? 0,
      hours: entry.hours,
      date: entry.date,
      description: entry.description ?? '',
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
    updateMutation.mutate(
      {
        entryId: entry.id,
        data: {
          projectId: data.projectId !== entry.projectId ? data.projectId : undefined,
          taskId: data.taskId !== entry.taskId ? data.taskId : undefined,
          hours: data.hours,
          date: data.date,
          description: data.description || null,
        },
      },
      {
        onSuccess: () => {
          toast({ title: 'Time entry updated' });
          queryClient.invalidateQueries({ queryKey: getListTimeEntriesQueryKey() });
          onOpenChange(false);
        },
        onError: (err: any) => {
          toast({ variant: 'destructive', title: 'Failed to update', description: err?.error || 'An error occurred.' });
        },
      }
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Pencil className="w-4 h-4" />
            Edit Time Entry
          </DialogTitle>
          <DialogDescription>
            Update the details for this time entry.
            {!isAvpOrAbove && ' Only pending entries can be edited.'}
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 pt-2">
            {/* Client */}
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

            {/* Project — combobox with search */}
            <FormField control={form.control} name="projectId" render={({ field }) => (
              <FormItem>
                <FormLabel>Project</FormLabel>
                <FormControl>
                  <ProjectCombobox
                    projects={projects}
                    value={field.value}
                    onChange={handleProjectChange}
                    disabled={!selectedClientId || selectedClientId === 0}
                    isLoading={isLoadingProjects}
                    placeholder={
                      !selectedClientId || selectedClientId === 0
                        ? 'Select a client first'
                        : 'Select a project'
                    }
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )} />

            {/* Task */}
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
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button type="submit" disabled={updateMutation.isPending}>
                {updateMutation.isPending ? 'Saving...' : 'Save Changes'}
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
            By default all hours are billable — set a lower billable amount to designate the remainder as non-billable.
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
