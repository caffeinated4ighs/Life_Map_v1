/**
 * dbAgent.js
 * ----------
 * Executes Supabase CRUD for all 8 Life Map tools.
 * Updated: TASK-20260526-025 — remove_task added
 *          TASK-20260527-002 — complete_task date filter removed (FLAG-DATE)
 *                            — query_today switched to status-based filter (FLAG-DATE)
 *          TASK-20260527-003 — clear_tasks added (bulk cancel)
 */

import { supabase } from "./supabaseClient.js";

// ─────────────────────────────────────────────
// Payload trimmer
// ─────────────────────────────────────────────

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
        task_count:     tasks.length,
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
        level:    data.level    ?? null,
        total_xp: data.total_xp ?? null,
        gold:     data.gold     ?? null,
        streak:   data.streak   ?? null,
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

    case "clear_tasks":
      trimmed = {
        cancelled_count: data.cancelled_count ?? 0,
        scope:           data.scope           ?? "all",
      };
      break;

    default:
      trimmed = data;
  }

  const charLen      = JSON.stringify(trimmed).length;
  const approxTokens = Math.ceil(charLen / 4);
  console.log(`[dbAgent] trimResult(${toolName}) → ${charLen} chars (~${approxTokens} tokens)`);
  if (approxTokens > 300) {
    console.warn(`[dbAgent] WARNING: trimResult(${toolName}) exceeds 300-token budget (${approxTokens} tokens).`);
  }

  return trimmed;
}

// ─────────────────────────────────────────────
// Tool handlers
// ─────────────────────────────────────────────

async function handleAddTask(logicResult) {
  const args = logicResult.resolvedArgs;

  const row = {
    title:            args.title,
    date:             args.date,
    type:             args.type        ?? "Bonus",
    priority:         args.priority    ?? 2,
    status:           "Pending",
    time:             args.time        ?? null,
    time_block:       args.time_block  ?? "Flexible",
    category:         args.category    ?? null,
    energy_cost:      args.energy_cost ?? 3,
    late_rule:        args.late_rule   ?? "carry_over",
    xp:               logicResult.xp   ?? 0,
    gold:             logicResult.gold ?? 0,
    description:      args.notes       ?? null,
    deferred:         false,
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
    if (arcErr) console.warn(`[dbAgent] arc_tasks insert failed (non-fatal): ${arcErr.message}`);
  }

  return {
    success: true,
    data: trimResult("add_task", { title: data.title, xp: data.xp, gold: data.gold, date: data.date }),
    error: null,
  };
}

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
    // FLAG-DATE fix: no date filter — match on status only, most recent wins
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
    return { success: false, data: null, error: `complete_task: "${taskRow.title}" is already done.` };
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
    return { success: false, data: null, error: `complete_task: player_state error: ${playerErr?.message}` };
  }

  const xpEarned    = logicResult.xpEarned   ?? taskRow.xp;
  const goldEarned  = logicResult.goldEarned  ?? taskRow.gold;
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
      total_xp:         newTotalXp,
      gold:             newGold,
      level:            newLevel,
      xp_to_next_level: xpToNext,
      updated_at:       new Date().toISOString(),
    })
    .eq("id", 1);

  if (playerUpdateErr) {
    console.warn(`[dbAgent] player_state update warning: ${playerUpdateErr.message}`);
  }

  return {
    success: true,
    data: trimResult("complete_task", {
      task_title:  taskRow.title,
      xp_earned:   xpEarned,
      gold_earned: goldEarned,
      leveled_up:  leveledUp,
      new_level:   leveledUp ? newLevel : null,
    }),
    error: null,
  };
}

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

  const updates = { date: args.new_date, updated_at: new Date().toISOString() };
  if (args.new_time       !== undefined) updates.time       = args.new_time;
  if (args.new_time_block !== undefined) updates.time_block = args.new_time_block;

  const { error: updateErr } = await supabase
    .from("tasks")
    .update(updates)
    .eq("id", taskRow.id);

  if (updateErr) {
    return { success: false, data: null, error: `reschedule_task update error: ${updateErr.message}` };
  }

  return {
    success: true,
    data: trimResult("reschedule_task", { task_title: taskRow.title, new_date: args.new_date }),
    error: null,
  };
}

