# Life Map v1

Personal RPG-style life management system. Talk to an LLM secretary that manages tasks, tracks XP/gold/stats, and keeps life on track. Single user. Casual tone. Real game mechanics.

## Stack

- **API**: Node/Express → Railway
- **LLM**: Groq (llama-4-scout-17b-16e-instruct)
- **DB**: Supabase (Postgres)
- **Cron**: GitHub Actions

## Repo Structure

```
Life_Map_v1/
├── api/                        # Express API (Railway root)
│   ├── src/
│   │   ├── server.js           # Entry point, all routes
│   │   ├── groqClient.js       # Groq API wrapper, two-pass tool call
│   │   ├── supabaseClient.js   # Supabase client init
│   │   ├── sessionManager.js   # Conversation + message persistence
│   │   ├── toolHandler.js      # Tool validation + agent dispatch
│   │   ├── logicAgent.js       # Normalisation, inference, reward computation
│   │   └── dbAgent.js          # Supabase CRUD for all 6 tools
│   ├── groq_tool_spec.js       # Groq tool definitions (6 tools)
│   ├── package.json
│   └── .env.example
├── .github/
│   └── workflows/
│       ├── health_ping.yml     # Every 6hrs — keep Supabase alive
│       ├── good_morning.yml    # 12:00 UTC — open the day
│       └── eod.yml             # 04:00 UTC — close the day
├── scripts/                    # SQL migrations (run in order)
│   ├── 2026-05-25_initial_schema.sql
│   ├── 2026-05-25_patch_indexes_constraints.sql
│   ├── 2026-05-25_patch_skills_level_default.sql
│   └── 2026-05-26_patch_tasks_type_gold_check.sql
├── project_knowledge/          # Supervisor log + handoff docs
│   ├── SUPERVISOR_LOG.md
│   └── HANDOFF_TO_NEW_SESSION.md
├── railway.toml
└── .gitignore
```

## Local Setup

```bash
cd api
cp .env.example .env
# fill in SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GROQ_API_KEY

npm install
npm run dev
```

## API Routes

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | DB connectivity check |
| POST | `/chat` | Main conversation loop |
| POST | `/cron/morning` | Morning job (GitHub Actions) |
| POST | `/cron/eod` | End-of-day job (GitHub Actions) |

### POST /chat

```json
// Request
{ "message": "add a task to go for a run tomorrow", "session_id": "optional-uuid" }

// Response
{ "reply": "Done — run added for tomorrow.", "session_id": "uuid" }
```

## SQL Migrations

Run against Supabase in order via the SQL editor:

1. `2026-05-25_initial_schema.sql` — 19 tables, seeds player_state + 8 stats
2. `2026-05-25_patch_indexes_constraints.sql` — 7 indexes + 7 CHECK constraints
3. `2026-05-25_patch_skills_level_default.sql` — skills.level DEFAULT 0 fix
4. `2026-05-26_patch_tasks_type_gold_check.sql` — tasks.type (all 4 types) + tasks.gold CHECK

## Game Mechanics (locked)

- **XP**: Mandatory=10 / Habit=12 / Project=15 / Bonus=6. No priority multiplier.
- **Gold**: P0=15g / P1=10g / P2=6g / P3=3g base + effort offset + MH offset. Floor 1g.
- **MH**: Normal≥70 | Reduced 50-69 | MinViable 30-49 | Recovery<30. Start=100.
- **Skill XP crossover**: Direct=80% / Partial=40% / Indirect=15%
- **Streak bonus**: XP only. Level 6-10: +5%/day cap 25%. Level 11-15: +8%/day cap 40%. Level 16-20: +12%/day cap 60%.
