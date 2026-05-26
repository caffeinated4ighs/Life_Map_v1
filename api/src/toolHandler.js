/**
 * toolHandler.js
 * --------------
 * Validates LLM tool calls and dispatches to Logic Agent → DB Agent.
 *
 * Owned by: Chat API Agent
 * Referenced by: server.js (POST /chat loop)
 * Updated:  TASK-20260526-011 + TASK-20260526-012 — stubs replaced with real agents
 *           TASK-20260526-023 — callDbAgent stub removed, real import wired
 *           TASK-20260526-028 — remove_task guard added (same pattern as complete_task)
 *
 * Pipeline per AGENTS.md:
 *   LLM returns tool_use → validate name → enforce arg guards →
 *   Logic Agent (normalise + compute rewards) → DB Agent (Supabase CRUD) →
 *   return result to caller for Groq second pass
 *
 * Design decisions enforced here (per Integration Agent / SUPERVISOR_LOG):
 *   - add_task:      xp and gold must be null (LLM must not freestyle reward values)
 *   - complete_task: task_id OR task_title required — reject if neither present
 *   - remove_task:   task_id OR task_title required — reject if neither present
 *   - All tool names validated against VALID_TOOL_NAMES whitelist
 */

import { VALID_TOOL_NAMES } from "../groq_tool_spec.js";
import { callLogicAgent } from "./logicAgent.js";
import { callDbAgent } from "./dbAgent.js";

// ─────────────────────────────────────────────
// Guard helpers
// ─────────────────────────────────────────────

/**
 * Enforce add_task constraints.
 * XP and gold must NOT be set by the LLM — Logic Agent computes them.
 * Nullify silently (don't reject — LLM might forget; just strip).
 */
function sanitizeAddTask(args) {
  const sanitized = { ...args };
  if (sanitized.xp != null) {
    console.warn("[toolHandler] add_task: LLM provided xp value — stripping. Logic Agent will compute.");
    sanitized.xp = null;
  }
  if (sanitized.gold != null) {
    console.warn("[toolHandler] add_task: LLM provided gold value — stripping. Logic Agent will compute.");
    sanitized.gold = null;
  }
  return sanitized;
}

/**
 * Enforce complete_task constraints.
 * At least one of task_id or task_title must be present.
 * Returns { valid: bool, error: string|null }.
 */
function validateCompleteTask(args) {
  if (!args.task_id && !args.task_title) {
    return {
      valid: false,
      error:
        "complete_task requires either task_id or task_title. Neither was provided by the LLM.",
    };
  }
  return { valid: true, error: null };
}

/**
 * Enforce remove_task constraints.
 * At least one of task_id or task_title must be present.
 * Returns { valid: bool, error: string|null }.
 */
function validateRemoveTask(args) {
  if (!args.task_id && !args.task_title) {
    return {
      valid: false,
      error:
        "remove_task requires either task_id or task_title. Neither was provided by the LLM.",
    };
  }
  return { valid: true, error: null };
}

// ─────────────────────────────────────────────
// Main dispatch
// ─────────────────────────────────────────────

/**
 * Handle a tool call returned by the LLM.
 *
 * @param {string} toolName   - Tool name from Groq response
 * @param {object} toolArgs   - Parsed arguments from Groq response
 * @returns {Promise<{ success: boolean, result: object, clarification?: string }>}
 */
export async function handleToolCall(toolName, toolArgs) {
  // 1. Validate tool name against whitelist
  if (!VALID_TOOL_NAMES.includes(toolName)) {
    console.error(`[toolHandler] Unknown tool name: "${toolName}". Rejecting.`);
    return {
      success: false,
      result: { error: `Unknown tool: ${toolName}` },
    };
  }

  // 2. Per-tool arg guards
  let args = { ...toolArgs };

  if (toolName === "add_task") {
    args = sanitizeAddTask(args);
  }

  if (toolName === "complete_task") {
    const check = validateCompleteTask(args);
    if (!check.valid) {
      return {
        success: false,
        result: { error: check.error },
        clarification:
          "Could you clarify which task you're completing? A task ID or name works.",
      };
    }
  }

  if (toolName === "remove_task") {
    const check = validateRemoveTask(args);
    if (!check.valid) {
      return {
        success: false,
        result: { error: check.error },
        clarification:
          "Could you clarify which task you want to remove? A task ID or name works.",
      };
    }
  }

  // 3. Logic Agent — normalisation, inference, reward computation
  let logicResult;
  try {
    logicResult = await callLogicAgent(toolName, args);
  } catch (err) {
    console.error("[toolHandler] Logic Agent error:", err);
    return { success: false, result: { error: `Logic Agent error: ${err.message}` } };
  }

  // 4. Check if Logic Agent needs clarification from user
  if (logicResult.needsClarification) {
    return {
      success: false,
      result: { needsClarification: true },
      clarification: logicResult.casualPrompt ?? "Could you give me a bit more detail on that?",
    };
  }

  // 5. DB Agent — real Supabase CRUD
  let dbResult;
  try {
    dbResult = await callDbAgent(logicResult);
  } catch (err) {
    console.error("[toolHandler] DB Agent error:", err);
    return { success: false, result: { error: `DB Agent error: ${err.message}` } };
  }

  return {
    success: dbResult.success,
    result: dbResult,
  };
}
