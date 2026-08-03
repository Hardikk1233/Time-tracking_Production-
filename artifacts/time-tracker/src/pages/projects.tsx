import React, { useState } from 'react';
import { useAuth } from '@/lib/auth';
import { 
  useListProjects, 
  useCreateProject, 
  useDeleteProject,
  useListClients,
  getListProjectsQueryKey
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
import { Skeleton } from '@/components/ui/skeleton';
import { Plus, Trash2, FolderKanban, ChevronRight } from 'lucide-react';

const projectSchema = z.object({
  clientId: z.coerce.number().min(1, 'Client is required'),
  name: z.string().min(1, 'Name is required'),
  description: z.string().optional(),
});

export default function Projects() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [clientFilter, setClientFilter] = useState<string>('all');
  
  const queryParams = { 
    ...(clientFilter !== 'all' ? { clientId: Number(clientFilter) } : {}) 
  };
  
  const { data: projects, isLoading } = useListProjects(queryParams);
  const { data: clients } = useListClients();
  const deleteMutation = useDeleteProject();

  const isManager = ['avp', 'md'].includes(user?.role || '');

  const handleDelete = (id: number) => {
    if (confirm('Are you sure you want to delete this project?')) {
      deleteMutation.mutate({ projectId: id }, {
        onSuccess: () => {
          toast({ title: 'Project deleted' });
          queryClient.invalidateQueries({ queryKey: getListProjectsQueryKey() });
        }
      });
    }
  };

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">Projects</h1>
          <p className="text-muted-foreground font-mono text-sm mt-1">Client engagements and initiatives</p>
        </div>
        
        <div className="flex items-center gap-3">
          <Select value={clientFilter} onValueChange={setClientFilter}>
            <SelectTrigger className="w-[200px] bg-card">
              <SelectValue placeholder="All Clients" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Clients</SelectItem>
              {clients?.map(c => (
                <SelectItem key={c.id} value={c.id.toString()}>{c.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          {isManager && (
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
        ) : projects && projects.length > 0 ? (
          projects.map(project => (
            <Card key={project.id} className="shadow-sm border-border hover:border-primary/50 transition-colors group flex flex-col">
              <CardContent className="p-6 flex flex-col h-full">
                <div className="flex justify-between items-start mb-4">
                  <div className="p-2 bg-primary/10 rounded-md text-primary">
                    <FolderKanban className="w-5 h-5" />
                  </div>
                  {isManager && (
                    <Button 
                      variant="ghost" 
                      size="icon" 
                      className="h-8 w-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10 -mr-2 -mt-2 opacity-0 group-hover:opacity-100 transition-opacity"
                      onClick={(e) => { e.preventDefault(); handleDelete(project.id); }}
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  )}
                </div>
                <div className="text-xs font-mono text-primary mb-1">{project.clientName}</div>
                <h3 className="font-bold text-lg leading-tight text-foreground mb-2 line-clamp-1">{project.name}</h3>
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
          ))
        ) : (
          <div className="col-span-full py-12 text-center text-muted-foreground font-mono text-sm border border-dashed border-border rounded-lg">
            NO PROJECTS FOUND
          </div>
        )}
      </div>
    </div>
  );
}

function CreateProjectDialog({ open, onOpenChange, clients }: { open: boolean, onOpenChange: (open: boolean) => void, clients: any[] }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const createMutation = useCreateProject();

  const form = useForm<z.infer<typeof projectSchema>>({
    resolver: zodResolver(projectSchema),
    defaultValues: { clientId: undefined, name: '', description: '' },
  });

  const onSubmit = (data: z.infer<typeof projectSchema>) => {
    createMutation.mutate({ data }, {
      onSuccess: () => {
        toast({ title: 'Project created' });
        queryClient.invalidateQueries({ queryKey: getListProjectsQueryKey() });
        form.reset();
        onOpenChange(false);
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button className="shadow-md font-semibold tracking-tight">
          <Plus className="w-4 h-4 mr-2" />
          New Project
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>Create Project</DialogTitle>
          <DialogDescription>Create a new project under a client.</DialogDescription>
        </DialogHeader>
        
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 pt-4">
            <FormField
              control={form.control}
              name="clientId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Client</FormLabel>
                  <Select onValueChange={(val) => field.onChange(Number(val))} value={field.value?.toString()}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Select a client" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {clients.map(c => (
                        <SelectItem key={c.id} value={c.id.toString()}>{c.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Project Name</FormLabel>
                  <FormControl>
                    <Input placeholder="Phase 1 Implementation" {...field} />
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
                  <FormLabel>Description</FormLabel>
                  <FormControl>
                    <Input placeholder="Scope of work" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="pt-4 flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button type="submit" disabled={createMutation.isPending}>
                {createMutation.isPending ? 'Saving...' : 'Create'}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
