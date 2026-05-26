/**
 * logicAgent.js
 * -------------
 * Field inference, FLAG-008 normalisation, reward computation.
 * Replaces callLogicAgent stub in toolHandler.js.
 *
 * Owned by: Logic Agent
 * Task:     TASK-20260526-012
 * Called by: toolHandler.js (before DB Agent)
 *
 * RESPONSIBILITIES:
 *   1. FLAG-008 normalisation (hard contract — DB CHECK will reject otherwise):
 *      tasks.type:        mandatory→Mandatory | bonus→Bonus | habit→Habit | project→Project
 *      tasks.late_rule:   carry_over_penalty→penalise | carry_over→carry_over | drop→drop | expire→drop
 *      tasks.priority:    P0→0 | P1→1 | P2→2 | P3→3
 *      tasks.energy_cost: low→2 | medium→3 | high→5
 *      tasks.time_block:  morning→Morning | afternoon→Afternoon | evening→Evening | anytime/night/null→Flexible
 *
 *   2. Field inference for add_task (fill sensible defaults when LLM omits):
 *      - type:        default 'Bonus' if not provided
 *      - priority:    default P2 (2) if not provided
 *      - energy_cost: default 3 (medium) if not provided
 *      - late_rule:   'carry_over' for mandatory/habit/project; 'drop' for bonus
 *      - time_block:  'Flexible' if not provided
 *
 *   3. Reward computation for add_task:
 *      - XP: flat per type. Mandatory=10 / Habit=12 / Project=15 / Bonus=6. No priority multiplier. Ever.
 *      - Gold: base by priority + effort offset + MH offset. Floor 1g.
 *        Base: P0=15g / P1=10g / P2=6g / P3=3g
 *        Effort offset: low=-2 / medium=0 / high=+5
 *        MH offset: Positive(>=70)=-2 / Normal(50-69)=0 / Drain(<50)=+3
 *
 *   4. complete_task resolution:
 *      - If task_id null: fuzzy title match against today's Pending tasks
 *      - Fetch task_stats for stat deltas
 *      - Fetch task_skill_links for skill XP crossover
 *      - Apply arc modifier if arc_task link exists
 *      - Apply streak bonus to XP if mandatory_met + streak level qualifies
 *      - Return needsClarification: true if title matches 0 or 2+ tasks
 *
 *   5. FLAG-004: null-guard arcs.end_date before arc pressure division
 *
 * Return shape:
 *   {
 *     tool: string,
 *     resolvedArgs: object,       // DB-native types only, fully populated
 *     xp: number | undefined,
 *     gold: number | undefined,
 *     statDeltas: [{stat_id, delta}],
 *     skillDeltas: [{skill_id, xp_amount}],
 *     needsClarification: boolean,
 *     casualPrompt: string | undefined,
 *   }
 */

import { supabase } from "./supabaseClient.js";

// ─────────────────────────────────────────────
// XP base values per task type (AGENTS.md, locked)
// Priority does NOT affect XP. Ever.
// ─────────────────────────────────────────────
const XP_BASE = {
  Mandatory: 10,
  Habit:     12,
  Project:   15,
  Bonus:      6,
};

// ─────────────────────────────────────────────
// Gold base values by priority (AGENTS.md, locked)
// ─────────────────────────────────────────────
const GOLD_BASE = { 0: 15, 1: 10, 2: 6, 3: 3 };

const EFFORT_OFFSET  = { low: -2, medium: 0, high: 5 };
const MH_GOLD_OFFSET = (mhScore) => {
  if (mhScore >= 70) return -2;   // Positive / Normal
  if (mhScore >= 50) return 0;    // Reduced
  return 3;                        // Drain (MinViable / Recovery)
};

