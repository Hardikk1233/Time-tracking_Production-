/**
 * The human-readable reason inside a failed API call.
 *
 * The generated client throws ApiError with the parsed response body on
 * `.data`, so a route's `{ error: "..." }` lives at `err.data.error`. Every
 * toast in the app read `err.error` instead — a property that does not exist —
 * so the server could refuse with a precise explanation and the person still
 * saw "Failed to delete." Route it through here and the explanation survives.
 */
export function errorMessage(err: unknown, fallback: string): string {
  const e = err as {
    data?: { error?: unknown };
    error?: unknown;
  } | null;

  if (typeof e?.data?.error === "string" && e.data.error) {
    return e.data.error;
  }
  // Some callers hand over an already-unwrapped body.
  if (typeof e?.error === "string" && e.error) {
    return e.error;
  }
  return fallback;
}
