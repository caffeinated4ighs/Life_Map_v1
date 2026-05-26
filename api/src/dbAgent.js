/**
 * dbAgent.js
 * ----------
 * Executes Supabase CRUD for all 7 Life Map tools.
 * Updated: TASK-20260526-025 — add remove_task (soft-delete via status='Cancelled')
 * Owned by: DB Agent
 * Called by: toolHandler.js (replaces callDbAgent stub)
 *
 * Contract:
 *   Input:  logicResult — fully resolved spec from Logic Agent (DB-native types only)
 *   Output: { success: bool, data: object (trimmed), error: string | null }
 *
 * FLAG-008 normalisation is handled UPSTREAM by Logic Agent before reaching here.
 * DB Agent receives only DB-native types:
 *   tasks.type        → Title Case  ("Mandatory" | "Bonus" | "Habit" | "Project")
 *   tasks.late_rule   → "carry_over" | "drop" | "penalise"
 *   tasks.priority    → INTEGER 0–3
 *   tasks.energy_cost → INTEGER 1–5
 *
 * trimResult(toolName, data):
 *   Strips each payload to the LLM-facing minimum before returning to toolHandler.
 *   Full data is used for all DB writes; only the trimmed object travels upward.
 *   Target: < 300 tokens when serialised as JSON.
 *   Token budget verified via JSON.stringify(trimmed).length log on each return path.
 */

import { supabase } from "./supabaseClient.js";

// ─────────────────────────────────────────────
// Payload trimmer
// ─────────────────────────────────────────────

/**
 * Strip a tool result to the minimum the LLM needs to narrate a short reply.
 * Full DB data is consumed internally before this runs.
 *
 * @param {string} toolName
 * @param {object} data - Raw result from the DB operation
 * @returns {object} Trimmed LLM-facing payload
 */
function trimResult(toolName, data) {
  let trimmed;

  switch (toolName) {
    case "add_task":
      trimmed = {
        title: data.title ?? null,
        xp: data.xp ?? null,
        gold: data.gold ?? null,
        date: data.date ?? null,
      };
      break;

    case "complete_task":
      trimmed = {
        task_title: data.task_title ?? null,
        xp_earned: data.xp_earned ?? null,
        gold_earned: data.gold_earned ?? null,
        leveled_up: data.leveled_up ?? false,
        new_level: data.new_level ?? null,
      };
      break;

    case "reschedule_task":
      trimmed = {
        task_title: data.task_title ?? null,
        new_date: data.new_date ?? null,
      };
      break;

    case "query_today": {
      // Tasks: title + status only, no descriptions, timestamps, UUIDs, etc.
      const tasks = Array.isArray(data.tasks) ? data.tasks : [];
      const mandatoryOpen = tasks.filter(
        (t) => t.type === "Mandatory" && t.status === "Pending"
      ).length;
      trimmed = {
        task_count: tasks.length,
        mandatory_open: mandatoryOpen,
        tasks: tasks.map((t) => ({ title: t.title, status: t.status })),
        player: {
          gold: data.player?.gold ?? null,
          total_xp: data.player?.total_xp ?? null,
          streak: data.player?.streak ?? null,
        },
      };
      break;
    }

    case "query_player_state":
      trimmed = {
        level: data.level ?? null,
        total_xp: data.total_xp ?? null,
        gold: data.gold ?? null,
        streak: data.streak ?? null,
        stats: Array.isArray(data.stats)
          ? data.stats.map((s) => ({ name: s.stat_name, value: s.current_value }))
          : [],
        active_effects: Array.isArray(data.effects)
          ? data.effects.map((e) => e.name)
          : [],
      };
      break;

    case "log_event":
      trimmed = {
        event_type: data.event_type ?? null,
        date: data.date ?? null,
      };
      break;

    case "remove_task":
      // Minimal: task_title + date only (~15 tokens)
      trimmed = {
        task_title: data.task_title ?? null,
        date: data.date ?? null,
      };
      break;

    default:
      // Unknown tool — pass through as-is (should never happen after VALID_TOOL_NAMES check)
      trimmed = data;
  }

  // Token budget check — log character length as proxy (1 token ≈ 4 chars)
  const serialised = JSON.stringify(trimmed);
  const charLen = serialised.length;
  const approxTokens = Math.ceil(charLen / 4);
  console.log(
    `[dbAgent] trimResult(${toolName}) → ${charLen} chars (~${approxTokens} tokens)`
  );
  if (approxTokens > 300) {
    console.warn(
      `[dbAgent] WARNING: trimResult(${toolName}) exceeds 300-token budget (${approxTokens} tokens). Review payload.`
    );
  }

  return trimmed;
}

