# Life Map v1 — RPG Task Manager

A personal life management system built as a conversational RPG. You talk to an LLM secretary in plain English — it manages your tasks, tracks XP/gold/stats, and keeps your day on track. Game mechanics are real, not cosmetic.

**Production URL:** `https://lifemapv1-production.up.railway.app`

---

## Stack

```
User → POST /chat → Express API → Groq LLM → Logic Agent → DB Agent → Supabase (Postgres)
                                                                ↑
                                             GitHub Actions (cron) → /cron/morning + /cron/eod
```

| Layer | Technology |
|-------|-----------|
| API server | Node.js + Express (ESM) |
| LLM | Groq — llama-4-scout-17b-16e-instruct |
| Database | Supabase (Postgres) — project `hmdrjdkjyhmigpbdeocu`, us-west-2 |
| Hosting | Railway — root directory: `api/` |
| Cron | GitHub Actions — 3 workflows |

---

## Repository Structure

```
Life_Map_v1/
├── api/
│   ├── src/
│   │   ├── server.js          — Express entry point, all routes
│   │   ├── groqClient.js      — Groq API wrapper, two-pass tool call loop
│   │   ├── sessionManager.js  — Conversation lifecycle, message persistence
│   │   ├── toolHandler.js     — Tool validation, dispatch to Logic + DB agents
│   │   ├── logicAgent.js      — Normalisation, XP/gold computation
│   │   ├── dbAgent.js         — All Supabase CRUD, result trimming
│   │   └── supabaseClient.js  — Supabase client init + health check
│   ├── groq_tool_spec.js      — 7 Groq tool definitions
│   ├── package.json
│   └── railway.toml
├── .github/
│   └── workflows/
│       ├── health_ping.yml    — Every 6hrs, keeps Supabase free tier alive
│       ├── good_morning.yml   — 12:00 UTC daily (7am EST)
│       └── eod.yml            — 04:00 UTC daily (11pm EST)
├── scripts/
│   ├── 2026-05-25_initial_schema.sql
│   ├── 2026-05-25_patch_indexes_constraints.sql
│   ├── 2026-05-25_patch_skills_level_default.sql
│   └── 2026-05-26_patch_tasks_type_check.sql
└── AGENTS.md                  — Architecture source of truth
```

---

## Setup From Scratch

### 1. Prerequisites

- Node.js >= 20
- A Supabase project (free tier works)
- A Groq API key (free tier works)
- A Railway account
- A GitHub account

### 2. Database

Run the migration files in order against your Supabase project (SQL editor or CLI):

```
1. scripts/2026-05-25_initial_schema.sql
2. scripts/2026-05-25_patch_indexes_constraints.sql
3. scripts/2026-05-25_patch_skills_level_default.sql
4. scripts/2026-05-26_patch_tasks_type_check.sql
```

This creates 19 tables, seeds `player_state` (id=1) and all 8 stats at 0.

### 3. Environment Variables

Create `api/.env` for local dev:

```env
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
GROQ_API_KEY=your-groq-api-key
GROQ_MODEL_PRIMARY=llama-4-scout-17b-16e-instruct
CONTEXT_WINDOW=5
NODE_ENV=development
PORT=3000
```

### 4. Local Development

```bash
cd api
npm install
npm run dev        # node --watch src/server.js
```

Test it:
```bash
# Health check
curl http://localhost:3000/health

# Add a task
curl -X POST http://localhost:3000/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "add a task: go for a run"}'

# Continue conversation (use session_id from above response)
curl -X POST http://localhost:3000/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "actually remove it", "session_id": "YOUR_SESSION_ID"}'
```

### 5. Railway Deployment

1. Push repo to GitHub
2. Create a Railway project, link to your GitHub repo
3. In Railway service settings → **Root Directory**: set to `api`
4. Add environment variables in Railway dashboard (same as `.env` above, minus `PORT`)
5. Deploy — Railway reads `railway.toml` for build/start commands and healthcheck

### 6. GitHub Actions (Cron)

Add these secrets to your GitHub repo (Settings → Secrets → Actions):

```
RAILWAY_URL                = https://your-app.up.railway.app
SUPABASE_URL               = https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY  = your-service-role-key
GROQ_API_KEY               = your-groq-api-key
```

The three workflows activate automatically. Trigger them manually first via the Actions tab to verify.

---

## API Reference

### `GET /health`
Liveness + DB connectivity check. No auth required.

**Response:**
```json
{
  "status": "ok",
  "db": "connected",
  "timestamp": "2026-05-26T20:00:00.000Z"
}
```

### `POST /chat`
Main conversation endpoint. Accepts a plain English message, returns a plain English reply.

**Request:**
```json
{
  "message": "add a task: finish the report by 5pm",
  "session_id": "optional-uuid-for-existing-conversation"
}
```

**Response:**
```json
{
  "reply": "Task added.",
  "session_id": "uuid-string"
}
```

Pass `session_id` back on every subsequent message to maintain conversation context. Omit it to start a new conversation.

### `POST /cron/morning`
Triggered by GitHub Actions at 12:00 UTC daily. Requires header `x-cron-secret: <SUPABASE_SERVICE_ROLE_KEY>`. Currently a stub — returns 200 OK. Full implementation in Wave 3.

### `POST /cron/eod`
Triggered by GitHub Actions at 04:00 UTC daily. Same auth. Currently a stub.

