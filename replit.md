# TimeTrack

A full-stack time tracking application for professional services firms with a 4-tier hierarchy (MD → AVP → Associate → Analyst), client/project/task management, time entry logging with approval workflows, and an analytics dashboard.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 8080)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run typecheck:libs` — rebuild lib declarations (run after adding new schema/model files)
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string, `SESSION_SECRET` — express-session secret

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- Frontend: React + Vite, Tailwind CSS, shadcn/ui, Recharts, Wouter (routing), React Query
- API: Express 5 + express-session (MemoryStore)
- DB: PostgreSQL + Drizzle ORM
- Auth: bcryptjs password hashing, session cookies
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval v8 (from OpenAPI spec at `lib/api-spec/openapi.yaml`)
- Build: esbuild (bundled ESM)

## Where things live

- `lib/db/src/schema/` — Drizzle table definitions (source of truth for DB shape)
- `lib/api-spec/openapi.yaml` — OpenAPI spec (source of truth for API contract)
- `lib/api-client-react/src/generated/` — auto-generated hooks and types (do not edit)
- `artifacts/api-server/src/routes/` — Express route handlers
- `artifacts/time-tracker/src/pages/` — React page components
- `artifacts/time-tracker/src/components/ui/` — shadcn/ui component library

## Architecture decisions

- **Session auth over JWT**: Uses express-session with MemoryStore for simplicity in dev. Swap to Redis-backed sessions before production.
- **Orval v8 + Zod v3 shim**: Orval v8 generates Zod v4 syntax; `lib/api-zod/tsconfig.json` has a paths alias pointing `zod` → `zod/v4` to make it compatible with the workspace's Zod v3 install.
- **No `alias()` from drizzle-orm**: The installed version doesn't export `alias`. The approver join in time-entries was simplified to omit `approvedByName` on list queries (the field returns `null`); fetch separately if needed.
- **Role-based UI**: Frontend enforces role visibility (Analysts cannot set billable flag; Approvals page requires Associate+; Clients/Projects/Team management requires AVP+).

## Product

- **Login** — email + password for all 4 roles; redirects to dashboard on success
- **Dashboard** — KPI cards (total/billable/non-billable hours, pending count), stacked bar chart by client, activity feed, team utilization table (AVP/MD only), date range selector
- **Time Entries** — log hours against any task; Associates+ can approve/reject others' pending entries; filter by status
- **Approvals** — dedicated queue for pending entries belonging to others
- **Clients / Client Detail** — CRUD, team assignments, linked projects
- **Projects / Project Detail** — CRUD, team assignments, task management inline
- **Tasks** — global task list with project/client filter
- **Team Directory** — user cards with role badges; MD/AVP can provision new accounts

## Seed accounts (all password: `password123`)

| Email | Role |
|---|---|
| james@timetrack.com | MD |
| sarah@timetrack.com | AVP |
| marcus@timetrack.com | AVP |
| priya@timetrack.com | Associate |
| daniel@timetrack.com | Associate |
| olivia@timetrack.com | Associate |
| ethan@timetrack.com | Analyst |
| aisha@timetrack.com | Analyst |
| ryan@timetrack.com | Analyst |
| sofia@timetrack.com | Analyst |

## Gotchas

- Run `pnpm run typecheck:libs` after any changes to `lib/db` or `lib/api-spec` before typechecking the app packages.
- The API server rebuilds on every `dev` start (esbuild in watch not configured); restart the workflow after code changes.
- `SESSION_SECRET` must be set in Replit Secrets or the server will error on startup.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
