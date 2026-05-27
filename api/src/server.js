/**
 * server.js
 * ---------
 * Life Map API — Express entry point.
 * Updated: TASK-20260527-004 — added GET /state endpoint for dashboard polling.
 *          Dashboard must use /state, never /chat, to avoid polluting conversation context.
 */

import "dotenv/config";
import express from "express";
import { fileURLToPath } from "url";
import path from "path";
import { checkDbConnectivity, supabase } from "./supabaseClient.js";
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SYSTEM_PROMPT = `You are a casual RPG task manager secretary. Use tools to manage tasks and answer questions. Always reply in plain conversational English — never output JSON or structured data in your replies. Keep replies very short (e.g. "Task added.", "Done — calling mom cancelled.", "You've got 3 tasks open: calling mom (mandatory), wrap up project, send SSN email."). When asked about a specific task, always name it explicitly. Never say "Task Title" — use the actual task name from the tool result.`;

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

const PORT = process.env.PORT || 3000;

// ─────────────────────────────────────────────
// GET /health
// ─────────────────────────────────────────────
app.get("/health", async (_req, res) => {
  const dbConnected = await checkDbConnectivity();
  res.status(dbConnected ? 200 : 503).json({
    status: dbConnected ? "ok" : "degraded",
    db: dbConnected ? "connected" : "error",
    last_cron: null,
    timestamp: new Date().toISOString(),
  });
});

// ─────────────────────────────────────────────
// GET /state  — dashboard data endpoint
// Returns structured task list + player snapshot without touching any conversation.
// The frontend MUST use this for all display refreshes — never POST /chat for this.
// ─────────────────────────────────────────────
app.get("/state", async (_req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);

    const { data: tasks, error: tasksErr } = await supabase
      .from("tasks")
      .select("id, title, type, status, priority, date, xp, gold")
      .in("status", ["Pending", "Carried Over"])
      .order("date", { ascending: true });

    if (tasksErr) {
      return res.status(500).json({ error: `tasks query failed: ${tasksErr.message}` });
    }

    const { data: player, error: playerErr } = await supabase
      .from("player_state")
      .select("level, total_xp, gold, streak, xp_to_next_level, mh_score")
      .eq("id", 1)
      .single();

    if (playerErr) {
      return res.status(500).json({ error: `player_state query failed: ${playerErr.message}` });
    }

    return res.json({
      tasks: tasks ?? [],
      player: player ?? {},
      as_of: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[server] GET /state error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
});

// ─────────────────────────────────────────────
// Cron auth middleware
// ─────────────────────────────────────────────
function requireCronSecret(req, res, next) {
  const secret   = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const provided = req.headers["x-cron-secret"];
  if (!provided || provided !== secret) {
    return res.status(401).json({ error: "Unauthorized — invalid or missing x-cron-secret." });
  }
  next();
}

app.post("/cron/morning", requireCronSecret, async (_req, res) => {
  console.log("[server] /cron/morning triggered at", new Date().toISOString());
  return res.status(200).json({ status: "ok", message: "stub — not yet implemented" });
});

app.post("/cron/eod", requireCronSecret, async (_req, res) => {
  console.log("[server] /cron/eod triggered at", new Date().toISOString());
  return res.status(200).json({ status: "ok", message: "stub — not yet implemented" });
});

// ─────────────────────────────────────────────
// POST /chat
// ─────────────────────────────────────────────
app.post("/chat", async (req, res) => {
  const { message, session_id: incomingSessionId } = req.body;

  if (!message || typeof message !== "string" || message.trim() === "") {
    return res.status(400).json({ error: "message is required and must be a non-empty string." });
  }

  let sessionId = incomingSessionId ?? null;

  try {
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

    const userSummary = buildUserSummary(message);
    await insertMessage(sessionId, userSummary);

    const history = await assembleContext(sessionId);

    const groqResponse = await callGroq({
      systemPrompt: SYSTEM_PROMPT,
      history,
      userMessage: message,
    });

    let finalReply;
    let assistantIntent  = "chitchat";
    let assistantEntities = {};
    let assistantOutcome  = "ok";

    if (groqResponse.type === "tool_use") {
      const { toolName, toolArgs, rawCall } = groqResponse;
      assistantIntent = toolName;

      console.log(`[server] LLM requested tool: ${toolName}`, toolArgs);

      const toolResult = await handleToolCall(toolName, toolArgs);

      if (!toolResult.success && toolResult.clarification) {
        finalReply       = toolResult.clarification;
        assistantOutcome = "clarification needed";
        assistantEntities = { tool: toolName };
      } else {
        const secondPass = await callGroqWithToolResult({
          systemPrompt: SYSTEM_PROMPT,
          history,
          userMessage: message,
          toolCall:    rawCall,
          toolResult:  toolResult.result,
        });

        finalReply       = secondPass.content;
        assistantOutcome = toolResult.success ? "success" : "tool_error";

        // Store task titles in entities so follow-up questions can reference them
        const resultData = toolResult.result?.data ?? {};
        assistantEntities = {
          tool:    toolName,
          success: toolResult.success,
          // For query_today: persist task titles so "what's the mandatory task?" works
          ...(resultData.tasks     ? { tasks: resultData.tasks }               : {}),
          ...(resultData.task_title ? { task_title: resultData.task_title }     : {}),
          ...(resultData.title      ? { title: resultData.title }               : {}),
          ...(toolArgs.task_id      ? { task_id: toolArgs.task_id }             : {}),
          ...(toolArgs.date         ? { date: toolArgs.date }                   : {}),
        };
      }
    } else {
      finalReply = groqResponse.content;
    }

    const assistantSummary = buildAssistantSummary(
      assistantIntent,
      assistantEntities,
      assistantOutcome
    );
    await insertMessage(sessionId, assistantSummary);

    return res.json({ reply: finalReply, session_id: sessionId });

  } catch (err) {
    console.error("[server] POST /chat error:", err);
    return res.status(500).json({
      error: "Internal server error. Please try again.",
      detail: process.env.NODE_ENV === "development" ? err.message : undefined,
    });
  }
});

// ─────────────────────────────────────────────
// Static files + GET /
// ─────────────────────────────────────────────
app.use(express.static(path.join(__dirname, "..")));
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "index.html"));
});

// ─────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[server] Life Map API running on port ${PORT}`);
  console.log(`[server] Model: ${process.env.GROQ_MODEL_PRIMARY ?? "llama-4-scout-17b-16e-instruct"}`);
  console.log(`[server] Context window: ${process.env.CONTEXT_WINDOW ?? 5} exchanges`);
});

export default app;
