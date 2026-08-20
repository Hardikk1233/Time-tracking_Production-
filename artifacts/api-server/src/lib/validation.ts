/**
 * Request-value guards.
 *
 * The OpenAPI spec already states these bounds and Orval generates Zod schemas
 * from it, but nothing on the server validated request bodies — so a negative
 * or 999-hour entry was accepted. These are the checks the write paths need
 * until the generated schemas are wired in as middleware.
 */

export const MIN_HOURS = 0.25;
export const MAX_HOURS = 24;

/** Parses a route parameter that must be a positive integer id. */
export function parseId(raw: string | string[] | undefined): number | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/** Returns an error message, or null when valid. */
export function validateHours(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "hours must be a number";
  }
  if (value < MIN_HOURS || value > MAX_HOURS) {
    return `hours must be between ${MIN_HOURS} and ${MAX_HOURS}`;
  }
  return null;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function validateDate(value: unknown): string | null {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) {
    return "date must be in YYYY-MM-DD format";
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return "date is not a real calendar date";
  // Round-trips only for real dates — rejects 2026-02-31 and similar.
  if (parsed.toISOString().slice(0, 10) !== value) {
    return "date is not a real calendar date";
  }
  return null;
}

/** Postgres restrict_violation — raised by the time-entry immutability trigger. */
export function isRestrictViolation(err: unknown): boolean {
  const candidate = err as { code?: string; cause?: { code?: string } };
  return (candidate?.code ?? candidate?.cause?.code) === "23001";
}
