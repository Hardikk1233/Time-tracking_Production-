import React, { useState } from 'react';
import { useRoute, useLocation } from 'wouter';
import { useAuth } from '@/lib/auth';
import {
  useGetClient,
  useListClientAssignments,
  useAssignUserToClient,
  useRemoveUserFromClient,
  useListUsers,
  useListProjects,
  useListClientFteHistory,
  useAddClientFteHistory,
  useDeleteClientFteHistory,
  getListClientAssignmentsQueryKey,
  getListClientFteHistoryQueryKey,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/hooks/use-toast';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { HourBlocksCard, ProductAllocationCard } from '@/components/client-engagement';
import {
  ArrowLeft, Building2, Users, FolderKanban, UserPlus, UserMinus,
  ChevronRight, TrendingUp, Plus, Trash2, Calendar,
} from 'lucide-react';
import { Link } from 'wouter';
import { format, parseISO } from 'date-fns';

// ─── FTE History form schema ──────────────────────────────────────────────────
const fteSchema = z.object({
  fteCount: z.coerce.number().min(0.1, 'Min 0.1').max(100, 'Max 100'),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD required'),
  effectiveTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD required').optional().or(z.literal('')),
});
type FteForm = z.infer<typeof fteSchema>;

export default function ClientDetail() {
  const [, params] = useRoute('/clients/:id');
  const [, setLocation] = useLocation();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const clientId = parseInt(params?.id || '0', 10);
  const [selectedUserId, setSelectedUserId] = useState<string>('');
  const [fteDialogOpen, setFteDialogOpen] = useState(false);

  const { data: client, isLoading: isLoadingClient } = useGetClient(clientId);
  const { data: assignments, isLoading: isLoadingAssignments } = useListClientAssignments(clientId);
  const { data: allUsers } = useListUsers();
  const { data: projects, isLoading: isLoadingProjects } = useListProjects({ clientId });
  const { data: fteHistory, isLoading: isLoadingFte } = useListClientFteHistory(clientId);

  const assignMutation = useAssignUserToClient();
  const removeMutation = useRemoveUserFromClient();
  const deleteFteMutation = useDeleteClientFteHistory();

  const isManager = ['avp', 'md'].includes(user?.role || '');
  // Blocks and product allocation open up one rank lower than client admin,
  // matching requireRole("associate") on the API.
  const canAllocate = ['associate', 'avp', 'md'].includes(user?.role || '');
  const engagementType = client?.engagementType ?? 'fte';

  const assignedIds = new Set((assignments || []).map(u => u.id));
  const unassignedUsers = (allUsers || []).filter(u => !assignedIds.has(u.id));

  const handleAssign = () => {
    if (!selectedUserId) return;
    assignMutation.mutate(
      { clientId, data: { userId: Number(selectedUserId) } },
      {
        onSuccess: () => {
          toast({ title: 'User assigned to client' });
          queryClient.invalidateQueries({ queryKey: getListClientAssignmentsQueryKey(clientId) });
          setSelectedUserId('');
        },
        onError: (err: any) => toast({ variant: 'destructive', title: 'Error', description: err.error || 'Failed to assign user.' }),
      }
    );
  };

  const handleRemove = (userId: number) => {
    removeMutation.mutate(
      { clientId, userId },
      {
        onSuccess: () => {
          toast({ title: 'User removed from client' });
          queryClient.invalidateQueries({ queryKey: getListClientAssignmentsQueryKey(clientId) });
        },
        onError: (err: any) => toast({ variant: 'destructive', title: 'Error', description: err.error || 'Failed to remove user.' }),
      }
    );
  };

  const handleDeleteFte = (entryId: number) => {
    if (!confirm('Delete this FTE period?')) return;
    deleteFteMutation.mutate(
      { clientId, entryId },
      {
        onSuccess: () => {
          toast({ title: 'FTE period deleted' });
          queryClient.invalidateQueries({ queryKey: getListClientFteHistoryQueryKey(clientId) });
        },
        onError: (err: any) => toast({ variant: 'destructive', title: 'Error', description: err.error || 'Failed to delete.' }),
      }
    );
  };

  if (isLoadingClient) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (!client) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[50vh] gap-4">
        <p className="text-muted-foreground font-mono">CLIENT NOT FOUND</p>
        <Button variant="outline" onClick={() => setLocation('/clients')}>Back to Clients</Button>
      </div>
    );
  }

  // Sort FTE history by effectiveFrom ascending
  const sortedFteHistory = [...(fteHistory || [])].sort((a, b) =>
    a.effectiveFrom < b.effectiveFrom ? -1 : 1
  );

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      {/* Header */}
      <div>
        <Link href="/clients">
          <Button variant="ghost" className="text-muted-foreground hover:text-foreground mb-4 -ml-2 h-8">
            <ArrowLeft className="w-4 h-4 mr-1" />
            All Clients
          </Button>
        </Link>
        <div className="flex items-start gap-4">
          <div className="p-3 bg-primary/10 rounded-lg text-primary">
            <Building2 className="w-6 h-6" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3 flex-wrap">
              <h1 className="text-3xl font-bold tracking-tight text-foreground">{client.name}</h1>
              {client.isActive === false && (
                <Badge variant="outline" className="text-amber-600 border-amber-300 bg-amber-50 font-mono text-xs">
                  INACTIVE
                </Badge>
              )}
            </div>
            <p className="text-muted-foreground font-mono text-sm mt-1">
              {client.description || 'No description provided.'}
            </p>
            <p className="text-xs text-muted-foreground font-mono mt-1 opacity-60">
              Client since {format(new Date(client.createdAt), 'MMMM yyyy')}
            </p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Assigned Team Members */}
        <Card className="shadow-sm border-border">
          <CardHeader className="border-b border-border/50 bg-muted/20 pb-4">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base font-bold flex items-center gap-2">
                <Users className="w-4 h-4 text-primary" />
                Assigned Team
                <Badge variant="secondary" className="font-mono text-[10px]">
                  {assignments?.length || 0}
                </Badge>
              </CardTitle>
            </div>
          </CardHeader>
          <CardContent className="pt-4 space-y-4">
            {isManager && (
              <div className="flex gap-2">
                <Select value={selectedUserId} onValueChange={setSelectedUserId}>
                  <SelectTrigger className="flex-1 bg-background">
                    <SelectValue placeholder="Select a team member..." />
                  </SelectTrigger>
                  <SelectContent>
                    {unassignedUsers.length === 0 ? (
                      <div className="p-2 text-sm text-muted-foreground text-center">All users assigned</div>
                    ) : (
                      unassignedUsers.map(u => (
                        <SelectItem key={u.id} value={u.id.toString()}>
                          {u.name} <span className="text-muted-foreground text-xs">({u.role})</span>
                        </SelectItem>
                      ))
                    )}
                  </SelectContent>
                </Select>
                <Button size="sm" onClick={handleAssign} disabled={!selectedUserId || assignMutation.isPending} className="shrink-0">
                  <UserPlus className="w-4 h-4" />
                </Button>
              </div>
            )}
            {isLoadingAssignments ? (
              <div className="space-y-3">{[1, 2, 3].map(i => <Skeleton key={i} className="h-12 w-full" />)}</div>
            ) : assignments && assignments.length > 0 ? (
              <div className="space-y-2">
                {assignments.map(u => (
                  <div key={u.id} className="flex items-center justify-between p-3 bg-muted/30 rounded-md group">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-primary/10 text-primary flex items-center justify-center font-bold text-xs">
                        {u.name.substring(0, 2).toUpperCase()}
                      </div>
                      <div>
                        <p className="text-sm font-medium text-foreground">{u.name}</p>
                        <p className="text-xs text-muted-foreground capitalize font-mono">{u.role}</p>
                      </div>
                    </div>
                    {isManager && (
                      <Button
                        variant="ghost" size="icon"
                        className="h-7 w-7 text-muted-foreground hover:text-destructive hover:bg-destructive/10 opacity-0 group-hover:opacity-100 transition-opacity"
                        onClick={() => handleRemove(u.id)} disabled={removeMutation.isPending}
                      >
                        <UserMinus className="w-3.5 h-3.5" />
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div className="py-8 text-center text-muted-foreground font-mono text-sm border border-dashed border-border rounded-md">
                NO TEAM MEMBERS ASSIGNED
              </div>
            )}
          </CardContent>
        </Card>

        {/* Projects */}
        <Card className="shadow-sm border-border">
          <CardHeader className="border-b border-border/50 bg-muted/20 pb-4">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base font-bold flex items-center gap-2">
                <FolderKanban className="w-4 h-4 text-primary" />
                Projects
                <Badge variant="secondary" className="font-mono text-[10px]">{projects?.length || 0}</Badge>
              </CardTitle>
              {isManager && (
                <Link href="/projects">
                  <Button variant="ghost" size="sm" className="h-7 text-xs text-primary">
                    Manage <ChevronRight className="w-3 h-3 ml-0.5" />
                  </Button>
                </Link>
              )}
            </div>
          </CardHeader>
          <CardContent className="pt-4">
            {isLoadingProjects ? (
              <div className="space-y-3">{[1, 2, 3].map(i => <Skeleton key={i} className="h-12 w-full" />)}</div>
            ) : projects && projects.length > 0 ? (
              <div className="space-y-2">
                {projects.map(p => (
                  <Link key={p.id} href={`/projects/${p.id}`}>
                    <div className="flex items-center justify-between p-3 bg-muted/30 rounded-md hover:bg-muted/50 transition-colors cursor-pointer group">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded bg-primary/10 text-primary flex items-center justify-center">
                          <FolderKanban className="w-4 h-4" />
                        </div>
                        <div>
                          <div className="flex items-center gap-2">
                            <p className="text-sm font-medium text-foreground">{p.name}</p>
                            {p.isActive === false && (
                              <Badge variant="outline" className="text-[10px] font-mono text-amber-600 border-amber-300 bg-amber-50">
                                INACTIVE
                              </Badge>
                            )}
                          </div>
                          <p className="text-xs text-muted-foreground font-mono">
                            Added {format(new Date(p.createdAt), 'MMM yyyy')}
                          </p>
                        </div>
                      </div>
                      <ChevronRight className="w-4 h-4 text-muted-foreground group-hover:text-primary transition-colors" />
                    </div>
                  </Link>
                ))}
              </div>
            ) : (
              <div className="py-8 text-center text-muted-foreground font-mono text-sm border border-dashed border-border rounded-md">
                NO PROJECTS YET
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* The engagement decides which of these is meaningful, so only one shows. */}
      {engagementType === 'block_hours' && (
        <HourBlocksCard clientId={clientId} canManage={canAllocate} />
      )}
      {engagementType === 'product' && (
        <ProductAllocationCard clientId={clientId} canManage={canAllocate} />
      )}

      {/* FTE History */}
      {engagementType === 'fte' && (
      <Card className="shadow-sm border-border">
        <CardHeader className="border-b border-border/50 bg-muted/20 pb-4">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base font-bold flex items-center gap-2">
              <TrendingUp className="w-4 h-4 text-primary" />
              FTE History
              <Badge variant="secondary" className="font-mono text-[10px]">{sortedFteHistory.length}</Badge>
            </CardTitle>
            {isManager && (
              <AddFtePeriodDialog
                open={fteDialogOpen}
                onOpenChange={setFteDialogOpen}
                clientId={clientId}
              />
            )}
          </div>
        </CardHeader>
        <CardContent className="pt-4">
          {/* Current FTE summary */}
          <div className="mb-4 p-3 bg-primary/5 rounded-md border border-primary/10 flex items-center gap-3">
            <div className="p-2 bg-primary/10 rounded text-primary">
              <Users className="w-4 h-4" />
            </div>
            <div>
              <p className="text-sm font-semibold text-foreground">
                Current FTE: <span className="text-primary font-mono">{client.fteCount}</span>
              </p>
              <p className="text-xs text-muted-foreground font-mono">
                Baseline — {(client.fteCount * 160).toFixed(0)} h/mo capacity
              </p>
            </div>
          </div>

          {isLoadingFte ? (
            <div className="space-y-3">{[1, 2].map(i => <Skeleton key={i} className="h-14 w-full" />)}</div>
          ) : sortedFteHistory.length > 0 ? (
            <div className="space-y-2">
              {sortedFteHistory.map((entry, i) => {
                const isOpen = entry.effectiveTo === null;
                const isLatest = i === sortedFteHistory.length - 1;
                return (
                  <div
                    key={entry.id}
                    className={`flex items-center justify-between p-3 rounded-md border group ${
                      isLatest && isOpen
                        ? 'bg-emerald-50 border-emerald-200'
                        : 'bg-muted/30 border-border'
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <div className="p-1.5 rounded bg-primary/10 text-primary">
                        <Calendar className="w-3.5 h-3.5" />
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-semibold text-foreground font-mono">
                            {entry.fteCount} FTE
                          </span>
                          {isLatest && isOpen && (
                            <Badge className="text-[10px] bg-emerald-100 text-emerald-700 border-emerald-200 border font-mono">
                              CURRENT
                            </Badge>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground font-mono">
                          {entry.effectiveFrom}
                          {entry.effectiveTo ? ` → ${entry.effectiveTo}` : ' → present'}
                          <span className="ml-2 opacity-60">
                            ({(entry.fteCount * 160).toFixed(0)} h/mo)
                          </span>
                        </p>
                      </div>
                    </div>
                    {isManager && (
                      <Button
                        variant="ghost" size="icon"
                        className="h-7 w-7 text-muted-foreground hover:text-destructive hover:bg-destructive/10 opacity-0 group-hover:opacity-100 transition-opacity"
                        onClick={() => handleDeleteFte(entry.id)}
                        disabled={deleteFteMutation.isPending}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="py-8 text-center text-muted-foreground font-mono text-sm border border-dashed border-border rounded-md">
              <p>NO FTE HISTORY RECORDED</p>
              {isManager && (
                <p className="text-xs mt-1 opacity-70">
                  Add periods to track time-weighted FTE changes over time.
                </p>
              )}
            </div>
          )}
        </CardContent>
      </Card>
      )}
    </div>
  );
}

function AddFtePeriodDialog({ open, onOpenChange, clientId }: { open: boolean; onOpenChange: (v: boolean) => void; clientId: number }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const addMutation = useAddClientFteHistory();

  const form = useForm<FteForm>({
    resolver: zodResolver(fteSchema),
    defaultValues: { fteCount: 1, effectiveFrom: '', effectiveTo: '' },
  });

  const onSubmit = (data: FteForm) => {
    addMutation.mutate(
      {
        clientId,
        data: {
          fteCount: data.fteCount,
          effectiveFrom: data.effectiveFrom,
          effectiveTo: data.effectiveTo || null,
        } as any,
      },
      {
        onSuccess: () => {
          toast({ title: 'FTE period added' });
          queryClient.invalidateQueries({ queryKey: getListClientFteHistoryQueryKey(clientId) });
          form.reset({ fteCount: 1, effectiveFrom: '', effectiveTo: '' });
          onOpenChange(false);
        },
        onError: (err: any) => {
          toast({ variant: 'destructive', title: 'Error', description: err.error || 'Failed to add FTE period.' });
        },
      }
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" className="h-8 text-xs gap-1.5">
          <Plus className="w-3.5 h-3.5" /> Add Period
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle>Add FTE Period</DialogTitle>
          <DialogDescription>
            Record a time-bounded FTE count for this client. Leave "End date" empty for an open-ended current period.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 pt-4">
            <FormField control={form.control} name="fteCount" render={({ field }) => (
              <FormItem>
                <FormLabel>FTE Count</FormLabel>
                <FormControl>
                  <Input type="number" step="0.1" min="0.1" max="100" placeholder="1.5" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )} />
            <div className="grid grid-cols-2 gap-4">
              <FormField control={form.control} name="effectiveFrom" render={({ field }) => (
                <FormItem>
                  <FormLabel>Start date</FormLabel>
                  <FormControl><Input type="date" {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="effectiveTo" render={({ field }) => (
                <FormItem>
                  <FormLabel>End date <span className="text-muted-foreground font-normal">(optional)</span></FormLabel>
                  <FormControl><Input type="date" {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
            </div>
            <div className="pt-2 flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button type="submit" disabled={addMutation.isPending}>
                {addMutation.isPending ? 'Saving...' : 'Add Period'}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
