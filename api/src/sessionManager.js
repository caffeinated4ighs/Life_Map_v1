/**
 * sessionManager.js
 * -----------------
 * Handles conversation lifecycle and message persistence.
 *
 * Updated: TASK-20260527-004 — renderSummaryAsText now includes task titles
 *          from entities so follow-up questions ("what's the mandatory task?")
 *          can be answered from context without a second DB query.
 */

import { supabase } from "./supabaseClient.js";

const CONTEXT_WINDOW = parseInt(process.env.CONTEXT_WINDOW ?? "5", 10);

// ─────────────────────────────────────────────
// Conversation management
// ─────────────────────────────────────────────

export async function createConversation() {
  const { data, error } = await supabase
    .from("conversations")
    .insert({ started_at: new Date().toISOString() })
    .select("id")
    .single();
  if (error) throw new Error(`Failed to create conversation: ${error.message}`);
  return data.id;
}

export async function conversationExists(conversationId) {
  const { data, error } = await supabase
    .from("conversations")
    .select("id")
    .eq("id", conversationId)
    .single();
  return !error && !!data;
}

// ─────────────────────────────────────────────
// Message persistence
// ─────────────────────────────────────────────

export async function insertMessage(conversationId, summaryJson) {
  const { error } = await supabase.from("messages").insert({
    conversation_id: conversationId,
    role:            summaryJson.role,
    summary_json:    summaryJson,
    created_at:      summaryJson.timestamp ?? new Date().toISOString(),
  });
  if (error) throw new Error(`Failed to insert message: ${error.message}`);
}

// ─────────────────────────────────────────────
// Context assembly
// ─────────────────────────────────────────────

/**
 * Render a summary_json row as plain English for Groq history.
 *
 * Key change (TASK-20260527-004):
 * query_today results now include actual task titles in the rendered string so
 * follow-up questions like "what's the mandatory task?" are answerable from
 * context without firing another DB query.
 */
function renderSummaryAsText(s) {
  const preview  = s.raw_preview ?? "";
  const intent   = s.intent      ?? "unknown";
  const outcome  = s.outcome     ?? "ok";
  const entities = s.entities    ?? {};

  if (s.role === "user") {
    switch (intent) {
      case "add_task":      return `User asked to add task: ${preview}`;
      case "complete_task": return `User completed a task: ${preview}`;
      case "remove_task":   return `User asked to remove a task: ${preview}`;
      case "clear_tasks":   return `User asked to clear all tasks: ${preview}`;
      default:              return `User said: ${preview}`;
    }
  }

  // ── assistant role ──

  if (intent === "chitchat") return "Assistant replied conversationally.";

  if (outcome === "clarification needed" || outcome === "tool_error") {
    return `Assistant couldn't complete ${intent} — clarification requested.`;
  }

  // query_today — include full task list so follow-up questions work
  if (intent === "query_today") {
    if (!Array.isArray(entities.tasks) || entities.tasks.length === 0) {
      return "Assistant returned task list: no open tasks.";
    }
    const lines = entities.tasks.map((t) => {
      const tag = t.status !== "Pending" ? ` (${t.status})` : "";
      const typeTag = t.type === "Mandatory" ? " [mandatory]" : "";
      return `${t.title}${typeTag}${tag}`;
    });
    return `Assistant returned task list: ${lines.join(", ")}.`;
  }

  // query_player_state
  if (intent === "query_player_state") {
    return "Assistant returned player state results.";
  }

  // clear_tasks
  if (intent === "clear_tasks") {
    const count = entities.cancelled_count ?? "all";
    return `Assistant cleared ${count} tasks.`;
  }

  // remove_task
  if (intent === "remove_task") {
    if (outcome === "success" || outcome === "ok") {
      const title = entities.task_title ? `'${entities.task_title}'` : "task";
      return `Assistant cancelled task ${title}.`;
    }
    return "Assistant couldn't find that task — clarification requested.";
  }

  // add_task / complete_task / reschedule_task — success path
  const tool     = entities.tool  ?? intent;
  const title    = entities.task_title ?? entities.title ?? "";
  const xpPart   = entities.xp   != null ? ` XP+${entities.xp}`   : "";
  const goldPart = entities.gold != null ? ` Gold+${entities.gold}` : "";
  const reward   = (xpPart || goldPart) ? ` —${xpPart}${goldPart}` : "";
  return `Assistant ${tool}${title ? " '" + title + "'" : ""}${reward}.`.trim();
}

/**
 * Pull the last N messages and format as Groq history array.
 */
export async function assembleContext(conversationId) {
  const { data, error } = await supabase
    .from("messages")
    .select("role, summary_json, created_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(CONTEXT_WINDOW * 2);

  if (error) throw new Error(`Failed to fetch context: ${error.message}`);
  if (!data || data.length === 0) return [];

  return data
    .reverse()
    .map((row) => {
      const s = typeof row.summary_json === "string"
        ? JSON.parse(row.summary_json)
        : row.summary_json;
      return {
        role:    row.role === "assistant" ? "assistant" : "user",
        content: renderSummaryAsText(s),
      };
    });
}

// ─────────────────────────────────────────────
// Summary helpers
// ─────────────────────────────────────────────

export function buildUserSummary(rawMessage, intent = "unknown", entities = {}) {
  return {
    role:        "user",
    intent,
    entities,
    outcome:     "received",
    raw_preview: rawMessage.slice(0, 120),
    timestamp:   new Date().toISOString(),
  };
}

export function buildAssistantSummary(intent, entities = {}, outcome = "ok") {
  return {
    role:      "assistant",
    intent,
    entities,
    outcome,
    timestamp: new Date().toISOString(),
  };
}
