-- =============================================================================
-- Life Map — Patch Migration: tasks.status CHECK — add 'Cancelled'
-- File:    2026-05-26_patch_tasks_status_cancelled.sql
-- Author:  Scripting Agent  |  Task: TASK-20260526-024
-- Status:  FINAL
--
-- Run order: standalone — run after all three 2026-05-25 migrations and
--   after 2026-05-26_patch_tasks_type_check.sql.
--
-- Problem: tasks.status CHECK constraint (tasks_status_check) validates only
--   'Pending' | 'Done' | 'Skipped' | 'Carried Over'. A fifth status value,
--   'Cancelled', is required. INSERT or UPDATE with status='Cancelled' will
--   hard-fail against the existing constraint.
--   Fix: drop the old constraint, add a replacement covering all five values.
--
-- Idempotency:
--   - DROP CONSTRAINT uses IF EXISTS — safe to re-run if already dropped.
--   - ADD CONSTRAINT uses DO $$ / pg_constraint check — no-op if already present.
--   - No data mutations — tasks table is empty at migration time.
--
-- Postgres note: ADD CONSTRAINT IF NOT EXISTS is not natively supported.
--   The DO $$ block pattern (check pg_constraint first) is used throughout,
--   consistent with 2026-05-25_patch_indexes_constraints.sql.
--
-- Rollback statements at bottom of file.
-- =============================================================================


-- =============================================================================
-- SECTION 1 — tasks.status CHECK
-- Drop the four-value constraint and replace with one covering all five values.
-- =============================================================================

-- Step 1a: Drop the existing constraint if present.
-- IF EXISTS prevents failure on re-run after a previous successful migration.
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_status_check;

-- Step 1b: Add the replacement constraint covering all five status values.
-- DO $$ block for idempotency — no-op if constraint already exists with this name.
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'tasks_status_check' AND conrelid = 'tasks'::regclass
    ) THEN
        ALTER TABLE tasks ADD CONSTRAINT tasks_status_check
            CHECK (status IN ('Pending', 'Done', 'Skipped', 'Carried Over', 'Cancelled'));
    END IF;
END $$;


-- =============================================================================
-- ROLLBACK (do not execute — reference only)
-- =============================================================================
-- -- Restore four-value tasks.status CHECK (without Cancelled):
-- ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_status_check;
-- ALTER TABLE tasks ADD CONSTRAINT tasks_status_check
--     CHECK (status IN ('Pending', 'Done', 'Skipped', 'Carried Over'));
-- =============================================================================
-- END
-- =============================================================================