// ─────────────────────────────────────────────
// Tool handlers
// ─────────────────────────────────────────────

/**
 * add_task
 * INSERT into tasks. Returns the inserted row with Logic Agent-computed xp/gold.
 */
async function handleAddTask(logicResult) {
  const args = logicResult.resolvedArgs;

  const row = {
    title: args.title,
    date: args.date,
    type: args.type ?? "Bonus",
    priority: args.priority ?? 2,
    status: "Pending",
    time: args.time ?? null,
    time_block: args.time_block ?? "Flexible",
    category: args.category ?? null,
    energy_cost: args.energy_cost ?? 3,
    late_rule: args.late_rule ?? "carry_over",
    xp: logicResult.xp ?? 0,
    gold: logicResult.gold ?? 0,
    description: args.notes ?? null,
    deferred: false,
    penalty_modifier: 1.0,
  };

  const { data, error } = await supabase
    .from("tasks")
    .insert(row)
    .select("id, title, xp, gold, date")
    .single();

  if (error) {
    return { success: false, data: null, error: `add_task DB error: ${error.message}` };
  }

  // If arc_id provided and resolved to a real UUID, wire the junction
  if (logicResult.resolvedArgs.arc_id) {
    const { error: arcErr } = await supabase.from("arc_tasks").insert({
      arc_id: logicResult.resolvedArgs.arc_id,
      task_id: data.id,
    });
    if (arcErr) {
      console.warn(`[dbAgent] arc_tasks insert failed (non-fatal): ${arcErr.message}`);
    }
  }

  const fullData = { title: data.title, xp: data.xp, gold: data.gold, date: data.date };
  return { success: true, data: trimResult("add_task", fullData), error: null };
}

/**
 * complete_task
 * UPDATE tasks.status = Done.
 * UPDATE player_state: total_xp += xp_earned, gold += gold_earned.
 * Check for level-up against xp_to_next_level.
 */
