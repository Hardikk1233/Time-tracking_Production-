import React, { useState } from 'react';
import { useAuth } from '@/lib/auth';
import {
  useListProjects,
  useCreateProject,
  useUpdateProject,
  useDeleteProject,
  useListClients,
  useListTasks,
  useListUsers,
  getListProjectsQueryKey,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { useToast } from '@/hooks/use-toast';
import { format } from 'date-fns';
import { Link } from 'wouter';

import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Plus, Trash2, FolderKanban, ChevronRight, Check, PowerOff, Power } from 'lucide-react';

const projectSchema = z.object({
  clientId: z.coerce.number().min(1, 'Client is required'),
  name: z.string().min(1, 'Name is required'),
  description: z.string().optional(),
  taskIds: z.array(z.number()).optional(),
  userIds: z.array(z.number()).optional(),
});
type ProjectForm = z.infer<typeof projectSchema>;

export default function Projects() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [clientFilter, setClientFilter] = useState<string>('all');
  const [showInactive, setShowInactive] = useState(false);
  
  const queryParams = { ...(clientFilter !== 'all' ? { clientId: Number(clientFilter) } : {}) };
  const { data: projects, isLoading } = useListProjects(queryParams);
  const { data: clients } = useListClients();
  const deleteMutation = useDeleteProject();
  const updateMutation = useUpdateProject();

  const canManageProjects = ['associate', 'avp', 'md'].includes(user?.role || '');

  const handleDelete = (id: number) => {
    if (confirm('Are you sure you want to delete this project?')) {
      deleteMutation.mutate({ projectId: id }, {
        onSuccess: () => {
          toast({ title: 'Project deleted' });
          queryClient.invalidateQueries({ queryKey: getListProjectsQueryKey() });
        },
        onError: (err: any) => {
          toast({ variant: 'destructive', title: 'Error', description: err.error || 'Failed to delete.' });
        }
      });
    }
  };

  const handleToggleActive = (id: number, currentlyActive: boolean) => {
    updateMutation.mutate(
      { projectId: id, data: { isActive: !currentlyActive } as any },
      {
        onSuccess: () => {
          toast({ title: currentlyActive ? 'Project set to inactive' : 'Project reactivated' });
          queryClient.invalidateQueries({ queryKey: getListProjectsQueryKey() });
        },
        onError: (err: any) => {
          toast({ variant: 'destructive', title: 'Error', description: err.error || 'Failed to update.' });
        }
      }
    );
  };

  const allProjects = projects || [];
  const inactiveCount = allProjects.filter(p => p.isActive === false).length;
  const displayed = allProjects.filter(p => showInactive || p.isActive !== false);

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">Projects</h1>
          <p className="text-muted-foreground font-mono text-sm mt-1">Client engagements and initiatives</p>
        </div>
        
        <div className="flex items-center gap-3 flex-wrap">
          <Select value={clientFilter} onValueChange={setClientFilter}>
            <SelectTrigger className="w-[180px] bg-card">
              <SelectValue placeholder="All Clients" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Clients</SelectItem>
              {clients?.map(c => (
                <SelectItem key={c.id} value={c.id.toString()}>{c.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          {canManageProjects && inactiveCount > 0 && (
            <Button variant="outline" size="sm" onClick={() => setShowInactive(v => !v)} className="text-xs gap-1.5">
              {showInactive ? <Power className="w-3.5 h-3.5" /> : <PowerOff className="w-3.5 h-3.5" />}
              {showInactive ? 'Hide' : 'Show'} Inactive ({inactiveCount})
            </Button>
          )}

          {canManageProjects && (
            <CreateProjectDialog open={isDialogOpen} onOpenChange={setIsDialogOpen} clients={clients || []} />
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {isLoading ? (
          Array(6).fill(0).map((_, i) => (
            <Card key={i} className="shadow-sm border-border">
              <CardContent className="p-6 space-y-4">
                <Skeleton className="h-6 w-2/3" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-1/2" />
              </CardContent>
            </Card>
          ))
        ) : displayed.length > 0 ? (
          displayed.map(project => {
            const isInactive = project.isActive === false;
            return (
              <Card key={project.id} className={`shadow-sm border-border hover:border-primary/50 transition-colors group flex flex-col ${isInactive ? 'opacity-60' : ''}`}>
                <CardContent className="p-6 flex flex-col h-full">
                  <div className="flex justify-between items-start mb-4">
                    <div className={`p-2 rounded-md ${isInactive ? 'bg-muted text-muted-foreground' : 'bg-primary/10 text-primary'}`}>
                      <FolderKanban className="w-5 h-5" />
                    </div>
                    {canManageProjects && (
                      <div className="flex gap-1 -mr-2 -mt-2 opacity-0 group-hover:opacity-100 transition-opacity">
                        <Button
                          variant="ghost"
                          size="icon"
                          title={isInactive ? 'Reactivate project' : 'Set inactive'}
                          className={`h-8 w-8 ${isInactive ? 'text-emerald-600 hover:bg-emerald-50' : 'text-amber-500 hover:bg-amber-50'}`}
                          onClick={(e) => { e.preventDefault(); handleToggleActive(project.id, !isInactive); }}
                          disabled={updateMutation.isPending}
                        >
                          {isInactive ? <Power className="w-4 h-4" /> : <PowerOff className="w-4 h-4" />}
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                          onClick={(e) => { e.preventDefault(); handleDelete(project.id); }}
                          disabled={deleteMutation.isPending}
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    )}
                  </div>
                  <div className="text-xs font-mono text-primary mb-1">{project.clientName}</div>
                  <div className="flex items-center gap-2 mb-2">
                    <h3 className="font-bold text-lg leading-tight text-foreground line-clamp-1">{project.name}</h3>
                    {isInactive && (
                      <Badge variant="outline" className="text-[10px] font-mono text-amber-600 border-amber-300 bg-amber-50 shrink-0">
                        INACTIVE
                      </Badge>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground line-clamp-2 mb-4 flex-1">
                    {project.description || 'No description provided.'}
                  </p>
                  <div className="flex items-center justify-between mt-auto pt-4 border-t border-border/50">
                    <span className="text-xs font-mono text-muted-foreground">
                      Added {format(new Date(project.createdAt), 'MMM dd, yyyy')}
                    </span>
                    <Link href={`/projects/${project.id}`}>
                      <Button variant="ghost" size="sm" className="h-8 text-primary hover:bg-primary/10 font-medium">
                        Details <ChevronRight className="w-4 h-4 ml-1" />
                      </Button>
                    </Link>
                  </div>
                </CardContent>
              </Card>
            );
          })
        ) : (
          <div className="col-span-full py-12 text-center text-muted-foreground font-mono text-sm border border-dashed border-border rounded-lg">
            NO PROJECTS FOUND
          </div>
        )}
      </div>
    </div>
  );
}

function MultiSelectList({ items, selectedIds, onToggle, emptyLabel, renderLabel }: {
  items: { id: number }[];
  selectedIds: number[];
  onToggle: (id: number) => void;
  emptyLabel: string;
  renderLabel: (item: any) => React.ReactNode;
}) {
  if (items.length === 0) return <p className="text-xs text-muted-foreground italic">{emptyLabel}</p>;
  return (
    <div className="grid grid-cols-1 gap-1 max-h-36 overflow-y-auto rounded-md border border-input bg-background p-2">
      {items.map((item: any) => {
        const selected = selectedIds.includes(item.id);
        return (
          <button key={item.id} type="button" onClick={() => onToggle(item.id)}
            className={`flex items-center gap-2 rounded px-2 py-1.5 text-sm transition-colors text-left ${selected ? 'bg-primary/10 text-primary font-medium' : 'hover:bg-muted'}`}>
            <div className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 ${selected ? 'bg-primary border-primary' : 'border-input'}`}>
              {selected && <Check className="w-2.5 h-2.5 text-white" />}
            </div>
            {renderLabel(item)}
          </button>
        );
      })}
    </div>
  );
}

function CreateProjectDialog({ open, onOpenChange, clients }: { open: boolean; onOpenChange: (open: boolean) => void; clients: any[] }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const createMutation = useCreateProject();
  const { data: tasks } = useListTasks();
  const { data: users } = useListUsers();

  const form = useForm<ProjectForm>({
    resolver: zodResolver(projectSchema),
    defaultValues: { name: '', description: '', taskIds: [], userIds: [] },
  });

  const selectedTaskIds = form.watch('taskIds') ?? [];
  const selectedUserIds = form.watch('userIds') ?? [];

  const toggle = (field: 'taskIds' | 'userIds', id: number) => {
    const cur = form.getValues(field) ?? [];
    form.setValue(field, cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id]);
  };

  const onSubmit = (data: ProjectForm) => {
    createMutation.mutate({ data: data as any }, {
      onSuccess: () => {
        toast({ title: 'Project created' });
        queryClient.invalidateQueries({ queryKey: getListProjectsQueryKey() });
        form.reset({ name: '', description: '', taskIds: [], userIds: [] });
        onOpenChange(false);
      },
      onError: (err: any) => {
        toast({ variant: 'destructive', title: 'Error', description: err.error || 'Failed to create project.' });
      }
    });
  };

  const activeClients = clients.filter(c => c.isActive !== false);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button className="shadow-md font-semibold tracking-tight">
          <Plus className="w-4 h-4 mr-2" />New Project
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[520px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Create Project</DialogTitle>
          <DialogDescription>Set up a new engagement for a client.</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 pt-4">
            <FormField control={form.control} name="clientId" render={({ field }) => (
              <FormItem>
                <FormLabel>Client</FormLabel>
                <Select onValueChange={field.onChange} value={field.value?.toString()}>
                  <FormControl><SelectTrigger><SelectValue placeholder="Select client" /></SelectTrigger></FormControl>
                  <SelectContent>
                    {activeClients.map(c => <SelectItem key={c.id} value={c.id.toString()}>{c.name}</SelectItem>)}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )} />
            <FormField control={form.control} name="name" render={({ field }) => (
              <FormItem>
                <FormLabel>Project Name</FormLabel>
                <FormControl><Input placeholder="Q3 Advisory" {...field} /></FormControl>
                <FormMessage />
              </FormItem>
            )} />
            <FormField control={form.control} name="description" render={({ field }) => (
              <FormItem>
                <FormLabel>Description <span className="text-muted-foreground font-normal">(Optional)</span></FormLabel>
                <FormControl><Input placeholder="Brief scope" {...field} /></FormControl>
                <FormMessage />
              </FormItem>
            )} />
            <div className="space-y-2">
              <Label>Enabled Tasks <span className="text-muted-foreground font-normal">(Optional)</span></Label>
              <MultiSelectList
                items={tasks || []}
                selectedIds={selectedTaskIds}
                onToggle={(id) => toggle('taskIds', id)}
                emptyLabel="No tasks available."
                renderLabel={(t) => <span>{t.name}</span>}
              />
            </div>
            <div className="space-y-2">
              <Label>Team Members <span className="text-muted-foreground font-normal">(Optional)</span></Label>
              <MultiSelectList
                items={(users || []).filter(u => u.isActive !== false)}
                selectedIds={selectedUserIds}
                onToggle={(id) => toggle('userIds', id)}
                emptyLabel="No users available."
                renderLabel={(u) => <span>{u.name} <span className="text-muted-foreground text-xs">({u.role})</span></span>}
              />
            </div>
            <div className="pt-4 flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button type="submit" disabled={createMutation.isPending}>{createMutation.isPending ? 'Creating...' : 'Create Project'}</Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
