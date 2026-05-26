-- =============================================================================
-- Life Map — Patch Migration: tasks.type CHECK + tasks.gold CHECK
-- File:    2026-05-26_patch_tasks_type_gold_check.sql
-- Author:  Scripting Agent  |  Task: TASK-20260526-013
-- Status:  FINAL — ready to execute on hmdrjdkjyhmigpbdeocu (us-west-2)
--
-- Run order: 4 of 4 — must run after all three 2026-05-25_* migrations
--
-- Resolves two open checklist items from SUPERVISOR_LOG.md:
--
--   1. tasks.type CHECK incomplete — initial schema only validated 'Mandatory' | 'Bonus'.
--      AGENTS.md defines 4 types. Logic Agent sends all 4 after FLAG-008 normalisation.
--      DB will reject 'Habit' and 'Project' inserts until this patch runs.
--      CRITICAL: must execute before Logic Agent + DB Agent first real write.
--
--   2. tasks.gold CHECK missing — gold base values were open at schema creation time.
--      Now confirmed: floor is 1g. CHECK (gold >= 1) added.
--      Note: gold=0 is only valid for the initial default row value before Logic Agent
--      computes rewards. After Logic Agent runs, all inserted rows will have gold >= 1.
--      If gold=0 default causes constraint violations on INSERT (before Logic Agent sets it),
--      the Logic Agent must always provide gold explicitly. DB Agent must never INSERT
--      with gold=0 from a Logic Agent result.
--
-- Idempotency: DO $$ pattern used (pg_constraint check before ADD CONSTRAINT).
--   Dropping and re-adding constraints is safe — no data loss.
--   All statements are safe to re-run.
--
-- Rollback:
--   ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_type_check;
--   ALTER TABLE tasks ADD CONSTRAINT tasks_type_check
--     CHECK (type IN ('Mandatory', 'Bonus'));
--   ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_gold_check;
-- =============================================================================


-- =============================================================================
-- SECTION 1 — REPLACE tasks.type CHECK (Mandatory | Bonus → all 4 types)
-- =============================================================================

-- Drop existing constraint (created in patch_indexes_constraints.sql with only 2 values)
-- DO $$ pattern: check if it exists before dropping — safe to re-run
DO $$ BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'tasks_type_check' AND conrelid = 'tasks'::regclass
    ) THEN
        ALTER TABLE tasks DROP CONSTRAINT tasks_type_check;
    END IF;
END $$;

-- Re-add with all 4 types per AGENTS.md
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'tasks_type_check' AND conrelid = 'tasks'::regclass
    ) THEN
        ALTER TABLE tasks ADD CONSTRAINT tasks_type_check
            CHECK (type IN ('Mandatory', 'Bonus', 'Habit', 'Project'));
    END IF;
END $$;


-- =============================================================================
-- SECTION 2 — ADD tasks.gold CHECK (gold >= 1)
-- =============================================================================

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'tasks_gold_check' AND conrelid = 'tasks'::regclass
    ) THEN
        ALTER TABLE tasks ADD CONSTRAINT tasks_gold_check
            CHECK (gold >= 1);
    END IF;
END $$;

-- NOTE: tasks.gold DEFAULT is 0 in the schema (initial state before Logic Agent sets it).
-- The gold >= 1 CHECK applies on INSERT and UPDATE. Logic Agent must always provide
-- a computed gold value (>= 1) when creating tasks. DB Agent must never INSERT a task
-- row with the default gold=0 from a Logic Agent result — Logic Agent owns gold computation.
-- The default=0 is retained for schema compatibility; the constraint enforces intent at write time.


-- =============================================================================
-- VERIFICATION QUERIES (run manually after execution to confirm)
-- =============================================================================
-- SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--   WHERE conrelid = 'tasks'::regclass AND conname IN ('tasks_type_check', 'tasks_gold_check');
--
-- Expected output:
--   tasks_type_check  | CHECK ((type = ANY (ARRAY['Mandatory'::text, 'Bonus'::text, 'Habit'::text, 'Project'::text])))
--   tasks_gold_check  | CHECK ((gold >= 1))


-- =============================================================================
-- ROLLBACK (do not execute — reference only)
-- =============================================================================
-- ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_type_check;
-- ALTER TABLE tasks ADD CONSTRAINT tasks_type_check
--     CHECK (type IN ('Mandatory', 'Bonus'));
-- ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_gold_check;
-- =============================================================================
-- END
-- =============================================================================
