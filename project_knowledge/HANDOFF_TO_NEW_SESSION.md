# Life Map — Supervisor Handoff Document
# Context Transfer to New Project Session
# Generated: 2026-05-26

---

## 1. WHAT THIS PROJECT IS

A personal RPG-style life management system. The user talks casually to an LLM secretary
that manages tasks, tracks XP/gold/stats, and keeps life on track. Single user. Casual tone.
Game mechanics are real — not cosmetic.

Stack: Node/Express API → Groq (LLM) → Supabase (Postgres DB) → Railway (hosting) → GitHub Actions (cron)

Architecture source of truth: AGENTS.md (must be carried into new session)
Supervisor log: SUPERVISOR_LOG.md (must be carried into new session)

---

## 2. WHAT IS FULLY DONE ✅

### Database — 100% live on Supabase
- Project: Life_map_v1 | ID: hmdrjdkjyhmigpbdeocu | Region: us-west-2
- URL: https://hmdrjdkjyhmigpbdeocu.supabase.co
- 19 tables live, all FK chains correct
- 7 performance indexes on hot query fields
- 7 CHECK constraints on tasks and task_skill_links
- player_state singleton seeded (id=1, level=0, mh_score=100, gold=0, streak=0)
- 8 stats seeded at current_value=0 (Strength/Vitality/Agility/Dexterity/Intelligence/Perception/Charisma/Willpower)
- RLS active on conversations + messages (permissive, single-user)
- skills.level DEFAULT corrected to 0

### API Server — fully scaffolded, smoke tested
Files (all in api/src/ or api/):
- server.js — Express entry point, POST /chat, GET /health, POST /cron/morning (stub), POST /cron/eod (stub)
- groqClient.js — Groq API wrapper, two-pass tool call handling, 3-attempt retry
- supabaseClient.js — Supabase client init + DB connectivity check
- sessionManager.js — conversation create, message insert, context assembly (last N*2 rows)
- toolHandler.js — tool name validation, add_task guards, complete_task guards, Logic+DB stubs
- groq_tool_spec.js — 6 Groq tool definitions (api/ deployed copy)
- package.json — ESM, groq-sdk, @supabase/supabase-js, express, dotenv
- railway.toml — nixpacks builder, node src/server.js, /health healthcheck

### Tool Spec — 6 tools defined and patched
- add_task, complete_task, reschedule_task, query_today, query_player_state, log_event
- All nullable optional fields use anyOf pattern (Groq-compatible)
- VALID_TOOL_NAMES frozen export for guard clauses
- Both copies (api/ and integration/) in sync

