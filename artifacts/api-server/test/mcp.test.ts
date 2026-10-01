import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";
import request from "supertest";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import app from "../src/app";
import { config } from "../src/config";
import { resetKeyStoreForTesting } from "../src/lib/entra";
import { resetDatabase, type Fixtures } from "./fixtures";

/**
 * The MCP endpoint, which hands a conversational agent a token on somebody's
 * behalf.
 *
 * Two things are worth pinning here. The first is who may use it at all: this
 * is the one surface in the app restricted by rank rather than by scope, and a
 * regression would quietly widen it to the whole firm. The second is the
 * discovery document, which is the client's only route into the OAuth flow -
 * if the resource it names stops matching the registered Application ID URI,
 * Entra refuses every token with AADSTS9010010 and the connector simply says
 * it failed.
 */
const ISSUER = "https://test-issuer.local/v2.0";
const AUDIENCE = "api://timetrack-test";
const KID = "test-key-1";
const JWKS_PORT = 8098;

type PrivateKey = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];

let privateKey: PrivateKey;
let keyServer: http.Server;

/** A token for somebody in the given TimeTrack app role. */
async function mintToken(role: string, email: string, oid: string): Promise<string> {
  return new SignJWT({ oid, preferred_username: email, name: email, roles: [role] })
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setExpirationTime("10m")
    .sign(privateKey);
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

/** The smallest valid JSON-RPC body, so a refusal is about auth and nothing else. */
const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test", version: "1.0.0" },
  },
};

function post(token?: string) {
  const r = request(app)
    .post("/mcp")
    .set("Accept", "application/json, text/event-stream")
    .set("Content-Type", "application/json");
  return token ? r.set(bearer(token)).send(initialize) : r.send(initialize);
}

describe("the MCP endpoint", () => {
  let f: Fixtures;

  beforeAll(async () => {
    const pair = await generateKeyPair("RS256");
    privateKey = pair.privateKey;
    const jwk = await exportJWK(pair.publicKey);
    const body = JSON.stringify({ keys: [{ ...jwk, kid: KID, alg: "RS256", use: "sig" }] });

    keyServer = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(body);
    });
    await new Promise<void>((resolve) => keyServer.listen(JWKS_PORT, "127.0.0.1", resolve));
    resetKeyStoreForTesting();
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => keyServer.close(() => resolve()));
  });

  beforeEach(async () => {
    f = await resetDatabase();
  });

  describe("who may use it", () => {
    it("refuses an analyst, an associate and an AVP", async () => {
      // Everybody below md. The app itself is open to them; this is not.
      const cases: Array<[string, string, string]> = [
        ["TimeTrack.Analyst", "analyst@test.local", "oid-mcp-analyst"],
        ["TimeTrack.Associate", "associate@test.local", "oid-mcp-associate"],
        ["TimeTrack.AVP", "avp@test.local", "oid-mcp-avp"],
      ];

      for (const [role, email, oid] of cases) {
        const res = await post(await mintToken(role, email, oid));
        expect(res.status, `${role} should be refused`).toBe(403);
        expect(JSON.stringify(res.body)).toMatch(/limited to administrators/i);
      }
    });

    it("lets an md through the gate", async () => {
      // Admins hold md, so this covers them too - the title is a label on the
      // same rank, and the gate reads the rank.
      const res = await post(await mintToken("TimeTrack.MD", "md@test.local", "oid-mcp-md"));

      expect(res.status).not.toBe(403);
      expect(res.status).not.toBe(401);
    });
  });

  describe("refusing without a token", () => {
    it("answers 401 and says where to authenticate", async () => {
      const res = await post();

      expect(res.status).toBe(401);
      // Without this header a client has no way into the OAuth flow at all,
      // and the connector reports only that it failed.
      const challenge = res.headers["www-authenticate"];
      expect(challenge).toContain("Bearer");
      expect(challenge).toContain(
        'resource_metadata="https://timetrack.test.local/.well-known/oauth-protected-resource/mcp"',
      );
    });

    it("answers 401 for a token it cannot verify", async () => {
      const res = await post("not-a-real-token");
      expect(res.status).toBe(401);
      expect(res.headers["www-authenticate"]).toContain("resource_metadata=");
    });
  });

  describe("the discovery document", () => {
    it("names the endpoint's own URL as the resource", async () => {
      // This must stay identical to MCP_PUBLIC_URL and to the Application ID
      // URI registered on the API app. It named the api:// URI instead for as
      // long as the app had no verified domain, and the connector could not
      // complete the flow for exactly that reason.
      const res = await request(app).get("/.well-known/oauth-protected-resource");

      expect(res.status).toBe(200);
      expect(res.body.resource).toBe("https://timetrack.test.local/mcp");
      expect(res.body.resource).toBe(config.mcpPublicUrl);
    });

    it("is served at both spellings, because clients differ", async () => {
      const bare = await request(app).get("/.well-known/oauth-protected-resource");
      const suffixed = await request(app).get("/.well-known/oauth-protected-resource/mcp");

      expect(suffixed.status).toBe(200);
      expect(suffixed.body).toEqual(bare.body);
    });

    it("points at the tenant and names the scope a token needs", async () => {
      const res = await request(app).get("/.well-known/oauth-protected-resource");

      expect(res.body.authorization_servers[0]).toContain(config.entraTenantId);
      expect(res.body.scopes_supported).toContain(config.entraApiScope);
      expect(res.body.bearer_methods_supported).toEqual(["header"]);
    });
  });
});
