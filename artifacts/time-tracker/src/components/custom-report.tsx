import { Fragment, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { displayTitleOf } from '@/lib/roles';

/**
 * The Custom Reports table.
 *
 * Built around one question asked at three depths, because that is how the
 * question is actually asked: a memo took 100 hours — fine — but *who* spent
 * them, and *on what*? An AVP at 50 of those 100 hours is a staffing problem
 * that the project total alone cannot show.
 *
 * So: client → project → person → task, each level collapsible and carrying
 * its own total. Projects open by default (the level most people came for),
 * people and tasks are one click away. Nothing is hidden behind a hover.
 */

export interface CustomRow {
  userId: number;
  userName: string;
  userRole: string;
  userTitle?: string | null;
  clientId: number;
  clientName: string;
  projectId: number;
  projectName: string;
  taskId: number;
  taskName: string;
  totalHours: number;
  billableHours: number;
  nonBillableHours: number;
}

export interface Requester {
  id: number;
  clientId: number;
  name: string;
  designation: string;
}

const fmt = (n: number) => n.toFixed(1);

/** Hours summed over a set of rows. */
function totals(rows: CustomRow[]) {
  return rows.reduce(
    (acc, r) => ({
      total: acc.total + r.totalHours,
      billable: acc.billable + r.billableHours,
      nonBillable: acc.nonBillable + r.nonBillableHours,
    }),
    { total: 0, billable: 0, nonBillable: 0 },
  );
}

/** Groups rows by a key, preserving the order the server sent them in. */
function groupBy<T>(rows: CustomRow[], key: (r: CustomRow) => T): Map<T, CustomRow[]> {
  const out = new Map<T, CustomRow[]>();
  for (const r of rows) {
    const k = key(r);
    const list = out.get(k);
    if (list) list.push(r);
    else out.set(k, [r]);
  }
  return out;
}

function HoursCells({ rows, bold = false }: { rows: CustomRow[]; bold?: boolean }) {
  const t = totals(rows);
  const share = t.total > 0 ? (100 * t.billable) / t.total : 0;
  return (
    <>
      <td className={cn('py-2 px-3 text-right tabular-nums', bold && 'font-semibold')}>{fmt(t.total)}</td>
      <td className="py-2 px-3 text-right tabular-nums text-muted-foreground">{fmt(t.billable)}</td>
      <td className="py-2 px-3 text-right tabular-nums text-muted-foreground">{fmt(t.nonBillable)}</td>
      <td className="py-2 px-3 text-right tabular-nums text-muted-foreground">{t.total > 0 ? `${share.toFixed(0)}%` : '—'}</td>
    </>
  );
}

export function CustomReportTable({
  rows,
  requesters,
}: {
  rows: CustomRow[];
  requesters: Requester[];
}) {
  // Collapsed sets rather than expanded ones, so newly-arrived groups after a
  // refetch come back open instead of silently folding shut.
  const [closedClients, setClosedClients] = useState<Set<number>>(new Set());
  const [openMembers, setOpenMembers] = useState<Set<string>>(new Set());

  const byClient = useMemo(() => groupBy(rows, (r) => r.clientId), [rows]);
  const requestersByClient = useMemo(() => {
    const m = new Map<number, Requester[]>();
    for (const q of requesters) {
      const list = m.get(q.clientId) ?? [];
      list.push(q);
      m.set(q.clientId, list);
    }
    return m;
  }, [requesters]);

  const toggle = <T,>(set: Set<T>, value: T, apply: (next: Set<T>) => void) => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    apply(next);
  };

  if (rows.length === 0) {
    return (
      <div className="py-16 text-center text-muted-foreground font-mono text-sm border border-dashed border-border rounded-md">
        NO HOURS IN THIS SELECTION
      </div>
    );
  }

  const grand = totals(rows);

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-xs text-muted-foreground uppercase tracking-wider">
            <th className="py-2 px-3 text-left font-medium">Client / Project / Member / Task</th>
            <th className="py-2 px-3 text-right font-medium">Total</th>
            <th className="py-2 px-3 text-right font-medium">Billable</th>
            <th className="py-2 px-3 text-right font-medium">Non-bill.</th>
            <th className="py-2 px-3 text-right font-medium">Billable %</th>
          </tr>
        </thead>
        <tbody>
          {[...byClient.entries()].map(([clientId, clientRows]) => {
            const clientOpen = !closedClients.has(clientId);
            const clientName = clientRows[0].clientName;
            const clientRequesters = requestersByClient.get(clientId) ?? [];
            const byProject = groupBy(clientRows, (r) => r.projectId);

            return (
              <Fragment key={`client-${clientId}`}>
                {/* ── Client ─────────────────────────────────────────── */}
                <tr
                  className="border-b border-border bg-muted/40 cursor-pointer hover:bg-muted/60"
                  onClick={() => toggle(closedClients, clientId, setClosedClients)}
                >
                  <td className="py-2.5 px-3">
                    <div className="flex items-center gap-2 flex-wrap">
                      {clientOpen ? <ChevronDown className="w-4 h-4 shrink-0" /> : <ChevronRight className="w-4 h-4 shrink-0" />}
                      <span className="font-semibold">{clientName}</span>
                      {clientRequesters.length > 0 && (
                        <span className="text-xs text-muted-foreground font-normal">
                          · requested by{' '}
                          {clientRequesters.map((q, i) => (
                            <span key={q.id}>
                              {i > 0 && ', '}
                              {q.name}
                              <span className="opacity-60"> ({q.designation})</span>
                            </span>
                          ))}
                        </span>
                      )}
                    </div>
                  </td>
                  <HoursCells rows={clientRows} bold />
                </tr>

                {clientOpen &&
                  [...byProject.entries()].map(([projectId, projectRows]) => {
                    const byMember = groupBy(projectRows, (r) => r.userId);
                    return (
                      <Fragment key={`project-${projectId}`}>
                        {/* ── Project ────────────────────────────────── */}
                        <tr className="border-b border-border/50 bg-background">
                          <td className="py-2 px-3 pl-10 font-medium">{projectRows[0].projectName}</td>
                          <HoursCells rows={projectRows} bold />
                        </tr>

                        {/* ── Member ─────────────────────────────────── */}
                        {[...byMember.entries()].map(([userId, memberRows]) => {
                          const key = `${projectId}-${userId}`;
                          const memberOpen = openMembers.has(key);
                          return (
                            <Fragment key={`member-${key}`}>
                              <tr
                                className="border-b border-border/30 cursor-pointer hover:bg-muted/20"
                                onClick={() => toggle(openMembers, key, setOpenMembers)}
                              >
                                <td className="py-1.5 px-3 pl-16">
                                  <div className="flex items-center gap-2">
                                    {memberOpen ? <ChevronDown className="w-3.5 h-3.5 opacity-50" /> : <ChevronRight className="w-3.5 h-3.5 opacity-50" />}
                                    <span>{memberRows[0].userName}</span>
                                    <Badge variant="outline" className="text-[10px] font-normal">
                                      {displayTitleOf(memberRows[0].userRole, memberRows[0].userTitle)}
                                    </Badge>
                                  </div>
                                </td>
                                <HoursCells rows={memberRows} />
                              </tr>

                              {/* ── Task ─────────────────────────────── */}
                              {memberOpen &&
                                memberRows.map((r) => (
                                  <tr key={`t-${key}-${r.taskId}`} className="border-b border-border/20 bg-muted/10">
                                    <td className="py-1.5 px-3 pl-[5.5rem] text-muted-foreground text-xs">{r.taskName}</td>
                                    <HoursCells rows={[r]} />
                                  </tr>
                                ))}
                            </Fragment>
                          );
                        })}
                      </Fragment>
                    );
                  })}
              </Fragment>
            );
          })}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-border font-semibold bg-muted/30">
            <td className="py-2.5 px-3">Total</td>
            <td className="py-2.5 px-3 text-right tabular-nums">{fmt(grand.total)}</td>
            <td className="py-2.5 px-3 text-right tabular-nums">{fmt(grand.billable)}</td>
            <td className="py-2.5 px-3 text-right tabular-nums">{fmt(grand.nonBillable)}</td>
            <td className="py-2.5 px-3 text-right tabular-nums">
              {grand.total > 0 ? `${((100 * grand.billable) / grand.total).toFixed(0)}%` : '—'}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
