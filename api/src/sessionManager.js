/**
 * sessionManager.js
 * -----------------
 * Handles conversation lifecycle and message persistence.
 *
 * Owned by: Chat API Agent
 * Writes to: conversations, messages (Supabase)
 * Referenced by: server.js (POST /chat)
 *
 * Per AGENTS.md:
 *   - Each conversation = one row in `conversations`
 *   - Each exchange = one row in `messages` (summary JSON, NOT a transcript)
 *   - Context assembly = last N messages pulled before each Groq call
 *   - CONTEXT_WINDOW env var (default 5) controls N
 */

import { supabase } from "./supabaseClient.js";

const CONTEXT_WINDOW = parseInt(process.env.CONTEXT_WINDOW ?? "5", 10);

// ─────────────────────────────────────────────
// Conversation management
// ─────────────────────────────────────────────

/**
 * Create a new conversation row and return its ID.
 * Called when POST /chat receives a message with no session_id.
 *
 * @returns {Promise<string>} New conversation UUID
 */
export async function createConversation() {
  const { data, error } = await supabase
    .from("conversations")
    .insert({ started_at: new Date().toISOString() })
    .select("id")
    .single();

  if (error) throw new Error(`Failed to create conversation: ${error.message}`);
  return data.id;
}

/**
 * Verify a conversation exists. Returns true/false.
 * Used to guard against spoofed or stale session_ids.
 *
 * @param {string} conversationId
 * @returns {Promise<boolean>}
 */
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

/**
 * Insert a message summary row into `messages`.
 *
 * summary_json schema (per AGENTS.md):
 * {
 *   role:      "user" | "assistant",
 *   intent:    string (e.g. "add_task", "complete_task", "chitchat"),
 *   entities:  object (resolved IDs, dates, task names, etc.),
 *   outcome:   string (e.g. "task created", "clarification needed"),
 *   timestamp: ISO8601 string
 * }
 *
 * @param {string} conversationId
 * @param {object} summaryJson
 * @returns {Promise<void>}
 */
export async function insertMessage(conversationId, summaryJson) {
  const { error } = await supabase.from("messages").insert({
    conversation_id: conversationId,
    role: summaryJson.role,
    summary_json: summaryJson,
    created_at: summaryJson.timestamp ?? new Date().toISOString(),
  });

  if (error) throw new Error(`Failed to insert message: ${error.message}`);
}

// ─────────────────────────────────────────────
// Context assembly
// ─────────────────────────────────────────────

/**
 * Render a summary_json row as a plain English string for Groq history.
 * No JSON serialisation — content must be readable by the LLM as natural language.
 *
 * User patterns (keyed on intent):
 *   add_task:      "User asked to add task: [raw_preview]"
 *   complete_task: "User completed a task: [raw_preview]"
 *   remove_task:   "User asked to remove a task: [raw_preview]"
 *   chitchat:      "User said: [raw_preview]"
 *   unknown / *:   "User said: [raw_preview]"
 *
 * Assistant patterns (keyed on intent + outcome):
 *   tool + success:              "Assistant [tool] '[task_title]' — XP+[xp] Gold+[gold]"
 *   remove_task + success:       "Assistant cancelled task '[task_title]'."
 *   remove_task + error:         "Assistant couldn't find that task — clarification requested."
 *   chitchat:                    "Assistant replied conversationally."
 *   * + clarification/error:     "Assistant couldn't complete [tool] — clarification requested."
 *   query tools:                 "Assistant returned [tool] results."
 *
 * @param {object} s - Parsed summary_json object
 * @returns {string}
 */
function renderSummaryAsText(s) {
  const preview = s.raw_preview ?? "";
  const intent = s.intent ?? "unknown";
  const outcome = s.outcome ?? "ok";
  const entities = s.entities ?? {};

  if (s.role === "user") {
    switch (intent) {
      case "add_task":
        return `User asked to add task: ${preview}`;
      case "complete_task":
        return `User completed a task: ${preview}`;
      case "remove_task":
        return `User asked to remove a task: ${preview}`;
      case "chitchat":
        return `User said: ${preview}`;
      default:
        return `User said: ${preview}`;
    }
  }

  // assistant role
  if (intent === "chitchat") {
    return "Assistant replied conversationally.";
  }

  // remove_task — separate success and error paths
  if (intent === "remove_task") {
    if (outcome === "success" || outcome === "ok") {
      const title = entities.task_title ? `'${entities.task_title}'` : "task";
      return `Assistant cancelled task ${title}.`;
    }
    return "Assistant couldn't find that task — clarification requested.";
  }

  if (outcome === "clarification needed" || outcome === "tool_error") {
    return `Assistant couldn't complete ${intent} — clarification requested.`;
  }

  const queryTools = ["query_today", "query_player_state"];
  if (queryTools.includes(intent)) {
    return `Assistant returned ${intent} results.`;
  }

  // success path — tool action with reward info
  const tool = entities.tool ?? intent;
  const title = entities.task_title ? `'${entities.task_title}'` : "";
  const xpPart = entities.xp != null ? ` XP+${entities.xp}` : "";
  const goldPart = entities.gold != null ? ` Gold+${entities.gold}` : "";
  const rewardPart = (xpPart || goldPart) ? ` —${xpPart}${goldPart}` : "";
  return `Assistant ${tool}${title ? " " + title : ""}${rewardPart}`.trim();
}

/**
 * Pull the last N messages for a conversation and format them
 * as the history array expected by groqClient.callGroq.
 *
 * Returns an array of { role: "user"|"assistant", content: string }
 * where content is a plain English description of each exchange.
 * No JSON serialisation — keeps context readable for the LLM.
 *
 * @param {string} conversationId
 * @returns {Promise<Array<{ role: string, content: string }>>}
 */
export async function assembleContext(conversationId) {
  const { data, error } = await supabase
    .from("messages")
    .select("role, summary_json, created_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(CONTEXT_WINDOW * 2); // fetch both sides of each exchange

  if (error) throw new Error(`Failed to fetch context: ${error.message}`);
  if (!data || data.length === 0) return [];

  // Reverse to chronological order for the LLM
  return data
    .reverse()
    .map((row) => {
      const s =
        typeof row.summary_json === "string"
          ? JSON.parse(row.summary_json)
          : row.summary_json;

      return {
        role: row.role === "assistant" ? "assistant" : "user",
        content: renderSummaryAsText(s),
      };
    });
}

// ─────────────────────────────────────────────
// Summary helpers
// ─────────────────────────────────────────────

/**
 * Build a summary_json object for a user turn.
 *
 * @param {string} rawMessage   - Raw user message text
 * @param {string} [intent]     - Detected intent (filled after tool resolution)
 * @param {object} [entities]   - Resolved entities (filled after tool resolution)
 * @returns {object}
 */
export function buildUserSummary(rawMessage, intent = "unknown", entities = {}) {
  return {
    role: "user",
    intent,
    entities,
    outcome: "received",
    raw_preview: rawMessage.slice(0, 120), // Lean preview only — not a transcript
    timestamp: new Date().toISOString(),
  };
}

/**
 * Build a summary_json object for an assistant turn.
 *
 * @param {string} intent       - Tool name or "chitchat"
 * @param {object} entities     - Entities resolved during this turn
 * @param {string} outcome      - e.g. "task created", "clarification needed", "query returned"
 * @returns {object}
 */
export function buildAssistantSummary(intent, entities = {}, outcome = "ok") {
  return {
    role: "assistant",
    intent,
    entities,
    outcome,
    timestamp: new Date().toISOString(),
  };
}
