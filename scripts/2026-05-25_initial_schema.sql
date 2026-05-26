-- =============================================================================
-- Life Map — Initial Schema Migration
-- File:    2026-05-25_initial_schema.sql
-- Author:  Scripting Agent
-- Tasks:   TASK-20260525-001 (schema) + TASK-20260525-010 (skills.level fix)
-- Status:  FINAL — executed and verified on hmdrjdkjyhmigpbdeocu (us-west-2)
--
-- Run order: 1 of 3
--   1. 2026-05-25_initial_schema.sql          ← this file
--   2. 2026-05-25_patch_indexes_constraints.sql
--   3. 2026-05-25_patch_skills_level_default.sql  (no-op if running fresh)
--
-- Covers all 19 tables listed in AGENTS.md DB Schema Reference.
-- shop_items excluded — post-MVP per AGENTS.md.
-- player_state singleton (id=1) and all 8 stats seeded at bottom.
--
-- Field type assumptions (where AGENTS.md was silent):
--   tasks.type            TEXT — "Mandatory" | "Bonus" | "Habit" | "Project"
--   tasks.priority        INTEGER — P0..P3 mapped to integers 0–3
--   tasks.status          TEXT — "Pending" | "Done" | "Skipped" | "Carried Over"
--   tasks.time_block      TEXT — "Morning" | "Afternoon" | "Evening" | "Flexible"
--   tasks.category        TEXT — freeform, inferred by Logic Agent
--   tasks.energy_cost     INTEGER — 1–5 scale
--   tasks.xp              INTEGER — base XP value before modifiers
--   tasks.gold            INTEGER — base gold value before modifiers
--   tasks.late_rule       TEXT — "carry_over" | "drop" | "penalise"
--   tasks.deferred        BOOLEAN DEFAULT FALSE
--   tasks.penalty_modifier NUMERIC(4,2) DEFAULT 1.0
--   tasks.description     TEXT (nullable)
--   stats.stat_name       TEXT — human-readable (Strength, Vitality, etc.)
--   stats.current_value   INTEGER DEFAULT 0
--   skills.xp_accumulated INTEGER DEFAULT 0
--   skills.level          INTEGER DEFAULT 0  ← FLAG-006 fix: was 1, corrected to 0
--   skills.decay_rate     NUMERIC(5,4) DEFAULT 0.05 — fractional decay per tick
--   skills.in_decay       BOOLEAN DEFAULT FALSE
--   arcs.weight           NUMERIC(4,2) — XP/pressure multiplier
--   arcs.status           TEXT — "Active" | "Completed" | "Abandoned"
--   effects.intensity     NUMERIC(4,2) — scalar effect strength
--   effects.duration      INTEGER — display-only remaining days (expires_on is authoritative)
--   effects.stat_offset   NUMERIC(4,2) — flat stat delta per day
--   effects.suppresses_arc_pressure BOOLEAN DEFAULT FALSE
--   effects.active        BOOLEAN DEFAULT TRUE
--   effects.expires_on    DATE (nullable) — authoritative expiry field
--   effect_arcs.modifier  NUMERIC(4,2) — arc weight multiplier/offset
--   anchors.anchor_type   TEXT — "class" | "appointment" | "commitment"
--   anchors.recurrence    TEXT (nullable) — "MWF" | "daily" | NULL for one-off
--   day_snapshots.steps   INTEGER (nullable)
--   streak_log.streak_count INTEGER — running streak length at row time
--   events.value          NUMERIC (nullable) — steps count, units consumed, etc.
--   messages.role         TEXT — "user" | "assistant" | "system"
--
-- RLS NOTE (conversations + messages):
--   Current policy: permissive for authenticated role — single-user system.
--   FUTURE multi-user: add user_id UUID REFERENCES auth.users(id) to both tables
--   and tighten RLS to: USING (auth.uid() = user_id)
-- =============================================================================


-- ---------------------------------------------------------------------------
-- UUID EXTENSION (idempotent)
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";


-- ---------------------------------------------------------------------------
-- 1. player_state  (singleton — seed row at bottom)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS player_state (
    id                  INTEGER PRIMARY KEY DEFAULT 1,
    mh_score            INTEGER NOT NULL DEFAULT 100,
    mh_mode             TEXT NOT NULL DEFAULT 'Normal',
    gold                INTEGER NOT NULL DEFAULT 0,
    streak              INTEGER NOT NULL DEFAULT 0,
    total_xp            INTEGER NOT NULL DEFAULT 0,
    level               INTEGER NOT NULL DEFAULT 0,
    xp_to_next_level    INTEGER NOT NULL DEFAULT 50,    -- Level 0→1 per XP table in AGENTS.md
    timezone            TEXT NOT NULL DEFAULT 'America/New_York',
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT player_state_singleton CHECK (id = 1)
);


