-- Time-entry integrity, enforced below the application.
--
-- The rule the firm needs is that hours approved by an Associate or above
-- cannot afterwards be changed. Enforcing that only in Express would mean the
-- guarantee is worth exactly as much as the next refactor; these triggers hold
-- it at the storage layer, so no route — and no ad-hoc SQL — can break it.

-- ─── 1. Immutability guard ───────────────────────────────────────────────────
-- BEFORE trigger: aborts the statement, so nothing is written and no audit row
-- is produced for a change that never happened.

CREATE OR REPLACE FUNCTION guard_time_entry_immutability()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'approved' THEN
      RAISE EXCEPTION 'Approved time entries cannot be deleted (entry %)', OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.status = 'approved' THEN
    -- The one permitted way out of "approved": an explicit reopen back to
    -- pending that changes no billable values. Corrections then happen in the
    -- open, as a fresh edit-and-reapprove cycle, each step audited.
    IF NEW.status = 'pending'
       AND NEW.hours = OLD.hours
       AND NEW.date = OLD.date
       AND NEW.task_id = OLD.task_id
       AND NEW.project_id IS NOT DISTINCT FROM OLD.project_id
       AND NEW.billable_hours IS NOT DISTINCT FROM OLD.billable_hours
    THEN
      RETURN NEW;
    END IF;

    RAISE EXCEPTION 'Approved time entries are immutable (entry %)', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER IF EXISTS time_entries_immutability ON time_entries;
--> statement-breakpoint

CREATE TRIGGER time_entries_immutability
  BEFORE UPDATE OR DELETE ON time_entries
  FOR EACH ROW EXECUTE FUNCTION guard_time_entry_immutability();
--> statement-breakpoint

-- ─── 2. Audit ledger ─────────────────────────────────────────────────────────
-- AFTER trigger: only successful changes are recorded. The acting user arrives
-- via `set_config('app.actor_id', …, true)`, set per transaction by withActor()
-- in lib/db — a trigger has no other way to know who is behind a write.

CREATE OR REPLACE FUNCTION record_time_entry_event()
RETURNS trigger AS $$
DECLARE
  actor integer := NULLIF(current_setting('app.actor_id', true), '')::integer;
  act   text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO time_entry_events (time_entry_id, action, actor_id, previous, next)
    VALUES (NEW.id, 'created', actor, NULL, to_jsonb(NEW));
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    INSERT INTO time_entry_events (time_entry_id, action, actor_id, previous, next)
    VALUES (OLD.id, 'deleted', actor, to_jsonb(OLD), NULL);
    RETURN OLD;
  END IF;

  act := CASE
    WHEN NEW.status = OLD.status                          THEN 'updated'
    WHEN NEW.status = 'approved'                          THEN 'approved'
    WHEN NEW.status = 'rejected'                          THEN 'rejected'
    WHEN OLD.status = 'approved' AND NEW.status = 'pending' THEN 'reopened'
    ELSE 'updated'
  END;

  INSERT INTO time_entry_events (time_entry_id, action, actor_id, previous, next)
  VALUES (NEW.id, act, actor, to_jsonb(OLD), to_jsonb(NEW));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER IF EXISTS time_entries_audit ON time_entries;
--> statement-breakpoint

CREATE TRIGGER time_entries_audit
  AFTER INSERT OR UPDATE OR DELETE ON time_entries
  FOR EACH ROW EXECUTE FUNCTION record_time_entry_event();
--> statement-breakpoint

-- ─── 3. Keep the ledger append-only ──────────────────────────────────────────
-- Nothing rewrites history, including the application itself.

CREATE OR REPLACE FUNCTION reject_time_entry_event_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'time_entry_events is append-only'
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER IF EXISTS time_entry_events_append_only ON time_entry_events;
--> statement-breakpoint

CREATE TRIGGER time_entry_events_append_only
  BEFORE UPDATE OR DELETE ON time_entry_events
  FOR EACH ROW EXECUTE FUNCTION reject_time_entry_event_mutation();
