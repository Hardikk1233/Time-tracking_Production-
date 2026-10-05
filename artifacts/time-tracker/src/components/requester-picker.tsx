import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  useListClientRequesters,
  useAddClientRequester,
  getListClientRequestersQueryKey,
} from '@workspace/api-client-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { errorMessage } from '@/lib/errors';
import { cn } from '@/lib/utils';

/**
 * Picks the person at the client who asked for a piece of work, and records a
 * new one without leaving the page.
 *
 * Both places that set a requester - creating a project, and editing one
 * afterwards - used to offer only the names already on file and tell anybody
 * else to go and add them on the client page. That is a dead end at exactly
 * the wrong moment: somebody is setting up a project *because* a person asked
 * for it, and that person is very often the one nobody has recorded yet.
 *
 * Adding here writes to the client, not to the project, so the new name is on
 * file for every future project too - the same list the client page shows.
 * Anyone who may set a requester may create one: both are open to associates
 * and above, so there is no step here that hands you a form you are not
 * allowed to submit.
 */

/** Chosen from the menu to open the form. Cannot collide with an id or 'none'. */
const ADD_NEW = '__add_new__';

export function RequesterPicker({
  clientId,
  value,
  onChange,
  disabled = false,
  triggerClassName,
  placeholder = 'Select a requester',
}: {
  /** Null until a client is chosen; the list belongs to the client. */
  clientId: number | null;
  value: number | null;
  onChange: (requesterId: number | null) => void;
  disabled?: boolean;
  triggerClassName?: string;
  placeholder?: string;
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [designation, setDesignation] = useState('');
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: requesters } = useListClientRequesters(clientId ?? 0, {
    query: { enabled: Boolean(clientId) } as any,
  });
  const addMutation = useAddClientRequester();

  const options = requesters ?? [];
  const canSave = name.trim().length > 0 && designation.trim().length > 0;

  const reset = () => {
    setName('');
    setDesignation('');
    setAdding(false);
  };

  const create = () => {
    if (!clientId || !canSave) return;
    addMutation.mutate(
      { clientId, data: { name: name.trim(), designation: designation.trim() } },
      {
        onSuccess: (created: { id: number; name: string }) => {
          toast({ title: `${created.name} added` });
          // The client page and the other picker read the same list.
          void queryClient.invalidateQueries({
            queryKey: getListClientRequestersQueryKey(clientId),
          });
          // Chosen straight away: adding one here is always in order to use it.
          onChange(created.id);
          reset();
        },
        onError: (err: any) =>
          toast({
            variant: 'destructive',
            title: 'Could not add requester',
            description: errorMessage(err, 'Please try again.'),
          }),
      },
    );
  };

  if (adding) {
    return (
      <div className="space-y-2 rounded-md border border-input bg-muted/20 p-3">
        <p className="text-xs text-muted-foreground">
          New requester for this client. Both fields are required.
        </p>
        <div className="flex gap-2 flex-wrap">
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name — e.g. Priya Menon"
            className="h-8 flex-1 min-w-[10rem] text-sm"
            // Enter saves, so the quick case never needs the mouse. Guarded on
            // canSave, or a half-filled form submits on the first keystroke.
            onKeyDown={(e) => { if (e.key === 'Enter' && canSave) { e.preventDefault(); create(); } }}
          />
          <Input
            value={designation}
            onChange={(e) => setDesignation(e.target.value)}
            placeholder="Designation — e.g. CFO"
            className="h-8 flex-1 min-w-[10rem] text-sm"
            onKeyDown={(e) => { if (e.key === 'Enter' && canSave) { e.preventDefault(); create(); } }}
          />
        </div>
        <div className="flex gap-2 justify-end">
          <Button type="button" variant="ghost" size="sm" onClick={reset} disabled={addMutation.isPending}>
            Cancel
          </Button>
          <Button type="button" size="sm" onClick={create} disabled={!canSave || addMutation.isPending}>
            {addMutation.isPending ? 'Adding…' : 'Add and select'}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <Select
      value={value ? String(value) : 'none'}
      disabled={disabled || !clientId}
      onValueChange={(v) => {
        if (v === ADD_NEW) { setAdding(true); return; }
        onChange(v === 'none' ? null : Number(v));
      }}
    >
      <SelectTrigger className={cn('text-sm', triggerClassName)}>
        <SelectValue placeholder={clientId ? placeholder : 'Choose a client first'} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="none">— Not recorded</SelectItem>
        {options.map((r) => (
          <SelectItem key={r.id} value={String(r.id)}>
            {r.name} <span className="text-muted-foreground text-xs">· {r.designation}</span>
          </SelectItem>
        ))}
        {/* Last, and separated: it is an action among a list of names. */}
        <SelectItem value={ADD_NEW} className="border-t mt-1 pt-2 text-primary font-medium">
          + Add someone new
        </SelectItem>
      </SelectContent>
    </Select>
  );
}
