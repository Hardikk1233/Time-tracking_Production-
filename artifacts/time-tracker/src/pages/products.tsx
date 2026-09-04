import React, { useState } from 'react';
import { useAuth } from '@/lib/auth';
import {
  useListProducts,
  useCreateProduct,
  useDeleteProduct,
  useListMyProductAssignments,
  getListProductsQueryKey,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { useToast } from '@/hooks/use-toast';
import { format } from 'date-fns';

import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Plus, Trash2, Package } from 'lucide-react';
import { errorMessage } from '@/lib/errors';

const productSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  description: z.string().optional(),
});

/**
 * The product catalog, and what the signed-in person has been asked to produce.
 *
 * Deliberately separate from Tasks: a task is a *type of work* logged against a
 * project, a product is a *deliverable a client bought*, handed to somebody.
 */
export default function Products() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [isDialogOpen, setIsDialogOpen] = useState(false);

  const { data: products, isLoading } = useListProducts();
  const { data: mine } = useListMyProductAssignments();
  const deleteMutation = useDeleteProduct();

  // Associate and above, matching requireRole("associate") on the API.
  const canManage = ['associate', 'avp', 'md'].includes(user?.role || '');

  const handleDelete = (id: number, name: string) => {
    if (confirm(`Delete "${name}" from the catalog? Any allocations of it are removed too.`)) {
      deleteMutation.mutate({ productId: id }, {
        onSuccess: () => {
          toast({ title: 'Product deleted' });
          queryClient.invalidateQueries({ queryKey: getListProductsQueryKey() });
        },
        onError: (err: any) => {
          toast({ variant: 'destructive', title: 'Error', description: errorMessage(err, 'Failed to delete product.') });
        },
      });
    }
  };

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">Products</h1>
          <p className="text-muted-foreground font-mono text-sm mt-1">Firm-wide catalog of client deliverables</p>
        </div>

        {canManage && <CreateProductDialog open={isDialogOpen} onOpenChange={setIsDialogOpen} />}
      </div>

      {mine && mine.length > 0 && (
        <Card className="shadow-sm border-primary/30 bg-primary/5 p-6">
          <h2 className="font-bold text-sm uppercase tracking-wider font-mono text-primary mb-4">
            Assigned to you
          </h2>
          <div className="space-y-2">
            {mine.map((a) => (
              <div key={a.id} className="flex items-center justify-between gap-4 text-sm">
                <div className="flex items-center gap-2 min-w-0">
                  <Package className="w-4 h-4 text-primary shrink-0 opacity-70" />
                  <span className="font-medium text-foreground truncate">{a.productName}</span>
                  <span className="text-muted-foreground truncate">for {a.clientName}</span>
                </div>
                <span className="font-mono text-xs text-muted-foreground shrink-0">
                  {format(new Date(a.assignedAt), 'MMM dd, yyyy')}
                </span>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card className="shadow-sm border-border overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/30 text-left text-xs uppercase tracking-wider font-mono text-muted-foreground">
                <th className="px-6 py-4 font-medium">Product</th>
                <th className="px-6 py-4 font-medium">Description</th>
                <th className="px-6 py-4 font-medium">Defined By</th>
                <th className="px-6 py-4 font-medium">Created</th>
                {canManage && <th className="px-6 py-4 font-medium text-right">Actions</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-border/50">
              {isLoading ? (
                Array(4).fill(0).map((_, i) => (
                  <tr key={i}>
                    <td className="px-6 py-4"><Skeleton className="h-4 w-48" /></td>
                    <td className="px-6 py-4"><Skeleton className="h-4 w-32" /></td>
                    <td className="px-6 py-4"><Skeleton className="h-4 w-24" /></td>
                    <td className="px-6 py-4"><Skeleton className="h-4 w-20" /></td>
                    {canManage && <td className="px-6 py-4"><Skeleton className="h-8 w-8 ml-auto" /></td>}
                  </tr>
                ))
              ) : products && products.length > 0 ? (
                products.map((product) => (
                  <tr key={product.id} className="hover:bg-muted/10 transition-colors">
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-3">
                        <Package className="w-4 h-4 text-primary opacity-50" />
                        <span className="font-medium text-foreground">{product.name}</span>
                      </div>
                    </td>
                    <td className="px-6 py-4 text-muted-foreground">{product.description || '—'}</td>
                    <td className="px-6 py-4">
                      <Badge variant="outline" className="text-xs font-mono text-muted-foreground">
                        {product.createdByName}
                      </Badge>
                    </td>
                    <td className="px-6 py-4 font-mono text-xs text-muted-foreground">
                      {format(new Date(product.createdAt), 'MMM dd, yyyy')}
                    </td>
                    {canManage && (
                      <td className="px-6 py-4 text-right">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                          onClick={() => handleDelete(product.id, product.name)}
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </td>
                    )}
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={canManage ? 5 : 4} className="px-6 py-12 text-center text-muted-foreground font-mono text-sm border-b-0">
                    NO PRODUCTS DEFINED
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <p className="text-xs text-muted-foreground font-mono">
        Allocate products to people from a client page.
      </p>
    </div>
  );
}

function CreateProductDialog({ open, onOpenChange }: { open: boolean, onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const createMutation = useCreateProduct();

  const form = useForm<z.infer<typeof productSchema>>({
    resolver: zodResolver(productSchema),
    defaultValues: { name: '', description: '' },
  });

  const onSubmit = (data: z.infer<typeof productSchema>) => {
    createMutation.mutate({ data }, {
      onSuccess: () => {
        toast({ title: 'Product added to catalog' });
        queryClient.invalidateQueries({ queryKey: getListProductsQueryKey() });
        form.reset();
        onOpenChange(false);
      },
      onError: (err: any) => {
        toast({ variant: 'destructive', title: 'Error', description: errorMessage(err, 'Failed to create product.') });
      },
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button className="shadow-md font-semibold tracking-tight">
          <Plus className="w-4 h-4 mr-2" />
          New Product
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>Define a Product</DialogTitle>
          <DialogDescription>
            A deliverable a client buys — an investment memo, a model, a diligence pack.
            Once defined it can be allocated on any client.
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 pt-4">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Product Name</FormLabel>
                  <FormControl><Input placeholder="Investment Memo" {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Description <span className="text-muted-foreground font-normal">(Optional)</span></FormLabel>
                  <FormControl><Input placeholder="What this deliverable covers" {...field} /></FormControl>
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
