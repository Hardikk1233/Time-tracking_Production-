import { config } from "../config";

/**
 * Calls this server's own HTTP API, carrying the caller's bearer token.
 *
 * Going back through HTTP rather than querying the database directly is
 * deliberate. Every visibility rule in this app lives in the route layer —
 * visibleUserIds, visibleClientIds, isInApprovalScope — so a tool that read
 * tables straight would have to restate all of it, and would drift the first
 * time one of those rules changed. Handing the same token to the same routes
 * means an MD sees what an MD sees in the browser, an associate sees what an
 * associate sees, and a fix to either applies here for free.
 *
 * The cost is a loopback request per tool call, which is not worth optimising
 * against the risk of two divergent permission models.
 */

export class ApiCallError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`API responded ${status}: ${body.slice(0, 200)}`);
    this.name = "ApiCallError";
  }
}

function baseUrl(): string {
  // Loopback: same process, so this never leaves the container.
  return `http://127.0.0.1:${config.port}`;
}

export async function apiGet<T>(
  path: string,
  token: string,
  query: Record<string, string | number | undefined> = {},
): Promise<T> {
  const url = new URL(`${baseUrl()}${path}`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new ApiCallError(response.status, await response.text());
  }

  return (await response.json()) as T;
}
