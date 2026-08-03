import React, { useState } from 'react';
import { useAuth } from '@/lib/auth';
import { 
  useListTasks, 
  useCreateTask, 
  useDeleteTask,
  useListProjects,
  getListTasksQueryKey
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { useToast } from '@/hooks/use-toast';
import { format } from 'date-fns';

import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Skeleton } from '@/components/ui/skeleton';
import { Plus, Trash2, CheckSquare } from 'lucide-react';

const taskSchema = z.object({
  projectId: z.coerce.number().min(1, 'Project is required'),
  name: z.string().min(1, 'Name is required'),
  description: z.string().optional(),
});

export default function Tasks() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [projectFilter, setProjectFilter] = useState<string>('all');
  
  const queryParams = { 
    ...(projectFilter !== 'all' ? { projectId: Number(projectFilter) } : {}) 
  };
  
  const { data: tasks, isLoading } = useListTasks(queryParams);
  const { data: projects } = useListProjects();
  const deleteMutation = useDeleteTask();

  const isManager = ['avp', 'md'].includes(user?.role || '');

  const handleDelete = (id: number) => {
    if (confirm('Are you sure you want to delete this task?')) {
      deleteMutation.mutate({ taskId: id }, {
        onSuccess: () => {
          toast({ title: 'Task deleted' });
          queryClient.invalidateQueries({ queryKey: getListTasksQueryKey() });
        }
      });
    }
  };

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">Tasks</h1>
          <p className="text-muted-foreground font-mono text-sm mt-1">Billable units of work</p>
        </div>
        
        <div className="flex items-center gap-3">
          <Select value={projectFilter} onValueChange={setProjectFilter}>
            <SelectTrigger className="w-[250px] bg-card">
              <SelectValue placeholder="All Projects" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Projects</SelectItem>
              {projects?.map(p => (
                <SelectItem key={p.id} value={p.id.toString()}>{p.clientName} - {p.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          {isManager && (
            <CreateTaskDialog open={isDialogOpen} onOpenChange={setIsDialogOpen} projects={projects || []} />
          )}
        </div>
      </div>

      <Card className="shadow-sm border-border overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/30 text-left text-xs uppercase tracking-wider font-mono text-muted-foreground">
                <th className="px-6 py-4 font-medium">Task Name</th>
                <th className="px-6 py-4 font-medium">Project</th>
                <th className="px-6 py-4 font-medium">Client</th>
                <th className="px-6 py-4 font-medium">Created</th>
                {isManager && <th className="px-6 py-4 font-medium text-right">Actions</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-border/50">
              {isLoading ? (
                Array(5).fill(0).map((_, i) => (
                  <tr key={i}>
                    <td className="px-6 py-4"><Skeleton className="h-4 w-48" /></td>
                    <td className="px-6 py-4"><Skeleton className="h-4 w-32" /></td>
                    <td className="px-6 py-4"><Skeleton className="h-4 w-24" /></td>
                    <td className="px-6 py-4"><Skeleton className="h-4 w-20" /></td>
                    {isManager && <td className="px-6 py-4"><Skeleton className="h-8 w-8 ml-auto" /></td>}
                  </tr>
                ))
              ) : tasks && tasks.length > 0 ? (
                tasks.map((task) => (
                  <tr key={task.id} className="hover:bg-muted/10 transition-colors">
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-3">
                        <CheckSquare className="w-4 h-4 text-primary opacity-50" />
                        <div className="flex flex-col">
                          <span className="font-medium text-foreground">{task.name}</span>
                          {task.description && <span className="text-xs text-muted-foreground">{task.description}</span>}
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-4 font-medium">{task.projectName}</td>
                    <td className="px-6 py-4 font-mono text-xs text-muted-foreground">{task.clientName}</td>
                    <td className="px-6 py-4 font-mono text-xs text-muted-foreground">
                      {format(new Date(task.createdAt), 'MMM dd, yyyy')}
                    </td>
                    {isManager && (
                      <td className="px-6 py-4 text-right">
                        <Button 
                          variant="ghost" 
                          size="icon" 
                          className="h-8 w-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                          onClick={() => handleDelete(task.id)}
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </td>
                    )}
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={isManager ? 5 : 4} className="px-6 py-12 text-center text-muted-foreground font-mono text-sm border-b-0">
                    NO TASKS FOUND
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

function CreateTaskDialog({ open, onOpenChange, projects }: { open: boolean, onOpenChange: (open: boolean) => void, projects: any[] }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const createMutation = useCreateTask();

  const form = useForm<z.infer<typeof taskSchema>>({
    resolver: zodResolver(taskSchema),
    defaultValues: { projectId: undefined, name: '', description: '' },
  });

  const onSubmit = (data: z.infer<typeof taskSchema>) => {
    createMutation.mutate({ data }, {
      onSuccess: () => {
        toast({ title: 'Task created' });
        queryClient.invalidateQueries({ queryKey: getListTasksQueryKey() });
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
          New Task
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>Create Task</DialogTitle>
          <DialogDescription>Define a specific unit of work for time tracking.</DialogDescription>
        </DialogHeader>
        
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 pt-4">
            <FormField
              control={form.control}
              name="projectId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Project</FormLabel>
                  <Select onValueChange={(val) => field.onChange(Number(val))} value={field.value?.toString()}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Select a project" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {projects.map(p => (
                        <SelectItem key={p.id} value={p.id.toString()}>{p.clientName} - {p.name}</SelectItem>
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
                  <FormLabel>Description</FormLabel>
                  <FormControl>
                    <Input placeholder="Brief details about the task" {...field} />
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