// ─────────────────────────────────────────────
// Streak XP bonus multiplier
// Requires mandatory_met = true. XP only — gold unaffected.
// ─────────────────────────────────────────────
function streakBonusMultiplier(level, streakCount) {
  if (level < 6 || streakCount === 0) return 1.0;
  let ratePerDay, cap;
  if (level <= 10)      { ratePerDay = 0.05; cap = 0.25; }
  else if (level <= 15) { ratePerDay = 0.08; cap = 0.40; }
  else                  { ratePerDay = 0.12; cap = 0.60; }
  const bonus = Math.min(ratePerDay * streakCount, cap);
  return 1.0 + bonus;
}

// ─────────────────────────────────────────────
// FLAG-008: Normalisation maps
// ─────────────────────────────────────────────
function normaliseType(raw) {
  if (!raw) return "Bonus"; // default
  const map = {
    mandatory: "Mandatory",
    bonus:     "Bonus",
    habit:     "Habit",
    project:   "Project",
    // already-correct passthrough
    Mandatory: "Mandatory",
    Bonus:     "Bonus",
    Habit:     "Habit",
    Project:   "Project",
  };
  return map[raw] ?? "Bonus";
}

function normaliseLateRule(raw, type) {
  if (!raw) return type === "Bonus" ? "drop" : "carry_over"; // infer from type
  const map = {
    carry_over:         "carry_over",
    drop:               "drop",
    expire:             "drop",          // tool spec alias
    carry_over_penalty: "penalise",      // FLAG-008 rename
    penalise:           "penalise",      // already correct
  };
  return map[raw] ?? "carry_over";
}

function normalisePriority(raw) {
  if (raw == null) return 2; // default P2
  if (typeof raw === "number") return Math.min(3, Math.max(0, raw));
  const map = { P0: 0, P1: 1, P2: 2, P3: 3, "0": 0, "1": 1, "2": 2, "3": 3 };
  return map[String(raw)] ?? 2;
}

function normaliseEnergyCost(raw) {
  if (raw == null) return 3; // default medium
  if (typeof raw === "number") return Math.min(5, Math.max(1, raw));
  const map = { low: 2, medium: 3, high: 5 };
  return map[String(raw).toLowerCase()] ?? 3;
}

function normaliseTimeBlock(raw) {
  if (!raw) return "Flexible";
  const map = {
    morning:   "Morning",
    afternoon: "Afternoon",
    evening:   "Evening",
    night:     "Evening",    // map night→Evening (DB only has 4 values)
    anytime:   "Flexible",
    flexible:  "Flexible",
    Morning:   "Morning",
    Afternoon: "Afternoon",
    Evening:   "Evening",
    Flexible:  "Flexible",
  };
  return map[raw] ?? "Flexible";
}

// ─────────────────────────────────────────────
// get player state once per request (cached in closure)
// ─────────────────────────────────────────────
async function fetchPlayerState() {
  const { data, error } = await supabase
    .from("player_state")
    .select("level, total_xp, gold, mh_score, streak")
    .eq("id", 1)
    .single();
  if (error || !data) {
    console.warn("[logicAgent] Failed to fetch player_state:", error?.message);
    return { level: 0, total_xp: 0, gold: 0, mh_score: 100, streak: 0 };
  }
  return data;
}

