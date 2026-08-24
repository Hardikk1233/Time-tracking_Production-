import { getAccessToken } from './entra';

/**
 * Minimal client for the temporary rollout endpoints.
 *
 * Deliberately hand-written rather than added to the OpenAPI spec and
 * regenerated through Orval: this whole feature is scaffolding that comes out
 * once the rollout has settled, and it should not leave a trace in the
 * generated client that someone has to remember to remove.
 *
 * Bearer token where Entra is active, session cookie otherwise — same-origin
 * requests send the cookie by default, so nothing extra is needed for it.
 */
async function authHeaders(): Promise<HeadersInit> {
  const headers: Record<string, string> = { accept: 'application/json' };
  try {
    const token = await getAccessToken();
    if (token) headers.authorization = `Bearer ${token}`;
  } catch {
    // Fall through unauthenticated; the endpoint decides what that means.
  }
  return headers;
}

export async function devGet<T>(path: string): Promise<T> {
  const response = await fetch(`/api${path}`, {
    headers: await authHeaders(),
  });
  if (!response.ok) {
    throw new Error(`GET ${path} responded ${response.status}`);
  }
  return (await response.json()) as T;
}

export async function devSend<T>(
  method: 'POST' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T | null> {
  const headers = new Headers(await authHeaders());
  if (body !== undefined) headers.set('content-type', 'application/json');

  const response = await fetch(`/api${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (!response.ok) {
    // The server's message is the useful half — surface it rather than a status.
    let detail = `${method} ${path} responded ${response.status}`;
    try {
      const parsed = (await response.json()) as { error?: string };
      if (parsed?.error) detail = parsed.error;
    } catch {
      // Non-JSON body; the status line above stands.
    }
    throw new Error(detail);
  }

  if (response.status === 204) return null;
  return (await response.json()) as T;
}

// ─── Shapes returned by the console endpoints ────────────────────────────────

export interface AppEvent {
  id: number;
  occurredAt: string;
  source: 'client' | 'server';
  level: 'error' | 'warn' | 'info';
  message: string;
  stack: string | null;
  url: string | null;
  method: string | null;
  statusCode: number | null;
  userEmail: string | null;
  userAgent: string | null;
  requestId: string | null;
  context: Record<string, unknown> | null;
}

export interface FeedbackItem {
  id: number;
  createdAt: string;
  userEmail: string;
  userName: string;
  userRole: string;
  kind: 'bug' | 'idea' | 'other';
  message: string;
  pageUrl: string | null;
  status: 'new' | 'read';
}
