// Imported first so configuration problems surface as one clear startup error
// before any module reaches for a connection string.
import { config } from "./config";
import app from "./app";
import { closeDatabase } from "@workspace/db";
import { logger } from "./lib/logger";

const server = app.listen(config.port, () => {
  logger.info(
    {
      port: config.port,
      nodeEnv: config.nodeEnv,
      servingStatic: Boolean(config.staticDir),
    },
    "Server listening",
  );
});

/**
 * Container Apps sends SIGTERM before removing a replica during a deploy or
 * scale-in. Draining in-flight requests here is what makes those swaps
 * invisible to users rather than a burst of failed calls.
 */
const SHUTDOWN_TIMEOUT_MS = 15_000;
let shuttingDown = false;

function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "Shutting down");

  // Safety net: if a long-running request never finishes, exit anyway rather
  // than letting the platform kill us at an arbitrary point.
  const forceExit = setTimeout(() => {
    logger.error("Graceful shutdown timed out; exiting");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();

  server.close(async (err) => {
    if (err) logger.error({ err }, "Error closing HTTP server");
    try {
      await closeDatabase();
    } catch (dbErr) {
      logger.error({ err: dbErr }, "Error closing database pool");
    }
    clearTimeout(forceExit);
    logger.info("Shutdown complete");
    process.exit(err ? 1 : 0);
  });
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

process.on("unhandledRejection", (reason) => {
  logger.error({ err: reason }, "Unhandled promise rejection");
});

process.on("uncaughtException", (err) => {
  logger.fatal({ err }, "Uncaught exception; exiting");
  process.exit(1);
});
