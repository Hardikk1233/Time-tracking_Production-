import React, { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { format } from 'date-fns';
import {
  useGetClientHourBlocks,
  useCreateHourBlock,
  useDeleteHourBlock,
  useListClientProductAssignments,
  useAssignProduct,
  useDeleteProductAssignment,
  useListProducts,
  useListUsers,
  getGetClientHourBlocksQueryKey,
  getListClientProductAssignmentsQueryKey,
} from '@workspace/api-client-react';
import { useToast } from '@/hooks/use-toast';
import { displayTitle } from '@/lib/roles';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Plus, Trash2, Clock, Package } from 'lucide-react';
import { errorMessage } from '@/lib/errors';

/**
 * The two engagement panels on a client page.
 *
 * Which one is shown is decided by the client engagement type, so a client is
 * never asked for hours it did not buy or products it does not receive.
 */

// ─── Block of hours ──────────────────────────────────────────────────────────

const hourBlockSchema = z.object({
  hours: z.coerce.number().positive('Hours must be greater than zero'),
  purchasedOn: z.string().min(1, 'Purchase date is required'),
  note: z.string().optional(),
});
type HourBlockForm = z.infer<typeof hourBlockSchema>;

function Stat({ label, value, tone, muted }: { label: string; value: number; tone?: 'ok' | 'warn' | 'danger'; muted?: boolean }) {
  const color =
    tone === 'danger' ? 'text-destructive' :
    tone === 'warn' ? 'text-amber-600' :
    muted ? 'text-muted-foreground' : 'text-foreground';
  return (
    <div className="p-3 rounded-md border border-border/50 bg-muted/10">
      <p className="text-[10px] uppercase tracking-wider font-mono text-muted-foreground">{label}</p>
      <p className={`text-lg font-bold font-mono ${color}`}>{value.toFixed(1)}h</p>
    </div>
  );
}

/**
 * What the client bought and what is left of it.
 *
 * The balance comes from the API rather than being summed here: consumption
 * spans every project on the client, which this page does not load.
 */
