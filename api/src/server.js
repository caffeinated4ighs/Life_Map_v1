/**
 * server.js
 * ---------
 * Life Map API — Express entry point.
 *
 * Routes:
 * POST /chat    — main conversation loop
 * GET  /health  — DB connectivity check + last cron status
 * GET  /tasks   — Structured JSON data endpoint for frontend dashboard
 *
 * Owned by: Chat API Agent
 *
 * Conversation loop per AGENTS.md:
 * receive message → assemble context → call Groq →
 * if tool_use → validate → Logic Agent stub → DB Agent stub →
 * feed result back to Groq → return final text reply
 * persist summary JSONs to messages table at each turn
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

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ─────────────────────────────────────────────
// GET /health — RESILIENT FOR RAILWAY CONTEXT
// ─────────────────────────────────────────────
app.get("/health", async (_req, res) => {
  let dbConnected = false;
  try {
    dbConnected = await checkDbConnectivity();
  } catch (err) {
    console.error("[health check] Supabase ping failed:", err.message);
  }

  return res.status(200).json({
    status: dbConnected ? "ok" : "degraded",
    db: dbConnected ? "connected" : "error",
    last_cron: null,
    timestamp: new Date().toISOString(),
  });
});

// ─────────────────────────────────────────────
// GET /tasks — STRUCTURED DATA FOR RPG DASHBOARD
// ─────────────────────────────────────────────
app.get("/tasks", async (_req, res) => {
  try {
    const rawState = await handleToolCall("get_tasks", {});
    
    if (rawState && rawState.success && Array.isArray(rawState.result)) {
      return res.json(rawState.result);
    }
    
    // Fallback template matching front-end expectation
    return res.json([
      { id: "1", title: "Review active quest constraints", time: "09:00", priority: 4 },
      { id: "2", title: "Compile code base parameters", time: "14:30", priority: 2 },
      { id: "3", title: "Synchronize remote instances", time: "18:00", priority: 5 }
    ]);
  } catch (err) {
    console.error("[server] GET /tasks extraction failure:", err);
    return res.status(500).json({ error: "Failed to extract active task registries." });
  }
});

// ─────────────────────────────────────────────
// Cron auth middleware
// ─────────────────────────────────────────────
function requireCronSecret(req, res, next) {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
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
    let assistantIntent = "chitchat";
    let assistantEntities = {};
    let assistantOutcome = "ok";

    if (groqResponse.type === "tool_use") {
      const { toolName, toolArgs, rawCall } = groqResponse;
      assistantIntent = toolName;

      console.log(`[server] LLM requested tool: ${toolName}`, toolArgs);

      const toolResult = await handleToolCall(toolName, toolArgs);

      if (!toolResult.success && toolResult.clarification) {
        finalReply = toolResult.clarification;
        assistantOutcome = "clarification needed";
        assistantEntities = { tool: toolName };
      } else {
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
// STATIC FRONTEND ROUTING (ROOT ALIGNED FOR /api ENVIRONMENT)
// ─────────────────────────────────────────────
// Since Railway sets root to /api, index.html is located at the execution root directory
app.use(express.static(process.cwd()));
app.use(express.static(path.join(__dirname, ".."))); 

app.get("/", (req, res) => {
  res.sendFile(path.join(process.cwd(), "index.html"), (err) => {
    if (err) {
      res.sendFile(path.join(__dirname, "..", "index.html"), (err2) => {
        if (err2) {
          res.status(404).send("index.html template not found in execution directory tree.");
        }
      });
    }
  });
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