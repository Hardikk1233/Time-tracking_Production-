import React, { useState } from 'react';
import { useAuth } from '@/lib/auth';
import {
  useListPublicHolidays,
  useCreatePublicHoliday,
  useDeletePublicHoliday,
  getListPublicHolidaysQueryKey,
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
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { CalendarDays, Plus, Trash2, ShieldAlert } from 'lucide-react';

const holidaySchema = z.object({
  date: z.string().min(1, 'Date is required'),
  name: z.string().min(1, 'Name is required'),
});
type HolidayForm = z.infer<typeof holidaySchema>;

export default function Holidays() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [isDialogOpen, setIsDialogOpen] = useState(false);

  const { data: holidays, isLoading } = useListPublicHolidays();
  const deleteMutation = useDeletePublicHoliday();

  const isMd = user?.role === 'md';

  const handleDelete = (id: number, name: string) => {
    if (!confirm(`Remove "${name}" from the public holiday calendar?`)) return;
    deleteMutation.mutate({ id } as any, {
      onSuccess: () => {
        toast({ title: 'Holiday removed' });
        queryClient.invalidateQueries({ queryKey: getListPublicHolidaysQueryKey() });
      },
      onError: (err: any) => {
        toast({ variant: 'destructive', title: 'Error', description: err?.error || 'Failed to remove holiday.' });
      },
    });
  };

  if (!isMd) {
    return (
      <div className="flex flex-col items-center justify-center h-[60vh] text-center gap-3">
        <ShieldAlert className="w-10 h-10 text-muted-foreground" />
        <p className="text-muted-foreground font-mono text-sm">Only Managing Directors can manage public holidays.</p>
      </div>
    );
  }

  const today = format(new Date(), 'yyyy-MM-dd');
  const upcoming = (holidays ?? []).filter(h => h.date >= today);
  const past = (holidays ?? []).filter(h => h.date < today);

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">Public Holidays</h1>
          <p className="text-muted-foreground font-mono text-sm mt-1">
            Excluded from working-day and capacity calculations firm-wide
          </p>
        </div>
        <CreateHolidayDialog open={isDialogOpen} onOpenChange={setIsDialogOpen} />
      </div>

      <Card className="shadow-sm border-border">
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-6 space-y-3">
              {[1, 2, 3].map(i => <Skeleton key={i} className="h-12 w-full" />)}
            </div>
          ) : holidays && holidays.length > 0 ? (
            <div className="divide-y divide-border/50">
              {upcoming.length > 0 && (
                <div className="px-6 pt-4 pb-1 text-xs font-mono uppercase tracking-wider text-muted-foreground">Upcoming</div>
              )}
              {upcoming.map(h => (
                <HolidayRow key={h.id} holiday={h} onDelete={handleDelete} deleting={deleteMutation.isPending} />
              ))}
              {past.length > 0 && (
                <div className="px-6 pt-4 pb-1 text-xs font-mono uppercase tracking-wider text-muted-foreground">Past</div>
              )}
              {past.map(h => (
                <HolidayRow key={h.id} holiday={h} onDelete={handleDelete} deleting={deleteMutation.isPending} past />
              ))}
            </div>
          ) : (
            <div className="p-12 text-center text-muted-foreground font-mono text-sm">
              NO PUBLIC HOLIDAYS CONFIGURED
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function HolidayRow({
  holiday, onDelete, deleting, past = false,
}: {
  holiday: { id: number; date: string; name: string };
  onDelete: (id: number, name: string) => void;
  deleting: boolean;
  past?: boolean;
}) {
  return (
    <div className={`flex items-center justify-between gap-4 px-6 py-3 hover:bg-muted/20 transition-colors ${past ? 'opacity-60' : ''}`}>
      <div className="flex items-center gap-3 min-w-0">
        <div className="w-9 h-9 rounded-md bg-primary/10 text-primary flex items-center justify-center shrink-0">
          <CalendarDays className="w-4 h-4" />
        </div>
        <div className="flex flex-col min-w-0">
          <span className="font-medium text-foreground truncate">{holiday.name}</span>
          <span className="text-xs text-muted-foreground font-mono">
            {format(new Date(holiday.date + 'T00:00:00'), 'EEEE, MMM d, yyyy')}
          </span>
        </div>
      </div>
      <div className="flex items-center gap-3 shrink-0">
        {!past && <Badge variant="outline" className="font-mono text-[10px] uppercase">Upcoming</Badge>}
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
          onClick={() => onDelete(holiday.id, holiday.name)}
          disabled={deleting}
        >
          <Trash2 className="w-4 h-4" />
        </Button>
      </div>
    </div>
  );
}

function CreateHolidayDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const createMutation = useCreatePublicHoliday();

  const form = useForm<HolidayForm>({
    resolver: zodResolver(holidaySchema),
    defaultValues: { date: format(new Date(), 'yyyy-MM-dd'), name: '' },
  });

  const onSubmit = (data: HolidayForm) => {
    createMutation.mutate(
      { data: { date: data.date, name: data.name } },
      {
        onSuccess: () => {
          toast({ title: 'Holiday added' });
          queryClient.invalidateQueries({ queryKey: getListPublicHolidaysQueryKey() });
          form.reset({ date: format(new Date(), 'yyyy-MM-dd'), name: '' });
          onOpenChange(false);
        },
        onError: (err: any) => {
          toast({ variant: 'destructive', title: 'Failed to add holiday', description: err?.error || 'An error occurred.' });
        },
      }
    );
  };

  const handleClose = (v: boolean) => {
    if (!v) form.reset({ date: format(new Date(), 'yyyy-MM-dd'), name: '' });
    onOpenChange(v);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogTrigger asChild>
        <Button className="shadow-md font-semibold tracking-tight">
          <Plus className="w-4 h-4 mr-2" />
          Add Holiday
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>Add Public Holiday</DialogTitle>
          <DialogDescription>
            This date will be excluded from working-day and capacity calculations for everyone.
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 pt-2">
            <FormField control={form.control} name="date" render={({ field }) => (
              <FormItem>
                <FormLabel>Date</FormLabel>
                <FormControl><Input type="date" {...field} /></FormControl>
                <FormMessage />
              </FormItem>
            )} />
            <FormField control={form.control} name="name" render={({ field }) => (
              <FormItem>
                <FormLabel>Name</FormLabel>
                <FormControl><Input placeholder="e.g. Diwali, Christmas" {...field} /></FormControl>
                <FormMessage />
              </FormItem>
            )} />
            <div className="pt-2 flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => handleClose(false)}>Cancel</Button>
              <Button type="submit" disabled={createMutation.isPending}>
                {createMutation.isPending ? 'Adding...' : 'Add Holiday'}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
