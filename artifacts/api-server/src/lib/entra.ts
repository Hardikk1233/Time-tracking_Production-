import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { config } from "../config";
import { isRole, type Role } from "./roles";

/**
 * Microsoft Entra ID token verification.
 *
 * Tokens are checked against the tenant's published signing keys — signature,
 * issuer, audience and expiry — so the API trusts nothing the caller asserts
 * about themselves beyond what Microsoft signed.
 */

/** App roles as declared in the API app registration's manifest. */
const ROLE_CLAIM_MAP: Record<string, Role> = {
  "TimeTrack.MD": "md",
  "TimeTrack.AVP": "avp",
  "TimeTrack.Associate": "associate",
  "TimeTrack.Analyst": "analyst",
};

const ROLE_PRECEDENCE: Role[] = ["md", "avp", "associate", "analyst"];

export interface EntraIdentity {
  /** Immutable per-person object id within the tenant. */
  oid: string;
  email: string;
  name: string;
  role: Role;
}

export class EntraAuthError extends Error {
  constructor(
    message: string,
    readonly reason: string,
  ) {
    super(message);
    this.name = "EntraAuthError";
  }
}

/** True when the tenant details needed to validate tokens are configured. */
export function isEntraConfigured(): boolean {
  return Boolean(config.entraTenantId && config.entraAudience);
}

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function keyStore(): ReturnType<typeof createRemoteJWKSet> {
  if (!jwks) {
    // jose caches the key set and refetches on rotation, so this is not a
    // network round-trip per request.
    jwks = createRemoteJWKSet(
      new URL(
        config.entraJwksUri ??
          `https://login.microsoftonline.com/${config.entraTenantId}/discovery/v2.0/keys`,
      ),
    );
  }
  return jwks;
}

/** Test seam: lets the suite point verification at a local key set. */
export function resetKeyStoreForTesting(): void {
  jwks = null;
}

function highestRole(claim: unknown): Role | null {
  const values = Array.isArray(claim)
    ? claim
    : typeof claim === "string"
      ? [claim]
      : [];

  const mapped = values
    .map((value) => ROLE_CLAIM_MAP[String(value)] ?? (isRole(value) ? value : null))
    .filter((value): value is Role => value != null);

  if (mapped.length === 0) return null;
  // Someone in several groups gets the most senior of them.
  return ROLE_PRECEDENCE.find((role) => mapped.includes(role)) ?? null;
}

function readString(payload: JWTPayload, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

/**
 * Verifies a bearer token and extracts the identity it carries.
 *
 * Throws EntraAuthError for anything that fails — the caller turns that into a
 * 401 without echoing the detail back to the client.
 */
export async function verifyEntraToken(token: string): Promise<EntraIdentity> {
  if (!isEntraConfigured()) {
    throw new EntraAuthError("Entra is not configured", "not_configured");
  }

  let payload: JWTPayload;
  try {
    const verified = await jwtVerify(token, keyStore(), {
      audience: config.entraAudience!,
      issuer: config.entraIssuer ?? [
        `https://login.microsoftonline.com/${config.entraTenantId}/v2.0`,
        `https://sts.windows.net/${config.entraTenantId}/`,
      ],
      clockTolerance: 60,
    });
    payload = verified.payload;
  } catch (err) {
    throw new EntraAuthError(
      `Token verification failed: ${String(err)}`,
      "invalid_token",
    );
  }

  const oid = readString(payload, "oid", "sub");
  if (!oid) {
    throw new EntraAuthError("Token carries no object id", "missing_oid");
  }

  const email = readString(payload, "preferred_username", "email", "upn");
  if (!email) {
    throw new EntraAuthError("Token carries no email", "missing_email");
  }

  const role = highestRole(payload["roles"]);
  if (!role) {
    // Assignment is required on the app registration, so this means the person
    // signed in but was never granted a TimeTrack role.
    throw new EntraAuthError(
      "Token carries no recognised TimeTrack role",
      "no_role",
    );
  }

  return {
    oid,
    email: email.toLowerCase(),
    name: readString(payload, "name") ?? email,
    role,
  };
}