async function handleQueryToday(logicResult) {
  const args  = logicResult.resolvedArgs;
  const today = new Date().toISOString().slice(0, 10);

  const filterStatus       = args.filter_status      ?? "open";
  const includeCarriedOver = args.include_carried_over === true || args.include_carried_over === "true";

  let tasks = [];

  if (filterStatus === "open") {
    // FLAG-DATE fix: query by status, not by date
    const statusFilter = includeCarriedOver ? ["Pending", "Carried Over"] : ["Pending"];
    const { data, error } = await supabase
      .from("tasks")
      .select("id, title, type, status, priority, energy_cost, xp, gold, date")
      .in("status", statusFilter)
      .order("date", { ascending: true });
    if (error) return { success: false, data: null, error: `query_today error: ${error.message}` };
    tasks = data ?? [];

  } else if (filterStatus === "done") {
    const { data, error } = await supabase
      .from("tasks")
      .select("id, title, type, status, priority, energy_cost, xp, gold, date")
      .eq("status", "Done")
      .gte("date", today)
      .order("date", { ascending: true });
    if (error) return { success: false, data: null, error: `query_today error: ${error.message}` };
    tasks = data ?? [];

  } else {
    // "all" — tasks dated today
    const { data, error } = await supabase
      .from("tasks")
      .select("id, title, type, status, priority, energy_cost, xp, gold, date")
      .eq("date", today)
      .order("created_at", { ascending: true });
    if (error) return { success: false, data: null, error: `query_today error: ${error.message}` };
    tasks = data ?? [];
  }

  const { data: player, error: playerErr } = await supabase
    .from("player_state")
    .select("gold, total_xp, streak, level")
    .eq("id", 1)
    .single();

  if (playerErr) console.warn(`[dbAgent] query_today: player_state warning: ${playerErr.message}`);

  return {
    success: true,
    data: trimResult("query_today", { tasks, player: player ?? {} }),
    error: null,
  };
}

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
    const { data } = await supabase.from("stats").select("stat_name, current_value").order("id");
    stats = data ?? [];
  }

  let effects = [];
  if (includeEffects) {
    const { data } = await supabase.from("effects").select("name, intensity, expires_on").eq("active", true);
    effects = data ?? [];
  }

  let skills = [];
  if (includeSkills) {
    const { data } = await supabase.from("skills").select("name, level, xp_accumulated, in_decay")
      .order("level", { ascending: false }).limit(10);
    skills = data ?? [];
  }

  return {
    success: true,
    data: trimResult("query_player_state", {
      level: player.level, total_xp: player.total_xp, gold: player.gold,
      streak: player.streak, stats, effects, skills,
    }),
    error: null,
  };
}

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
  if (error) return { success: false, data: null, error: `log_event DB error: ${error.message}` };

  return {
    success: true,
    data: trimResult("log_event", { event_type: args.event_type, date: row.event_date }),
    error: null,
  };
}

async function handleRemoveTask(logicResult) {
  const args = logicResult.resolvedArgs;
  let taskRow = null;

  if (args.task_id) {
    const { data, error } = await supabase
      .from("tasks").select("id, title, date, status").eq("id", args.task_id).single();
    if (error || !data) {
      return { success: false, data: null, error: `remove_task: task_id ${args.task_id} not found.` };
    }
    taskRow = data;
  } else if (args.task_title) {
    const { data, error } = await supabase
      .from("tasks").select("id, title, date, status")
      .ilike("title", `%${args.task_title}%`)
      .not("status", "eq", "Done")
      .not("status", "eq", "Cancelled")
      .order("created_at", { ascending: false })
      .limit(1).single();
    if (error || !data) {
      return { success: false, data: null, error: `remove_task: no cancellable task matching "${args.task_title}".` };
    }
    taskRow = data;
  } else {
    return { success: false, data: null, error: "remove_task: task_id or task_title required." };
  }

  if (taskRow.status === "Cancelled") {
    return { success: false, data: null, error: `remove_task: "${taskRow.title}" is already cancelled.` };
  }
  if (taskRow.status === "Done") {
    return { success: false, data: null, error: `remove_task: "${taskRow.title}" is already done.` };
  }

  const { error: updateErr } = await supabase
    .from("tasks").update({ status: "Cancelled", updated_at: new Date().toISOString() }).eq("id", taskRow.id);

  if (updateErr) {
    return { success: false, data: null, error: `remove_task update error: ${updateErr.message}` };
  }

  return {
    success: true,
    data: trimResult("remove_task", { task_title: taskRow.title, date: taskRow.date }),
    error: null,
  };
}

/**
 * clear_tasks
 * Bulk soft-delete: UPDATE tasks SET status = 'Cancelled'
 * scope "today" = only tasks dated today.
 * scope "all"   = all Pending/Carried Over tasks regardless of date.
 * Returns cancelled_count so the LLM can give an accurate reply.
 */
async function handleClearTasks(logicResult) {
  const { scope } = logicResult.resolvedArgs;
  const today = new Date().toISOString().slice(0, 10);

  let query = supabase
    .from("tasks")
    .update({ status: "Cancelled", updated_at: new Date().toISOString() })
    .in("status", ["Pending", "Carried Over"]);

  if (scope === "today") {
    query = query.eq("date", today);
  }
  // scope "all" — no additional filter

  // Use select to get back the affected rows so we can count them
  const { data, error } = await query.select("id");

  if (error) {
    return { success: false, data: null, error: `clear_tasks DB error: ${error.message}` };
  }

  const cancelledCount = Array.isArray(data) ? data.length : 0;
  console.log(`[dbAgent] clear_tasks(${scope}): cancelled ${cancelledCount} tasks`);

  return {
    success: true,
    data: trimResult("clear_tasks", { cancelled_count: cancelledCount, scope }),
    error: null,
  };
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
    case "clear_tasks":        return handleClearTasks(logicResult);
    default:
      return { success: false, data: null, error: `dbAgent: unknown tool "${tool}"` };
  }
}
