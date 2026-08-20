import { defineConfig } from "drizzle-kit";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL, ensure the database is provisioned");
}

export default defineConfig({
  schema: "./src/schema/index.ts",
  // Versioned SQL migrations live here and are applied by the API image's
  // migrate entrypoint. `push` remains a local-development convenience only —
  // it diffs against a live database and can drop columns without warning.
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
});
