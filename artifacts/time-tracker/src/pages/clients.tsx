import React, { useState } from 'react';
import { Link } from 'wouter';
import { useAuth } from '@/lib/auth';
import {
  useListClients,
  useCreateClient,
  useUpdateClient,
  useDeleteClient,
  useListUsers,
  getListClientsQueryKey,
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
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Plus, Trash2, Building2, ChevronRight, Users, PowerOff, Power } from 'lucide-react';

const clientSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  description: z.string().optional(),
  fteCount: z.coerce.number().min(0.1, 'Min 0.1 FTE').max(100, 'Max 100 FTEs').default(1),
  associateIds: z.array(z.number()).optional(),
});
type ClientForm = z.infer<typeof clientSchema>;

export default function Clients() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [showInactive, setShowInactive] = useState(false);

  const { data: clients, isLoading } = useListClients();
  const deleteMutation = useDeleteClient();
  const updateMutation = useUpdateClient();

  const isManager = ['avp', 'md'].includes(user?.role || '');

  const handleDelete = (id: number) => {
    if (confirm('Are you sure you want to delete this client?')) {
      deleteMutation.mutate({ clientId: id }, {
        onSuccess: () => {
          toast({ title: 'Client deleted' });
          queryClient.invalidateQueries({ queryKey: getListClientsQueryKey() });
        },
        onError: (err: any) => {
          toast({ variant: 'destructive', title: 'Error', description: err.error || 'Failed to delete client.' });
        }
      });
    }
  };

  const handleToggleActive = (id: number, currentlyActive: boolean) => {
    updateMutation.mutate(
      { clientId: id, data: { isActive: !currentlyActive } as any },
      {
        onSuccess: () => {
          toast({ title: currentlyActive ? 'Client set to inactive' : 'Client reactivated' });
          queryClient.invalidateQueries({ queryKey: getListClientsQueryKey() });
        },
        onError: (err: any) => {
          toast({ variant: 'destructive', title: 'Error', description: err.error || 'Failed to update client.' });
        }
      }
    );
  };

  const allClients = clients || [];
  const inactiveCount = allClients.filter(c => c.isActive === false).length;
  const displayed = allClients.filter(c => showInactive || c.isActive !== false);

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">Clients</h1>
          <p className="text-muted-foreground font-mono text-sm mt-1">Manage client portfolios</p>
        </div>

        <div className="flex items-center gap-2">
          {isManager && inactiveCount > 0 && (
            <Button variant="outline" size="sm" onClick={() => setShowInactive(v => !v)} className="text-xs gap-1.5">
              {showInactive ? <Power className="w-3.5 h-3.5" /> : <PowerOff className="w-3.5 h-3.5" />}
              {showInactive ? 'Hide' : 'Show'} Inactive ({inactiveCount})
            </Button>
          )}
          {isManager && (
            <CreateClientDialog open={isDialogOpen} onOpenChange={setIsDialogOpen} />
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
          displayed.map(client => {
            const isInactive = client.isActive === false;
            return (
              <Card key={client.id} className={`shadow-sm border-border hover:border-primary/50 transition-colors group flex flex-col ${isInactive ? 'opacity-60' : ''}`}>
                <CardContent className="p-6 flex flex-col h-full">
                  <div className="flex justify-between items-start mb-4">
                    <div className={`p-2 rounded-md ${isInactive ? 'bg-muted text-muted-foreground' : 'bg-primary/10 text-primary'}`}>
                      <Building2 className="w-5 h-5" />
                    </div>
                    {isManager && (
                      <div className="flex gap-1 -mr-2 -mt-2 opacity-0 group-hover:opacity-100 transition-opacity">
                        <Button
                          variant="ghost"
                          size="icon"
                          title={isInactive ? 'Reactivate client' : 'Set inactive'}
                          className={`h-8 w-8 ${isInactive ? 'text-emerald-600 hover:bg-emerald-50' : 'text-amber-500 hover:bg-amber-50'}`}
                          onClick={(e) => { e.preventDefault(); handleToggleActive(client.id, !isInactive); }}
                          disabled={updateMutation.isPending}
                        >
                          {isInactive ? <Power className="w-4 h-4" /> : <PowerOff className="w-4 h-4" />}
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                          onClick={(e) => { e.preventDefault(); handleDelete(client.id); }}
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    )}
                  </div>

                  <div className="flex items-center gap-2 mb-1">
                    <h3 className="font-bold text-lg leading-tight text-foreground line-clamp-1">{client.name}</h3>
                    {isInactive && (
                      <Badge variant="outline" className="text-[10px] font-mono text-amber-600 border-amber-300 bg-amber-50 shrink-0">
                        INACTIVE
                      </Badge>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground line-clamp-2 mb-3 flex-1">
                    {client.description || 'No description provided.'}
                  </p>

                  <div className="flex items-center gap-2 mb-4">
                    <Badge variant="outline" className="text-xs font-mono text-primary border-primary/30 bg-primary/5">
                      <Users className="w-3 h-3 mr-1" />
                      {client.fteCount ?? 1} FTE
                    </Badge>
                    <span className="text-xs text-muted-foreground font-mono">
                      {(((client.fteCount ?? 1) * 160)).toFixed(0)}h/mo capacity
                    </span>
                  </div>

                  <div className="flex items-center justify-between mt-auto pt-4 border-t border-border/50">
                    <span className="text-xs font-mono text-muted-foreground">
                      Added {format(new Date(client.createdAt), 'MMM yyyy')}
                    </span>
                    <Link href={`/clients/${client.id}`}>
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
            NO CLIENTS FOUND
          </div>
        )}
      </div>
    </div>
  );
}

function CreateClientDialog({ open, onOpenChange }: { open: boolean, onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const createMutation = useCreateClient();
  const { data: associates } = useListUsers({ role: 'associate' } as any);

  const form = useForm<ClientForm>({
    resolver: zodResolver(clientSchema),
    defaultValues: { name: '', description: '', fteCount: 1, associateIds: [] },
  });

  const selectedAssociateIds: number[] = form.watch('associateIds') ?? [];

  const toggleAssociate = (id: number) => {
    const current = form.getValues('associateIds') ?? [];
    form.setValue('associateIds', current.includes(id) ? current.filter(x => x !== id) : [...current, id]);
  };

  const onSubmit = (data: ClientForm) => {
    createMutation.mutate(
      { data: { name: data.name, description: data.description, fteCount: data.fteCount, associateIds: data.associateIds } as any },
      {
        onSuccess: () => {
          toast({ title: 'Client created' });
          queryClient.invalidateQueries({ queryKey: getListClientsQueryKey() });
          form.reset({ name: '', description: '', fteCount: 1, associateIds: [] });
          onOpenChange(false);
        },
        onError: (err: any) => {
          toast({ variant: 'destructive', title: 'Error', description: err.error || 'Failed to create client.' });
        }
      }
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button className="shadow-md font-semibold tracking-tight">
          <Plus className="w-4 h-4 mr-2" />New Client
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>Create Client</DialogTitle>
          <DialogDescription>Add a new client to the firm's portfolio.</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 pt-4">
            <FormField control={form.control} name="name" render={({ field }) => (
              <FormItem>
                <FormLabel>Client Name</FormLabel>
                <FormControl><Input placeholder="Acme Corp" {...field} /></FormControl>
                <FormMessage />
              </FormItem>
            )} />
            <FormField control={form.control} name="description" render={({ field }) => (
              <FormItem>
                <FormLabel>Description <span className="text-muted-foreground font-normal">(Optional)</span></FormLabel>
                <FormControl><Input placeholder="Brief overview of the client" {...field} /></FormControl>
                <FormMessage />
              </FormItem>
            )} />
            <FormField control={form.control} name="fteCount" render={({ field }) => (
              <FormItem>
                <FormLabel>No. of FTEs</FormLabel>
                <FormControl>
                  <Input type="number" step="0.1" min="0.1" max="100" placeholder="1" {...field} />
                </FormControl>
                <p className="text-xs text-muted-foreground mt-1">
                  1 FTE = 8 h/day · 40 h/week · 160 h/month capacity
                  {field.value > 0 && <> — <span className="text-primary font-medium">{(field.value * 160).toFixed(0)} h/mo total</span></>}
                </p>
                <FormMessage />
              </FormItem>
            )} />
            <div className="space-y-2">
              <Label>Associates Responsible <span className="text-muted-foreground font-normal">(Optional)</span></Label>
              {associates && associates.length > 0 ? (
                <div className="grid grid-cols-1 gap-1 max-h-36 overflow-y-auto rounded-md border border-input bg-background p-2">
                  {associates.map((a) => {
                    const selected = selectedAssociateIds.includes(a.id);
                    return (
                      <button key={a.id} type="button" onClick={() => toggleAssociate(a.id)}
                        className={`flex items-center gap-2 rounded px-2 py-1.5 text-sm transition-colors text-left ${selected ? 'bg-primary/10 text-primary font-medium' : 'hover:bg-muted text-foreground'}`}>
                        <div className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 ${selected ? 'bg-primary border-primary' : 'border-input'}`}>
                          {selected && <svg className="w-2.5 h-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>}
                        </div>
                        <span>{a.name}</span>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground italic">No associates found.</p>
              )}
              {selectedAssociateIds.length > 0 && <p className="text-xs text-primary mt-1 font-mono">{selectedAssociateIds.length} selected</p>}
            </div>
            <div className="pt-4 flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button type="submit" disabled={createMutation.isPending}>{createMutation.isPending ? 'Saving...' : 'Create'}</Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
