import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(here, "../../../lib/db/drizzle");

/**
 * Builds a throwaway database from the real migrations before the suite runs.
 *
 * Migrating rather than loading a snapshot means the tests exercise the same
 * triggers and constraints that production will have — a schema drift breaks
 * the suite instead of silently passing against a stale fixture.
 */
export async function setup(): Promise<void> {
  const url = new URL(
    process.env["DATABASE_URL"] ??
      "postgresql://postgres@localhost:5432/timetracker_test",
  );
  const dbName = url.pathname.replace(/^\//, "");

  const adminUrl = new URL(url.toString());
  adminUrl.pathname = "/postgres";

  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  try {
    await admin.connect();
  } catch (err) {
    throw new Error(
      `Cannot reach Postgres at ${adminUrl.host}. Start it before running the tests.\n${String(err)}`,
    );
  }

  // Terminate strays so DROP cannot block on a leaked connection.
  await admin.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
     WHERE datname = $1 AND pid <> pg_backend_pid()`,
    [dbName],
  );
  await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
  await admin.query(`CREATE DATABASE "${dbName}"`);
  await admin.end();

  const pool = new pg.Pool({ connectionString: url.toString() });
  try {
    await migrate(drizzle(pool), { migrationsFolder });
  } finally {
    await pool.end();
  }
}

export async function teardown(): Promise<void> {
  // The database is left in place after a run so a failing test can be
  // inspected; the next run recreates it from scratch.
}
