-- =============================================================================
-- Life Map — Patch Migration: skills.level DEFAULT fix
-- File:    2026-05-25_patch_skills_level_default.sql
-- Author:  Scripting Agent  |  Task: TASK-20260525-010
-- Status:  FINAL — executed and verified on hmdrjdkjyhmigpbdeocu (us-west-2)
--
-- Run order: 3 of 3 — must run after 2026-05-25_patch_indexes_constraints.sql
--
-- Resolves FLAG-006: skills.level DEFAULT was 1 in initial schema, inconsistent
-- with player_state.level DEFAULT 0. Manager confirmed 0 is the correct baseline
-- for both — nothing earned until earned.
--
-- If running against a fresh project (initial_schema.sql already had DEFAULT 0
-- baked in), the ALTER is still valid and the UPDATE is a safe no-op.
--
-- Rollback: ALTER TABLE skills ALTER COLUMN level SET DEFAULT 1;
--           UPDATE skills SET level = 1 WHERE level = 0;
-- =============================================================================

-- Fix column default for all future INSERTs
ALTER TABLE skills ALTER COLUMN level SET DEFAULT 0;

-- Reset any existing rows seeded with the old default
-- Safe: no real user data exists at migration time
UPDATE skills SET level = 0 WHERE level = 1;

-- =============================================================================
-- END
-- =============================================================================
