import React, { useState } from 'react';
import { useAuth } from '@/lib/auth';
import { 
  useListUsers, 
  useCreateUser,
  useUpdateUser,
  useDeleteUser,
  getListUsersQueryKey,
  UserInputRole
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
import { Plus, Trash2, ShieldCheck, Mail, PowerOff, Power } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

const userSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  email: z.string().email('Invalid email'),
  password: z.string().min(6, 'Password must be at least 6 characters'),
  role: z.enum(['analyst', 'associate', 'avp', 'md']),
  reportingToId: z.coerce.number().optional().nullable(),
});

export default function Team() {
  const { user: currentUser } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [showInactive, setShowInactive] = useState(false);
  
  const { data: users, isLoading } = useListUsers();
  const deleteMutation = useDeleteUser();
  const updateMutation = useUpdateUser();

  const isManager = ['avp', 'md'].includes(currentUser?.role || '');

  const handleDelete = (id: number) => {
    if (id === currentUser?.id) {
      toast({ variant: 'destructive', title: 'Action denied', description: 'You cannot delete yourself.' });
      return;
    }
    if (confirm('Are you sure you want to delete this user?')) {
      deleteMutation.mutate({ userId: id }, {
        onSuccess: () => {
          toast({ title: 'User deleted' });
          queryClient.invalidateQueries({ queryKey: getListUsersQueryKey() });
        },
        onError: (err: any) => {
          toast({ variant: 'destructive', title: 'Error', description: err.error || 'Failed to delete user.' });
        }
      });
    }
  };

  const handleToggleActive = (id: number, currentlyActive: boolean) => {
    updateMutation.mutate(
      { userId: id, data: { isActive: !currentlyActive } as any },
      {
        onSuccess: () => {
          toast({ title: currentlyActive ? 'User deactivated' : 'User reactivated' });
          queryClient.invalidateQueries({ queryKey: getListUsersQueryKey() });
        },
        onError: (err: any) => {
          toast({ variant: 'destructive', title: 'Error', description: err.error || 'Failed to update user.' });
        }
      }
    );
  };

  const displayed = (users || []).filter(u => showInactive || u.isActive !== false);
  const inactiveCount = (users || []).filter(u => u.isActive === false).length;

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">Team Directory</h1>
          <p className="text-muted-foreground font-mono text-sm mt-1">Organizational hierarchy and personnel</p>
        </div>
        
        <div className="flex items-center gap-2">
          {inactiveCount > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowInactive(v => !v)}
              className="text-xs gap-1.5"
            >
              {showInactive ? <Power className="w-3.5 h-3.5" /> : <PowerOff className="w-3.5 h-3.5" />}
              {showInactive ? 'Hide' : 'Show'} Inactive ({inactiveCount})
            </Button>
          )}
          {isManager && (
            <CreateUserDialog open={isDialogOpen} onOpenChange={setIsDialogOpen} users={users || []} />
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {isLoading ? (
          Array(8).fill(0).map((_, i) => (
            <Card key={i} className="shadow-sm border-border">
              <CardContent className="p-6 flex flex-col items-center text-center space-y-4">
                <Skeleton className="w-16 h-16 rounded-full" />
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-3 w-20 rounded-full" />
                <Skeleton className="h-3 w-40 mt-2" />
              </CardContent>
            </Card>
          ))
        ) : displayed.length > 0 ? (
          displayed.map((u) => {
            const isInactive = u.isActive === false;
            return (
              <Card key={u.id} className={`shadow-sm border-border hover:border-primary/30 transition-colors group ${isInactive ? 'opacity-60' : ''}`}>
                <CardContent className="p-6 flex flex-col relative h-full">
                  {isManager && u.id !== currentUser?.id && (
                    <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <Button
                        variant="ghost"
                        size="icon"
                        title={isInactive ? 'Reactivate user' : 'Deactivate user'}
                        className={`h-8 w-8 ${isInactive ? 'text-emerald-600 hover:bg-emerald-50' : 'text-amber-500 hover:bg-amber-50'}`}
                        onClick={() => handleToggleActive(u.id, !isInactive)}
                        disabled={updateMutation.isPending}
                      >
                        {isInactive ? <Power className="w-4 h-4" /> : <PowerOff className="w-4 h-4" />}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                        onClick={() => handleDelete(u.id)}
                        disabled={deleteMutation.isPending}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  )}
                  
                  <div className="flex flex-col items-center text-center mb-4">
                    <div className={`w-16 h-16 rounded-full flex items-center justify-center font-bold text-xl mb-3 shadow-inner ${isInactive ? 'bg-muted text-muted-foreground' : 'bg-primary/10 text-primary'}`}>
                      {u.name.substring(0, 2).toUpperCase()}
                    </div>
                    <h3 className="font-bold text-lg leading-tight text-foreground mb-1">{u.name}</h3>
                    <div className="flex items-center gap-1.5 flex-wrap justify-center">
                      <Badge variant="secondary" className="font-mono text-[10px] uppercase tracking-wider">
                        {u.role === 'md' && <ShieldCheck className="w-3 h-3 mr-1 text-amber-500" />}
                        {u.role}
                      </Badge>
                      {isInactive && (
                        <Badge variant="outline" className="text-[10px] font-mono text-amber-600 border-amber-300 bg-amber-50">
                          INACTIVE
                        </Badge>
                      )}
                    </div>
                  </div>
                  
                  <div className="mt-auto space-y-2 text-sm">
                    <div className="flex items-center gap-2 text-muted-foreground font-mono text-xs">
                      <Mail className="w-3 h-3" />
                      <span className="truncate">{u.email}</span>
                    </div>
                    {u.reportingToName && (
                      <div className="text-xs pt-2 border-t border-border/50 text-muted-foreground flex justify-between">
                        <span className="font-mono opacity-70">REPORTS TO</span>
                        <span className="font-medium text-foreground">{u.reportingToName}</span>
                      </div>
                    )}
                    <div className="text-[10px] pt-1 text-muted-foreground font-mono opacity-50 flex justify-between">
                      <span>JOINED</span>
                      <span>{format(new Date(u.createdAt), 'MMM yyyy')}</span>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })
        ) : (
          <div className="col-span-full py-12 text-center text-muted-foreground font-mono text-sm border border-dashed border-border rounded-lg">
            NO USERS FOUND
          </div>
        )}
      </div>
    </div>
  );
}

function CreateUserDialog({ open, onOpenChange, users }: { open: boolean, onOpenChange: (open: boolean) => void, users: any[] }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const createMutation = useCreateUser();

  const form = useForm<z.infer<typeof userSchema>>({
    resolver: zodResolver(userSchema),
    defaultValues: { name: '', email: '', password: '', role: 'analyst', reportingToId: null },
  });

  const onSubmit = (data: z.infer<typeof userSchema>) => {
    const payload = { ...data, reportingToId: data.reportingToId || undefined };
    createMutation.mutate({ data: payload as any }, {
      onSuccess: () => {
        toast({ title: 'User created' });
        queryClient.invalidateQueries({ queryKey: getListUsersQueryKey() });
        form.reset();
        onOpenChange(false);
      },
      onError: (err: any) => {
        toast({ variant: 'destructive', title: 'Error', description: err.error || 'Failed to create user.' });
      }
    });
  };

  const possibleManagers = users.filter(u => ['avp', 'md', 'associate'].includes(u.role));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button className="shadow-md font-semibold tracking-tight">
          <Plus className="w-4 h-4 mr-2" />
          Add Personnel
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Add Personnel</DialogTitle>
          <DialogDescription>Provision a new terminal account for a team member.</DialogDescription>
        </DialogHeader>
        
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 pt-4">
            <div className="grid grid-cols-2 gap-4">
              <FormField control={form.control} name="name" render={({ field }) => (
                <FormItem>
                  <FormLabel>Full Name</FormLabel>
                  <FormControl><Input placeholder="Jane Doe" {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="email" render={({ field }) => (
                <FormItem>
                  <FormLabel>Email</FormLabel>
                  <FormControl><Input type="email" placeholder="jane.doe@firm.com" {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
            </div>
            <FormField control={form.control} name="password" render={({ field }) => (
              <FormItem>
                <FormLabel>Initial Password</FormLabel>
                <FormControl><Input type="password" placeholder="Min 6 characters" {...field} /></FormControl>
                <FormMessage />
              </FormItem>
            )} />
            <div className="grid grid-cols-2 gap-4">
              <FormField control={form.control} name="role" render={({ field }) => (
                <FormItem>
                  <FormLabel>Role Level</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger><SelectValue placeholder="Select role" /></SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="analyst">Analyst</SelectItem>
                      <SelectItem value="associate">Associate</SelectItem>
                      <SelectItem value="avp">AVP</SelectItem>
                      <SelectItem value="md">Managing Director</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="reportingToId" render={({ field }) => (
                <FormItem>
                  <FormLabel>Reports To (Optional)</FormLabel>
                  <Select onValueChange={(val) => field.onChange(val === "none" ? null : Number(val))} value={field.value?.toString() || "none"}>
                    <FormControl>
                      <SelectTrigger><SelectValue placeholder="Select manager" /></SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="none">None</SelectItem>
                      {possibleManagers.map(m => (
                        <SelectItem key={m.id} value={m.id.toString()}>{m.name} ({m.role.toUpperCase()})</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )} />
            </div>
            <div className="pt-4 flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button type="submit" disabled={createMutation.isPending}>
                {createMutation.isPending ? 'Provisioning...' : 'Provision Account'}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
