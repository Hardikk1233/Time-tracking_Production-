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
  useListProjectTasks,
  useListProjectTaskAssignments,
  useAssignTaskToProject,
  useCreateTask,
  useRemoveTaskFromProject,
  getListProjectAssignmentsQueryKey,
  getListProjectTasksQueryKey,
  getListTasksQueryKey,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/hooks/use-toast';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { ArrowLeft, FolderKanban, Users, CheckSquare, UserPlus, UserMinus, ShieldCheck, Plus } from 'lucide-react';
import { Link } from 'wouter';
import { TaskAssignees } from '@/components/task-assignees';
import { format } from 'date-fns';
import { errorMessage } from '@/lib/errors';

const ROLE_ORDER = ['md', 'avp', 'associate', 'analyst'] as const;
const ROLE_LABELS: Record<string, string> = { md: 'Managing Directors', avp: 'AVPs', associate: 'Associates', analyst: 'Analysts' };

export default function ProjectDetail() {
  const [, params] = useRoute('/projects/:id');
  const [, setLocation] = useLocation();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const projectId = parseInt(params?.id || '0', 10);
  const [selectedUserId, setSelectedUserId] = useState<string>('');
  const [selectedTaskId, setSelectedTaskId] = useState<string>('');
  const [newTaskName, setNewTaskName] = useState('');

  const { data: project, isLoading: isLoadingProject } = useGetProject(projectId);
  const { data: assignments, isLoading: isLoadingAssignments } = useListProjectAssignments(projectId);
  const { data: allUsers } = useListUsers();
  const { data: tasks, isLoading: isLoadingTasks } = useListProjectTasks(projectId);
  const { data: allTasks } = useListTasks();
  const { data: taskAssignments } = useListProjectTaskAssignments(projectId);

  const assignMutation = useAssignUserToProject();
  const removeMutation = useRemoveUserFromProject();
  const assignTaskMutation = useAssignTaskToProject();
  const removeTaskMutation = useRemoveTaskFromProject();
  const createTaskMutation = useCreateTask();

  // Associates and above can manage a project's team and tasks
  const isManager = ['associate', 'avp', 'md'].includes(user?.role || '');

  const assignedIds = new Set((assignments || []).map(u => u.id));
  const unassignedUsers = (allUsers || []).filter(u => !assignedIds.has(u.id));

  const enabledTaskIds = new Set((tasks || []).map(t => t.id));
  const unassignedTasks = (allTasks || []).filter(t => !enabledTaskIds.has(t.id));

  // Group assigned users by role
  const assignmentsByRole = ROLE_ORDER.reduce((acc, role) => {
    acc[role] = (assignments || []).filter(u => u.role === role);
    return acc;
  }, {} as Record<string, typeof assignments>);

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
        onError: (err: any) => toast({ variant: 'destructive', title: 'Error', description: errorMessage(err, 'Failed to assign.') }),
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
        onError: (err: any) => toast({ variant: 'destructive', title: 'Error', description: errorMessage(err, 'Failed to remove.') }),
      }
    );
  };

  /**
   * Define a task and switch it on for this project in one go.
   *
   * A name already in the catalog is reused rather than rejected: the catalog
   * is firm-wide and unique on name, so "Research" typed on a second project
   * should enable the existing one, not fail with a conflict the person cannot
   * act on.
   */
  const handleCreateAndEnableTask = () => {
    const name = newTaskName.trim();
    if (!name) return;

    const existing = (allTasks || []).find(
      t => t.name.trim().toLowerCase() === name.toLowerCase(),
    );

    const enable = (taskId: number) => {
      assignTaskMutation.mutate(
        { projectId, data: { taskId } },
        {
          onSuccess: () => {
            setNewTaskName('');
            queryClient.invalidateQueries({ queryKey: getListProjectTasksQueryKey(projectId) });
            queryClient.invalidateQueries({ queryKey: getListTasksQueryKey() });
          },
          onError: (err: any) =>
            toast({ variant: 'destructive', title: 'Error', description: errorMessage(err, 'Failed to enable task.') }),
        },
      );
    };

    if (existing) {
      enable(existing.id);
      return;
    }

    createTaskMutation.mutate(
      { data: { name } },
      {
        onSuccess: created => enable(created.id),
        onError: (err: any) =>
          toast({ variant: 'destructive', title: 'Error', description: errorMessage(err, 'Failed to create task.') }),
      },
    );
  };

  const handleAssignTask = () => {
    if (!selectedTaskId) return;
    assignTaskMutation.mutate(
      { projectId, data: { taskId: Number(selectedTaskId) } },
      {
        onSuccess: () => {
          toast({ title: 'Task enabled for project' });
          queryClient.invalidateQueries({ queryKey: getListProjectTasksQueryKey(projectId) });
          setSelectedTaskId('');
        },
        onError: (err: any) => toast({ variant: 'destructive', title: 'Error', description: errorMessage(err, 'Failed to enable task.') }),
      }
    );
  };

  const handleRemoveTask = (taskId: number) => {
    if (confirm('Remove this task from the project? Time entries already logged against it will be unaffected.')) {
      removeTaskMutation.mutate(
        { projectId, taskId },
        {
          onSuccess: () => {
            toast({ title: 'Task removed from project' });
            queryClient.invalidateQueries({ queryKey: getListProjectTasksQueryKey(projectId) });
          },
          onError: (err: any) => toast({ variant: 'destructive', title: 'Error', description: errorMessage(err, 'Failed to remove task.') }),
        }
      );
    }
  };

  if (isLoadingProject) {
    return <div className="space-y-6"><Skeleton className="h-10 w-48" /><Skeleton className="h-32 w-full" /></div>;
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
            <p className="text-muted-foreground font-mono text-sm mt-1">{project.description || 'No description provided.'}</p>
            <p className="text-xs text-muted-foreground font-mono mt-1 opacity-60">Created {format(new Date(project.createdAt), 'MMMM yyyy')}</p>
          </div>
        </div>
      </div>

      {/* Project summary strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {ROLE_ORDER.map(role => {
          const group = assignmentsByRole[role] || [];
          return (
            <div key={role} className="bg-muted/30 border border-border/50 rounded-lg p-3 flex flex-col gap-1">
              <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">{ROLE_LABELS[role]}</span>
              <span className="text-2xl font-bold font-mono text-foreground">{group.length}</span>
              <div className="flex flex-wrap gap-1 mt-0.5">
                {group.slice(0, 3).map(u => (
                  <span key={u.id} className="text-[10px] bg-primary/10 text-primary px-1.5 py-0.5 rounded font-medium truncate max-w-[80px]">{u.name.split(' ')[0]}</span>
                ))}
                {group.length > 3 && <span className="text-[10px] text-muted-foreground">+{group.length - 3}</span>}
              </div>
            </div>
          );
        })}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Tasks */}
        <Card className="shadow-sm border-border">
          <CardHeader className="border-b border-border/50 bg-muted/20 pb-4">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base font-bold flex items-center gap-2">
                <CheckSquare className="w-4 h-4 text-primary" />
                Tasks
                <Badge variant="secondary" className="font-mono text-[10px]">{tasks?.length || 0}</Badge>
              </CardTitle>
            </div>
          </CardHeader>
          <CardContent className="pt-4 space-y-4">
            {isManager && (
              <div className="space-y-2">
                {/* Naming a task and enabling it are one action here. Sending
                    somebody to the catalog to define it first, then back to the
                    project to switch it on, is the round trip that made this
                    panel look broken when the catalog was empty. */}
                <div className="flex gap-2">
                  <Input
                    value={newTaskName}
                    onChange={e => setNewTaskName(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        handleCreateAndEnableTask();
                      }
                    }}
                    placeholder="Add a task — e.g. Investment Memo"
                    className="flex-1 bg-background"
                  />
                  <Button
                    size="sm"
                    onClick={handleCreateAndEnableTask}
                    disabled={!newTaskName.trim() || createTaskMutation.isPending || assignTaskMutation.isPending}
                    className="shrink-0"
                  >
                    <Plus className="w-4 h-4" />
                  </Button>
                </div>

                {/* Only worth offering once something exists to reuse. */}
                {unassignedTasks.length > 0 && (
                  <div className="flex gap-2">
                    <Select value={selectedTaskId} onValueChange={setSelectedTaskId}>
                      <SelectTrigger className="flex-1 bg-background">
                        <SelectValue placeholder="…or reuse one from the catalog" />
                      </SelectTrigger>
                      <SelectContent>
                        {unassignedTasks.map(t => (
                          <SelectItem key={t.id} value={t.id.toString()}>{t.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button size="sm" variant="outline" onClick={handleAssignTask} disabled={!selectedTaskId || assignTaskMutation.isPending} className="shrink-0">
                      <CheckSquare className="w-4 h-4" />
                    </Button>
                  </div>
                )}
              </div>
            )}

            {isLoadingTasks ? (
              <div className="space-y-3">{[1, 2, 3].map(i => <Skeleton key={i} className="h-12 w-full" />)}</div>
            ) : tasks && tasks.length > 0 ? (
              <div className="space-y-2">
                {tasks.map(t => (
                  <div key={t.id} className="flex items-start justify-between gap-3 p-3 bg-muted/30 rounded-md group">
                    <div className="flex items-start gap-3 min-w-0">
                      <CheckSquare className="w-4 h-4 text-primary/50 shrink-0 mt-0.5" />
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-foreground">{t.name}</p>
                        {t.description && <p className="text-xs text-muted-foreground">{t.description}</p>}
                        {/* Who is expected to do this. Not a restriction on who
                            may log against it — anyone on the project still can. */}
                        <TaskAssignees
                          projectId={projectId}
                          taskId={t.id}
                          assignments={taskAssignments || []}
                          members={assignments || []}
                          myUserId={user?.id ?? 0}
                          myRole={user?.role ?? 'analyst'}
                        />
                      </div>
                    </div>
                    {isManager && (
                      <Button
                        variant="ghost" size="icon"
                        className="h-7 w-7 text-muted-foreground hover:text-destructive hover:bg-destructive/10 opacity-0 group-hover:opacity-100 transition-opacity"
                        onClick={() => handleRemoveTask(t.id)}
                        disabled={removeTaskMutation.isPending}
                      >
                        <UserMinus className="w-3.5 h-3.5" />
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div className="py-8 text-center text-muted-foreground font-mono text-sm border border-dashed border-border rounded-md">NO TASKS ENABLED YET</div>
            )}
          </CardContent>
        </Card>

        {/* Team Assignments — grouped by role */}
        <Card className="shadow-sm border-border">
          <CardHeader className="border-b border-border/50 bg-muted/20 pb-4">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base font-bold flex items-center gap-2">
                <Users className="w-4 h-4 text-primary" />
                Project Team
                <Badge variant="secondary" className="font-mono text-[10px]">{assignments?.length || 0}</Badge>
              </CardTitle>
            </div>
          </CardHeader>
          <CardContent className="pt-4 space-y-4">
            {isManager && (
              <div className="flex gap-2">
                <Select value={selectedUserId} onValueChange={setSelectedUserId}>
                  <SelectTrigger className="flex-1 bg-background">
                    <SelectValue placeholder="Add a team member..." />
                  </SelectTrigger>
                  <SelectContent>
                    {unassignedUsers.length === 0 ? (
                      <div className="p-2 text-sm text-muted-foreground text-center">All users assigned</div>
                    ) : (
                      unassignedUsers.map(u => (
                        <SelectItem key={u.id} value={u.id.toString()}>
                          {u.name} <span className="text-muted-foreground text-xs capitalize">({u.role})</span>
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
              <div className="space-y-3">{[1, 2, 3].map(i => <Skeleton key={i} className="h-10 w-full" />)}</div>
            ) : assignments && assignments.length > 0 ? (
              <div className="space-y-4">
                {ROLE_ORDER.map(role => {
                  const group = assignmentsByRole[role] || [];
                  if (group.length === 0) return null;
                  return (
                    <div key={role}>
                      <p className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1">
                        {role === 'md' && <ShieldCheck className="w-3 h-3 text-amber-500" />}
                        {ROLE_LABELS[role]}
                      </p>
                      <div className="space-y-1.5">
                        {group.map(u => (
                          <div key={u.id} className="flex items-center justify-between p-2.5 bg-muted/30 rounded-md group">
                            <div className="flex items-center gap-2.5">
                              <div className="w-7 h-7 rounded-full bg-primary/10 text-primary flex items-center justify-center font-bold text-[10px]">
                                {u.name.substring(0, 2).toUpperCase()}
                              </div>
                              <span className="text-sm font-medium text-foreground">{u.name}</span>
                            </div>
                            {isManager && (
                              <Button
                                variant="ghost" size="icon"
                                className="h-6 w-6 text-muted-foreground hover:text-destructive hover:bg-destructive/10 opacity-0 group-hover:opacity-100 transition-opacity"
                                onClick={() => handleRemove(u.id)}
                                disabled={removeMutation.isPending}
                              >
                                <UserMinus className="w-3 h-3" />
                              </Button>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="py-8 text-center text-muted-foreground font-mono text-sm border border-dashed border-border rounded-md">NO TEAM MEMBERS ASSIGNED</div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

