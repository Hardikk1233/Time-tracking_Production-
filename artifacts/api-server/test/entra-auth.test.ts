import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";
import request from "supertest";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import app from "../src/app";
import { resetKeyStoreForTesting } from "../src/lib/entra";
import { resetDatabase, signIn, type Fixtures } from "./fixtures";

/**
 * Entra sign-in, verified end to end against a locally-hosted key set.
 *
 * The point is to exercise the real verification path — signature, issuer,
 * audience, expiry, role claims — rather than to stub it out, so the tenant
 * being absent does not mean the code is untested.
 */
const ISSUER = "https://test-issuer.local/v2.0";
const AUDIENCE = "api://timetrack-test";
const KID = "test-key-1";
const JWKS_PORT = 8098;

// Inferred rather than imported: jose renamed its key type between versions.
type PrivateKey = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];

let privateKey: PrivateKey;
let otherPrivateKey: PrivateKey;
let keyServer: http.Server;

interface TokenOptions {
  oid?: string;
  email?: string;
  name?: string;
  roles?: string[] | string | null;
  audience?: string;
  issuer?: string;
  expiresIn?: string;
  signWithWrongKey?: boolean;
}

async function mintToken(options: TokenOptions = {}): Promise<string> {
  const payload: Record<string, unknown> = {
    oid: options.oid ?? "entra-oid-1",
    preferred_username: options.email ?? "new.person@tristone.test",
    name: options.name ?? "New Person",
  };
  if (options.roles !== null) {
    payload["roles"] = options.roles ?? ["TimeTrack.Analyst"];
  }

  return new SignJWT(payload)
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setIssuedAt()
    .setIssuer(options.issuer ?? ISSUER)
    .setAudience(options.audience ?? AUDIENCE)
    .setExpirationTime(options.expiresIn ?? "10m")
    .sign(options.signWithWrongKey ? otherPrivateKey : privateKey);
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

describe("Entra ID authentication", () => {
  let f: Fixtures;

  beforeAll(async () => {
    const pair = await generateKeyPair("RS256");
    const otherPair = await generateKeyPair("RS256");
    privateKey = pair.privateKey;
    otherPrivateKey = otherPair.privateKey;

    const jwk = await exportJWK(pair.publicKey);
    const body = JSON.stringify({
      keys: [{ ...jwk, kid: KID, alg: "RS256", use: "sig" }],
    });

    keyServer = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(body);
    });
    await new Promise<void>((resolve) =>
      keyServer.listen(JWKS_PORT, "127.0.0.1", resolve),
    );
    resetKeyStoreForTesting();
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => keyServer.close(() => resolve()));
  });

  beforeEach(async () => {
    f = await resetDatabase();
  });

  describe("rejects anything it did not sign off on", () => {
    it("a token for another audience", async () => {
      const token = await mintToken({ audience: "api://someone-else" });
      const res = await request(app).get("/api/time-entries").set(bearer(token));
      expect(res.status).toBe(401);
    });

    it("a token from another issuer", async () => {
      const token = await mintToken({ issuer: "https://evil.example/v2.0" });
      const res = await request(app).get("/api/time-entries").set(bearer(token));
      expect(res.status).toBe(401);
    });

    it("a token signed with a key the tenant does not publish", async () => {
      const token = await mintToken({ signWithWrongKey: true });
      const res = await request(app).get("/api/time-entries").set(bearer(token));
      expect(res.status).toBe(401);
    });

    it("an expired token", async () => {
      const token = await mintToken({ expiresIn: "-5m" });
      const res = await request(app).get("/api/time-entries").set(bearer(token));
      expect(res.status).toBe(401);
    });

    it("a tampered payload", async () => {
      const token = await mintToken();
      const [header, , signature] = token.split(".");
      const forged = Buffer.from(
        JSON.stringify({
          oid: "entra-oid-1",
          preferred_username: "attacker@tristone.test",
          roles: ["TimeTrack.MD"],
          iss: ISSUER,
          aud: AUDIENCE,
          exp: Math.floor(Date.now() / 1000) + 600,
        }),
      ).toString("base64url");

      const res = await request(app)
        .get("/api/time-entries")
        .set(bearer(`${header}.${forged}.${signature}`));
      expect(res.status).toBe(401);
    });

    it("gibberish", async () => {
      const res = await request(app)
        .get("/api/time-entries")
        .set(bearer("not-a-token"));
      expect(res.status).toBe(401);
    });

    it("a valid token carrying no TimeTrack role", async () => {
      // Signed in to the tenant, but never granted access to this app.
      const token = await mintToken({ roles: null });
      const res = await request(app).get("/api/time-entries").set(bearer(token));
      expect(res.status).toBe(401);

      const rows = await db
        .select()
        .from(usersTable)
        .where(eq(usersTable.entraOid, "entra-oid-1"));
      expect(rows).toHaveLength(0);
    });
  });

  describe("provisioning on first sign-in", () => {
    it("creates the account from the token, with no password", async () => {
      const token = await mintToken({
        oid: "oid-new",
        email: "Fresh.Face@Tristone.test",
        name: "Fresh Face",
        roles: ["TimeTrack.Associate"],
      });

      const res = await request(app).get("/api/time-entries").set(bearer(token));
      expect(res.status).toBe(200);

      const [created] = await db
        .select()
        .from(usersTable)
        .where(eq(usersTable.entraOid, "oid-new"));

      expect(created).toBeDefined();
      expect(created.email).toBe("fresh.face@tristone.test");
      expect(created.name).toBe("Fresh Face");
      expect(created.role).toBe("associate");
      expect(created.passwordHash).toBeNull();
    });

    it("adopts an existing password account rather than duplicating it", async () => {
      const token = await mintToken({
        oid: "oid-analyst",
        email: "analyst@test.local",
        name: "Ana Lyst",
      });

      await request(app).get("/api/time-entries").set(bearer(token));

      const rows = await db
        .select()
        .from(usersTable)
        .where(eq(usersTable.email, "analyst@test.local"));

      expect(rows).toHaveLength(1);
      // Same row, so their logged history stays attached to them.
      expect(rows[0].id).toBe(f.analyst);
      expect(rows[0].entraOid).toBe("oid-analyst");
    });

    it("does not create a second account on repeat sign-ins", async () => {
      const token = await mintToken({ oid: "oid-repeat", email: "repeat@tristone.test" });
      await request(app).get("/api/time-entries").set(bearer(token));
      await request(app).get("/api/time-entries").set(bearer(token));

      const rows = await db
        .select()
        .from(usersTable)
        .where(eq(usersTable.entraOid, "oid-repeat"));
      expect(rows).toHaveLength(1);
    });
  });

  describe("Entra owns roles", () => {
    it("maps each app role onto the firm's hierarchy", async () => {
      const cases: Array<[string, string]> = [
        ["TimeTrack.Analyst", "analyst"],
        ["TimeTrack.Associate", "associate"],
        ["TimeTrack.AVP", "avp"],
        ["TimeTrack.MD", "md"],
      ];

      for (const [claim, expected] of cases) {
        const oid = `oid-${expected}`;
        const token = await mintToken({
          oid,
          email: `${expected}@tristone.test`,
          roles: [claim],
        });
        await request(app).get("/api/time-entries").set(bearer(token));

        const [user] = await db
          .select()
          .from(usersTable)
          .where(eq(usersTable.entraOid, oid));
        expect(user.role).toBe(expected);
      }
    });

    it("grants the most senior role when someone is in several groups", async () => {
      const token = await mintToken({
        oid: "oid-multi",
        email: "multi@tristone.test",
        roles: ["TimeTrack.Analyst", "TimeTrack.AVP", "TimeTrack.Associate"],
      });
      await request(app).get("/api/time-entries").set(bearer(token));

      const [user] = await db
        .select()
        .from(usersTable)
        .where(eq(usersTable.entraOid, "oid-multi"));
      expect(user.role).toBe("avp");
    });

    it("re-syncs when the role changes in the directory", async () => {
      const first = await mintToken({
        oid: "oid-promoted",
        email: "promoted@tristone.test",
        roles: ["TimeTrack.Analyst"],
      });
      await request(app).get("/api/time-entries").set(bearer(first));

      const promoted = await mintToken({
        oid: "oid-promoted",
        email: "promoted@tristone.test",
        roles: ["TimeTrack.MD"],
      });
      await request(app).get("/api/time-entries").set(bearer(promoted));

      const [user] = await db
        .select()
        .from(usersTable)
        .where(eq(usersTable.entraOid, "oid-promoted"));
      expect(user.role).toBe("md");
    });

    it("carries the role into authorization, not just the stored row", async () => {
      const analystToken = await mintToken({
        oid: "oid-perm-analyst",
        email: "perm-analyst@tristone.test",
        roles: ["TimeTrack.Analyst"],
      });
      const mdToken = await mintToken({
        oid: "oid-perm-md",
        email: "perm-md@tristone.test",
        roles: ["TimeTrack.MD"],
      });

      // Creating a user is AVP and above.
      const asAnalyst = await request(app)
        .post("/api/users")
        .set(bearer(analystToken))
        .send({ name: "X", email: "x@tristone.test", password: "a-long-enough-password", role: "analyst" });
      expect(asAnalyst.status).toBe(403);

      const asMd = await request(app)
        .post("/api/users")
        .set(bearer(mdToken))
        .send({ name: "X", email: "x@tristone.test", password: "a-long-enough-password", role: "analyst" });
      expect(asMd.status).toBe(201);
    });

    it("still refuses an account deactivated locally", async () => {
      const token = await mintToken({
        oid: "oid-gone",
        email: "inactive@test.local",
        name: "Gone Away",
      });
      const res = await request(app).get("/api/time-entries").set(bearer(token));
      expect(res.status).toBe(403);
    });
  });

  describe("coexisting with password sign-in during the migration", () => {
    it("keeps session sign-in working while Entra is enabled", async () => {
      const agent = await signIn(app, "md@test.local");
      expect((await agent.get("/api/time-entries")).status).toBe(200);
    });

    it("refuses password sign-in for an Entra-provisioned account", async () => {
      const token = await mintToken({ oid: "oid-nopass", email: "nopass@tristone.test" });
      await request(app).get("/api/time-entries").set(bearer(token));

      const res = await request(app)
        .post("/api/auth/login")
        .send({ email: "nopass@tristone.test", password: "anything-at-all" });
      expect(res.status).toBe(401);
    });

    it("advertises how to sign in without exposing anything secret", async () => {
      const res = await request(app).get("/api/auth/config");
      expect(res.status).toBe(200);
      expect(res.body.passwordSignIn).toBe(true);
      expect(res.body.entra.tenantId).toBeTruthy();
      expect(JSON.stringify(res.body)).not.toMatch(/secret|password_hash/i);
    });
  });
});
