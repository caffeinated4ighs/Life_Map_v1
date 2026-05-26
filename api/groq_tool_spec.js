/**
 * groq_tool_spec.js
 * -----------------
 * Groq tool_use definitions for Chat API Agent.
 * Import this module and pass GROQ_TOOLS into every Groq API call's `tools` array.
 *
 * Owned by: Integration Agent
 * Consumed by: Chat API Agent (injected into every Groq /chat/completions call)
 * Schema source: AGENTS.md DB Schema Reference + landed migrations (TASK-20260525-*)
 *
 * Patch history:
 *   TASK-20260525-005 — initial spec, 6 tools defined
 *   TASK-20260525-012 — smoke test patches:
 *     - add_task: xp, gold, arc_id → anyOf:[integer,null] (Groq rejects null on typed fields)
 *     - add_task: time, notes → anyOf:[string,null] (same)
 *     - add_task: time_block, type, priority, energy_cost, category, late_rule → anyOf:[string(enum),null]
 *     - complete_task: task_id → anyOf:[integer,null], task_title/completed_at → anyOf:[string,null]
 *     - reschedule_task: task_id → anyOf:[integer,null], task_title/new_time → anyOf:[string,null]
 *     - reschedule_task: new_time_block → anyOf:[string(enum),null]
 *     - query_today: include_carried_over → anyOf:[boolean,string] (LLM passes "true" as string)
 *     - query_player_state: include_skills/effects/stats → anyOf:[boolean,string]
 *     - log_event: date, label, notes → anyOf:[string,null]; value → anyOf:[number,null]
 *   TASK-20260526-026 — add remove_task (tool 7); update VALID_TOOL_NAMES comment
 *
 * Tool categories:
 *   add_task           — create a new task row
 *   complete_task      — mark a task done, trigger XP/gold/stat/skill resolution
 *   reschedule_task    — move a deferred or upcoming task to a new date/time
 *   query_today        — fetch today's task list + player snapshot
 *   query_player_state — fetch full player state (XP, gold, level, stats, streak)
 *   log_event          — record a freeform daily event (steps, substance, leisure, etc.)
 *   remove_task        — cancel/delete a task without awarding XP or gold
 *
 * IMPORTANT: These are the tool *definitions* fed to the LLM.
 * The LLM returns a tool_use block → Chat API Agent extracts args →
 * Logic Agent validates/fills defaults → DB Agent executes.
 * The LLM never writes to the DB directly.
 */