// ─────────────────────────────────────────────
// add_task logic
// ─────────────────────────────────────────────
async function resolveAddTask(args) {
  const player = await fetchPlayerState();

  const rawEnergyLabel = args.energy_cost; // keep for gold offset before normalising
  const normType       = normaliseType(args.type);
  const normPriority   = normalisePriority(args.priority);
  const normEnergy     = normaliseEnergyCost(args.energy_cost);
  const normLateRule   = normaliseLateRule(args.late_rule, normType);
  const normTimeBlock  = normaliseTimeBlock(args.time_block);

  // XP: flat per type, no priority multiplier
  const baseXp = XP_BASE[normType];

  // Arc modifier on XP
  let arcXpMultiplier = 1.0;
  if (args.arc_id != null) {
    const { data: arc } = await supabase
      .from("arcs")
      .select("weight, end_date, status")
      .eq("id", args.arc_id)
      .single();
    if (arc && arc.status === "Active") {
      arcXpMultiplier = arc.weight ?? 1.0;
      // FLAG-004: null-guard end_date — arc pressure only computed in cron, not here
    }
  }
  const finalXp = Math.round(baseXp * arcXpMultiplier);

  // Gold: base + effort + MH offsets + arc modifier, floor 1
  const goldBase    = GOLD_BASE[normPriority] ?? 6;
  const effortLabel = typeof rawEnergyLabel === "string" ? rawEnergyLabel.toLowerCase() : "medium";
  const effortOff   = EFFORT_OFFSET[effortLabel] ?? 0;
  const mhOff       = MH_GOLD_OFFSET(player.mh_score);
  const rawGold     = goldBase + effortOff + mhOff;
  const goldBeforeArc = Math.max(1, rawGold);
  const finalGold   = Math.max(1, Math.round(goldBeforeArc * arcXpMultiplier));

  const resolvedArgs = {
    title:        args.title,
    date:         args.date,
    type:         normType,
    priority:     normPriority,
    energy_cost:  normEnergy,
    time_block:   normTimeBlock,
    late_rule:    normLateRule,
    xp:           finalXp,
    gold:         finalGold,
    status:       "Pending",
    deferred:     false,
    penalty_modifier: 1.0,
  };

  // Optional pass-through fields
  if (args.time != null)     resolvedArgs.time = args.time;
  if (args.category != null) resolvedArgs.category = args.category;
  if (args.arc_id != null)   resolvedArgs.arc_id = args.arc_id;
  if (args.notes != null)    resolvedArgs.notes = args.notes;

  console.log(`[logicAgent] add_task resolved: type=${normType} priority=${normPriority} xp=${finalXp} gold=${finalGold}`);

  return {
    tool: "add_task",
    resolvedArgs,
    xp: finalXp,
    gold: finalGold,
    statDeltas: [],
    skillDeltas: [],
    needsClarification: false,
  };
}

