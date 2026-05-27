/**
 * groq_tool_spec.js
 * -----------------
 * Groq tool_use definitions for Chat API Agent.
 *
 * Patch history:
 *   TASK-20260525-005 — initial spec, 6 tools defined
 *   TASK-20260525-012 — smoke test patches: nullable anyOf fields
 *   TASK-20260526-026 — add remove_task (tool 7)
 *   TASK-20260527-003 — add clear_tasks (tool 8): bulk cancel all open tasks
 */

export const GROQ_TOOLS = [

  // ──────────────────────────────────────────────────────────
  // 1. add_task
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
            description: "Optional specific time in HH:MM (24h) format.",
          },
          time_block: {
            anyOf: [
              { type: "string", enum: ["morning", "afternoon", "evening", "night", "anytime"] },
              { type: "null" },
            ],
            description: "Loose time-of-day bucket.",
          },
          type: {
            anyOf: [
              { type: "string", enum: ["mandatory", "bonus", "habit", "project"] },
              { type: "null" },
            ],
            description:
              "'mandatory' = must-do. 'bonus' = optional. 'habit' = recurring. 'project' = milestone.",
          },
          priority: {
            anyOf: [
              { type: "string", enum: ["P0", "P1", "P2", "P3"] },
              { type: "null" },
            ],
            description: "P0=critical, P1=high, P2=medium, P3=low.",
          },
          energy_cost: {
            anyOf: [
              { type: "string", enum: ["low", "medium", "high"] },
              { type: "null" },
            ],
            description: "Estimated effort required.",
          },
          category: {
            anyOf: [
              {
                type: "string",
                enum: ["health", "work", "study", "social", "finance", "creative", "admin", "personal", "leisure"],
              },
              { type: "null" },
            ],
            description: "Primary life domain.",
          },
          late_rule: {
            anyOf: [
              { type: "string", enum: ["carry_over", "expire", "carry_over_penalty"] },
              { type: "null" },
            ],
            description: "What happens if not done by end of day.",
          },
          xp: {
            anyOf: [{ type: "integer" }, { type: "null" }],
            description: "Leave null — Logic Agent computes.",
          },
          gold: {
            anyOf: [{ type: "integer" }, { type: "null" }],
            description: "Leave null — Logic Agent computes.",
          },
          arc_id: {
            anyOf: [{ type: "integer" }, { type: "null" }],
            description: "Arc this task contributes to, if any.",
          },
          notes: {
            anyOf: [{ type: "string" }, { type: "null" }],
            description: "Any extra detail the user provided.",
          },
        },
        required: ["title", "date"],
      },
    },
  },

  // ──────────────────────────────────────────────────────────
  // 2. complete_task
  // ──────────────────────────────────────────────────────────
  {
    type: "function",
    function: {
      name: "complete_task",
      description:
        "Mark a task as completed. Call when the user says they finished, did, or completed a task.",
      parameters: {
        type: "object",
        properties: {
          task_id: {
            anyOf: [{ type: "integer" }, { type: "null" }],
            description: "Primary key of the task to mark complete.",
          },
          task_title: {
            anyOf: [{ type: "string" }, { type: "null" }],
            description: "Title fallback if task_id unavailable.",
          },
          completed_at: {
            anyOf: [{ type: "string" }, { type: "null" }],
            description: "ISO 8601 datetime of actual completion. Defaults to now.",
          },
        },
        required: [],
      },
    },
  },

  // ──────────────────────────────────────────────────────────
  // 3. reschedule_task
  // ──────────────────────────────────────────────────────────
  {
    type: "function",
    function: {
      name: "reschedule_task",
      description:
        "Move a task to a different date or time. Use when the user says push, move, or reschedule.",
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
            description: "New specific time in HH:MM (24h) if user specifies.",
          },
          new_time_block: {
            anyOf: [
              { type: "string", enum: ["morning", "afternoon", "evening", "night", "anytime"] },
              { type: "null" },
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
  // ──────────────────────────────────────────────────────────
  {
    type: "function",
    function: {
      name: "query_today",
      description:
        "Fetch today's open task list and a player snapshot. " +
        "Call when the user asks what they have to do, what's left, or wants an overview. " +
        "Do NOT call this after a clear_tasks — just confirm the clear was done.",
      parameters: {
        type: "object",
        properties: {
          filter_status: {
            anyOf: [
              { type: "string", enum: ["all", "open", "done"] },
              { type: "null" },
            ],
            description: "Filter tasks by status. Default 'open'.",
            default: "open",
          },
          include_carried_over: {
            anyOf: [{ type: "boolean" }, { type: "string" }, { type: "null" }],
            description: "Include carried-over tasks. Default true.",
            default: true,
          },
        },
        required: [],
      },
    },
  },

  // ──────────────────────────────────────────────────────────
  // 5. query_player_state
  // ──────────────────────────────────────────────────────────
  {
    type: "function",
    function: {
      name: "query_player_state",
      description:
        "Fetch full player state: level, XP, gold, streak, stats, effects, skills. " +
        "Call when the user asks about stats, level, gold, or any RPG metric.",
      parameters: {
        type: "object",
        properties: {
          include_skills: {
            anyOf: [{ type: "boolean" }, { type: "string" }, { type: "null" }],
            description: "Include skill tree entries. Default true.",
            default: true,
          },
          include_effects: {
            anyOf: [{ type: "boolean" }, { type: "string" }, { type: "null" }],
            description: "Include active buffs/debuffs. Default true.",
            default: true,
          },
          include_stats: {
            anyOf: [{ type: "boolean" }, { type: "string" }, { type: "null" }],
            description: "Include all eight RPG stats. Default true.",
            default: true,
          },
        },
        required: [],
      },
    },
  },

  // ──────────────────────────────────────────────────────────
  // 6. log_event
  // ──────────────────────────────────────────────────────────
  {
    type: "function",
    function: {
      name: "log_event",
      description:
        "Record a freeform daily event — steps, substance, leisure, day off, mood. " +
        "Call when the user mentions something that isn't a task.",
      parameters: {
        type: "object",
        properties: {
          event_type: {
            type: "string",
            enum: ["steps", "substance", "leisure", "day_off", "cheat_day", "mh_manual"],
            description: "Category of event.",
          },
          date: {
            anyOf: [{ type: "string" }, { type: "null" }],
            description: "ISO 8601 date. Defaults to today.",
          },
          value: {
            anyOf: [{ type: "number" }, { type: "null" }],
            description: "Numeric value where applicable (steps, units, etc).",
          },
          label: {
            anyOf: [{ type: "string" }, { type: "null" }],
            description: "Short description. E.g. 'beer x2', '8500 steps'.",
          },
          notes: {
            anyOf: [{ type: "string" }, { type: "null" }],
            description: "Any extra context.",
          },
        },
        required: ["event_type"],
      },
    },
  },

  // ──────────────────────────────────────────────────────────
  // 7. remove_task
  // ──────────────────────────────────────────────────────────
  {
    type: "function",
    function: {
      name: "remove_task",
      description:
        "Remove a single specific task the user no longer wants to do. " +
        "Call when the user names or clearly identifies ONE task to cancel. " +
        "Do NOT call this for bulk removals — use clear_tasks instead when the user says " +
        "'remove all', 'clear all', 'wipe tasks', 'delete everything', or similar.",
      parameters: {
        type: "object",
        properties: {
          task_id: {
            anyOf: [{ type: "integer" }, { type: "null" }],
            description: "Primary key of the task to cancel.",
          },
          task_title: {
            anyOf: [{ type: "string" }, { type: "null" }],
            description: "Title fallback. Logic Agent will fuzzy match.",
          },
        },
        required: [],
      },
    },
  },

  // ──────────────────────────────────────────────────────────
  // 8. clear_tasks
  // Bulk-cancels all open tasks matching the given scope.
  // No XP or gold awarded — same contract as remove_task.
  // ──────────────────────────────────────────────────────────
  {
    type: "function",
    function: {
      name: "clear_tasks",
      description:
        "Cancel ALL open tasks in bulk. " +
        "Call this when the user says 'remove all tasks', 'clear everything', " +
        "'wipe my list', 'delete all tasks', 'clear today', or any phrasing that " +
        "implies removing more than one task without naming specific ones. " +
        "Do NOT use remove_task for this — it only handles one task at a time.",
      parameters: {
        type: "object",
        properties: {
          scope: {
            type: "string",
            enum: ["today", "all"],
            description:
              "'today' = cancel only tasks dated today. " +
              "'all' = cancel all Pending and Carried Over tasks regardless of date. " +
              "Default 'all' unless the user specifically says 'today'.",
            default: "all",
          },
        },
        required: [],
      },
    },
  },
];

/**
 * Tool names as a frozen constant for guard clauses in Chat API Agent.
 */
export const VALID_TOOL_NAMES = Object.freeze(
  GROQ_TOOLS.map((t) => t.function.name)
);
// => ["add_task", "complete_task", "reschedule_task", "query_today",
//     "query_player_state", "log_event", "remove_task", "clear_tasks"]