export function HourBlocksCard({ clientId, canManage }: { clientId: number; canManage: boolean }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);

  const { data, isLoading } = useGetClientHourBlocks(clientId);
  const deleteMutation = useDeleteHourBlock();

  const handleDelete = (id: number) => {
    if (confirm('Remove this block? Use this only for a purchase recorded in error.')) {
      deleteMutation.mutate({ hourBlockId: id }, {
        onSuccess: () => {
          toast({ title: 'Block removed' });
          queryClient.invalidateQueries({ queryKey: getGetClientHourBlocksQueryKey(clientId) });
        },
        onError: (err: any) => {
          toast({ variant: 'destructive', title: 'Error', description: errorMessage(err, 'Failed to remove block.') });
        },
      });
    }
  };

  const purchased = data?.purchasedHours ?? 0;
  const consumed = data?.consumedHours ?? 0;
  const remaining = data?.remainingHours ?? 0;
  const awaiting = consumed - (data?.approvedHours ?? 0);
  const usedPct = purchased > 0 ? Math.min(100, (consumed / purchased) * 100) : 0;

  return (
    <Card className="shadow-sm border-border">
      <CardHeader className="border-b border-border/50 bg-muted/20 pb-4">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base font-bold flex items-center gap-2">
            <Clock className="w-4 h-4 text-primary" />
            Block of Hours
            <Badge variant="secondary" className="font-mono text-[10px]">{data?.blocks?.length ?? 0}</Badge>
          </CardTitle>
          {canManage && <AddHourBlockDialog open={open} onOpenChange={setOpen} clientId={clientId} />}
        </div>
      </CardHeader>
      <CardContent className="pt-4">
        {isLoading ? (
          <div className="space-y-3">{[1, 2, 3].map(i => <Skeleton key={i} className="h-12 w-full" />)}</div>
        ) : (
          <>
            <div className="mb-4 grid grid-cols-2 sm:grid-cols-4 gap-3">
              <Stat label="Purchased" value={purchased} />
              <Stat label="Used" value={consumed} />
              <Stat
                label="Remaining"
                value={remaining}
                tone={remaining < 0 ? 'danger' : purchased > 0 && remaining <= purchased * 0.1 ? 'warn' : 'ok'}
              />
              <Stat label="Awaiting approval" value={awaiting} muted />
            </div>

            <div className="mb-4 h-2 w-full rounded-full bg-muted overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${remaining < 0 ? 'bg-destructive' : usedPct > 90 ? 'bg-amber-500' : 'bg-primary'}`}
                style={{ width: `${usedPct}%` }}
              />
            </div>

            {remaining < 0 && (
              <p className="mb-4 text-xs font-mono text-destructive">
                OVERRUN BY {Math.abs(remaining).toFixed(1)}H — more time has been logged than was bought.
              </p>
            )}

            <p className="mb-4 text-xs text-muted-foreground">
              Hours awaiting approval already draw the balance down: the work has been done,
              and a balance that ignored it would read high for as long as approval lags.
              Rejected entries do not count.
            </p>

            {data?.blocks && data.blocks.length > 0 ? (
              <div className="space-y-2">
                {data.blocks.map((b) => (
                  <div key={b.id} className="flex items-center justify-between gap-3 p-3 rounded-md border border-border/50 hover:bg-muted/10 transition-colors">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-foreground font-mono">{b.hours}h</span>
                        <span className="text-xs text-muted-foreground font-mono">
                          {format(new Date(b.purchasedOn), 'MMM dd, yyyy')}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground truncate">
                        {b.note || 'No note'} · recorded by {b.createdByName}
                      </p>
                    </div>
                    {canManage && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                        onClick={() => handleDelete(b.id)}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div className="py-8 text-center text-muted-foreground font-mono text-sm border border-dashed border-border rounded-md">
                <p>NO HOURS PURCHASED</p>
                {canManage && <p className="text-xs mt-1 opacity-70">Record the first block to start tracking a balance.</p>}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function AddHourBlockDialog({ open, onOpenChange, clientId }: { open: boolean; onOpenChange: (v: boolean) => void; clientId: number }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const createMutation = useCreateHourBlock();

  const blank = { hours: 0, purchasedOn: format(new Date(), 'yyyy-MM-dd'), note: '' };

  const form = useForm<HourBlockForm>({
    resolver: zodResolver(hourBlockSchema),
    defaultValues: blank,
  });

  const onSubmit = (data: HourBlockForm) => {
    createMutation.mutate({ clientId, data }, {
      onSuccess: () => {
        toast({ title: 'Purchase recorded' });
        queryClient.invalidateQueries({ queryKey: getGetClientHourBlocksQueryKey(clientId) });
        form.reset(blank);
        onOpenChange(false);
      },
      onError: (err: any) => {
        toast({ variant: 'destructive', title: 'Error', description: errorMessage(err, 'Failed to record purchase.') });
      },
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button size="sm" className="h-8 text-xs font-semibold">
          <Plus className="w-3.5 h-3.5 mr-1" />
          Record Purchase
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>Record a Purchase</DialogTitle>
          <DialogDescription>
            A top-up is a new block rather than an edit to an old one, so what was bought
            and when stays intact.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 pt-4">
            <FormField control={form.control} name="hours" render={({ field }) => (
              <FormItem>
                <FormLabel>Hours</FormLabel>
                <FormControl><Input type="number" step="0.5" min="0.5" placeholder="100" {...field} /></FormControl>
                <FormMessage />
              </FormItem>
            )} />
            <FormField control={form.control} name="purchasedOn" render={({ field }) => (
              <FormItem>
                <FormLabel>Purchased On</FormLabel>
                <FormControl><Input type="date" {...field} /></FormControl>
                <FormMessage />
              </FormItem>
            )} />
            <FormField control={form.control} name="note" render={({ field }) => (
              <FormItem>
                <FormLabel>Note <span className="text-muted-foreground font-normal">(Optional)</span></FormLabel>
                <FormControl><Input placeholder="PO number, contract reference" {...field} /></FormControl>
                <FormMessage />
              </FormItem>
            )} />
            <div className="pt-4 flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button type="submit" disabled={createMutation.isPending}>
                {createMutation.isPending ? 'Saving...' : 'Record'}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

// ─── Product allocation ──────────────────────────────────────────────────────

/** Which deliverables this client bought, and who is producing each. */
export function ProductAllocationCard({ clientId, canManage }: { clientId: number; canManage: boolean }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [productId, setProductId] = useState('');
  const [assigneeId, setAssigneeId] = useState('');

  const { data: assignments, isLoading } = useListClientProductAssignments(clientId);
  const { data: products } = useListProducts();
  const { data: users } = useListUsers();
  const assignMutation = useAssignProduct();
  const removeMutation = useDeleteProductAssignment();

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: getListClientProductAssignmentsQueryKey(clientId) });

  const handleAssign = () => {
    if (!productId || !assigneeId) return;
    assignMutation.mutate(
      { clientId, data: { productId: Number(productId), assigneeUserId: Number(assigneeId) } },
      {
        onSuccess: () => {
          toast({ title: 'Product allocated' });
          setProductId('');
          setAssigneeId('');
          invalidate();
        },
        onError: (err: any) => {
          toast({ variant: 'destructive', title: 'Error', description: errorMessage(err, 'Failed to allocate product.') });
        },
      },
    );
  };

  const handleRemove = (id: number) => {
    removeMutation.mutate({ assignmentId: id }, {
      onSuccess: () => { toast({ title: 'Allocation withdrawn' }); invalidate(); },
      onError: (err: any) => {
        toast({ variant: 'destructive', title: 'Error', description: errorMessage(err, 'Failed to withdraw allocation.') });
      },
    });
  };

  return (
    <Card className="shadow-sm border-border">
      <CardHeader className="border-b border-border/50 bg-muted/20 pb-4">
        <CardTitle className="text-base font-bold flex items-center gap-2">
          <Package className="w-4 h-4 text-primary" />
          Products
          <Badge variant="secondary" className="font-mono text-[10px]">{assignments?.length ?? 0}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-4 space-y-4">
        {canManage && (
          <div className="flex flex-col sm:flex-row gap-2">
            <Select value={productId} onValueChange={setProductId}>
              <SelectTrigger className="flex-1 bg-background">
                <SelectValue placeholder="Product..." />
              </SelectTrigger>
              <SelectContent>
                {(products ?? []).map(p => (
                  <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={assigneeId} onValueChange={setAssigneeId}>
              <SelectTrigger className="flex-1 bg-background">
                <SelectValue placeholder="Assign to..." />
              </SelectTrigger>
              <SelectContent>
                {(users ?? []).map(u => (
                  <SelectItem key={u.id} value={String(u.id)}>{u.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button onClick={handleAssign} disabled={!productId || !assigneeId || assignMutation.isPending}>
              <Plus className="w-4 h-4 mr-1" />
              Allocate
            </Button>
          </div>
        )}

        {canManage && (products ?? []).length === 0 && (
          <p className="text-xs text-muted-foreground">
            Nothing in the catalog yet — define a product on the Products page first.
          </p>
        )}

        {isLoading ? (
          <div className="space-y-3">{[1, 2, 3].map(i => <Skeleton key={i} className="h-12 w-full" />)}</div>
        ) : assignments && assignments.length > 0 ? (
          <div className="space-y-2">
            {assignments.map(a => (
              <div key={a.id} className="flex items-center justify-between gap-3 p-3 rounded-md border border-border/50 hover:bg-muted/10 transition-colors">
                <div className="min-w-0">
                  <p className="font-medium text-foreground truncate">{a.productName}</p>
                  <p className="text-xs text-muted-foreground truncate">
                    {a.assigneeName} · {displayTitle({ role: a.assigneeRole } as any)} · allocated {format(new Date(a.assignedAt), 'MMM dd, yyyy')}
                  </p>
                </div>
                {canManage && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                    onClick={() => handleRemove(a.id)}
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div className="py-8 text-center text-muted-foreground font-mono text-sm border border-dashed border-border rounded-md">
            <p>NOTHING ALLOCATED</p>
            {canManage && <p className="text-xs mt-1 opacity-70">Allocate a product to whoever is producing it.</p>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
