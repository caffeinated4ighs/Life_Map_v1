# Life Map — Frontend Developer Agent Brief

## READ THIS FIRST — MANDATORY

Before writing a single line of code or choosing a single colour, you must consult the user on the questions in the **Design Consultation** section below. Do not assume. Do not proceed with defaults. The user has a specific vision for this product and strong opinions about tone. Ask first, build second.

---

## What This Project Is

Life Map is a personal RPG-style life management system. The user talks to an AI secretary in plain English to manage tasks, track XP/gold/stats, and stay on track. The game mechanics are real — XP is earned, gold accumulates, stats grow. The tone is casual, direct, and personal. It is a single-user system.

The backend API is fully live in production. Your job is to build a UI on top of it.

---

## Design Consultation — Ask These Before Building

Present these questions to the user and wait for answers before proceeding. Do not pick defaults.

### 1. Interface style
What feel does this need to have?
- Clean and minimal (think Notion / Linear — functional, no game chrome)
- RPG-themed (dark UI, pixel fonts, health bars, gold coin icons)
- Something in between — modern but with subtle RPG flavour
- Something else entirely — describe it

### 2. Primary use pattern
How will they mainly use this?
- Type messages in a chat box (conversational, like the current API)
- See a dashboard with task lists, stats panels, buttons to act
- Both — chat on one side, live dashboard on the other
- Mobile-first (phone), tablet, or desktop?

### 3. What data to surface
Which of these panels matter most? (rank or select)
- Today's task list with status
- Player stats (XP, gold, level, streak)
- RPG stats (Strength, Vitality, etc.)
- Active effects/buffs
- Quick-add task form
- Task history / completed tasks

### 4. Actions via UI vs chat
Should the UI have buttons (e.g. "Complete", "Remove" next to each task), or should all actions go through the chat input, or both?

### 5. Tech stack preference
- Plain HTML/CSS/JS (no framework)
- React
- Vue
- Something else

### 6. Tone of the copy
- Casual and direct ("3 tasks left. Get moving.")
- Neutral and clean ("3 tasks remaining")
- Full RPG flavour ("3 quests await, adventurer")

---

## API Reference

**Base URL (production):** `https://lifemapv1-production.up.railway.app`

All requests are unauthenticated (single-user system, no login required at this stage).

---

### `GET /health`

Liveness check. Use this to show connection status in the UI.

```
GET /health
```

**Response:**
```json
{
  "status": "ok",
  "db": "connected",
  "timestamp": "2026-05-26T20:00:00.000Z"
}
```

---

### `POST /chat`

The main endpoint. Send any plain English message, get a plain English reply. This is the only endpoint the frontend needs for all user-initiated actions.

```
POST /chat
Content-Type: application/json
```

**Request body:**
```json
{
  "message": "add a task: finish the report by 5pm",
  "session_id": "optional-uuid"
}
```

- `message` — required. Plain English string. What the user typed.
- `session_id` — optional on first message. Required on all subsequent messages to maintain context. Always returned in the response — store it and send it back.

**Response:**
```json
{
  "reply": "Task added.",
  "session_id": "13538792-768a-4317-a06a-d9c543e2c7cb"
}
```

- `reply` — always a short plain English string. Display this to the user.
- `session_id` — store this in memory (or localStorage) and include it in every subsequent request.

**Important:** There is no login, no user token, no auth header required. Session continuity is handled entirely via `session_id`.

---

## What the LLM Understands

The AI understands natural language for all of the following actions. You do not need to build separate API calls for each — everything goes through `POST /chat`.

| User says something like... | What happens |
|-----------------------------|-------------|
| "add a task: go for a run" | Task created, XP/gold computed |
| "I finished the report" | Task marked Done, XP + gold awarded |
| "remove the gym task" | Task soft-deleted (Cancelled), no XP |
| "push my dentist appointment to Friday" | Task rescheduled |
| "what do I have today" | Returns today's open tasks + player snapshot |
| "how are my stats" | Returns level, XP, gold, streak, all 8 RPG stats |
| "I walked 8000 steps" | Logs a steps event |
| "had a few drinks tonight" | Logs a substance event |
| "took the day off" | Logs a day_off event |

