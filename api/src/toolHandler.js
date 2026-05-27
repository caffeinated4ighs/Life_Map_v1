/**
 * toolHandler.js
 * --------------
 * Validates LLM tool calls and dispatches to Logic Agent → DB Agent.
 *
 * Updated:  TASK-20260526-011/012 — stubs replaced with real agents
 *           TASK-20260526-023 — callDbAgent stub removed
 *           TASK-20260526-028 — remove_task guard added
 *           TASK-20260527-003 — clear_tasks registered (no special guard needed)
 */

import { VALID_TOOL_NAMES } from "../groq_tool_spec.js";
import { callLogicAgent } from "./logicAgent.js";
import { callDbAgent } from "./dbAgent.js";

// ─────────────────────────────────────────────
// Arg guards
// ─────────────────────────────────────────────

function sanitizeAddTask(args) {
  const sanitized = { ...args };
  if (sanitized.xp != null) {
    console.warn("[toolHandler] add_task: stripping LLM-provided xp — Logic Agent computes.");
    sanitized.xp = null;
  }
  if (sanitized.gold != null) {
    console.warn("[toolHandler] add_task: stripping LLM-provided gold — Logic Agent computes.");
    sanitized.gold = null;
  }
  return sanitized;
}

function validateCompleteTask(args) {
  if (!args.task_id && !args.task_title) {
    return { valid: false, error: "complete_task requires task_id or task_title." };
  }
  return { valid: true, error: null };
}

function validateRemoveTask(args) {
  if (!args.task_id && !args.task_title) {
    return { valid: false, error: "remove_task requires task_id or task_title." };
  }
  return { valid: true, error: null };
}

// clear_tasks needs no validation — scope defaults to "all" in Logic Agent if missing.

// ─────────────────────────────────────────────
// Main dispatch
// ─────────────────────────────────────────────

export async function handleToolCall(toolName, toolArgs) {
  if (!VALID_TOOL_NAMES.includes(toolName)) {
    console.error(`[toolHandler] Unknown tool: "${toolName}"`);
    return { success: false, result: { error: `Unknown tool: ${toolName}` } };
  }

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
        clarification: "Which task did you complete? Give me a name.",
      };
    }
  }

  if (toolName === "remove_task") {
    const check = validateRemoveTask(args);
    if (!check.valid) {
      return {
        success: false,
        result: { error: check.error },
        clarification: "Which task do you want to remove? Give me a name.",
      };
    }
  }

  let logicResult;
  try {
    logicResult = await callLogicAgent(toolName, args);
  } catch (err) {
    console.error("[toolHandler] Logic Agent error:", err);
    return { success: false, result: { error: `Logic Agent error: ${err.message}` } };
  }

  if (logicResult.needsClarification) {
    return {
      success: false,
      result: { needsClarification: true },
      clarification: logicResult.casualPrompt ?? "Could you give me a bit more detail?",
    };
  }

  let dbResult;
  try {
    dbResult = await callDbAgent(logicResult);
  } catch (err) {
    console.error("[toolHandler] DB Agent error:", err);
    return { success: false, result: { error: `DB Agent error: ${err.message}` } };
  }

  return { success: dbResult.success, result: dbResult };
}
