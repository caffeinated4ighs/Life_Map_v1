/**
 * server.js
 * ---------
 * Life Map API — Express entry point.
 *
 * Routes:
 *   POST /chat    — main conversation loop
 *   GET  /health  — DB connectivity check + last cron status
 *
 * Owned by: Chat API Agent
 *
 * Conversation loop per AGENTS.md:
 *   receive message → assemble context → call Groq →
 *   if tool_use → validate → Logic Agent stub → DB Agent stub →
 *   feed result back to Groq → return final text reply
 *   persist summary JSONs to messages table at each turn
 */

import "dotenv/config";
import express from "express";
import { checkDbConnectivity } from "./supabaseClient.js";
import {
  assembleContext,
  buildAssistantSummary,
  buildUserSummary,
  conversationExists,
  createConversation,
  insertMessage,
} from "./sessionManager.js"; 
import { callGroq, callGroqWithToolResult } from "./groqClient.js";
import { handleToolCall } from "./toolHandler.js";
// ─────────────────────────────────────────────
// INSERT THESE TWO LINES HERE
// ─────────────────────────────────────────────
import path from "path";
import cors from "cors";
import { fileURLToPath } from "url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─────────────────────────────────────────────
// System prompt placeholder
// TODO: replace with versioned prompt from Prompt Engineer Agent
// Hard cap: ~350 tokens per AGENTS.md
// ─────────────────────────────────────────────
const SYSTEM_PROMPT = `You are a casual RPG task manager secretary. Use tools to manage tasks and answer questions. Always reply in plain conversational English — never output JSON or structured data in your replies, very short replies (example -> task added/deleted/completed).`
const app = express();
//-------------
app.use(cors());
//============
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ─────────────────────────────────────────────
// GET /health
// ─────────────────────────────────────────────
app.get("/health", async (_req, res) => {
  const dbConnected = await checkDbConnectivity();
  res.status(dbConnected ? 200 : 503).json({
    status: dbConnected ? "ok" : "degraded",
    db: dbConnected ? "connected" : "error",
    last_cron: null, // TODO: read from day_snapshots or cron log once Cron Agent is live
    timestamp: new Date().toISOString(),
  });
});

// ─────────────────────────────────────────────
// ─────────────────────────────────────────────
// Cron auth middleware
// Validates x-cron-secret header against SUPABASE_SERVICE_ROLE_KEY.
// Applied to /cron/* routes only — NOT to /health (health ping is unauthenticated).
// ─────────────────────────────────────────────
function requireCronSecret(req, res, next) {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const provided = req.headers["x-cron-secret"];
  if (!provided || provided !== secret) {
    return res.status(401).json({ error: "Unauthorized — invalid or missing x-cron-secret." });
  }
  next();
}

// ─────────────────────────────────────────────
// POST /cron/morning
// Called by good_morning.yml GitHub Actions workflow at 12:00 UTC (7am EST).
// Triggers: carry-over logic, effect expiry, skill decay checks, arc pressure escalation,
// day_snapshots open record, morning briefing message row.
// ─────────────────────────────────────────────
app.post("/cron/morning", requireCronSecret, async (_req, res) => {
  // TODO: implement morning cron logic via Logic Agent + DB Agent
  //   - Create day_snapshots open record (mh_score_open, gold_open from player_state)
  //   - Carry over overdue tasks (check late_rule, apply penalty modifier if carry_over_penalty)
  //   - Expire effects where expires_on < today
  //   - Flag skills for decay where last_active + decay_threshold < today
  //   - Escalate arc weight if end_date within 7 days (Logic Agent decides)
  //   - Insert morning briefing as messages row with role: "system"
  //   - Idempotency: check day_snapshots for existing open record before writing
  console.log("[server] /cron/morning triggered at", new Date().toISOString());
  return res.status(200).json({ status: "ok", message: "stub — not yet implemented" });
});