The LLM resolves ambiguity from context. If the user says "remove that task" after discussing a specific task, it knows which one. You do not need to track this — the `session_id` handles it.

---

## Data Available to Display

If you want to show live data panels (stats, task lists, etc.) rather than just a chat interface, you can trigger queries by sending messages through `/chat`:

| To get... | Send this message |
|-----------|------------------|
| Today's tasks | `"list today's tasks"` |
| Player state (XP, gold, level, streak, stats) | `"show my stats"` |

The reply will be a plain English summary (e.g. "3 tasks open: run, report, dentist."). If you need structured data for rendering a dashboard, this is a limitation of the current API — it returns text, not JSON data objects.

**Design implication:** If you want to render structured panels (a task list with checkboxes, a stat bar for XP progress), you have two options:

1. **Parse the reply text** — fragile, not recommended.
2. **Request a structured data endpoint** — raise this with the Manager/backend. A `GET /state` endpoint returning structured JSON could be added. Do not implement this yourself — flag it as a requirement.

---

## Session Management

Store `session_id` in memory for the duration of the browser session. On page refresh, a new conversation starts (new `session_id`). This is expected behaviour — the API is conversational, not persistent-login.

If you want to persist the session across refreshes, store `session_id` in `localStorage` and send it on the first message. The backend will verify it exists and reuse it if valid.

```javascript
// Example session handling
const storedSession = localStorage.getItem('lifemap_session_id');

const response = await fetch('https://lifemapv1-production.up.railway.app/chat', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    message: userInput,
    session_id: storedSession ?? undefined
  })
});

const data = await response.json();
localStorage.setItem('lifemap_session_id', data.session_id);
displayReply(data.reply);
```

---

## Error Handling

The API returns HTTP 200 for all successful responses. Error cases:

| Status | Meaning | How to handle |
|--------|---------|--------------|
| 200 | Success | Display `reply` field |
| 400 | Empty or invalid message | Show "Please type a message" |
| 500 | Server error | Show "Something went wrong, try again" |
| 503 | DB unreachable (`/health`) | Show connection warning |

The `reply` field may also contain a clarification request from the LLM (e.g. "Which task do you mean? Give me a name."). These come back as 200 — just display them as normal replies.

---

## What Does NOT Exist Yet (Do Not Build Around These)

- No `GET /tasks` endpoint returning structured JSON task arrays
- No `GET /player` endpoint returning structured player state JSON
- No authentication or user accounts
- No WebSocket or real-time push — polling only if you need live updates
- No file upload
- No `/shop` endpoint
- No image assets or icons provided by the backend

If any of these are needed for the design the user wants, raise them with the Manager before building. They can be added as backend tasks.

---

## Constraints

- Single user — no login screen needed
- Mobile or desktop depending on user preference (ask in consultation)
- The API reply is always short plain English — design the UI to display short strings, not paragraphs
- CONTEXT_WINDOW is currently 3 (may be raised to 5) — the LLM remembers the last 3 exchanges, not the full session history. If you display a chat log, you are maintaining that display yourself — the backend does not return history
- CORS: confirm with Manager if the Railway deployment needs CORS headers added before a browser-based frontend can call it. This will likely be needed.

---

## CORS Note — Flag Before Building

The current API does not explicitly set CORS headers. A browser-based frontend on a different domain will be blocked by the browser. Before writing any fetch calls, raise this with the Manager:

> "The frontend will be hosted at [domain]. The API needs `Access-Control-Allow-Origin` set for that domain. Can the backend agent add CORS middleware to server.js?"

This is a one-line fix (`npm install cors` + `app.use(cors())`) but must be done on the backend before the frontend can make requests.

---

## Summary Checklist Before First Commit

- [ ] Design consultation complete — user has answered all 6 questions
- [ ] CORS requirement raised with Manager and confirmed resolved
- [ ] Session handling implemented (store + resend `session_id`)
- [ ] `/health` check on load to show connection status
- [ ] Error states handled (400, 500, 503)
- [ ] Structured data endpoint decision made (text-only vs new backend endpoint)
- [ ] Deployment target decided (where will the frontend be hosted?)
