import { Router, type IRouter, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { config } from "../config";
import { logger } from "../lib/logger";
import {
  verifyEntraToken,
  isEntraConfigured,
  EntraAuthError,
} from "../lib/entra";
import { resolveEntraPrincipal } from "../middlewares/auth";
import { buildMcpServer } from "../mcp/server";

const router: IRouter = Router();

/**
 * The MCP endpoint, for Claude connectors.
 *
 * Mounted outside /api on purpose: the URL is an identity. Claude names it as
 * the OAuth resource (RFC 8707), Entra issues tokens whose audience is that
 * exact string, and it is what a person types into the connector dialog. It
 * therefore has to be stable and to match MCP_PUBLIC_URL character for
 * character.
 *
 * Sessionless. Each request builds a server closed over the caller's token, so
 * two people connected at once cannot see through each other, and nothing has
 * to be evicted later.
 */

function bearer(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const [scheme, ...rest] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer") return null;
  return rest.join(" ").trim() || null;
}

/**
 * Where the metadata document lives, per RFC 9728.
 *
 * The well-known segment goes after the host and *before* the resource path —
 * so a resource at https://host/mcp is described at
 * https://host/.well-known/oauth-protected-resource/mcp. Appending the
 * well-known path to the resource URL instead produces an address that 404s,
 * and since this header is the client's only route into the OAuth flow, that
 * failure surfaces as a connector which cannot authenticate at all.
 */
function resourceMetadataUrl(): string {
  const url = new URL(config.mcpPublicUrl!);
  const path = url.pathname.replace(/\/$/, "");
  return `${url.origin}/.well-known/oauth-protected-resource${path}`;
}

/**
 * Refuses the request the way the spec requires.
 *
 * The WWW-Authenticate header is not decoration: it is how a client discovers
 * where to authenticate. Without it Claude has no way to start the OAuth flow
 * and simply reports that the connector failed.
 */
function unauthorized(res: Response, description: string): void {
  const metadataUrl = resourceMetadataUrl();
  res
    .status(401)
    .set(
      "WWW-Authenticate",
      `Bearer resource_metadata="${metadataUrl}", error="invalid_token", error_description="${description}"`,
    )
    .json({
      jsonrpc: "2.0",
      error: { code: -32001, message: `Unauthorized: ${description}` },
      id: null,
    });
}

// ─── Discovery ───────────────────────────────────────────────────────────────

/**
 * RFC 9728. Points Claude at the tenant that issues tokens for this resource,
 * and names the resource so the token it requests carries the right audience.
 *
 * Registered by app.ts at the host root, since that is where a client looks —
 * both at the bare well-known path and at the one suffixed with the resource
 * path, because clients differ on which they try.
 */
export function protectedResourceMetadata(_req: Request, res: Response): void {
  if (!config.mcpPublicUrl) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  res.json({
    resource: config.mcpPublicUrl,
    authorization_servers: [
      `https://login.microsoftonline.com/${config.entraTenantId}/v2.0`,
    ],
    bearer_methods_supported: ["header"],
    scopes_supported: [config.entraApiScope].filter(Boolean),
  });
}

// ─── The endpoint ────────────────────────────────────────────────────────────

async function handle(req: Request, res: Response): Promise<void> {
  if (!config.mcpPublicUrl) {
    // Without its own address the endpoint cannot describe where to
    // authenticate, so it does not pretend to exist.
    res.status(404).json({ error: "Not found" });
    return;
  }

  if (!isEntraConfigured()) {
    res.status(503).json({ error: "Entra is not configured on this server" });
    return;
  }

  const token = bearer(req);
  if (!token) {
    unauthorized(res, "A bearer token is required");
    return;
  }

  let principal;
  try {
    const identity = await verifyEntraToken(token);
    principal = await resolveEntraPrincipal(identity);
  } catch (err) {
    if (err instanceof EntraAuthError) {
      logger.warn({ reason: err.reason }, "Rejected an MCP token");
      unauthorized(res, "The token was not accepted");
      return;
    }
    throw err;
  }

  if (!principal) {
    res.status(403).json({ error: "This account has been deactivated" });
    return;
  }

  const server = buildMcpServer(token, principal);
  const transport = new StreamableHTTPServerTransport({
    // Sessionless: no server-side session to create, look up or expire.
    sessionIdGenerator: undefined,
  });

  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    logger.error({ err: String(err) }, "MCP request failed");
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal error" },
        id: null,
      });
    }
  }
}

router.post("/", handle);
router.get("/", handle);
router.delete("/", handle);

export default router;
