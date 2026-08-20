import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

const isProduction = process.env.NODE_ENV === "production";

function flag(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  return ["1", "true", "yes", "on"].includes(value);
}

function integer(name: string, fallback: number): number {
  const parsed = Number(process.env[name]?.trim());
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

// Azure Database for PostgreSQL requires TLS; local development typically runs
// without certificates, so SSL follows NODE_ENV unless set explicitly.
const useSsl = flag("DATABASE_SSL", isProduction);

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: useSsl
    ? { rejectUnauthorized: flag("DATABASE_SSL_REJECT_UNAUTHORIZED", true) }
    : undefined,
  // Sized against the smallest database tier's connection limit — see
  // DATABASE_POOL_MAX in the API server's config for the arithmetic.
  max: integer("DATABASE_POOL_MAX", 8),
  idleTimeoutMillis: integer("DATABASE_POOL_IDLE_MS", 30_000),
  connectionTimeoutMillis: integer("DATABASE_CONNECT_TIMEOUT_MS", 10_000),
});

// An idle client erroring (network blip, server restart) must not take the
// process down; the pool discards it and the next query gets a fresh one.
pool.on("error", (err) => {
  console.error("Unexpected database pool error", err);
});

export const db = drizzle(pool, { schema });

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Runs `fn` in a transaction tagged with the acting user's id.
 *
 * The audit triggers read this via `current_setting('app.actor_id')` — a
 * database trigger has no other way to know which person is behind a write.
 * `set_config(..., true)` scopes the value to the transaction, so it cannot
 * leak to the next request that borrows this pooled connection.
 *
 * Every mutating time-entry path must go through this; a write made outside it
 * still gets audited, but with a null actor.
 */
export async function withActor<T>(
  actorId: number,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT set_config('app.actor_id', ${String(actorId)}, true)`,
    );
    return fn(tx);
  });
}

/** Cheap liveness query for readiness probes. Throws if the database is unreachable. */
export async function checkDatabase(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("SELECT 1");
  } finally {
    client.release();
  }
}

/** Drains the pool during graceful shutdown. */
export async function closeDatabase(): Promise<void> {
  await pool.end();
}

export * from "./schema";
