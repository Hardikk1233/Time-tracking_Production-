import React, { useState } from 'react';
import { useRoute, useLocation } from 'wouter';
import { useAuth } from '@/lib/auth';
import {
  useGetProject,
  useListProjectAssignments,
  useAssignUserToProject,
  useRemoveUserFromProject,
  useListUsers,
  useListTasks,
  getListProjectAssignmentsQueryKey,
  getListTasksQueryKey,
  useCreateTask,
  useDeleteTask,
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
import { ArrowLeft, FolderKanban, Users, CheckSquare, UserPlus, UserMinus, Plus, Trash2 } from 'lucide-react';
import { Link } from 'wouter';
import { format } from 'date-fns';

const taskSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  description: z.string().optional(),
});

export default function ProjectDetail() {
  const [, params] = useRoute('/projects/:id');
  const [, setLocation] = useLocation();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const projectId = parseInt(params?.id || '0', 10);
  const [selectedUserId, setSelectedUserId] = useState<string>('');
  const [isTaskDialogOpen, setIsTaskDialogOpen] = useState(false);

  const { data: project, isLoading: isLoadingProject } = useGetProject(projectId);
  const { data: assignments, isLoading: isLoadingAssignments } = useListProjectAssignments(projectId);
  const { data: allUsers } = useListUsers();
  const { data: tasks, isLoading: isLoadingTasks } = useListTasks({ projectId });

  const assignMutation = useAssignUserToProject();
  const removeMutation = useRemoveUserFromProject();
  const deleteTaskMutation = useDeleteTask();

  const isManager = ['avp', 'md'].includes(user?.role || '');

  const assignedIds = new Set((assignments || []).map(u => u.id));
  const unassignedUsers = (allUsers || []).filter(u => !assignedIds.has(u.id));

  const handleAssign = () => {
    if (!selectedUserId) return;
    assignMutation.mutate(
      { projectId, data: { userId: Number(selectedUserId) } },
      {
        onSuccess: () => {
          toast({ title: 'User assigned to project' });
          queryClient.invalidateQueries({ queryKey: getListProjectAssignmentsQueryKey(projectId) });
          setSelectedUserId('');
        },
        onError: (err: any) => toast({ variant: 'destructive', title: 'Error', description: err.error || 'Failed to assign user.' }),
      }
    );
  };

  const handleRemove = (userId: number) => {
    removeMutation.mutate(
      { projectId, userId },
      {
        onSuccess: () => {
          toast({ title: 'User removed from project' });
          queryClient.invalidateQueries({ queryKey: getListProjectAssignmentsQueryKey(projectId) });
        },
        onError: (err: any) => toast({ variant: 'destructive', title: 'Error', description: err.error || 'Failed to remove user.' }),
      }
    );
  };

  const handleDeleteTask = (taskId: number) => {
    if (confirm('Delete this task?')) {
      deleteTaskMutation.mutate({ taskId }, {
        onSuccess: () => {
          toast({ title: 'Task deleted' });
          queryClient.invalidateQueries({ queryKey: getListTasksQueryKey({ projectId }) });
        },
      });
    }
  };

  if (isLoadingProject) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (!project) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[50vh] gap-4">
        <p className="text-muted-foreground font-mono">PROJECT NOT FOUND</p>
        <Button variant="outline" onClick={() => setLocation('/projects')}>Back to Projects</Button>
      </div>
    );
  }

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      {/* Header */}
      <div>
        <Link href="/projects">
          <Button variant="ghost" className="text-muted-foreground hover:text-foreground mb-4 -ml-2 h-8">
            <ArrowLeft className="w-4 h-4 mr-1" />
            All Projects
          </Button>
        </Link>
        <div className="flex items-start gap-4">
          <div className="p-3 bg-primary/10 rounded-lg text-primary">
            <FolderKanban className="w-6 h-6" />
          </div>
          <div>
            <div className="text-xs font-mono text-primary mb-1 uppercase tracking-wider">{project.clientName}</div>
            <h1 className="text-3xl font-bold tracking-tight text-foreground">{project.name}</h1>
            <p className="text-muted-foreground font-mono text-sm mt-1">
              {project.description || 'No description provided.'}
            </p>
            <p className="text-xs text-muted-foreground font-mono mt-1 opacity-60">
              Created {format(new Date(project.createdAt), 'MMMM yyyy')}
            </p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Tasks */}
        <Card className="shadow-sm border-border">
          <CardHeader className="border-b border-border/50 bg-muted/20 pb-4">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base font-bold flex items-center gap-2">
                <CheckSquare className="w-4 h-4 text-primary" />
                Tasks
                <Badge variant="secondary" className="font-mono text-[10px]">
                  {tasks?.length || 0}
                </Badge>
              </CardTitle>
              {isManager && (
                <CreateTaskInlineDialog
                  open={isTaskDialogOpen}
                  onOpenChange={setIsTaskDialogOpen}
                  projectId={projectId}
                />
              )}
            </div>
          </CardHeader>
          <CardContent className="pt-4">
            {isLoadingTasks ? (
              <div className="space-y-3">
                {[1, 2, 3].map(i => <Skeleton key={i} className="h-12 w-full" />)}
              </div>
            ) : tasks && tasks.length > 0 ? (
              <div className="space-y-2">
                {tasks.map(t => (
                  <div key={t.id} className="flex items-center justify-between p-3 bg-muted/30 rounded-md group">
                    <div className="flex items-center gap-3">
                      <CheckSquare className="w-4 h-4 text-primary/50 shrink-0" />
                      <div>
                        <p className="text-sm font-medium text-foreground">{t.name}</p>
                        {t.description && (
                          <p className="text-xs text-muted-foreground">{t.description}</p>
                        )}
                      </div>
                    </div>
                    {isManager && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-muted-foreground hover:text-destructive hover:bg-destructive/10 opacity-0 group-hover:opacity-100 transition-opacity"
                        onClick={() => handleDeleteTask(t.id)}
                        disabled={deleteTaskMutation.isPending}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div className="py-8 text-center text-muted-foreground font-mono text-sm border border-dashed border-border rounded-md">
                NO TASKS YET
              </div>
            )}
          </CardContent>
        </Card>

        {/* Assigned Team Members */}
        <Card className="shadow-sm border-border">
          <CardHeader className="border-b border-border/50 bg-muted/20 pb-4">
            <CardTitle className="text-base font-bold flex items-center gap-2">
              <Users className="w-4 h-4 text-primary" />
              Assigned Team
              <Badge variant="secondary" className="font-mono text-[10px]">
                {assignments?.length || 0}
              </Badge>
            </CardTitle>
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
                <Button
                  size="sm"
                  onClick={handleAssign}
                  disabled={!selectedUserId || assignMutation.isPending}
                  className="shrink-0"
                >
                  <UserPlus className="w-4 h-4" />
                </Button>
              </div>
            )}

            {isLoadingAssignments ? (
              <div className="space-y-3">
                {[1, 2, 3].map(i => <Skeleton key={i} className="h-12 w-full" />)}
              </div>
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
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-muted-foreground hover:text-destructive hover:bg-destructive/10 opacity-0 group-hover:opacity-100 transition-opacity"
                        onClick={() => handleRemove(u.id)}
                        disabled={removeMutation.isPending}
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
      </div>
    </div>
  );
}

function CreateTaskInlineDialog({
  open,
  onOpenChange,
  projectId,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  projectId: number;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const createMutation = useCreateTask();

  const form = useForm<z.infer<typeof taskSchema>>({
    resolver: zodResolver(taskSchema),
    defaultValues: { name: '', description: '' },
  });

  const onSubmit = (data: z.infer<typeof taskSchema>) => {
    createMutation.mutate(
      { data: { ...data, projectId } },
      {
        onSuccess: () => {
          toast({ title: 'Task created' });
          queryClient.invalidateQueries({ queryKey: getListTasksQueryKey({ projectId }) });
          form.reset();
          onOpenChange(false);
        },
        onError: (err: any) => toast({ variant: 'destructive', title: 'Error', description: err.error || 'Failed to create task.' }),
      }
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button size="sm" className="h-7 text-xs">
          <Plus className="w-3.5 h-3.5 mr-1" />
          Add Task
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle>Create Task</DialogTitle>
          <DialogDescription>Add a new task to this project.</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 pt-4">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Task Name</FormLabel>
                  <FormControl>
                    <Input placeholder="Research & Discovery" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Description (Optional)</FormLabel>
                  <FormControl>
                    <Input placeholder="Brief details..." {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="pt-2 flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button type="submit" disabled={createMutation.isPending}>
                {createMutation.isPending ? 'Creating...' : 'Create Task'}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