export const GROQ_TOOLS = [

  // ──────────────────────────────────────────────────────────
  // 1. add_task
  // Creates a new task. Non-essential fields are inferred by
  // Logic Agent if the LLM omits them.
  // ──────────────────────────────────────────────────────────
  {
    type: "function",
    function: {
      name: "add_task",
      description:
        "Add a new task for the user. Call this when the user describes something they need or want to do. " +
        "Extract as many fields as the user provides; Logic Agent will fill the rest. " +
        "Do NOT invent xp or gold values — leave them null if unspecified.",
      parameters: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "Short task title. Required. Max ~80 chars.",
          },
          date: {
            type: "string",
            description:
              "Target date in ISO 8601 format (YYYY-MM-DD). Use today's date if the user implies today or doesn't specify.",
          },
          time: {
            anyOf: [{ type: "string" }, { type: "null" }],
            description:
              "Optional specific time in HH:MM (24h) format. Omit if user doesn't mention a time.",
          },
          time_block: {
            anyOf: [
              { type: "string", enum: ["morning", "afternoon", "evening", "night", "anytime"] },
              { type: "null" }
            ],
            description:
              "Loose time-of-day bucket. Infer from context or user's wording. Use 'anytime' if truly open.",
          },
          type: {
            anyOf: [
              { type: "string", enum: ["mandatory", "bonus", "habit", "project"] },
              { type: "null" }
            ],
            description:
              "Task type. 'mandatory' = must-do, has penalty if missed. 'bonus' = optional upside. " +
              "'habit' = recurring behaviour. 'project' = milestone toward an arc.",
          },
          priority: {
            anyOf: [
              { type: "string", enum: ["P0", "P1", "P2", "P3"] },
              { type: "null" }
            ],
            description:
              "P0 = critical, P1 = high, P2 = medium, P3 = low/bonus. Infer from urgency language.",
          },
          energy_cost: {
            anyOf: [
              { type: "string", enum: ["low", "medium", "high"] },
              { type: "null" }
            ],
            description: "Estimated mental/physical effort required.",
          },
          category: {
            anyOf: [
              {
                type: "string",
                enum: ["health", "work", "study", "social", "finance", "creative", "admin", "personal", "leisure"],
              },
              { type: "null" }
            ],
            description: "Primary life domain this task belongs to.",
          },
          late_rule: {
            anyOf: [
              { type: "string", enum: ["carry_over", "expire", "carry_over_penalty"] },
              { type: "null" }
            ],
            description:
              "What happens if this task isn't done by end of day. " +
              "'carry_over' = moves to tomorrow unchanged. " +
              "'expire' = disappears (bonus tasks default here). " +
              "'carry_over_penalty' = moves with an XP/gold penalty applied.",
          },
          xp: {
            anyOf: [{ type: "integer" }, { type: "null" }],
            description:
              "XP reward on completion. Leave null — Logic Agent computes from type + priority.",
          },
          gold: {
            anyOf: [{ type: "integer" }, { type: "null" }],
            description:
              "Gold reward on completion. Leave null — Logic Agent computes from type + priority.",
          },
          arc_id: {
            anyOf: [{ type: "integer" }, { type: "null" }],
            description:
              "ID of the arc this task contributes to, if any. Omit if not part of an arc.",
          },
          notes: {
            anyOf: [{ type: "string" }, { type: "null" }],
            description: "Any extra detail the user provided. Optional.",
          },
        },
        required: ["title", "date"],
      },
    },
  },

  // ──────────────────────────────────────────────────────────
  // 2. complete_task
  // Marks a task done. DB Agent then triggers the full
  // reward cascade: XP, gold, stats, skills, streak.
  // ──────────────────────────────────────────────────────────
  {
    type: "function",
    function: {
      name: "complete_task",
      description:
        "Mark a task as completed. Call this when the user says they finished, did, or completed a task. " +
        "Resolve the task_id from context or by matching the title. " +
        "Optionally record the actual completion time.",
      parameters: {
        type: "object",
        properties: {
          task_id: {
            anyOf: [{ type: "integer" }, { type: "null" }],
            description:
              "Primary key of the task row to mark complete. " +
              "If unknown, use task_title to let Logic Agent resolve it.",
          },
          task_title: {
            anyOf: [{ type: "string" }, { type: "null" }],
            description:
              "Title of the task (fallback if task_id is not available). " +
              "Logic Agent will fuzzy-match against today's open tasks.",
          },
          completed_at: {
            anyOf: [{ type: "string" }, { type: "null" }],
            description:
              "ISO 8601 datetime of actual completion. Defaults to now if omitted.",
          },
        },
        required: [],
      },
    },
  },

  // ──────────────────────────────────────────────────────────
  // 3. reschedule_task
  // Moves a deferred or future task to a new date/time.
  // DB Agent deletes the old deferred row and inserts a new one.
  // ──────────────────────────────────────────────────────────
  {
    type: "function",
    function: {
      name: "reschedule_task",
      description:
        "Move a task to a different date or time. Use when the user says they want to push something, " +
        "move it, or reschedule it. Works on both carried-over tasks and upcoming tasks.",
      parameters: {
        type: "object",
        properties: {
          task_id: {
            anyOf: [{ type: "integer" }, { type: "null" }],
            description: "Primary key of the task to reschedule.",
          },
          task_title: {
            anyOf: [{ type: "string" }, { type: "null" }],
            description: "Title fallback if task_id unavailable.",
          },
          new_date: {
            type: "string",
            description: "New target date in ISO 8601 (YYYY-MM-DD). Required.",
          },
          new_time: {
            anyOf: [{ type: "string" }, { type: "null" }],
            description: "New specific time in HH:MM (24h) if user specifies one.",
          },
          new_time_block: {
            anyOf: [
              { type: "string", enum: ["morning", "afternoon", "evening", "night", "anytime"] },
              { type: "null" }
            ],
            description: "New time-of-day bucket if user specifies.",
          },
        },
        required: ["new_date"],
      },
    },
  },

  // ──────────────────────────────────────────────────────────
  // 4. query_today
  // Returns today's tasks and a lightweight player snapshot.
  // Use for "what do I have today", "what's left", "show my tasks".
  // ──────────────────────────────────────────────────────────
  {
    type: "function",
    function: {
      name: "query_today",
      description:
        "Fetch today's task list and a player snapshot (XP, gold, MH score, streak). " +
        "Call when the user asks what they have to do today, what's left, or wants an overview.",
      parameters: {
        type: "object",
        properties: {
          filter_status: {
            anyOf: [
              { type: "string", enum: ["all", "open", "done"] },
              { type: "null" }
            ],
            description:
              "Filter tasks by status. Default 'open' to show only remaining tasks.",
            default: "open",
          },
          include_carried_over: {
            anyOf: [{ type: "boolean" }, { type: "string" }, { type: "null" }],
            description:
              "Include tasks carried over from previous days. Default true.",
            default: true,
          },
        },
        required: [],
      },
    },
  },

  // ──────────────────────────────────────────────────────────
  // 5. query_player_state
  // Full player state: level, XP, gold, streak, all stats,
  // active effects, skills summary.
  // ──────────────────────────────────────────────────────────
  {
    type: "function",
    function: {
      name: "query_player_state",
      description:
        "Fetch the full player state: level, XP progress, gold balance, streak, " +
        "all eight stats, active effects/buffs, and skill summaries. " +
        "Call when the user asks about their stats, level, gold, how they're doing, or any RPG metric.",
      parameters: {
        type: "object",
        properties: {
          include_skills: {
            anyOf: [{ type: "boolean" }, { type: "string" }, { type: "null" }],
            description: "Include skill tree entries with XP and decay status. Default true.",
            default: true,
          },
          include_effects: {
            anyOf: [{ type: "boolean" }, { type: "string" }, { type: "null" }],
            description: "Include active buffs/debuffs. Default true.",
            default: true,
          },
          include_stats: {
            anyOf: [{ type: "boolean" }, { type: "string" }, { type: "null" }],
            description:
              "Include all eight RPG stats (Strength, Vitality, etc). Default true.",
            default: true,
          },
        },
        required: [],
      },
    },
  },

  // ──────────────────────────────────────────────────────────
  // 6. log_event
  // Records a freeform daily event to the `events` table.
  // Used for steps, substance use, leisure sessions, day-off,
  // cheat day, or manual MH adjustments.
  // ──────────────────────────────────────────────────────────
  {
    type: "function",
    function: {
      name: "log_event",
      description:
        "Record a freeform daily event — steps walked, a substance used, a leisure session, " +
        "a day off, or a manual mood/MH note. " +
        "Call when the user mentions doing something that isn't a task (e.g. 'I walked 8k steps', " +
        "'had a few drinks', 'took the day off', 'feeling rough today').",
      parameters: {
        type: "object",
        properties: {
          event_type: {
            type: "string",
            enum: ["steps", "substance", "leisure", "day_off", "cheat_day", "mh_manual"],
            description:
              "Category of event. " +
              "'steps' = step count log. " +
              "'substance' = alcohol, smoking, etc. " +
              "'leisure' = gaming, watching, other downtime. " +
              "'day_off' = full rest day (suppresses arc pressure). " +
              "'cheat_day' = alias for day_off with shop item context. " +
              "'mh_manual' = user explicitly notes their mood/mental state.",
          },
          date: {
            anyOf: [{ type: "string" }, { type: "null" }],
            description: "ISO 8601 date this event occurred. Defaults to today.",
          },
          value: {
            anyOf: [{ type: "number" }, { type: "null" }],
            description:
              "Numeric value where applicable: step count for 'steps', " +
              "units consumed for 'substance', MH delta for 'mh_manual'. " +
              "Omit for event types with no meaningful quantity.",
          },
          label: {
            anyOf: [{ type: "string" }, { type: "null" }],
            description:
              "Short description. E.g. 'beer x2', 'Netflix 2hr', 'cigarette', '8500 steps'. Optional.",
          },
          notes: {
            anyOf: [{ type: "string" }, { type: "null" }],
            description: "Any extra context the user mentioned. Optional.",
          },
        },
        required: ["event_type"],
      },
    },
  },

  // ──────────────────────────────────────────────────────────
  // 7. remove_task
  // Cancels a task the user no longer wants to do.
  // Sets status to 'Cancelled' — does NOT award XP or gold.
  // ──────────────────────────────────────────────────────────
  {
    type: "function",
    function: {
      name: "remove_task",
      description:
        "Remove a task the user no longer wants to do. " +
        "Call when the user says cancel, remove, delete, or drop a task. " +
        "This does NOT award XP or gold — use complete_task if the task was actually done.",
      parameters: {
        type: "object",
        properties: {
          task_id: {
            anyOf: [{ type: "integer" }, { type: "null" }],
            description: "Primary key of the task to cancel.",
          },
          task_title: {
            anyOf: [{ type: "string" }, { type: "null" }],
            description: "Title fallback if task_id unavailable. Logic Agent will fuzzy match.",
          },
        },
        required: [],
      },
    },
  },
];

/**
 * Tool names as a frozen constant for guard clauses in Chat API Agent.
 * Use this to validate that the LLM only calls known tools.
 */
export const VALID_TOOL_NAMES = Object.freeze(
  GROQ_TOOLS.map((t) => t.function.name)
);
// => ["add_task", "complete_task", "reschedule_task", "query_today", "query_player_state", "log_event", "remove_task"]