async function handleCompleteTask(logicResult) {
  const args = logicResult.resolvedArgs;

  // 1. Resolve task row
  let taskRow = null;

  if (args.task_id) {
    const { data, error } = await supabase
      .from("tasks")
      .select("id, title, xp, gold, status")
      .eq("id", args.task_id)
      .single();
    if (error || !data) {
      return { success: false, data: null, error: `complete_task: task_id ${args.task_id} not found.` };
    }
    taskRow = data;
  } else if (args.task_title) {
    // Fuzzy: case-insensitive ILIKE match on today's open tasks
    const today = new Date().toISOString().slice(0, 10);
    const { data, error } = await supabase
      .from("tasks")
      .select("id, title, xp, gold, status")
      .eq("date", today)
      .eq("status", "Pending")
      .ilike("title", `%${args.task_title}%`)
      .limit(1)
      .single();
    if (error || !data) {
      return {
        success: false,
        data: null,
        error: `complete_task: no open task matching "${args.task_title}" found for today.`,
      };
    }
    taskRow = data;
  } else {
    return { success: false, data: null, error: "complete_task: task_id or task_title required." };
  }

  if (taskRow.status === "Done") {
    return { success: false, data: null, error: `complete_task: task "${taskRow.title}" is already done.` };
  }

  // 2. Mark task done
  const completedAt = args.completed_at ?? new Date().toISOString();
  const { error: updateErr } = await supabase
    .from("tasks")
    .update({ status: "Done", updated_at: completedAt })
    .eq("id", taskRow.id);

  if (updateErr) {
    return { success: false, data: null, error: `complete_task update error: ${updateErr.message}` };
  }

  // 3. Fetch current player state
  const { data: player, error: playerErr } = await supabase
    .from("player_state")
    .select("id, total_xp, gold, level, xp_to_next_level, streak")
    .eq("id", 1)
    .single();

  if (playerErr || !player) {
    return { success: false, data: null, error: `complete_task: player_state fetch error: ${playerErr?.message}` };
  }

  // 4. Compute XP/gold (Logic Agent may have computed these; fall back to task row values)
  const xpEarned = logicResult.xpEarned ?? taskRow.xp;
  const goldEarned = logicResult.goldEarned ?? taskRow.gold;

  const newTotalXp = player.total_xp + xpEarned;
  const newGold = player.gold + goldEarned;

  // 5. Level-up check
  let newLevel = player.level;
  let xpToNext = player.xp_to_next_level;
  let leveledUp = false;

  if (newTotalXp >= player.xp_to_next_level && player.level < 20) {
    newLevel = player.level + 1;
    leveledUp = true;
    xpToNext = getXpToNextLevel(newLevel);
  }

  // 6. Update player state
  const { error: playerUpdateErr } = await supabase
    .from("player_state")
    .update({
      total_xp: newTotalXp,
      gold: newGold,
      level: newLevel,
      xp_to_next_level: xpToNext,
      updated_at: new Date().toISOString(),
    })
    .eq("id", 1);

  if (playerUpdateErr) {
    console.warn(`[dbAgent] player_state update warning: ${playerUpdateErr.message}`);
  }

  const fullData = {
    task_title: taskRow.title,
    xp_earned: xpEarned,
    gold_earned: goldEarned,
    leveled_up: leveledUp,
    new_level: leveledUp ? newLevel : null,
  };

  return { success: true, data: trimResult("complete_task", fullData), error: null };
}

/**
 * reschedule_task
 * UPDATE tasks.date (and optionally time/time_block).
 */
async function handleRescheduleTask(logicResult) {
  const args = logicResult.resolvedArgs;

  // Resolve task row
  let taskRow = null;

  if (args.task_id) {
    const { data, error } = await supabase
      .from("tasks")
      .select("id, title, deferred, status")
      .eq("id", args.task_id)
      .single();
    if (error || !data) {
      return { success: false, data: null, error: `reschedule_task: task_id ${args.task_id} not found.` };
    }
    taskRow = data;
  } else if (args.task_title) {
    const { data, error } = await supabase
      .from("tasks")
      .select("id, title, deferred, status")
      .ilike("title", `%${args.task_title}%`)
      .in("status", ["Pending", "Carried Over"])
      .limit(1)
      .single();
    if (error || !data) {
      return {
        success: false,
        data: null,
        error: `reschedule_task: no pending task matching "${args.task_title}".`,
      };
    }
    taskRow = data;
  } else {
    return { success: false, data: null, error: "reschedule_task: task_id or task_title required." };
  }

  const updates = {
    date: args.new_date,
    updated_at: new Date().toISOString(),
  };
  if (args.new_time !== undefined) updates.time = args.new_time;
  if (args.new_time_block !== undefined) updates.time_block = args.new_time_block;

  const { error: updateErr } = await supabase
    .from("tasks")
    .update(updates)
    .eq("id", taskRow.id);

  if (updateErr) {
    return { success: false, data: null, error: `reschedule_task update error: ${updateErr.message}` };
  }

  const fullData = { task_title: taskRow.title, new_date: args.new_date };
  return { success: true, data: trimResult("reschedule_task", fullData), error: null };
}

/**
 * query_today
 * SELECT tasks WHERE date = today (+ carried over if requested).
 * SELECT player_state snapshot.
 */
