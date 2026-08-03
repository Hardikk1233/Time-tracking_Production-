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
  getListClientAssignmentsQueryKey,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/hooks/use-toast';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { ArrowLeft, Building2, Users, FolderKanban, UserPlus, UserMinus, ChevronRight } from 'lucide-react';
import { Link } from 'wouter';
import { format } from 'date-fns';

export default function ClientDetail() {
  const [, params] = useRoute('/clients/:id');
  const [, setLocation] = useLocation();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const clientId = parseInt(params?.id || '0', 10);
  const [selectedUserId, setSelectedUserId] = useState<string>('');

  const { data: client, isLoading: isLoadingClient } = useGetClient(clientId);
  const { data: assignments, isLoading: isLoadingAssignments } = useListClientAssignments(clientId);
  const { data: allUsers } = useListUsers();
  const { data: projects, isLoading: isLoadingProjects } = useListProjects({ clientId });

  const assignMutation = useAssignUserToClient();
  const removeMutation = useRemoveUserFromClient();

  const isManager = ['avp', 'md'].includes(user?.role || '');

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
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-foreground">{client.name}</h1>
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

        {/* Projects */}
        <Card className="shadow-sm border-border">
          <CardHeader className="border-b border-border/50 bg-muted/20 pb-4">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base font-bold flex items-center gap-2">
                <FolderKanban className="w-4 h-4 text-primary" />
                Projects
                <Badge variant="secondary" className="font-mono text-[10px]">
                  {projects?.length || 0}
                </Badge>
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
              <div className="space-y-3">
                {[1, 2, 3].map(i => <Skeleton key={i} className="h-12 w-full" />)}
              </div>
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
                          <p className="text-sm font-medium text-foreground">{p.name}</p>
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
    </div>
  );
}
