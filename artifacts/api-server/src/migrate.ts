/**
 * Migration entrypoint.
 *
 * Runs as a one-shot job before a new revision goes live — deliberately not on
 * API startup, so that a failed migration surfaces as one failed job rather
 * than every replica crash-looping, and so concurrent replicas never race to
 * apply the same schema change.
 *
 * Built by esbuild alongside the server: `node dist/migrate.mjs`.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, closeDatabase } from "@workspace/db";
import { logger } from "./lib/logger";

const here = path.dirname(fileURLToPath(import.meta.url));

// Defaults to the folder shipped next to the bundle in the container image.
const migrationsFolder =
  process.env["MIGRATIONS_DIR"]?.trim() || path.join(here, "..", "drizzle");

async function main(): Promise<void> {
  logger.info({ migrationsFolder }, "Applying database migrations");
  await migrate(db, { migrationsFolder });
  logger.info("Migrations applied");
}

main()
  .then(async () => {
    await closeDatabase();
    process.exit(0);
  })
  .catch(async (err) => {
    logger.fatal({ err }, "Migration failed");
    try {
      await closeDatabase();
    } catch {
      // Already failing; the exit code below is what matters.
    }
    process.exit(1);
  });
