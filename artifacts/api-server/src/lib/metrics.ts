import { sql } from "drizzle-orm";
import { timeEntriesTable } from "@workspace/db";

/**
 * The firm's productivity measures, defined once.
 *
 * These previously lived inline in each route, which let two screens drift
 * apart: the dashboard treated hours awaiting review as zero-billable while
 * the reports treated them as fully billable, so the same person's utilisation
 * read 18% in one place and 30.5% in the other.
 */

/** A standard working day. Capacity is derived from this throughout. */
export const HOURS_PER_DAY = 8;

/**
 * Billable hours in SQL.
 *
 * An entry that has not been reviewed yet carries no split. It is counted as
 * *provisionally billable*, because that is what approving it without an
 * explicit split actually does - so the figure predicts the settled number
 * instead of dipping while work sits in the queue.
 */
export const billableHoursSql = sql<number>`
  COALESCE(SUM(COALESCE(${timeEntriesTable.billableHours}, ${timeEntriesTable.hours})), 0)
`;

export const nonBillableHoursSql = sql<number>`
  COALESCE(SUM(${timeEntriesTable.hours} - COALESCE(${timeEntriesTable.billableHours}, ${timeEntriesTable.hours})), 0)
`;

export const totalHoursSql = sql<number>`
  COALESCE(SUM(${timeEntriesTable.hours}), 0)
`;

/** Hours still awaiting a decision - shown so people can see what is unconfirmed. */
export const pendingHoursSql = sql<number>`
  COALESCE(SUM(CASE WHEN ${timeEntriesTable.status} = 'pending' THEN ${timeEntriesTable.hours} ELSE 0 END), 0)
`;

/** One decimal place everywhere, so the same figure reads the same on every screen. */
export function percent(numerator: number, denominator: number): number {
  if (!denominator || denominator <= 0) return 0;
  return Math.round((numerator / denominator) * 1000) / 10;
}

export function capacityHours(availableWorkingDays: number): number {
  return Math.max(availableWorkingDays, 0) * HOURS_PER_DAY;
}

export interface ProductivityInput {
  totalHours: number;
  billableHours: number;
  availableWorkingDays: number;
}

export interface Productivity {
  /** Capacity in hours, after holidays and that person's leave. */
  capacityHours: number;
  /**
   * Is this person filling their available time at all? Counts everything
   * logged, billable or not, so it reflects timesheet discipline rather than
   * work mix. Can exceed 100% when someone works beyond a standard day.
   */
  recordedUtilization: number;
  /** The headline consulting measure: how much capacity became billable work. */
  billableUtilization: number;
  /** Of the time actually recorded, the share that is billable. */
  efficiency: number;
}

/**
 * The three figures are deliberately distinct. Someone logging 10 hours in an
 * 8-hour day of which 4 are billable reads as 125% recorded, 50% billable and
 * 40% efficient - long hours, little of it billing - which one blended number
 * cannot express.
 */
export function productivity(input: ProductivityInput): Productivity {
  const capacity = capacityHours(input.availableWorkingDays);
  return {
    capacityHours: capacity,
    recordedUtilization: percent(input.totalHours, capacity),
    billableUtilization: percent(input.billableHours, capacity),
    efficiency: percent(input.billableHours, input.totalHours),
  };
}
