import React, { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  useAssignProjectTask,
  useDeleteProjectTaskAssignment,
  getListProjectTaskAssignmentsQueryKey,
  getListMyTaskAssignmentsQueryKey,
} from '@workspace/api-client-react';
import { useToast } from '@/hooks/use-toast';
import { displayTitle } from '@/lib/roles';

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { UserPlus, X } from 'lucide-react';
import { errorMessage } from '@/lib/errors';

interface Assignment {
  id: number;
  taskId: number;
  assigneeUserId: number;
  assigneeName: string;
  assigneeRole: string;
}

interface Member {
  id: number;
  name: string;
  role: string;
}

/**
 * Who is doing one task on one project, with the picker to change it.
 *
 * An assignment is an intention, not a permission — anyone on the project may
 * log time against any task enabled here regardless of what this shows. The
 * copy avoids implying otherwise.
 *
 * Analysts get no controls at all, only the names: work is handed down, and an
 * analyst reads what they have been given. Matching requireRole("associate") on
 * both write routes, so nothing on screen can produce a refusal.
 */
export function TaskAssignees({
  projectId,
  taskId,
  assignments,
  members,
  myRole,
}: {
  projectId: number;
  taskId: number;
  assignments: Assignment[];
  members: Member[];
  myRole: string;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [picking, setPicking] = useState('');

  const assignMutation = useAssignProjectTask();
  const removeMutation = useDeleteProjectTaskAssignment();

  const canAssign = ['associate', 'avp', 'md'].includes(myRole);
  const mine = assignments.filter(a => a.taskId === taskId);
  const takenIds = new Set(mine.map(a => a.assigneeUserId));
  const available = members.filter(m => !takenIds.has(m.id));

  const refresh = () => {
    queryClient.invalidateQueries({
      queryKey: getListProjectTaskAssignmentsQueryKey(projectId),
    });
    queryClient.invalidateQueries({ queryKey: getListMyTaskAssignmentsQueryKey() });
  };

  const assign = (assigneeUserId?: number) => {
    assignMutation.mutate(
      { projectId, data: assigneeUserId == null ? { taskId } : { taskId, assigneeUserId } },
      {
        onSuccess: () => {
          setPicking('');
          refresh();
        },
        onError: (err: any) => {
          toast({
            variant: 'destructive',
            title: 'Could not assign',
            description: errorMessage(err, 'Please try again.'),
          });
        },
      },
    );
  };

  const drop = (id: number) => {
    removeMutation.mutate({ assignmentId: id }, {
      onSuccess: refresh,
      onError: (err: any) => {
        toast({
          variant: 'destructive',
          title: 'Could not withdraw',
          description: errorMessage(err, 'Please try again.'),
        });
      },
    });
  };

  // Nothing to show and nothing to offer: keep the row out of the layout
  // rather than leaving an empty gap under every task.
  if (!canAssign && mine.length === 0) return null;

  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      {mine.map(a => {
        return (
          <Badge
            key={a.id}
            variant="outline"
            className="text-[11px] font-normal gap-1 pr-1 border-primary/30 bg-primary/5"
            title={`${a.assigneeName} — ${displayTitle({ role: a.assigneeRole } as any)}`}
          >
            {a.assigneeName}
            {canAssign && (
              <button
                type="button"
                onClick={() => drop(a.id)}
                disabled={removeMutation.isPending}
                aria-label={`Remove ${a.assigneeName}`}
                className="rounded hover:text-destructive focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/40"
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </Badge>
        );
      })}

      {!canAssign ? null : available.length > 0 ? (
        <Select
          value={picking}
          onValueChange={value => {
            setPicking(value);
            assign(Number(value));
          }}
        >
          <SelectTrigger className="h-6 w-auto gap-1 border-dashed px-2 text-[11px] text-muted-foreground">
            <UserPlus className="w-3 h-3" />
            <SelectValue placeholder="Assign" />
          </SelectTrigger>
          <SelectContent>
            {available.map(m => (
              <SelectItem key={m.id} value={String(m.id)} className="text-xs">
                {m.name} · {displayTitle({ role: m.role } as any)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        mine.length === 0 && (
          <span className="text-[11px] text-muted-foreground">
            Add someone to the project team to assign this
          </span>
        )
      )}
    </div>
  );
}