### Cron Workflows — stubbed, ready for wiring
- .github/workflows/health_ping.yml — every 6hrs, hits /health
- .github/workflows/good_morning.yml — 12:00 UTC daily (7am EST), POSTs /cron/morning
- .github/workflows/eod.yml — 04:00 UTC daily (11pm EST), POSTs /cron/eod
- x-cron-secret auth via SUPABASE_SERVICE_ROLE_KEY on /cron/* routes

### Smoke Test — PASSED
- GET /health → db:connected ✓
- POST /cron/morning without secret → 401 ✓
- POST /cron/morning with secret → 200 stub ✓
- POST /chat add task → natural language reply, session_id returned ✓
- POST /chat session reuse → same session_id, context retained ✓
- POST /chat reschedule → understood in context ✓
- POST /chat query today → stub returns, LLM answers from context ✓
- conversations + messages tables → writing correctly ✓
- Context window boundary at 5 exchanges → confirmed working ✓

### All Game Mechanics — LOCKED
- XP base: Mandatory=10 / Habit=12 / Project=15 / Bonus=6. NO priority multiplier ever.
- Gold base: P0=15g / P1=10g / P2=6g / P3=3g. Effort offset Low=-2/High=+5. Floor 1g.
- MH thresholds: Normal≥70 | Reduced 50-69 | Min Viable 30-49 | Recovery<30. Start=100.
- Skill XP crossover: Direct=80% / Partial=40% / Indirect=15% of task base XP.
- Streak bonus: Level 0-5 none | 6-10 +5%/day cap25% | 11-15 +8%/day cap40% | 16-20 +12%/day cap60%.
  Requires mandatory_met=true. XP only — gold unaffected by streak.
- Arc modifier: XP and gold both modified. Same multiplier formula.
- Level 0-20 XP table pre-computed in AGENTS.md.

---

## 3. WHAT CURRENTLY BREAKS / IS IFFY ⚠️

### CRITICAL — Will cause first real DB write to fail
**FLAG-008: Enum/type mismatches between tool spec and DB schema**
Logic Agent does not exist yet, so no data is writing to DB. But when it does, these
mismatches will cause hard failures unless Logic Agent normalises before DB write:

| Field | Tool Spec sends | DB expects | Mapping required |
|-------|----------------|------------|-----------------|
| tasks.type | "mandatory" (lowercase) | "Mandatory" (Title Case) | Capitalise |
| tasks.type | "habit", "project" | Not in DB CHECK yet | DB CHECK only has Mandatory/Bonus — habit/project need adding or Logic Agent must map |
| tasks.late_rule | "carry_over_penalty" | "penalise" | Rename |
| tasks.priority | "P0"-"P3" (string) | INTEGER 0-3 | Strip P, cast to int |
| tasks.energy_cost | "low"/"medium"/"high" | INTEGER 1-5 | low→2, medium→3, high→5 |

Logic Agent owns ALL of these conversions. DB Agent receives only DB-native types.

### IMPORTANT — Stubs not writing anything real yet
- toolHandler.js: callLogicAgent() and callDbAgent() are stubs. They log but never
  touch Supabase. tasks table is empty. player_state XP/gold never update.
  This is expected — Logic Agent and DB Agent haven't been built yet.

### IMPORTANT — Cron endpoints are stubs
- POST /cron/morning returns {"status":"ok","message":"stub"} — does nothing else
- POST /cron/eod returns {"status":"ok","message":"stub"} — does nothing else
- Good Morning logic (carry-overs, effect expiry, day snapshot open) not implemented
- EOD logic (streak eval, snapshot close, arc multipliers) not implemented

### MINOR — assembleContext role:system handling
- assembleContext() maps role:system → role:user when building Groq history
- Cron Agent morning briefing messages use role:system — will be misrepresented to Groq
- Not a problem until cron morning logic is implemented (stubs now), but needs fixing then

### MINOR — groq-sdk version
- package.json pins groq-sdk at ^0.3.3
- Needs confirming it supports llama-4-scout-17b-16e-instruct tool calling
- Bump to latest on first npm install if any compatibility warnings appear

### MINOR — tasks.type DB CHECK incomplete
- DB CHECK constraint only validates 'Mandatory' | 'Bonus'
- AGENTS.md defines 4 types: mandatory, bonus, habit, project
- habit and project are in the tool spec and AGENTS.md but not in the DB CHECK
- Either add habit/project to the DB CHECK (patch migration needed) or decide they map to Mandatory/Bonus
- This must be resolved before Logic Agent handles task type normalisation

### MINOR — tasks.gold CHECK not yet added
- Gold base values are now confirmed (P0=15g etc) so the CHECK constraint is unblocked
- Needs a one-line patch migration: CHECK (gold >= 1) or CHECK (gold BETWEEN 1 AND 100)
- Not blocking but flagged

### PENDING MANAGER ACTION
- GitHub repo Life_Map_v1 not yet created or pushed
- Railway project not yet created — RAILWAY_URL unknown
- GitHub Actions secrets not yet configured

---

## 4. ASSUMPTIONS MADE

### Schema assumptions (Scripting Agent, not in AGENTS.md)
- tasks.priority stored as INTEGER (0-3), not as text P0-P3. Mapping in Logic Agent.
- effects.duration stored as INTEGER (day count). expires_on is authoritative.
- skills.decay_rate stored as NUMERIC(5,4) (fractional daily rate, e.g. 0.0500).
- arcs.weight stored as NUMERIC(4,2). Sufficient for 0.00-99.99 multiplier range.
- mh_mode stored as TEXT (not enum) — kept flexible since thresholds were open during schema creation.

### Groq tool spec assumptions (Integration Agent)
- LLM-facing values are human-readable (P0, low, mandatory) regardless of DB storage type.
- Logic Agent is responsible for all type normalisation before DB write — this is a hard contract.
- complete_task requires no required fields in spec — Chat API Agent enforces task_id OR task_title.

### Railway assumptions (from previous iteration)
- API runs from api/ as Railway root directory (confirmed pattern from old project).
- railway.toml at repo root points to api/ — rootDirectory must be set in Railway dashboard too.

### XP priority decision
- Proposed XP values in one handoff doc used priority multipliers (mandatory×priority).
- Manager rejected this. XP is flat per task type only. Priority is urgency, not growth.
- This is a hard design decision — do not re-introduce priority XP multipliers.

---

## 5. WHAT NEEDS TO BE DONE NEXT (in order)

### Wave 1 — IMMEDIATE, parallel (this is the core unlock)

**DB Agent — replace callDbAgent stub in toolHandler.js**
Implement real Supabase CRUD for all 6 tools:
- add_task → INSERT into tasks, return inserted row
- complete_task → UPDATE tasks status + completed_at, UPDATE player_state XP+gold
- reschedule_task → DELETE deferred row + INSERT new with new_date/time
- query_today → SELECT tasks WHERE date=today, SELECT player_state snapshot
- query_player_state → SELECT player_state + stats + skills + effects
- log_event → INSERT into events
Return shape: { success: bool, data: [...], error: string|null }
FLAG-008 normalisation contract must be applied before inserts (or coordinate with Logic Agent on who normalises).

**Logic Agent — replace callLogicAgent stub in toolHandler.js**
Implement field inference and reward computation:
- add_task: infer xp (type-based), gold (priority+effort+MH offsets), late_rule default,
  energy_cost default, time_block default, arc modifier if arc_id present
  FLAG-004: null-guard arcs.end_date before arc pressure division
- complete_task: fuzzy title match if task_id null, stat delta computation from task_stats,
  skill XP from task_skill_links (80/40/15%), level-up check against AGENTS.md XP table
- Streak evaluation (for EOD cron): mandatory_met check, streak bonus computation
- ALL FLAG-008 normalisations: type→TitleCase, late_rule mapping, priority P0→0, energy_cost→int
- Return needsClarification when genuinely ambiguous (Chat API Agent surfaces to user)

### Wave 2 — after Wave 1 smoke test passes

**GitHub + Railway setup (Manager action)**
- Create Life_Map_v1 repo, push all current files in correct structure
- Create Railway project, link to repo, set rootDirectory=api/
- Configure GitHub Actions secrets
- This makes the system accessible from anywhere, not just localhost

**Prompt Engineer Agent**
- Replace SYSTEM_PROMPT placeholder in server.js with versioned prompt
- Hard cap 350 tokens. Current placeholder is ~50 tokens — plenty of room.
- Eval harness: test add_task, complete_task, query_today, chitchat, reschedule

### Wave 3 — after daily use begins

**Cron Agent logic implementation**
- POST /cron/morning: create day_snapshots open record, carry-over overdue tasks,
  expire effects, flag skill decay, escalate arc weight if end_date within 7 days,
  insert morning briefing as role:system message
  Fix assembleContext role:system → should pass through as system, not user
- POST /cron/eod: compute day totals, streak eval, close day_snapshot, arc XP multipliers

**Patch migration — DB cleanup**
- Add habit and project to tasks.type CHECK constraint (currently only Mandatory/Bonus)
- Add tasks.gold CHECK (gold >= 1) — now unblocked since gold values confirmed

### Post-MVP (do not build yet)
- Frontend purpose-built UI (stats display, task board, shop interface, arc tracker)
- Shop items table and /shop route
- Level-based XP scalar
- Multi-user RLS (tighten to user_id = auth.uid())
- updated_at auto-trigger

---

## 6. KEY CONSTANTS (copy into every new agent context)

- Supabase URL: https://hmdrjdkjyhmigpbdeocu.supabase.co
- Supabase project ID: hmdrjdkjyhmigpbdeocu (us-west-2)
- Groq model primary: llama-4-scout-17b-16e-instruct
- Groq model fallback: llama-4-maverick
- CONTEXT_WINDOW: 5 (tunable via env var)
- User timezone: America/New_York
- Good Morning cron: 12:00 UTC = 7am EST / 8am EDT
- EOD cron: 04:00 UTC = 11pm EST

XP base: Mandatory=10 / Habit=12 / Project=15 / Bonus=6
Gold base: P0=15g / P1=10g / P2=6g / P3=3g
Gold offsets: Effort Low=-2/High=+5 | MH Positive=-2/Drain=+3 | Floor=1g
MH: Normal≥70 | Reduced 50-69 | MinViable 30-49 | Recovery<30 | Start=100
Skill XP: Direct=80% / Partial=40% / Indirect=15% of task base XP

FLAG-008 Logic Agent normalisation (hard contract):
  tasks.type:        mandatory→Mandatory | bonus→Bonus | habit→Habit | project→Project
  tasks.late_rule:   carry_over→carry_over | drop→drop | carry_over_penalty→penalise
  tasks.priority:    P0→0 | P1→1 | P2→2 | P3→3
  tasks.energy_cost: low→2 | medium→3 | high→5

---

## 7. TASK ID STATE

Last issued: TASK-20260526-010
Next IDs: TASK-20260526-011 (DB Agent), TASK-20260526-012 (Logic Agent)

---

## 8. FILES TO COLLECT BEFORE STARTING NEW SESSION

Request the latest version of each file from the agent listed.
Use the one-line prompt provided — each agent should provide their most recent patched output.

| File | Agent | One-line prompt |
|------|-------|-----------------|
| server.js | Chat API Agent | "Provide your latest patched version of server.js including the SYSTEM_PROMPT update, /cron/* routes, and requireCronSecret middleware." |
| groqClient.js | Chat API Agent | "Provide your latest patched version of groqClient.js with the duplicate system prompt removed from callGroqWithToolResult." |
| toolHandler.js | Chat API Agent | "Provide your latest version of toolHandler.js with VALID_TOOL_NAMES guard, add_task xp/gold strip, complete_task id/title check, and Logic+DB stubs." |
| sessionManager.js | Chat API Agent | "Provide your latest version of sessionManager.js." |
| supabaseClient.js | Chat API Agent | "Provide your latest version of supabaseClient.js." |
| api/groq_tool_spec.js | Integration Agent | "Provide the latest patched groq_tool_spec.js with all anyOf nullable field fixes applied to xp, gold, arc_id, time, notes, and boolean query params." |
| integration/groq_tool_spec.js | Integration Agent | "Provide the canonical integration copy of groq_tool_spec.js — should be identical to api/groq_tool_spec.js." |
| package.json | Chat API Agent | "Provide your package.json for the Life Map API." |
| railway.toml | Chat API Agent | "Provide your railway.toml." |
| health_ping.yml | Cron Agent | "Provide the latest health_ping.yml GitHub Actions workflow." |
| good_morning.yml | Cron Agent | "Provide the latest good_morning.yml GitHub Actions workflow." |
| eod.yml | Cron Agent | "Provide the latest eod.yml GitHub Actions workflow." |
| 2026-05-25_initial_schema.sql | Scripting Agent | "Provide the initial schema SQL file for Life Map v1." |
| 2026-05-25_patch_indexes_constraints.sql | Scripting Agent | "Provide the patch migration SQL for indexes and CHECK constraints." |
| 2026-05-25_patch_skills_level_default.sql | Scripting Agent | "Provide the patch migration SQL for skills.level DEFAULT fix." |
| AGENTS.md | Manager | Carry the latest AGENTS.md v3 into the new session directly. |
| SUPERVISOR_LOG.md | Supervisor | Carry the current SUPERVISOR_LOG.md into the new session directly. |
