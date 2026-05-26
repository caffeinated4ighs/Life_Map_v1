/**
 * groqClient.js
 * -------------
 * Groq API wrapper: call, parse response blocks, retry on transient errors.
 *
 * Owned by: Chat API Agent
 * Referenced by: server.js (POST /chat)
 *
 * Uses groq-sdk under the hood but exposes a thin interface so the caller
 * never touches the SDK directly — swap-friendly if Groq changes API shape.
 */

import Groq from "groq-sdk";
import { GROQ_TOOLS } from "../groq_tool_spec.js";

const GROQ_MODEL = process.env.GROQ_MODEL_PRIMARY || "llama-4-scout-17b-16e-instruct";
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

/**
 * Sleep helper for retry backoff.
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Call the Groq chat completions endpoint.
 *
 * @param {object} params
 * @param {string} params.systemPrompt   - System prompt string (hard cap ~350 tokens per AGENTS.md)
 * @param {Array}  params.history        - Array of {role, content} objects (assembled from last N messages)
 * @param {string} params.userMessage    - The current user message (raw string)
 * @returns {Promise<GroqResponse>}      - Parsed response object (see parseGroqResponse)
 */
export async function callGroq({ systemPrompt, history, userMessage }) {
  const messages = [
    { role: "system", content: systemPrompt },
    ...history,
    { role: "user", content: userMessage },
  ];

  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const completion = await groq.chat.completions.create({
        model: GROQ_MODEL,
        messages,
        tools: GROQ_TOOLS,
        tool_choice: "auto",
        max_tokens: 1024,
        temperature: 0.3, // Lower = more predictable tool call behaviour
      });

      return parseGroqResponse(completion);
    } catch (err) {
      lastError = err;
      const isTransient =
        err?.status === 429 || err?.status === 500 || err?.status === 503;
      if (!isTransient || attempt === MAX_RETRIES) break;
      console.warn(
        `[groqClient] Transient error (attempt ${attempt}/${MAX_RETRIES}): ${err.message}. Retrying in ${RETRY_DELAY_MS * attempt}ms...`
      );
      await sleep(RETRY_DELAY_MS * attempt);
    }
  }

  throw new Error(`Groq API call failed after ${MAX_RETRIES} attempts: ${lastError?.message}`);
}

/**
 * Parse a Groq completion response into a normalised shape.
 *
 * Returns one of:
 *   { type: "text",     content: string }
 *   { type: "tool_use", toolName: string, toolArgs: object, rawCall: object }
 *
 * Groq surfaces tool calls in choices[0].message.tool_calls array.
 * We handle only the first tool call per turn (one tool per loop iteration per AGENTS.md).
 */
function parseGroqResponse(completion) {
  const message = completion.choices?.[0]?.message;

  if (!message) {
    throw new Error("Groq returned an empty choices array.");
  }

  // Tool call response
  if (message.tool_calls?.length > 0) {
    const call = message.tool_calls[0];
    let toolArgs;
    try {
      toolArgs = JSON.parse(call.function.arguments);
    } catch {
      throw new Error(
        `Groq tool call arguments are not valid JSON: ${call.function.arguments}`
      );
    }
    return {
      type: "tool_use",
      toolName: call.function.name,
      toolArgs,
      rawCall: call,
    };
  }

  // Plain text response
  return {
    type: "text",
    content: message.content ?? "",
  };
}

/**
 * Second-pass Groq call: feed tool result back for final reply.
 * Called after DB Agent stub returns a result.
 *
 * @param {object} params
 * @param {string} params.systemPrompt
 * @param {Array}  params.history
 * @param {string} params.userMessage
 * @param {object} params.toolCall        - rawCall from first pass
 * @param {object} params.toolResult      - Result object from DB Agent stub
 * @returns {Promise<{ type: "text", content: string }>}
 */
export async function callGroqWithToolResult({
  systemPrompt,
  history,
  userMessage,
  toolCall,
  toolResult,
}) {
  // Slice to last 2 exchanges (4 rows = 2 user + 2 assistant turns at CONTEXT_WINDOW*2 storage)
  const recentHistory = history.slice(-4);

  const messages = [
    { role: "system", content: systemPrompt },
    ...recentHistory,
    { role: "user", content: userMessage },
    // Groq expects the assistant message containing the tool_calls first
    {
      role: "assistant",
      content: null,
      tool_calls: [toolCall],
    },
    // Then the tool result
    {
      role: "tool",
      tool_call_id: toolCall.id,
      content: JSON.stringify(toolResult),
    },
  ];

  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const completion = await groq.chat.completions.create({
        model: GROQ_MODEL,
        messages,
        max_tokens: 1024,
        temperature: 0.3,
        // No tools on second pass — we want a final text reply
      });

      const message = completion.choices?.[0]?.message;
      return {
        type: "text",
        content: message?.content ?? "",
      };
    } catch (err) {
      lastError = err;
      const isTransient =
        err?.status === 429 || err?.status === 500 || err?.status === 503;
      if (!isTransient || attempt === MAX_RETRIES) break;
      await sleep(RETRY_DELAY_MS * attempt);
    }
  }

  throw new Error(
    `Groq API (tool result pass) failed after ${MAX_RETRIES} attempts: ${lastError?.message}`
  );
}
