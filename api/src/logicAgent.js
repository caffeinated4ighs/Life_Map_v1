/**
 * logicAgent.js
 * -------------
 * Normalises LLM tool arguments and computes reward values before DB write.
 *
 * Owned by: Logic Agent
 * Called by: toolHandler.js (after arg guards, before DB Agent)
 * Updated:  TASK-20260526-027 — remove_task handler added
 *           TASK-20260527-001 — time_block normalisation added (FLAG-009)
 *
 * FLAG-008 normalisation (all tools that carry these fields):
 *   tasks.type:        mandatory→Mandatory | bonus→Bonus | habit→Habit | project→Project
 *   tasks.late_rule:   carry_over→carry_over | drop→drop | carry_over_penalty→penalise
 *   tasks.priority:    P0→0 | P1→1 | P2→2 | P3→3
 *   tasks.energy_cost: low→2 | medium→3 | high→5
 *
 * FLAG-009 normalisation (added this patch):
 *   tasks.time_block:  morning→Morning | afternoon→Afternoon | evening→Evening |
 *                      night→Evening | anytime→Flexible | null→Flexible
 *                      DB CHECK expects Title Case: Morning|Afternoon|Evening|Flexible
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

// FLAG-009: time_block normalisation
// Tool spec sends lowercase ("morning", "anytime"), DB CHECK expects Title Case.
// "night" is not a valid DB value — map to "Evening" as closest equivalent.
// null/undefined → "Flexible" (safe default).
const TIME_BLOCK_MAP = {
  morning:   "Morning",
  afternoon: "Afternoon",
  evening:   "Evening",
  night:     "Evening",
  anytime:   "Flexible",
  flexible:  "Flexible",
};

function normaliseType(val)       { return val != null ? (TYPE_MAP[val] ?? val)            : null; }
function normaliseLateRule(val)   { return val != null ? (LATE_RULE_MAP[val] ?? val)       : null; }
function normalisePriority(val)   { return val != null ? (PRIORITY_MAP[val] ?? val)        : null; }
function normaliseEnergyCost(val) { return val != null ? (ENERGY_COST_MAP[val] ?? val)     : null; }
function normaliseTimeBlock(val)  { return TIME_BLOCK_MAP[val] ?? "Flexible"; }

// ─────────────────────────────────────────────
// XP base values (per AGENTS.md)
// ─────────────────────────────────────────────

const XP_BASE = {
  Mandatory: 10,
  Habit:     12,
  Project:   15,
  Bonus:      6,
};

// Gold base by priority (DB-native integer key)
const GOLD_BASE = { 0: 15, 1: 10, 2: 6, 3: 3 };

// ─────────────────────────────────────────────
// Per-tool handlers
// ─────────────────────────────────────────────

// ── remove_task ──────────────────────────────
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

  const resolvedArgs = {};
  if (task_id    != null) resolvedArgs.task_id    = task_id;
  if (task_title != null) resolvedArgs.task_title = task_title;

  return {
    tool: "remove_task",
    resolvedArgs,
    needsClarification: false,
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
    time_block:  normaliseTimeBlock(args.time_block),  // FLAG-009 fix
  };

  const taskType = resolvedArgs.type ?? "Bonus";
  const priority = resolvedArgs.priority ?? 2;

  const xp   = XP_BASE[taskType] ?? XP_BASE.Bonus;
  const gold = computeGold(priority, args.energy_cost ?? "medium");

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
  return {
    tool: "complete_task",
    resolvedArgs: { ...args },
    needsClarification: false,
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
// ─────────────────────────────────────────────

function computeGold(priorityInt, energyCostRaw) {
  const base   = GOLD_BASE[priorityInt] ?? GOLD_BASE[2];
  const offset = energyCostRaw === "low" ? -2 : energyCostRaw === "high" ? 5 : 0;
  return Math.max(1, base + offset);
}

// ─────────────────────────────────────────────
// Main export
// ─────────────────────────────────────────────

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
      throw new Error(`[logicAgent] Unknown tool: "${toolName}"`);
  }
}