// ─────────────────────────────────────────────
// complete_task logic
// Resolves task_id (fuzzy match if needed), computes rewards.
// ─────────────────────────────────────────────
async function resolveCompleteTask(args) {
  const player = await fetchPlayerState();
  let taskId = args.task_id ?? null;

  // Fuzzy title match if task_id not provided
  if (taskId == null) {
    if (!args.task_title) {
      return {
        tool: "complete_task",
        resolvedArgs: args,
        xp: 0, gold: 0,
        statDeltas: [], skillDeltas: [],
        needsClarification: true,
        casualPrompt: "Which task are you completing? Give me the name or ID.",
      };
    }

    const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    const { data: todayTasks, error: searchErr } = await supabase
      .from("tasks")
      .select("id, title, status")
      .eq("date", today)
      .in("status", ["Pending", "Carried Over"]);

    if (searchErr || !todayTasks) {
      return {
        tool: "complete_task",
        resolvedArgs: args,
        xp: 0, gold: 0,
        statDeltas: [], skillDeltas: [],
        needsClarification: true,
        casualPrompt: "I couldn't find your tasks right now. Can you give me the task ID?",
      };
    }

    // Simple fuzzy match: check if task title contains the search string (case-insensitive)
    const search = args.task_title.toLowerCase().trim();
    const matches = todayTasks.filter(t =>
      t.title.toLowerCase().includes(search) ||
      search.includes(t.title.toLowerCase().substring(0, 6)) // partial prefix match
    );

    if (matches.length === 0) {
      return {
        tool: "complete_task",
        resolvedArgs: args,
        xp: 0, gold: 0,
        statDeltas: [], skillDeltas: [],
        needsClarification: true,
        casualPrompt: `I couldn't find a task matching "${args.task_title}" today. What's the exact name?`,
      };
    }
    if (matches.length > 1) {
      const names = matches.map(t => `"${t.title}"`).join(", ");
      return {
        tool: "complete_task",
        resolvedArgs: args,
        xp: 0, gold: 0,
        statDeltas: [], skillDeltas: [],
        needsClarification: true,
        casualPrompt: `Found multiple tasks: ${names}. Which one?`,
      };
    }

    taskId = matches[0].id;
    console.log(`[logicAgent] complete_task: fuzzy matched "${args.task_title}" → ${taskId}`);
  }

  // Fetch the task for reward computation
  const { data: task, error: taskErr } = await supabase
    .from("tasks")
    .select("id, title, type, priority, xp, gold, status")
    .eq("id", taskId)
    .single();

  if (taskErr || !task) {
    return {
      tool: "complete_task",
      resolvedArgs: { ...args, task_id: taskId },
      xp: 0, gold: 0,
      statDeltas: [], skillDeltas: [],
      needsClarification: true,
      casualPrompt: "I couldn't find that task. Can you check the name?",
    };
  }

  if (task.status === "Done") {
    return {
      tool: "complete_task",
      resolvedArgs: { ...args, task_id: taskId },
      xp: 0, gold: 0,
      statDeltas: [], skillDeltas: [],
      needsClarification: false,
      casualPrompt: `"${task.title}" is already marked done.`,
    };
  }

  // Base XP and gold from task row (already computed by Logic Agent at creation)
  let xpEarned  = task.xp  ?? XP_BASE[task.type]  ?? 6;
  let goldEarned = task.gold ?? GOLD_BASE[normalisePriority(task.priority)] ?? 3;

  // Arc modifier: check if task is linked to an active arc
  const { data: arcLinks } = await supabase
    .from("arc_tasks")
    .select("arc_id, arcs(weight, status)")
    .eq("task_id", taskId);

  if (arcLinks && arcLinks.length > 0) {
    const activeArc = arcLinks.find(l => l.arcs?.status === "Active");
    if (activeArc) {
      const arcWeight = activeArc.arcs.weight ?? 1.0;
      xpEarned   = Math.round(xpEarned * arcWeight);
      goldEarned = Math.max(1, Math.round(goldEarned * arcWeight));
    }
  }

  // Streak XP bonus (XP only — gold unaffected per AGENTS.md)
  const streakMult = streakBonusMultiplier(player.level, player.streak);
  xpEarned = Math.round(xpEarned * streakMult);

  // Stat deltas from task_stats
  const { data: taskStats } = await supabase
    .from("task_stats")
    .select("stat_id, stat_delta")
    .eq("task_id", taskId);

  const statDeltas = (taskStats ?? []).map(ts => ({
    stat_id: ts.stat_id,
    delta: ts.stat_delta,
  }));

  // Skill XP crossover from task_skill_links
  // Logic Agent computes the crossover amount; DB Agent applies it.
  const { data: skillLinks } = await supabase
    .from("task_skill_links")
    .select("skill_id, crossover_level")
    .eq("task_id", taskId);

  const crossoverRate = { Direct: 0.80, Partial: 0.40, Indirect: 0.15 };
  const skillDeltas = (skillLinks ?? []).map(sl => ({
    skill_id: sl.skill_id,
    xp_amount: Math.round(task.xp * (crossoverRate[sl.crossover_level] ?? 0.15)),
  }));

  console.log(`[logicAgent] complete_task: task="${task.title}" xp=${xpEarned} gold=${goldEarned} streak_mult=${streakMult.toFixed(2)}`);

  return {
    tool: "complete_task",
    resolvedArgs: {
      ...args,
      task_id: taskId,
      completed_at: args.completed_at ?? new Date().toISOString(),
    },
    xp: xpEarned,
    gold: goldEarned,
    statDeltas,
    skillDeltas,
    needsClarification: false,
  };
}

