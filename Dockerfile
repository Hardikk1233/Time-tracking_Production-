# syntax=docker/dockerfile:1
#
# One image serves both the API and the built React app, so the deployment is a
# single Container App with no separate frontend host — and, because everything
# is same-origin, no CORS grant and no cross-site cookie handling.
#
# Build for linux/amd64. pnpm-workspace.yaml prunes the non-x64 native binaries
# for esbuild, rollup, lightningcss and tailwind-oxide, so other architectures
# cannot resolve a complete dependency tree:
#
#   docker build --platform linux/amd64 -t timetrack-api .
#
# Debian-based (not Alpine) on purpose: the workspace also prunes the *-musl
# rollup/lightningcss/oxide binaries, so a musl build stage fails to install.

# ─── Build ────────────────────────────────────────────────────────────────────
FROM node:24-slim AS build

RUN corepack enable
WORKDIR /repo

# Manifests first: a source-only change then reuses the cached install layer.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY artifacts/api-server/package.json      artifacts/api-server/
COPY artifacts/time-tracker/package.json    artifacts/time-tracker/
COPY artifacts/mockup-sandbox/package.json  artifacts/mockup-sandbox/
COPY lib/api-client-react/package.json      lib/api-client-react/
COPY lib/api-spec/package.json              lib/api-spec/
COPY lib/api-zod/package.json               lib/api-zod/
COPY lib/db/package.json                    lib/db/
COPY scripts/package.json                   scripts/

RUN pnpm install --frozen-lockfile

COPY . .

# The frontend's vite.config.ts requires both of these at build time.
ENV NODE_ENV=production \
    PORT=8080 \
    BASE_PATH=/

RUN pnpm --filter @workspace/time-tracker run build \
 && pnpm --filter @workspace/api-server run build

# ─── Runtime ──────────────────────────────────────────────────────────────────
FROM node:24-slim AS runtime

ENV NODE_ENV=production \
    PORT=8080 \
    STATIC_DIR=/app/public

WORKDIR /app

# esbuild bundles the API into self-contained ESM (verified to run with no
# node_modules present), so the runtime image carries only compiled output.
COPY --from=build --chown=node:node /repo/artifacts/api-server/dist ./dist
COPY --from=build --chown=node:node /repo/artifacts/time-tracker/dist/public ./public
# Applied by `node dist/migrate.mjs` as a pre-deploy job, never at startup.
COPY --from=build --chown=node:node /repo/lib/db/drizzle ./drizzle

USER node
EXPOSE 8080

# Signals reach Node directly, so the SIGTERM handler in src/index.ts can drain
# in-flight requests before the replica goes away.
CMD ["node", "--enable-source-maps", "dist/index.mjs"]