-- ---------------------------------------------------------------------------
-- 2. stats  (8 rows seeded below)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stats (
    id              SERIAL PRIMARY KEY,
    stat_name       TEXT NOT NULL UNIQUE,
    current_value   INTEGER NOT NULL DEFAULT 0,
    description     TEXT,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ---------------------------------------------------------------------------
-- 3. skills
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS skills (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name            TEXT NOT NULL UNIQUE,
    xp_accumulated  INTEGER NOT NULL DEFAULT 0,
    level           INTEGER NOT NULL DEFAULT 0,         -- FLAG-006: 0 not 1. Matches player_state.
    decay_rate      NUMERIC(5,4) NOT NULL DEFAULT 0.05,
    last_active     DATE,
    in_decay        BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ---------------------------------------------------------------------------
-- 4. arcs
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS arcs (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name        TEXT NOT NULL,
    weight      NUMERIC(4,2) NOT NULL DEFAULT 1.0,
    status      TEXT NOT NULL DEFAULT 'Active',
    start_date  DATE NOT NULL,
    end_date    DATE,                                   -- nullable: Logic Agent must guard null before arc pressure division
    notes       TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ---------------------------------------------------------------------------
-- 5. tasks
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tasks (
    id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    title            TEXT NOT NULL,
    description      TEXT,
    type             TEXT NOT NULL DEFAULT 'Bonus',
    priority         INTEGER NOT NULL DEFAULT 2,        -- 0=P0 (critical) … 3=P3 (low)
    status           TEXT NOT NULL DEFAULT 'Pending',
    date             DATE NOT NULL,
    time             TIME,                              -- nullable — only set when user specifies exact time
    time_block       TEXT NOT NULL DEFAULT 'Flexible',
    category         TEXT,
    energy_cost      INTEGER NOT NULL DEFAULT 2,        -- 1–5 scale
    xp               INTEGER NOT NULL DEFAULT 0,
    gold             INTEGER NOT NULL DEFAULT 0,
    late_rule        TEXT NOT NULL DEFAULT 'carry_over',
    deferred         BOOLEAN NOT NULL DEFAULT FALSE,
    penalty_modifier NUMERIC(4,2) NOT NULL DEFAULT 1.0,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ---------------------------------------------------------------------------
-- 6. arc_tasks  (junction: task ↔ arc)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS arc_tasks (
    arc_id   UUID NOT NULL REFERENCES arcs(id) ON DELETE CASCADE,
    task_id  UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    PRIMARY KEY (arc_id, task_id)
);


-- ---------------------------------------------------------------------------
-- 7. arc_skills  (junction: skill ↔ arc)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS arc_skills (
    arc_id    UUID NOT NULL REFERENCES arcs(id) ON DELETE CASCADE,
    skill_id  UUID NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
    PRIMARY KEY (arc_id, skill_id)
);


-- ---------------------------------------------------------------------------
-- 8. task_stats  (junction: task ↔ stat, with stat delta)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS task_stats (
    task_id     UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    stat_id     INTEGER NOT NULL REFERENCES stats(id) ON DELETE CASCADE,
    stat_delta  INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (task_id, stat_id)
);


-- ---------------------------------------------------------------------------
-- 9. task_skill_links  (junction: task ↔ skill, with crossover level)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS task_skill_links (
    task_id         UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    skill_id        UUID NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
    crossover_level TEXT NOT NULL DEFAULT 'Direct',    -- Direct | Partial | Indirect
    PRIMARY KEY (task_id, skill_id)
);


-- ---------------------------------------------------------------------------
-- 10. effects  (active buffs / debuffs)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS effects (
    id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name                    TEXT NOT NULL,
    description             TEXT,
    intensity               NUMERIC(4,2) NOT NULL DEFAULT 1.0,
    duration                INTEGER NOT NULL DEFAULT 1,  -- display-only; expires_on is authoritative
    stat_offset             NUMERIC(4,2) NOT NULL DEFAULT 0.0,
    suppresses_arc_pressure BOOLEAN NOT NULL DEFAULT FALSE,
    active                  BOOLEAN NOT NULL DEFAULT TRUE,
    expires_on              DATE,                        -- authoritative expiry; Cron Agent reads this
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ---------------------------------------------------------------------------
-- 11. effect_stats  (junction: effect ↔ stat)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS effect_stats (
    effect_id  UUID NOT NULL REFERENCES effects(id) ON DELETE CASCADE,
    stat_id    INTEGER NOT NULL REFERENCES stats(id) ON DELETE CASCADE,
    PRIMARY KEY (effect_id, stat_id)
);


-- ---------------------------------------------------------------------------
-- 12. effect_arcs  (junction: effect ↔ arc, with arc modifier)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS effect_arcs (
    effect_id  UUID NOT NULL REFERENCES effects(id) ON DELETE CASCADE,
    arc_id     UUID NOT NULL REFERENCES arcs(id) ON DELETE CASCADE,
    modifier   NUMERIC(4,2) NOT NULL DEFAULT 1.0,
    PRIMARY KEY (effect_id, arc_id)
);


-- ---------------------------------------------------------------------------
-- 13. anchors  (fixed calendar commitments)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS anchors (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name         TEXT NOT NULL,
    anchor_type  TEXT NOT NULL DEFAULT 'commitment',    -- class | appointment | commitment
    recurrence   TEXT,                                  -- "MWF" | "daily" | NULL for one-off
    start_time   TIME,
    end_time     TIME,
    active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ---------------------------------------------------------------------------
-- 14. day_snapshots  (per-day open/close record)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS day_snapshots (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    snapshot_date   DATE NOT NULL UNIQUE,
    mh_score_open   INTEGER,
    mh_score_close  INTEGER,
    gold_open       INTEGER,
    gold_close      INTEGER,
    xp_earned       INTEGER NOT NULL DEFAULT 0,
    steps           INTEGER,
    notes           TEXT,
    opened_at       TIMESTAMPTZ,
    closed_at       TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ---------------------------------------------------------------------------
-- 15. snapshot_anchors  (junction: day_snapshot ↔ anchor)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS snapshot_anchors (
    snapshot_id  UUID NOT NULL REFERENCES day_snapshots(id) ON DELETE CASCADE,
    anchor_id    UUID NOT NULL REFERENCES anchors(id) ON DELETE CASCADE,
    PRIMARY KEY (snapshot_id, anchor_id)
);


-- ---------------------------------------------------------------------------
-- 16. streak_log  (daily streak tracking)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS streak_log (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    log_date       DATE NOT NULL UNIQUE,
    mandatory_met  BOOLEAN NOT NULL DEFAULT FALSE,
    streak_count   INTEGER NOT NULL DEFAULT 0,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ---------------------------------------------------------------------------
-- 17. events  (freeform daily log events)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS events (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    event_date  DATE NOT NULL DEFAULT CURRENT_DATE,
    event_type  TEXT NOT NULL,
    value       NUMERIC,
    notes       TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT events_type_check CHECK (
        event_type IN ('steps', 'substance', 'leisure', 'day_off', 'cheat_day', 'mh_manual')
    )
);


-- ---------------------------------------------------------------------------
-- 18. conversations  (session-level metadata)
-- RLS: permissive now. See multi-user note in file header.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS conversations (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    summary_note  TEXT
);

ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "conversations_authenticated_all" ON conversations;
CREATE POLICY "conversations_authenticated_all"
    ON conversations FOR ALL TO authenticated
    USING (true) WITH CHECK (true);


-- ---------------------------------------------------------------------------
-- 19. messages  (per-exchange semantic summaries, FK → conversations)
-- role includes "system" to support Cron Agent morning briefing rows.
-- RLS: permissive now. See multi-user note in file header.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS messages (
    id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    conversation_id  UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role             TEXT NOT NULL,
    summary_json     JSONB NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT messages_role_check CHECK (role IN ('user', 'assistant', 'system'))
);

CREATE INDEX IF NOT EXISTS messages_conversation_created_idx
    ON messages (conversation_id, created_at DESC);

ALTER TABLE messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "messages_authenticated_all" ON messages;
CREATE POLICY "messages_authenticated_all"
    ON messages FOR ALL TO authenticated
    USING (true) WITH CHECK (true);


-- =============================================================================
-- SEED DATA
-- =============================================================================

-- player_state singleton
-- level=0, xp_to_next_level=50 per Level 0 row in AGENTS.md XP table.
INSERT INTO player_state (id, mh_score, mh_mode, gold, streak, total_xp, level, xp_to_next_level, timezone)
VALUES (1, 100, 'Normal', 0, 0, 0, 0, 50, 'America/New_York')
ON CONFLICT (id) DO NOTHING;

-- 8 stats — descriptions mirror AGENTS.md tag definitions
INSERT INTO stats (stat_name, current_value, description) VALUES
    ('Strength',     0, 'Raw physical power and muscle force. Tags: brute force, heavy lifting.'),
    ('Vitality',     0, 'Overall physical health, stamina, resilience. Tags: endurance, disease resistance.'),
    ('Agility',      0, 'Whole-body speed, reflexes, coordination. Tags: mobility, dodging.'),
    ('Dexterity',    0, 'Fine motor skills and hand-eye precision. Tags: precision work, fine-tuned skills.'),
    ('Intelligence', 0, 'Learning ability, logic, problem-solving. Tags: reasoning, knowledge retention.'),
    ('Perception',   0, 'Sensory awareness and attention to detail. Tags: observation, environmental awareness.'),
    ('Charisma',     0, 'Social influence and interpersonal skills. Tags: persuasion, leadership.'),
    ('Willpower',    0, 'Mental discipline, focus, inner resilience. Tags: discipline, mental fortitude.')
ON CONFLICT (stat_name) DO NOTHING;

-- =============================================================================
-- END — run patch files 2 and 3 immediately after this succeeds
-- =============================================================================