---

## Available Tools (LLM capabilities)

The LLM can call 7 tools based on what the user says. These are transparent to the user — they just talk normally.

| Tool | Triggered when user... | What it does |
|------|----------------------|--------------|
| `add_task` | Says they need to do something | Inserts task into DB, computes XP/gold |
| `complete_task` | Says they finished/did something | Marks task Done, awards XP + gold to player |
| `remove_task` | Says cancel/remove/drop a task | Soft-deletes (status = Cancelled), no XP awarded |
| `reschedule_task` | Says push/move/reschedule a task | Updates task date/time |
| `query_today` | Asks what they have to do | Returns today's open tasks + player snapshot |
| `query_player_state` | Asks about stats/level/gold | Returns full player state |
| `log_event` | Mentions steps/drinks/leisure/mood | Inserts event record |

---

## Game Mechanics

### XP
Flat per task type. No priority multiplier.

| Type | Base XP |
|------|---------|
| Mandatory | 10 |
| Habit | 12 |
| Project | 15 |
| Bonus | 6 |

### Gold
Base by priority + effort offset. Floor 1g.

| Priority | Base Gold |
|----------|-----------|
| P0 (critical) | 15g |
| P1 (high) | 10g |
| P2 (medium) | 6g |
| P3 (low) | 3g |

Effort offsets: Low −2g / High +5g. Arc modifier applies to both XP and gold. Streak bonus applies to XP only.

### Stats
8 RPG stats tracked: Strength, Vitality, Agility, Dexterity, Intelligence, Perception, Charisma, Willpower. All start at 0.

### Mental Health (MH)
Starts at 100. Thresholds: Normal ≥70 | Reduced 50–69 | Min Viable 30–49 | Recovery <30.

### Streak Bonus (XP only)
Requires `mandatory_met = true` for the day.

| Level | Bonus per day | Cap |
|-------|--------------|-----|
| 0–5 | none | — |
| 6–10 | +5% | +25% |
| 11–15 | +8% | +40% |
| 16–20 | +12% | +60% |

---

## Database Schema (19 tables)

Core tables: `player_state`, `tasks`, `stats`, `skills`, `arcs`, `arc_tasks`, `arc_skills`, `task_stats`, `task_skill_links`, `effects`, `effect_stats`, `effect_arcs`, `anchors`, `day_snapshots`, `snapshot_anchors`, `streak_log`, `events`, `conversations`, `messages`.

Full schema in `scripts/2026-05-25_initial_schema.sql`.

---

## Known Limitations & Future Improvements

### Cron Logic (Wave 3 — not yet built)
`/cron/morning` and `/cron/eod` are stubs. The following is designed but not implemented:
- **Morning:** carry-over overdue tasks, expire effects, flag skill decay, open day snapshot, insert morning briefing
- **EOD:** evaluate streak, close day snapshot, apply arc XP multipliers

### Skill & Stat Deltas
The complete_task reward pipeline currently awards XP and gold. Stat deltas (task → stat links) and skill XP crossover (Direct 80% / Partial 40% / Indirect 15%) are designed and the junction tables exist but are not yet computed at completion time. Logic Agent Wave 2 work.

### Arc System
Arcs (long-term goals with XP/gold multipliers) are fully modelled in the DB but not surfaced via tools yet. No `add_arc`, `query_arcs`, or arc modifier computation in the current tool set.

### Context Window
Currently `CONTEXT_WINDOW=3` (conservative, post-deployment). Raise to 5 in Railway env vars once daily use confirms stability.

### assembleContext — role:system
Morning briefing cron messages stored as `role:system` are currently mapped to `role:user` when building Groq history. Needs fixing before cron morning logic is implemented.

### Frontend
No purpose-built UI exists. Current interface is raw API calls. A frontend agent brief is provided separately.

### Multi-user
RLS is permissive (single user). Adding `user_id UUID REFERENCES auth.users(id)` to conversations and messages tables and tightening RLS policies would enable multi-user support.

### Shop System
`shop_items` table is post-MVP. Gold economy is fully tracked — the shop just isn't built yet.

### groq-sdk Version
Pinned at `^0.3.3`. Bump to latest on next `npm install` and verify no compatibility issues with llama-4-scout tool calling.

---

## Cron Schedule

| Workflow | Schedule | Endpoint | Purpose |
|----------|----------|----------|---------|
| health_ping | Every 6hrs | `GET /health` | Keep Supabase free tier alive |
| good_morning | 12:00 UTC (7am EST) | `POST /cron/morning` | Open the day (stub) |
| eod | 04:00 UTC (11pm EST) | `POST /cron/eod` | Close the day (stub) |

---

## Architecture Notes

- **Single user system.** All player state is a singleton row (id=1) in `player_state`.
- **No raw transcripts.** Conversation history is stored as semantic summary JSON, rendered as plain English for Groq context. Keeps token usage lean.
- **Logic Agent owns all reward computation.** DB Agent receives only DB-native types and never computes XP or gold independently.
- **Tool results are trimmed before the second Groq pass.** Worst case ~88 tokens (query_player_state). Prevents token bloat on DB-heavy queries.
- **Two-pass LLM loop.** First pass: intent detection + tool selection. Second pass: natural language reply from tool result. History sliced to last 2 exchanges on second pass.
