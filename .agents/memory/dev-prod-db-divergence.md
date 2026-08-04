---
name: Dev vs prod DB divergence
description: Why a bug can be fixed and verified in dev/republished, yet still reproduce on the published app — a data problem, not a code problem.
---

The workspace dev database and the published (production) app's database are separate instances. Publishing rebuilds and redeploys code, but does **not** copy or sync table rows between them.

**Why it matters:** any data created ad hoc during a dev session — via curl, a manual UI action, or a one-off script — exists only in the dev DB. If a bug's root cause is "missing row" rather than "wrong logic," fixing the code and republishing will not fix production, because the code was never the problem.

**How to apply:** When a user reports a bug still reproducing after a republish/redeploy that you already verified fixed in the dev preview:
1. Don't assume it's a stale build — check the *data* the two environments are actually serving (e.g. compare the same read endpoint against dev vs. the production URL directly with curl).
2. If production is missing rows dev has, insert them directly against production (e.g. via an authenticated API call to the production URL, or the database skill's production write path) rather than re-editing code.
3. Consider whether the feature needs a real seed script / migration step so future deploys don't hit the same gap.
