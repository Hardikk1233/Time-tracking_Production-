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

Without the webhook, feedback still arrives — the console just shows an unread
count instead of pushing a notification. To create one in Teams: channel → ⋯ →
Workflows → "Post to a channel when a webhook request is received", then paste
the generated URL into the variable.

## How access works

| Endpoint | Who |
|---|---|
| `POST /api/dev/client-events` | anyone, rate-limited to 30/min per IP |
| `POST /api/feedback` | any signed-in user |
| `GET/POST/DELETE /api/dev/*` | `DEV_CONSOLE_EMAILS` only |

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
   `src/lib/dev-events.ts`, `src/middlewares/dev-console.ts`
2. Their wiring in `src/routes/index.ts`, the `recordEvent` call in
   `src/app.ts`, and the block in `src/config.ts`
3. `artifacts/time-tracker/src/pages/dev.tsx`,
   `src/components/feedback-widget.tsx`, `src/lib/dev-api.ts`,
   `src/lib/error-reporting.ts`, and their imports in `App.tsx`,
   `main.tsx`, `main-layout.tsx`, `components/error-boundary.tsx`
4. `lib/db/src/schema/appEvents.ts` and `feedback.ts`, then generate a
   migration dropping both tables

Then unset `DEV_CONSOLE_EMAILS` and `FEEDBACK_WEBHOOK_URL`.
