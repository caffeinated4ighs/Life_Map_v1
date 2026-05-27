/**
 * logicAgent.js
 * -------------
 * Normalises LLM tool arguments and computes reward values before DB write.
 *
 * Owned by: Logic Agent
 * Called by: toolHandler.js (after arg guards, before DB Agent)
 * Updated:  TASK-20260526-027 — remove_task handler added
 *
 * Contract (per AGENTS.md + SUPERVISOR_LOG FLAG-008):
 *   - Receives raw LLM args (human-readable strings: "P0", "low", "mandatory")
 *   - Returns a fully resolved logicResult — DB-native types only
 *   - DB Agent receives only DB-native types; it never normalises
 *
 * FLAG-008 normalisation (all tools that carry these fields):
 *   tasks.type:        mandatory→Mandatory | bonus→Bonus | habit→Habit | project→Project
 *   tasks.late_rule:   carry_over→carry_over | drop→drop | carry_over_penalty→penalise
 *   tasks.priority:    P0→0 | P1→1 | P2→2 | P3→3
 *   tasks.energy_cost: low→2 | medium→3 | high→5
 *
 * logicResult shape:
 *   {
 *     tool:              string,           // tool name, passed through to DB Agent
 *     resolvedArgs:      object,           // DB-native args — DB Agent reads these
 *     needsClarification: boolean,         // true → surface casualPrompt to user, skip DB Agent
 *     casualPrompt?:     string,           // shown to user when needsClarification is true
 *     // Reward fields — present only for tools that compute them:
 *     xp?:              integer,
 *     gold?:            integer,
 *     statDeltas?:      Array<{ stat_id, delta }>,
 *     skillDeltas?:     Array<{ skill_id, xp_gain }>,
 *   }
 *
 * remove_task is the simplest path — no FLAG-008 fields, no reward computation.
 * The DB Agent sets tasks.status = 'Cancelled' and performs no XP/gold update.
 */

// ─────────────────────────────────────────────
// FLAG-008 normalisation helpers
// ─────────────────────────────────────────────

const TYPE_MAP = {
  mandatory: "Mandatory",
  bonus:     "Bonus",
  habit:     "Habit",
  project:   "Project",
};

const LATE_RULE_MAP = {
  carry_over:         "carry_over",
  drop:               "drop",
  carry_over_penalty: "penalise",
};

const PRIORITY_MAP = {
  P0: 0, P1: 1, P2: 2, P3: 3,
};

const ENERGY_COST_MAP = {
  low: 2, medium: 3, high: 5,
};

function normaliseType(val)       { return val != null ? (TYPE_MAP[val] ?? val)       : null; }
function normaliseLateRule(val)   { return val != null ? (LATE_RULE_MAP[val] ?? val)  : null; }
function normalisePriority(val)   { return val != null ? (PRIORITY_MAP[val] ?? val)   : null; }
function normaliseEnergyCost(val) { return val != null ? (ENERGY_COST_MAP[val] ?? val): null; }

// ─────────────────────────────────────────────
// XP base values (per AGENTS.md / SUPERVISOR_LOG 2026-05-26 00:01)
// ─────────────────────────────────────────────

const XP_BASE = {
  Mandatory: 10,
  Habit:     12,
  Project:   15,
  Bonus:      6,
};

// Gold base by priority (DB-native integer key, per AGENTS.md)
const GOLD_BASE = { 0: 15, 1: 10, 2: 6, 3: 3 };

// ─────────────────────────────────────────────
// Per-tool handlers
// ─────────────────────────────────────────────

// ── remove_task ──────────────────────────────
// Simplest Logic Agent path. No FLAG-008 fields. No reward computation.
// Validates that at least one identifier is present, then passes through.
function handleRemoveTask(args) {
  const { task_id, task_title } = args;

  if (!task_id && !task_title) {
    return {
      tool: "remove_task",
      resolvedArgs: {},
      needsClarification: true,
      casualPrompt: "Which task do you want to remove? Give me a name or ID.",
    };
  }

  // Build resolvedArgs with whichever identifier(s) are present
  const resolvedArgs = {};
  if (task_id    != null) resolvedArgs.task_id    = task_id;
  if (task_title != null) resolvedArgs.task_title = task_title;

  return {
    tool: "remove_task",
    resolvedArgs,
    needsClarification: false,
    // No xp, gold, statDeltas, skillDeltas — remove_task awards nothing
  };
}

