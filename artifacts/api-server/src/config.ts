/**
 * Centralised, fail-fast configuration.
 *
 * Every environment variable the server reads is declared here and validated at
 * import time, so a misconfigured deployment dies at startup with one complete
 * message instead of failing later in a request path — or, worse, silently
 * falling back to an insecure default.
 */

const NODE_ENV = process.env["NODE_ENV"] ?? "development";
const isProduction = NODE_ENV === "production";

const missing: string[] = [];
const invalid: string[] = [];

function read(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function required(name: string): string {
  const value = read(name);
  if (!value) {
    missing.push(name);
    return "";
  }
  return value;
}

/** Optional in development (with a clearly-marked fallback), mandatory in production. */
function requiredInProduction(name: string, devFallback: string): string {
  const value = read(name);
  if (value) return value;
  if (isProduction) missing.push(name);
  return devFallback;
}

function integer(
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = read(name);
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    invalid.push(`${name}="${value}" (expected an integer ${min}–${max})`);
    return fallback;
  }
  return parsed;
}

function boolean(name: string, fallback: boolean): boolean {
  const value = read(name)?.toLowerCase();
  if (value === undefined) return fallback;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  invalid.push(`${name}="${value}" (expected true or false)`);
  return fallback;
}

function list(name: string): string[] {
  const value = read(name);
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export const config = {
  nodeEnv: NODE_ENV,
  isProduction,

  /** Container Apps injects PORT; 8080 matches the container's EXPOSE. */
  port: integer("PORT", 8080, 1, 65535),
  logLevel: read("LOG_LEVEL") ?? "info",

  databaseUrl: required("DATABASE_URL"),

  /**
   * Azure Database for PostgreSQL requires TLS. Defaults on in production and
   * off locally, where Postgres typically runs without certificates.
   */
  databaseSsl: boolean("DATABASE_SSL", isProduction),

  /**
   * Kept deliberately small: the B1ms database tier allows ~35 connections in
   * total, and the API can scale to 3 replicas. 8 per replica leaves headroom
   * for migrations and administrative sessions.
   */
  databasePoolMax: integer("DATABASE_POOL_MAX", 8, 1, 100),

  sessionSecret: requiredInProduction(
    "SESSION_SECRET",
    "dev-only-insecure-secret",
  ),

  /**
   * Empty in production: the container serves the frontend, so browser calls
   * are same-origin and need no CORS grant at all. Populate only for local
   * development against the Vite dev server.
   */
  corsOrigins: list("CORS_ORIGINS"),

  /**
   * Absolute path to the built frontend. Unset in local development, where Vite
   * serves the app; set in the container so one process serves both.
   */
  staticDir: read("STATIC_DIR"),

  /** Behind Container Apps ingress, so the client IP and protocol come from headers. */
  trustProxy: boolean("TRUST_PROXY", isProduction),

  // ─── Microsoft Entra ID ────────────────────────────────────────────────────
  // Unset until the tenant is provisioned, in which case the API stays on
  // session auth. Once both are present, bearer tokens are accepted alongside
  // sessions; ENTRA_ONLY then retires passwords entirely.

  /** Directory (tenant) id. */
  entraTenantId: read("ENTRA_TENANT_ID"),
  /** Application ID URI or client id of the API registration — the audience. */
  entraAudience: read("ENTRA_AUDIENCE"),
  /** Client id of the SPA registration, handed to the browser for MSAL. */
  entraSpaClientId: read("ENTRA_SPA_CLIENT_ID"),
  /** Scope the SPA requests for the API, e.g. api://<id>/access_as_user. */
  entraApiScope: read("ENTRA_API_SCOPE"),
  /** Overrides for tests and sovereign clouds; derived from the tenant otherwise. */
  entraIssuer: read("ENTRA_ISSUER"),
  entraJwksUri: read("ENTRA_JWKS_URI"),
  /** Refuse password sign-in, leaving Entra as the only way in. */
  entraOnly: boolean("ENTRA_ONLY", false),
} as const;

if (missing.length > 0 || invalid.length > 0) {
  const problems = [
    ...missing.map((name) => `  - ${name} is required but was not set`),
    ...invalid.map((detail) => `  - ${detail}`),
  ].join("\n");

  throw new Error(
    `Invalid server configuration (NODE_ENV=${NODE_ENV}):\n${problems}`,
  );
}