// ─────────────────────────────────────────────
// reschedule_task logic
// Resolves task_id (fuzzy match), normalises time_block.
// ─────────────────────────────────────────────
async function resolveRescheduleTask(args) {
  let taskId = args.task_id ?? null;

  if (taskId == null) {
    if (!args.task_title) {
      return {
        tool: "reschedule_task",
        resolvedArgs: args,
        xp: undefined, gold: undefined,
        statDeltas: [], skillDeltas: [],
        needsClarification: true,
        casualPrompt: "Which task do you want to move? Give me the name.",
      };
    }

    const { data: openTasks } = await supabase
      .from("tasks")
      .select("id, title, status")
      .in("status", ["Pending", "Carried Over"]);

    const search = args.task_title.toLowerCase().trim();
    const matches = (openTasks ?? []).filter(t =>
      t.title.toLowerCase().includes(search)
    );

    if (matches.length === 0) {
      return {
        tool: "reschedule_task",
        resolvedArgs: args,
        xp: undefined, gold: undefined,
        statDeltas: [], skillDeltas: [],
        needsClarification: true,
        casualPrompt: `Couldn't find a task matching "${args.task_title}". What's the full name?`,
      };
    }
    if (matches.length > 1) {
      const names = matches.map(t => `"${t.title}"`).join(", ");
      return {
        tool: "reschedule_task",
        resolvedArgs: args,
        xp: undefined, gold: undefined,
        statDeltas: [], skillDeltas: [],
        needsClarification: true,
        casualPrompt: `Multiple matches: ${names}. Which one?`,
      };
    }

    taskId = matches[0].id;
  }

  const resolvedArgs = {
    task_id: taskId,
    new_date: args.new_date,
  };
  if (args.new_time != null) resolvedArgs.new_time = args.new_time;
  if (args.new_time_block != null) resolvedArgs.new_time_block = normaliseTimeBlock(args.new_time_block);

  return {
    tool: "reschedule_task",
    resolvedArgs,
    xp: undefined, gold: undefined,
    statDeltas: [], skillDeltas: [],
    needsClarification: false,
  };
}

// ─────────────────────────────────────────────
// query_today + query_player_state + log_event
// Minimal logic work — mostly pass-through with boolean normalisation.
// ─────────────────────────────────────────────
async function resolveQueryToday(args) {
  return {
    tool: "query_today",
    resolvedArgs: args,
    xp: undefined, gold: undefined,
    statDeltas: [], skillDeltas: [],
    needsClarification: false,
  };
}

async function resolveQueryPlayerState(args) {
  return {
    tool: "query_player_state",
    resolvedArgs: args,
    xp: undefined, gold: undefined,
    statDeltas: [], skillDeltas: [],
    needsClarification: false,
  };
}

async function resolveLogEvent(args) {
  // No normalisation needed — event_type is validated by toolHandler before reaching here
  return {
    tool: "log_event",
    resolvedArgs: args,
    xp: undefined, gold: undefined,
    statDeltas: [], skillDeltas: [],
    needsClarification: false,
  };
}

// ─────────────────────────────────────────────
// Main dispatch — called from toolHandler.js
// Replace the callLogicAgent stub with this.
// ─────────────────────────────────────────────

/**
 * Run Logic Agent for a given tool + args.
 *
 * @param {string} toolName
 * @param {object} args - Raw args from LLM (pre-normalisation)
 * @returns {Promise<LogicResult>}
 */
export async function callLogicAgent(toolName, args) {
  console.log(`[logicAgent] Resolving: ${toolName}`, args);

  switch (toolName) {
    case "add_task":
      return resolveAddTask(args);
    case "complete_task":
      return resolveCompleteTask(args);
    case "reschedule_task":
      return resolveRescheduleTask(args);
    case "query_today":
      return resolveQueryToday(args);
    case "query_player_state":
      return resolveQueryPlayerState(args);
    case "log_event":
      return resolveLogEvent(args);
    default:
      console.error(`[logicAgent] Unknown tool: ${toolName}`);
      return {
        tool: toolName,
        resolvedArgs: args,
        xp: undefined, gold: undefined,
        statDeltas: [], skillDeltas: [],
        needsClarification: false,
      };
  }
}