async function handleQueryToday(logicResult) {
  const args = logicResult.resolvedArgs;
  const today = new Date().toISOString().slice(0, 10);

  const filterStatus = args.filter_status ?? "open";
  const includeCarriedOver =
    args.include_carried_over === true || args.include_carried_over === "true";

  // Build tasks query
  let query = supabase
    .from("tasks")
    .select("id, title, type, status, priority, energy_cost, xp, gold")
    .eq("date", today);

  if (filterStatus === "open") {
    query = query.eq("status", "Pending");
  } else if (filterStatus === "done") {
    query = query.eq("status", "Done");
  }

  if (includeCarriedOver && filterStatus === "open") {
    // Pull carried-over tasks separately (they live on previous dates)
    const { data: carriedRows } = await supabase
      .from("tasks")
      .select("id, title, type, status, priority, energy_cost, xp, gold")
      .eq("status", "Carried Over");
    const { data: todayRows, error } = await query;
    if (error) {
      return { success: false, data: null, error: `query_today tasks error: ${error.message}` };
    }
    return buildQueryTodayResult([...(todayRows ?? []), ...(carriedRows ?? [])]);
  }

  const { data: tasks, error } = await query;
  if (error) {
    return { success: false, data: null, error: `query_today tasks error: ${error.message}` };
  }

  return buildQueryTodayResult(tasks ?? []);
}

async function buildQueryTodayResult(tasks) {
  const { data: player, error: playerErr } = await supabase
    .from("player_state")
    .select("gold, total_xp, streak, level")
    .eq("id", 1)
    .single();

  if (playerErr) {
    console.warn(`[dbAgent] query_today: player_state fetch warning: ${playerErr.message}`);
  }

  const fullData = { tasks, player: player ?? {} };
  return { success: true, data: trimResult("query_today", fullData), error: null };
}

/**
 * query_player_state
 * SELECT player_state + stats (+ optional skills + effects).
 */
async function handleQueryPlayerState(logicResult) {
  const args = logicResult.resolvedArgs;

  const includeSkills = args.include_skills !== false && args.include_skills !== "false";
  const includeEffects = args.include_effects !== false && args.include_effects !== "false";
  const includeStats = args.include_stats !== false && args.include_stats !== "false";

  const { data: player, error: playerErr } = await supabase
    .from("player_state")
    .select("level, total_xp, gold, streak, mh_score, mh_mode, xp_to_next_level")
    .eq("id", 1)
    .single();

  if (playerErr || !player) {
    return { success: false, data: null, error: `query_player_state error: ${playerErr?.message}` };
  }

  let stats = [];
  if (includeStats) {
    const { data: statsData } = await supabase
      .from("stats")
      .select("stat_name, current_value")
      .order("id", { ascending: true });
    stats = statsData ?? [];
  }

  let effects = [];
  if (includeEffects) {
    const { data: effectsData } = await supabase
      .from("effects")
      .select("name, intensity, expires_on")
      .eq("active", true);
    effects = effectsData ?? [];
  }

  let skills = [];
  if (includeSkills) {
    const { data: skillsData } = await supabase
      .from("skills")
      .select("name, level, xp_accumulated, in_decay")
      .order("level", { ascending: false })
      .limit(10);
    skills = skillsData ?? [];
  }

  const fullData = {
    level: player.level,
    total_xp: player.total_xp,
    gold: player.gold,
    streak: player.streak,
    stats,
    effects,
    skills,
  };

  return { success: true, data: trimResult("query_player_state", fullData), error: null };
}

/**
 * log_event
 * INSERT into events.
 */
async function handleLogEvent(logicResult) {
  const args = logicResult.resolvedArgs;
  const today = new Date().toISOString().slice(0, 10);

  const row = {
    event_type: args.event_type,
    event_date: args.date ?? today,
    value: args.value ?? null,
    notes: args.notes
      ? `${args.label ? args.label + " — " : ""}${args.notes}`
      : (args.label ?? null),
  };

  const { error } = await supabase.from("events").insert(row);

  if (error) {
    return { success: false, data: null, error: `log_event DB error: ${error.message}` };
  }

  const fullData = { event_type: args.event_type, date: row.event_date };
  return { success: true, data: trimResult("log_event", fullData), error: null };
}

