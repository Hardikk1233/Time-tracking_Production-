# The /dev console

Temporary tooling for the Entra rollout: somewhere for errors to land, and a
way for the people testing to say what went wrong without writing an email.

All of it is inert unless configured, and all of it is meant to come out. The
removal checklist is at the bottom of this file.

## What it does

**Captures errors from both sides of the app.** Container Apps already streams
the server's stdout to Log Analytics, but that only ever contains what the
*server* did. A React render that throws, a chunk that fails to load, an MSAL
popup the browser blocked — none of it reaches Log Analytics, and none of it is
something the person who hit it can usefully describe an hour later. Both sides
now land in one `app_events` table.

**Collects feedback.** A small button on every page, one message, sent with the
sender's identity and the page they were on. The page matters: "the dates are
wrong" means something different on `/reports` than on `/time-entries`, and
nobody remembers to say which they meant.

**Shows both at `/dev`.** Newest first, filterable by client/server, with stack
traces behind a toggle.

**Measures the app under load.** Added for the firm-wide rollout, when a
hundred people share a quarter of a vCPU. Every `/api` request is timed on the
server and, separately, in the browser that made it; each replica records its
own health every fifteen seconds. The **Performance** tab on `/dev` turns that
into four answers:

| Question | What answers it |
|---|---|
| Is it under load? | Requests per interval stacked by replica (a second colour appearing is Container Apps scaling out), and each replica's event-loop lag, memory, in-flight count and database-pool queue. |
| Is it slow? | p50/p95/p99 as the server measured it, next to p95 as browsers experienced it. The gap between the two is the network and the ingress, not the server. |
| Who was affected? | People ranked by failures, abandoned calls and slow calls - not by volume - with what their own browser reported alongside. |
| What exactly happened? | The individual calls behind any of the above, newest first, from both ends of the wire; or everything one person did in the window. |

Server rows and browser rows share one table and one route normalisation
(`/api/time-entries/412` → `/api/time-entries/:id`), which is what lets the
same call be read from both sides. A request the browser gave up on before the
answer came is recorded as status `499`; a call that got no response at all is
recorded by the browser as status `0`. Both count as failures.

Capture costs nothing on the request path: a finished request pushes one
object onto an in-memory buffer, and the database sees one batched insert
every five seconds. If the database is unreachable the buffer is capped and
the oldest rows dropped, so a database outage shows as a gap in the graphs
rather than as a process growing until it is killed.

## Configuration

Set on the Container App:

```
DEV_CONSOLE_EMAILS=hardik.pandey@tristone-partners.com
```

Comma-separated. **Leaving it unset switches the console off** rather than
opening it — the dangerous default for an access list is the permissive one,
and this variable is absent in every environment nobody has deliberately
configured.

Deliberately not `requireRole("md")`: seniority says nothing about who is
debugging a rollout, and the console shows raw stack traces and other people's
verbatim feedback. That is a narrower audience than "every Managing Director".

Optional:

```
FEEDBACK_WEBHOOK_URL=<Teams incoming webhook, or anything taking {"text": "..."}>
DEV_EVENT_RETENTION=5000
```

Request telemetry has its own settings, and unlike the console it is **on by
default** - the point is to already have the data from before somebody
reports slowness:

```
METRICS_ENABLED=true          # false makes the middleware and sampler no-ops
METRICS_RETENTION_DAYS=7      # request rows and replica samples older than this are trimmed on write
METRICS_SLOW_MS=1000          # what "slow" means in the console's counts and highlights
METRICS_SAMPLE_MS=15000       # how often each replica records its own health
```

`CONTAINER_APP_REPLICA_NAME` is set by the platform and is what the rows are
grouped by; a local run uses `local-<pid>` instead.

Without the webhook, feedback still arrives — the console just shows an unread
count instead of pushing a notification. To create one in Teams: channel → ⋯ →
Workflows → "Post to a channel when a webhook request is received", then paste
the generated URL into the variable.

## How access works

| Endpoint | Who |
|---|---|
| `POST /api/dev/client-events` | anyone, rate-limited to 30/min per IP |
| `POST /api/dev/client-metrics` | any signed-in user |
| `POST /api/feedback` | any signed-in user |
| `GET/POST/DELETE /api/dev/*` | `DEV_CONSOLE_EMAILS` only |

Browser timings, unlike crash reports, require a sign-in. A page that could
not sign in has no timing worth keeping that the crash report does not already
carry, and the token is what stops a script filling the table with fiction
about other people's experience. The console's own traffic (`/api/dev/*`) and
the platform's probes (`/api/healthz`, `/api/readyz`) are excluded from
capture on both sides, so the console never measures itself.

The intake endpoint is unauthenticated **on purpose**. The reports worth having
most are the ones from a browser that could not sign in — a token that will not
verify is the bug being reported, so demanding a valid token would discard
exactly the evidence needed. It is rate-limited instead, capped at 20 events
per request, and the client stops after 50 reports per page load so a render
loop cannot flood it.

Everything the console can read answers `404` rather than `403` to anyone not on
the list. The console is not a feature of the product, and someone who is not on
the list has no reason to learn it exists.

## What is deliberately not stored

Query strings are stripped from every URL before it is written. Report ids and
date ranges are not secret, but `?token=` and `?email=` end up in URLs more
often than anyone intends, and this table is read by a person in a browser
rather than by an access-controlled log pipeline.

## Removing it

One migration and four deletions:

1. `artifacts/api-server/src/routes/dev.ts`,
   `src/lib/dev-events.ts`, `src/lib/telemetry.ts`,
   `src/lib/telemetry-reports.ts`, `src/middlewares/dev-console.ts`
2. Their wiring in `src/routes/index.ts`; in `src/app.ts` the `recordEvent`
   call and the `requestTelemetry` mount; in `src/index.ts` the sampler start
   and the `flushMetrics` call on shutdown; and both blocks in `src/config.ts`
3. `artifacts/time-tracker/src/pages/dev.tsx`, `src/pages/dev-performance.tsx`,
   `src/components/feedback-widget.tsx`, `src/lib/dev-api.ts`,
   `src/lib/error-reporting.ts`, `src/lib/perf-reporting.ts`, and their
   imports in `App.tsx`, `main.tsx`, `main-layout.tsx`,
   `components/error-boundary.tsx`
4. `lib/db/src/schema/appEvents.ts`, `feedback.ts` and `requestMetrics.ts`,
   then generate a migration dropping all four tables

Then unset `DEV_CONSOLE_EMAILS`, `FEEDBACK_WEBHOOK_URL` and any `METRICS_*`
variables. The telemetry half can also be switched off on its own with
`METRICS_ENABLED=false`, which leaves the console readable for what it has
already collected.
