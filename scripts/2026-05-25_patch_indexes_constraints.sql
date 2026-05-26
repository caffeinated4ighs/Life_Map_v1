-- =============================================================================
-- Life Map — Patch Migration: Indexes + CHECK Constraints
-- File:    2026-05-25_patch_indexes_constraints.sql
-- Author:  Scripting Agent  |  Task: TASK-20260525-002
-- Status:  FINAL — executed and verified on hmdrjdkjyhmigpbdeocu (us-west-2)
--
-- Run order: 2 of 3 — must run after 2026-05-25_initial_schema.sql
--
-- Adds 7 performance indexes and 7 CHECK constraints.
-- All statements are fully idempotent — safe to re-run.
--
-- Not added (by design):
--   effects.duration  — display-only, unconstrained per Manager decision
--   tasks.gold range  — open question at time of writing; add in future patch
--
-- Postgres note — ADD CONSTRAINT IF NOT EXISTS:
--   Not natively supported in any current Postgres version. Each constraint
--   addition uses a DO $$ block that checks pg_constraint first. Safe to re-run.
--   CREATE INDEX IF NOT EXISTS is natively supported since PG 9.5.
--
-- Rollback statements at bottom of file.
-- =============================================================================


-- =============================================================================
-- SECTION 1 — INDEXES
-- =============================================================================

-- tasks(date) — primary date lookup
CREATE INDEX IF NOT EXISTS idx_tasks_date
    ON tasks (date);

-- tasks(status, date) — composite for carry-over scan and daily task queries
CREATE INDEX IF NOT EXISTS idx_tasks_status_date
    ON tasks (status, date);

-- events(event_date, event_type) — EOD daily event aggregation
CREATE INDEX IF NOT EXISTS idx_events_event_date_type
    ON events (event_date, event_type);

-- arcs(status) — filter active arcs for arc modifier computation
CREATE INDEX IF NOT EXISTS idx_arcs_status
    ON arcs (status);

-- arcs(start_date) — arc XP multiplier date-proximity math
CREATE INDEX IF NOT EXISTS idx_arcs_start_date
    ON arcs (start_date);

-- streak_log(log_date) — daily uniqueness already enforced; named index for query planning
CREATE INDEX IF NOT EXISTS idx_streak_log_log_date
    ON streak_log (log_date);

-- day_snapshots(snapshot_date) — explicit named index alongside UNIQUE constraint
CREATE INDEX IF NOT EXISTS idx_day_snapshots_snapshot_date
    ON day_snapshots (snapshot_date);


-- =============================================================================
-- SECTION 2 — CHECK CONSTRAINTS
-- DO $$ pattern used for idempotency (see header note).
-- =============================================================================

-- tasks.status
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'tasks_status_check' AND conrelid = 'tasks'::regclass
    ) THEN
        ALTER TABLE tasks ADD CONSTRAINT tasks_status_check
            CHECK (status IN ('Pending', 'Done', 'Skipped', 'Carried Over'));
    END IF;
END $$;

-- tasks.type
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'tasks_type_check' AND conrelid = 'tasks'::regclass
    ) THEN
        ALTER TABLE tasks ADD CONSTRAINT tasks_type_check
            CHECK (type IN ('Mandatory', 'Bonus', 'Habit', 'Project'));
    END IF;
END $$;

-- tasks.late_rule
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'tasks_late_rule_check' AND conrelid = 'tasks'::regclass
    ) THEN
        ALTER TABLE tasks ADD CONSTRAINT tasks_late_rule_check
            CHECK (late_rule IN ('carry_over', 'drop', 'penalise'));
    END IF;
END $$;

-- tasks.time_block
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'tasks_time_block_check' AND conrelid = 'tasks'::regclass
    ) THEN
        ALTER TABLE tasks ADD CONSTRAINT tasks_time_block_check
            CHECK (time_block IN ('Morning', 'Afternoon', 'Evening', 'Flexible'));
    END IF;
END $$;

-- tasks.priority (0–3 integer range)
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'tasks_priority_check' AND conrelid = 'tasks'::regclass
    ) THEN
        ALTER TABLE tasks ADD CONSTRAINT tasks_priority_check
            CHECK (priority BETWEEN 0 AND 3);
    END IF;
END $$;

-- tasks.energy_cost (1–5 integer range)
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'tasks_energy_cost_check' AND conrelid = 'tasks'::regclass
    ) THEN
        ALTER TABLE tasks ADD CONSTRAINT tasks_energy_cost_check
            CHECK (energy_cost BETWEEN 1 AND 5);
    END IF;
END $$;

-- task_skill_links.crossover_level
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'task_skill_links_crossover_level_check' AND conrelid = 'task_skill_links'::regclass
    ) THEN
        ALTER TABLE task_skill_links ADD CONSTRAINT task_skill_links_crossover_level_check
            CHECK (crossover_level IN ('Direct', 'Partial', 'Indirect'));
    END IF;
END $$;


-- =============================================================================
-- ROLLBACK (do not execute — reference only)
-- =============================================================================
-- DROP INDEX IF EXISTS idx_tasks_date;
-- DROP INDEX IF EXISTS idx_tasks_status_date;
-- DROP INDEX IF EXISTS idx_events_event_date_type;
-- DROP INDEX IF EXISTS idx_arcs_status;
-- DROP INDEX IF EXISTS idx_arcs_start_date;
-- DROP INDEX IF EXISTS idx_streak_log_log_date;
-- DROP INDEX IF EXISTS idx_day_snapshots_snapshot_date;
-- ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_status_check;
-- ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_type_check;
-- ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_late_rule_check;
-- ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_time_block_check;
-- ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_priority_check;
-- ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_energy_cost_check;
-- ALTER TABLE task_skill_links DROP CONSTRAINT IF EXISTS task_skill_links_crossover_level_check;
-- =============================================================================
-- END
-- =============================================================================
