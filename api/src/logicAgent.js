/**
 * logicAgent.js
 * -------------
 * Normalises LLM tool arguments and computes reward values before DB write.
 *
 * Owned by: Logic Agent
 * Called by: toolHandler.js (after arg guards, before DB Agent)
 * Updated:  TASK-20260526-027 — remove_task handler added
 *           TASK-20260527-001 — time_block normalisation (FLAG-009)
 *           TASK-20260527-002 — date clamping (FLAG-DATE)
 *           TASK-20260527-003 — clear_tasks handler added
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

const TIME_BLOCK_MAP = {
  morning:   "Morning",
  afternoon: "Afternoon",
  evening:   "Evening",
  night:     "Evening",
  anytime:   "Flexible",
  flexible:  "Flexible",
};

function normaliseType(val)       { return val != null ? (TYPE_MAP[val] ?? val)        : null; }
function normaliseLateRule(val)   { return val != null ? (LATE_RULE_MAP[val] ?? val)   : null; }
function normalisePriority(val)   { return val != null ? (PRIORITY_MAP[val] ?? val)    : null; }
function normaliseEnergyCost(val) { return val != null ? (ENERGY_COST_MAP[val] ?? val) : null; }
function normaliseTimeBlock(val)  { return TIME_BLOCK_MAP[val] ?? "Flexible"; }

// ─────────────────────────────────────────────
// FLAG-DATE: date clamping helper
// ─────────────────────────────────────────────

function resolveDate(llmDate) {
  const serverToday = new Date().toISOString().slice(0, 10);
  if (!llmDate) return serverToday;
  if (llmDate < serverToday) {
    console.warn(
      `[logicAgent] FLAG-DATE: LLM sent past date "${llmDate}" — correcting to ${serverToday}`
    );
    return serverToday;
  }
  return llmDate;
}

// ─────────────────────────────────────────────
// XP / Gold tables
// ─────────────────────────────────────────────

const XP_BASE = {
  Mandatory: 10,
  Habit:     12,
  Project:   15,
  Bonus:      6,
};

const GOLD_BASE = { 0: 15, 1: 10, 2: 6, 3: 3 };

function computeGold(priorityInt, energyCostRaw) {
  const base   = GOLD_BASE[priorityInt] ?? GOLD_BASE[2];
  const offset = energyCostRaw === "low" ? -2 : energyCostRaw === "high" ? 5 : 0;
  return Math.max(1, base + offset);
}

// ─────────────────────────────────────────────
// Per-tool handlers
// ─────────────────────────────────────────────

function handleAddTask(args) {
  const resolvedDate = resolveDate(args.date);

  const resolvedArgs = {
    ...args,
    date:        resolvedDate,
    type:        normaliseType(args.type),
    late_rule:   normaliseLateRule(args.late_rule),
    priority:    normalisePriority(args.priority),
    energy_cost: normaliseEnergyCost(args.energy_cost),
    time_block:  normaliseTimeBlock(args.time_block),
  };

  const taskType = resolvedArgs.type ?? "Bonus";
  const priority = resolvedArgs.priority ?? 2;
  const xp       = XP_BASE[taskType] ?? XP_BASE.Bonus;
  const gold     = computeGold(priority, args.energy_cost ?? "medium");

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

function handleCompleteTask(args) {
  return {
    tool: "complete_task",
    resolvedArgs: { ...args },
    needsClarification: false,
    statDeltas:  [],
    skillDeltas: [],
  };
}

function handleRescheduleTask(args) {
  return {
    tool: "reschedule_task",
    resolvedArgs: { ...args, new_date: resolveDate(args.new_date) },
    needsClarification: false,
    statDeltas:  [],
    skillDeltas: [],
  };
}

function handleQueryToday(args) {
  return { tool: "query_today", resolvedArgs: { ...args }, needsClarification: false };
}

function handleQueryPlayerState(args) {
  return { tool: "query_player_state", resolvedArgs: { ...args }, needsClarification: false };
}

function handleLogEvent(args) {
  return { tool: "log_event", resolvedArgs: { ...args }, needsClarification: false };
}

function handleRemoveTask(args) {
  if (!args.task_id && !args.task_title) {
    return {
      tool: "remove_task",
      resolvedArgs: {},
      needsClarification: true,
      casualPrompt: "Which task do you want to remove? Give me a name or ID.",
    };
  }
  const resolvedArgs = {};
  if (args.task_id    != null) resolvedArgs.task_id    = args.task_id;
  if (args.task_title != null) resolvedArgs.task_title = args.task_title;
  return { tool: "remove_task", resolvedArgs, needsClarification: false };
}

/**
 * clear_tasks
 * Bulk cancel all open tasks by scope.
 * scope "today" = only tasks dated today.
 * scope "all"   = all Pending/Carried Over regardless of date (default).
 */
function handleClearTasks(args) {
  const scope = (args.scope === "today") ? "today" : "all";
  return {
    tool: "clear_tasks",
    resolvedArgs: { scope },
    needsClarification: false,
  };
}

// ─────────────────────────────────────────────
// Main export
// ─────────────────────────────────────────────

export async function callLogicAgent(toolName, args) {
  console.log(`[logicAgent] Dispatching: ${toolName}`, args);

  switch (toolName) {
    case "add_task":           return handleAddTask(args);
    case "complete_task":      return handleCompleteTask(args);
    case "reschedule_task":    return handleRescheduleTask(args);
    case "query_today":        return handleQueryToday(args);
    case "query_player_state": return handleQueryPlayerState(args);
    case "log_event":          return handleLogEvent(args);
    case "remove_task":        return handleRemoveTask(args);
    case "clear_tasks":        return handleClearTasks(args);
    default:
      throw new Error(`[logicAgent] Unknown tool: "${toolName}"`);
  }
}