/**
 * remove_task
 * Soft-delete: UPDATE tasks SET status = 'Cancelled', updated_at = NOW()
 * Resolves task by id or ILIKE title match (any non-Done status).
 * Does NOT delete the row — preserves audit trail.
 * Requires: tasks_status_check includes 'Cancelled' (TASK-20260526-024/025).
 */
async function handleRemoveTask(logicResult) {
  const args = logicResult.resolvedArgs;

  // Resolve task row
  let taskRow = null;

  if (args.task_id) {
    const { data, error } = await supabase
      .from("tasks")
      .select("id, title, date, status")
      .eq("id", args.task_id)
      .single();
    if (error || !data) {
      return { success: false, data: null, error: `remove_task: task_id ${args.task_id} not found.` };
    }
    taskRow = data;
  } else if (args.task_title) {
    const { data, error } = await supabase
      .from("tasks")
      .select("id, title, date, status")
      .ilike("title", `%${args.task_title}%`)
      .not("status", "eq", "Done")
      .not("status", "eq", "Cancelled")
      .order("date", { ascending: false })
      .limit(1)
      .single();
    if (error || !data) {
      return {
        success: false,
        data: null,
        error: `remove_task: no cancellable task matching "${args.task_title}".`,
      };
    }
    taskRow = data;
  } else {
    return { success: false, data: null, error: "remove_task: task_id or task_title required." };
  }

  if (taskRow.status === "Cancelled") {
    return { success: false, data: null, error: `remove_task: task "${taskRow.title}" is already cancelled.` };
  }
  if (taskRow.status === "Done") {
    return { success: false, data: null, error: `remove_task: task "${taskRow.title}" is already done — cannot cancel.` };
  }

  const { error: updateErr } = await supabase
    .from("tasks")
    .update({ status: "Cancelled", updated_at: new Date().toISOString() })
    .eq("id", taskRow.id);

  if (updateErr) {
    return { success: false, data: null, error: `remove_task update error: ${updateErr.message}` };
  }

  const fullData = { task_title: taskRow.title, date: taskRow.date };
  return { success: true, data: trimResult("remove_task", fullData), error: null };
}

// ─────────────────────────────────────────────
// XP table helper (AGENTS.md levels 0–20)
// ─────────────────────────────────────────────

/**
 * Return xp_to_next_level for a given level.
 * Simple progression: Level N→N+1 costs 50 * (N+1) XP.
 * Example: L0→L1=50, L1→L2=100, L2→L3=150 … L19→L20=1000.
 * Logic Agent should maintain the full table; this is the DB Agent fallback.
 */
function getXpToNextLevel(level) {
  if (level >= 20) return 999999; // Soft cap at level 20
  return 50 * (level + 1);
}

// ─────────────────────────────────────────────
// Main dispatch
// ─────────────────────────────────────────────

/**
 * Execute a DB operation for the given tool and return a trimmed result.
 *
 * @param {object} logicResult - Fully resolved spec from Logic Agent
 * @returns {Promise<{ success: boolean, data: object, error: string|null }>}
 */
export async function callDbAgent(logicResult) {
  const { tool } = logicResult;

  console.log(`[dbAgent] Dispatching: ${tool}`);

  switch (tool) {
    case "add_task":
      return handleAddTask(logicResult);
    case "complete_task":
      return handleCompleteTask(logicResult);
    case "reschedule_task":
      return handleRescheduleTask(logicResult);
    case "query_today":
      return handleQueryToday(logicResult);
    case "query_player_state":
      return handleQueryPlayerState(logicResult);
    case "log_event":
      return handleLogEvent(logicResult);
    case "remove_task":
      return handleRemoveTask(logicResult);
    default:
      return {
        success: false,
        data: null,
        error: `dbAgent: unknown tool "${tool}"`,
      };
  }
}