// ─────────────────────────────────────────────
// POST /cron/eod
// Called by eod.yml GitHub Actions workflow at 04:00 UTC (11pm EST).
// Triggers: streak evaluation, day_snapshots close record, arc XP multipliers.
// ─────────────────────────────────────────────
app.post("/cron/eod", requireCronSecret, async (_req, res) => {
  // TODO: implement EOD cron logic via Logic Agent + DB Agent
  //   - Pull all tasks for today, compute: completed count, mandatory_met boolean, XP earned, gold earned
  //   - Run streak evaluation via Logic Agent -> update streak_log + player_state streak
  //   - Close day_snapshots: write mh_score_close, gold_close, xp_earned
  //   - Apply arc XP multipliers to completed arc tasks
  //   - No LLM calls — all deterministic rules per AGENTS.md
  console.log("[server] /cron/eod triggered at", new Date().toISOString());
  return res.status(200).json({ status: "ok", message: "stub — not yet implemented" });
});

// POST /chat
// Body: { session_id?: string, message: string }
// Returns: { reply: string, session_id: string }
// ─────────────────────────────────────────────
app.post("/chat", async (req, res) => {
  const { message, session_id: incomingSessionId } = req.body;

  // Validate request
  if (!message || typeof message !== "string" || message.trim() === "") {
    return res.status(400).json({ error: "message is required and must be a non-empty string." });
  }

  let sessionId = incomingSessionId ?? null;

  try {
    // 1. Session resolution
    if (sessionId) {
      const exists = await conversationExists(sessionId);
      if (!exists) {
        console.warn(`[server] session_id "${sessionId}" not found — creating new conversation.`);
        sessionId = null;
      }
    }
    if (!sessionId) {
      sessionId = await createConversation();
    }

    // 2. Persist user message summary (intent resolved after tool call — updated below)
    const userSummary = buildUserSummary(message);
    await insertMessage(sessionId, userSummary);

    // 3. Assemble context (last N exchanges)
    const history = await assembleContext(sessionId);

    // 4. First Groq call
    const groqResponse = await callGroq({
      systemPrompt: SYSTEM_PROMPT,
      history,
      userMessage: message,
    });

    let finalReply;
    let assistantIntent = "chitchat";
    let assistantEntities = {};
    let assistantOutcome = "ok";

    // 5. Tool call branch
    if (groqResponse.type === "tool_use") {
      const { toolName, toolArgs, rawCall } = groqResponse;
      assistantIntent = toolName;

      console.log(`[server] LLM requested tool: ${toolName}`, toolArgs);

      // 5a. Validate + dispatch to Logic Agent stub → DB Agent stub
      const toolResult = await handleToolCall(toolName, toolArgs);

      if (!toolResult.success && toolResult.clarification) {
        // Clarification needed — surface casual prompt directly without Groq second pass
        finalReply = toolResult.clarification;
        assistantOutcome = "clarification needed";
        assistantEntities = { tool: toolName };
      } else {
        // 5b. Feed tool result back to Groq for final natural language reply
        const secondPass = await callGroqWithToolResult({
          systemPrompt: SYSTEM_PROMPT,
          history,
          userMessage: message,
          toolCall: rawCall,
          toolResult: toolResult.result,
        });

        finalReply = secondPass.content;
        assistantOutcome = toolResult.success ? "success" : "tool_error";
        assistantEntities = {
          tool: toolName,
          success: toolResult.success,
          ...(toolArgs.task_id ? { task_id: toolArgs.task_id } : {}),
          ...(toolArgs.task_title ? { task_title: toolArgs.task_title } : {}),
          ...(toolArgs.date ? { date: toolArgs.date } : {}),
        };
      }
    } else {
      // Plain text reply — no tool call
      finalReply = groqResponse.content;
    }

    // 6. Persist assistant summary
    const assistantSummary = buildAssistantSummary(
      assistantIntent,
      assistantEntities,
      assistantOutcome
    );
    await insertMessage(sessionId, assistantSummary);

    // 7. Return
    return res.json({ reply: finalReply, session_id: sessionId });

  } catch (err) {
    console.error("[server] POST /chat error:", err);
    return res.status(500).json({
      error: "Internal server error. Please try again.",
      detail: process.env.NODE_ENV === "development" ? err.message : undefined,
    });
  }
});
//--------------------
app.use(express.static(path.join(__dirname, "api")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "api", "index.html"));
});
//-------------------
// ─────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[server] Life Map API running on port ${PORT}`);
  console.log(`[server] Model: ${process.env.GROQ_MODEL_PRIMARY ?? "llama-4-scout-17b-16e-instruct"}`);
  console.log(`[server] Context window: ${process.env.CONTEXT_WINDOW ?? 5} exchanges`);
});

export default app;