// ── add_task ─────────────────────────────────
function handleAddTask(args) {
  const resolvedArgs = {
    ...args,
    type:        normaliseType(args.type),
    late_rule:   normaliseLateRule(args.late_rule),
    priority:    normalisePriority(args.priority),
    energy_cost: normaliseEnergyCost(args.energy_cost),
  };

  const taskType = resolvedArgs.type ?? "Bonus";
  const priority = resolvedArgs.priority ?? 2; // default P2

  const xp   = XP_BASE[taskType] ?? XP_BASE.Bonus;
  const gold  = computeGold(priority, args.energy_cost ?? "medium");

  return {
    tool: "add_task",
    resolvedArgs: { ...resolvedArgs, xp, gold },
    needsClarification: false,
    xp,
    gold,
    statDeltas:  [],
    skillDeltas: [],
  };
}

// ── complete_task ─────────────────────────────
function handleCompleteTask(args) {
  // task_id / task_title presence already validated in toolHandler before this call
  return {
    tool: "complete_task",
    resolvedArgs: { ...args },
    needsClarification: false,
    // XP/gold/stat/skill deltas require task lookup — DB Agent reads task row first,
    // then applies rewards. Full reward pipeline TODO in Logic Agent Wave 2.
    statDeltas:  [],
    skillDeltas: [],
  };
}

// ── reschedule_task ───────────────────────────
function handleRescheduleTask(args) {
  return {
    tool: "reschedule_task",
    resolvedArgs: { ...args },
    needsClarification: false,
    statDeltas:  [],
    skillDeltas: [],
  };
}

// ── query_today ───────────────────────────────
function handleQueryToday(args) {
  return {
    tool: "query_today",
    resolvedArgs: { ...args },
    needsClarification: false,
  };
}

// ── query_player_state ────────────────────────
function handleQueryPlayerState(args) {
  return {
    tool: "query_player_state",
    resolvedArgs: { ...args },
    needsClarification: false,
  };
}

// ── log_event ─────────────────────────────────
function handleLogEvent(args) {
  return {
    tool: "log_event",
    resolvedArgs: { ...args },
    needsClarification: false,
  };
}

// ─────────────────────────────────────────────
// Gold computation helper
// Base: P0=15g / P1=10g / P2=6g / P3=3g
// Effort offset: low=-2 / medium=0 / high=+5
// Floor: 1g minimum
// (per SUPERVISOR_LOG 2026-05-25 00:19)
// ─────────────────────────────────────────────

function computeGold(priorityInt, energyCostRaw) {
  const base   = GOLD_BASE[priorityInt] ?? GOLD_BASE[2];
  const offset = energyCostRaw === "low" ? -2 : energyCostRaw === "high" ? 5 : 0;
  return Math.max(1, base + offset);
}

// ─────────────────────────────────────────────
// Main export
// ─────────────────────────────────────────────

/**
 * Dispatch to the appropriate per-tool handler.
 * Called by toolHandler.js after arg guards.
 *
 * @param {string} toolName   - Validated tool name (already checked against VALID_TOOL_NAMES)
 * @param {object} args       - Raw LLM args (post-sanitization in toolHandler)
 * @returns {object}          - logicResult — see contract in file header
 */
export async function callLogicAgent(toolName, args) {
  console.log(`[logicAgent] Dispatching: ${toolName}`, args);

  switch (toolName) {
    case "remove_task":        return handleRemoveTask(args);
    case "add_task":           return handleAddTask(args);
    case "complete_task":      return handleCompleteTask(args);
    case "reschedule_task":    return handleRescheduleTask(args);
    case "query_today":        return handleQueryToday(args);
    case "query_player_state": return handleQueryPlayerState(args);
    case "log_event":          return handleLogEvent(args);

    default:
      // Should never reach here — toolHandler validates against VALID_TOOL_NAMES first
      throw new Error(`[logicAgent] Unknown tool: "${toolName}"`);
  }
}
