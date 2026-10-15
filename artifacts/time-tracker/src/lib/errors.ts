/**
 * The human-readable reason inside a failed API call.
 *
 * The generated client throws ApiError with the parsed response body on
 * `.data`, so a route's `{ error: "..." }` lives at `err.data.error`. Every
 * toast in the app read `err.error` instead — a property that does not exist —
 * so the server could refuse with a precise explanation and the person still
 * saw "Failed to delete." Route it through here and the explanation survives.
 */
/** Said instead of the caller's fallback when the session, not the feature, is what failed. */
export const SESSION_EXPIRED_MESSAGE =
  'Your sign-in has expired. Open the app again in a new tab to sign back in — ' +
  'nothing you have already saved is affected.';

export function errorMessage(err: unknown, fallback: string): string {
  const e = err as {
    status?: unknown;
    data?: { error?: unknown };
    error?: unknown;
  } | null;

  // A lapsed session is not a failure of whatever the person was doing, and
  // saying so sends them to retry a form that cannot succeed. The server's own
  // wording for a 401 ("Unauthorized", "Missing token") is no better: it names
  // the mechanism rather than the thing to do about it. So this answer wins
  // over the body, and every toast in the app inherits it at once.
  if (e?.status === 401) {
    return SESSION_EXPIRED_MESSAGE;
  }

  if (typeof e?.data?.error === "string" && e.data.error) {
    return e.data.error;
  }
  // Some callers hand over an already-unwrapped body.
  if (typeof e?.error === "string" && e.error) {
    return e.error;
  }
  return fallback;
}
