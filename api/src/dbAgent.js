/**
 * dbAgent.js
 * ----------
 * Executes Supabase CRUD for all 7 Life Map tools.
 * Updated: TASK-20260526-025 — add remove_task (soft-delete via status='Cancelled')
 *          TASK-20260527-002 — fix complete_task title match (drop date filter, FLAG-DATE)
 *                            — fix query_today to use status filter, not date filter (FLAG-DATE)
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
 * FLAG-DATE: Logic Agent clamps all dates before reaching here.
 *   DB Agent never applies its own date logic — it trusts logicResult.resolvedArgs.date.
 *
 * trimResult(toolName, data):
 *   Strips each payload to the LLM-facing minimum before returning to toolHandler.
 *   Full data is used for all DB writes; only the trimmed object travels upward.
 *   Target: < 300 tokens when serialised as JSON.
 */

import { supabase } from "./supabaseClient.js";

// ─────────────────────────────────────────────
// Payload trimmer
// ─────────────────────────────────────────────

/**
 * Strip a tool result to the minimum the LLM needs to narrate a short reply.
 */
function trimResult(toolName, data) {
  let trimmed;

  switch (toolName) {
    case "add_task":
      trimmed = {
        title: data.title ?? null,
        xp:    data.xp   ?? null,
        gold:  data.gold ?? null,
        date:  data.date ?? null,
      };
      break;

    case "complete_task":
      trimmed = {
        task_title:  data.task_title  ?? null,
        xp_earned:   data.xp_earned   ?? null,
        gold_earned: data.gold_earned ?? null,
        leveled_up:  data.leveled_up  ?? false,
        new_level:   data.new_level   ?? null,
      };
      break;

    case "reschedule_task":
      trimmed = {
        task_title: data.task_title ?? null,
        new_date:   data.new_date   ?? null,
      };
      break;

    case "query_today": {
      const tasks = Array.isArray(data.tasks) ? data.tasks : [];
      const mandatoryOpen = tasks.filter(
        (t) => t.type === "Mandatory" && t.status === "Pending"
      ).length;
      trimmed = {
        task_count:    tasks.length,
        mandatory_open: mandatoryOpen,
        tasks: tasks.map((t) => ({ title: t.title, status: t.status })),
        player: {
          gold:     data.player?.gold     ?? null,
          total_xp: data.player?.total_xp ?? null,
          streak:   data.player?.streak   ?? null,
        },
      };
      break;
    }

    case "query_player_state":
      trimmed = {
        level:   data.level   ?? null,
        total_xp: data.total_xp ?? null,
        gold:    data.gold    ?? null,
        streak:  data.streak  ?? null,
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
        date:       data.date       ?? null,
      };
      break;

    case "remove_task":
      trimmed = {
        task_title: data.task_title ?? null,
        date:       data.date       ?? null,
      };
      break;

    default:
      trimmed = data;
  }

  const serialised  = JSON.stringify(trimmed);
  const charLen     = serialised.length;
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
 * INSERT into tasks. Logic Agent has already clamped the date (FLAG-DATE).
 */
async function handleAddTask(logicResult) {
  const args = logicResult.resolvedArgs;

  const row = {
    title:           args.title,
    date:            args.date,          // Already clamped by Logic Agent
    type:            args.type            ?? "Bonus",
    priority:        args.priority        ?? 2,
    status:          "Pending",
    time:            args.time            ?? null,
    time_block:      args.time_block      ?? "Flexible",
    category:        args.category        ?? null,
    energy_cost:     args.energy_cost     ?? 3,
    late_rule:       args.late_rule       ?? "carry_over",
    xp:              logicResult.xp       ?? 0,
    gold:            logicResult.gold     ?? 0,
    description:     args.notes           ?? null,
    deferred:        false,
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

  if (logicResult.resolvedArgs.arc_id) {
    const { error: arcErr } = await supabase.from("arc_tasks").insert({
      arc_id:  logicResult.resolvedArgs.arc_id,
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
 * Check for level-up.
 *
 * FLAG-DATE fix: title match no longer filters by date. Tasks may have any date
 * due to LLM date hallucination history. Match on status='Pending' only, ordered
 * by created_at DESC so the most recently added task wins on ambiguous names.
 */
async function handleCompleteTask(logicResult) {
  const args = logicResult.resolvedArgs;

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
    // FLAG-DATE fix: removed .eq("date", today) — tasks may have any date.
    // Match on Pending status only, most recently created match wins.
    const { data, error } = await supabase
      .from("tasks")
      .select("id, title, xp, gold, status")
      .eq("status", "Pending")
      .ilike("title", `%${args.task_title}%`)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();
    if (error || !data) {
      return {
        success: false,
        data: null,
        error: `complete_task: no open task matching "${args.task_title}".`,
      };
    }
    taskRow = data;
  } else {
    return { success: false, data: null, error: "complete_task: task_id or task_title required." };
  }

  if (taskRow.status === "Done") {
    return { success: false, data: null, error: `complete_task: task "${taskRow.title}" is already done.` };
  }

  const completedAt = args.completed_at ?? new Date().toISOString();
  const { error: updateErr } = await supabase
    .from("tasks")
    .update({ status: "Done", updated_at: completedAt })
    .eq("id", taskRow.id);

  if (updateErr) {
    return { success: false, data: null, error: `complete_task update error: ${updateErr.message}` };
  }

  const { data: player, error: playerErr } = await supabase
    .from("player_state")
    .select("id, total_xp, gold, level, xp_to_next_level, streak")
    .eq("id", 1)
    .single();

  if (playerErr || !player) {
    return { success: false, data: null, error: `complete_task: player_state fetch error: ${playerErr?.message}` };
  }

  const xpEarned   = logicResult.xpEarned   ?? taskRow.xp;
  const goldEarned  = logicResult.goldEarned ?? taskRow.gold;
  const newTotalXp  = player.total_xp + xpEarned;
  const newGold     = player.gold + goldEarned;

  let newLevel  = player.level;
  let xpToNext  = player.xp_to_next_level;
  let leveledUp = false;

  if (newTotalXp >= player.xp_to_next_level && player.level < 20) {
    newLevel  = player.level + 1;
    leveledUp = true;
    xpToNext  = getXpToNextLevel(newLevel);
  }

  const { error: playerUpdateErr } = await supabase
    .from("player_state")
    .update({
      total_xp:        newTotalXp,
      gold:            newGold,
      level:           newLevel,
      xp_to_next_level: xpToNext,
      updated_at:      new Date().toISOString(),
    })
    .eq("id", 1);

  if (playerUpdateErr) {
    console.warn(`[dbAgent] player_state update warning: ${playerUpdateErr.message}`);
  }

  const fullData = {
    task_title:  taskRow.title,
    xp_earned:   xpEarned,
    gold_earned: goldEarned,
    leveled_up:  leveledUp,
    new_level:   leveledUp ? newLevel : null,
  };

  return { success: true, data: trimResult("complete_task", fullData), error: null };
}

/**
 * reschedule_task
 * UPDATE tasks.date (and optionally time/time_block).
 * Logic Agent has already clamped new_date (FLAG-DATE).
 */
async function handleRescheduleTask(logicResult) {
  const args = logicResult.resolvedArgs;

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
      .order("created_at", { ascending: false })
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
    date:       args.new_date,
    updated_at: new Date().toISOString(),
  };
  if (args.new_time       !== undefined) updates.time       = args.new_time;
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
 * Returns the user's task backlog and a player snapshot.
 *
 * FLAG-DATE fix: "open" filter now queries by status IN ('Pending', 'Carried Over')
 * rather than by date. This is correct behaviour regardless of date issues — the user
 * wants to see everything they still need to do, not just tasks dated exactly today.
 * "done" filter still scopes to tasks completed on or after today's date.
 * "all" still scopes to tasks dated today specifically.
 */
async function handleQueryToday(logicResult) {
  const args = logicResult.resolvedArgs;
  const today = new Date().toISOString().slice(0, 10);

  const filterStatus     = args.filter_status    ?? "open";
  const includeCarriedOver =
    args.include_carried_over === true || args.include_carried_over === "true";

  let tasks = [];

  if (filterStatus === "open") {
    // FLAG-DATE fix: query by status, not by date.
    // Pending = not yet done. Carried Over = explicitly moved forward.
    // includeCarriedOver is implicit in this query (both statuses included).
    const statusFilter = includeCarriedOver
      ? ["Pending", "Carried Over"]
      : ["Pending"];

    const { data, error } = await supabase
      .from("tasks")
      .select("id, title, type, status, priority, energy_cost, xp, gold, date")
      .in("status", statusFilter)
      .order("date", { ascending: true });

    if (error) {
      return { success: false, data: null, error: `query_today tasks error: ${error.message}` };
    }
    tasks = data ?? [];

  } else if (filterStatus === "done") {
    // Done tasks completed on or after today
    const { data, error } = await supabase
      .from("tasks")
      .select("id, title, type, status, priority, energy_cost, xp, gold, date")
      .eq("status", "Done")
      .gte("date", today)
      .order("date", { ascending: true });

    if (error) {
      return { success: false, data: null, error: `query_today tasks error: ${error.message}` };
    }
    tasks = data ?? [];

  } else {
    // "all" — everything dated today
    const { data, error } = await supabase
      .from("tasks")
      .select("id, title, type, status, priority, energy_cost, xp, gold, date")
      .eq("date", today)
      .order("created_at", { ascending: true });

    if (error) {
      return { success: false, data: null, error: `query_today tasks error: ${error.message}` };
    }
    tasks = data ?? [];
  }

  return buildQueryTodayResult(tasks);
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

  const includeSkills  = args.include_skills  !== false && args.include_skills  !== "false";
  const includeEffects = args.include_effects !== false && args.include_effects !== "false";
  const includeStats   = args.include_stats   !== false && args.include_stats   !== "false";

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
    level:    player.level,
    total_xp: player.total_xp,
    gold:     player.gold,
    streak:   player.streak,
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
  const args  = logicResult.resolvedArgs;
  const today = new Date().toISOString().slice(0, 10);

  const row = {
    event_type: args.event_type,
    event_date: args.date ?? today,
    value:      args.value ?? null,
    notes:      args.notes
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
 * Resolves by id or ILIKE title match (any non-Done, non-Cancelled status).
 * Does NOT delete the row — preserves audit trail.
 */
async function handleRemoveTask(logicResult) {
  const args = logicResult.resolvedArgs;

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
      .order("created_at", { ascending: false })
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
// XP table helper
// ─────────────────────────────────────────────

function getXpToNextLevel(level) {
  if (level >= 20) return 999999;
  return 50 * (level + 1);
}

// ─────────────────────────────────────────────
// Main dispatch
// ─────────────────────────────────────────────

export async function callDbAgent(logicResult) {
  const { tool } = logicResult;
  console.log(`[dbAgent] Dispatching: ${tool}`);

  switch (tool) {
    case "add_task":           return handleAddTask(logicResult);
    case "complete_task":      return handleCompleteTask(logicResult);
    case "reschedule_task":    return handleRescheduleTask(logicResult);
    case "query_today":        return handleQueryToday(logicResult);
    case "query_player_state": return handleQueryPlayerState(logicResult);
    case "log_event":          return handleLogEvent(logicResult);
    case "remove_task":        return handleRemoveTask(logicResult);
    default:
      return {
        success: false,
        data: null,
        error: `dbAgent: unknown tool "${tool}"`,
      };
  }
}
