# doordash-bot

A local Express server that wraps [`dd-cli`](https://github.com/) with a Claude-driven conversational agent. Send it a natural-language utterance and it searches restaurants, checks menus, and builds a DoorDash cart on your behalf — over a single HTTP endpoint.

## What it does

`POST /api/order` runs a bounded tool-use loop where Claude (Haiku) decides which `dd-cli` commands to run, reads the results, and either asks a clarifying question or gives a final answer — all phrased as short, spoken-friendly sentences (this is designed to be read aloud by text-to-speech, e.g. from an iOS Shortcut).

Capabilities:
- Search restaurants near your saved DoorDash address
- Filter out closed restaurants and rank by rating / stated preference ("something quick", "highly rated")
- Look up menus and item details
- Build a cart (add items, handle required customizations, remove items, view cart + subtotal)
- Ask clarifying questions when a request is ambiguous (vague query, multiple item matches, required size/protein/modifier choices)
- Multi-turn conversations via a `session_id` — the agent remembers context across requests

**Hard limit, enforced in code (not just prompted):** the agent can never place, checkout, or submit an order. `dd-cli order *` and `dd-cli login` are blocked by an explicit allowlist before any command reaches the shell, regardless of what the model requests. If asked to check out, it responds with a cart summary and says checkout isn't enabled.

## Setup

```bash
npm install
```

Create a `.env` file in the project root:

```
ANTHROPIC_API_KEY=your-key-here
```

`dd-cli` must already be installed, authenticated, and on your `PATH`.

## Run it

```bash
npm start
```

Server listens on `http://localhost:3000`. On startup it pre-warms your default saved delivery address (via `dd-cli address list`) so the first real request doesn't pay for it.

## API

### `POST /api/order`

**Request body:**

```json
{
  "utterance": "find me a taco place",
  "session_id": "optional — omit on the first turn, reuse the returned one for follow-ups"
}
```

**Response:**

```json
{
  "message": "I found three taco places nearby — which one sounds good?",
  "needs_clarification": "true",
  "session_id": "generated-or-reused-uuid"
}
```

`needs_clarification` is returned as the **string** `"true"`/`"false"` (not a JSON boolean) — this is deliberate, to work around inconsistent boolean parsing in iOS Shortcuts. Sessions expire after 5 minutes of inactivity.

### Example: multi-turn cart-building conversation

```bash
# Turn 1 — search
curl -s -X POST http://localhost:3000/api/order -H "Content-Type: application/json" \
  -d '{"utterance":"find me a taco place"}'
# => {"message":"...","needs_clarification":"true","session_id":"<SID>"}

# Turn 2 — pick one (reuse session_id from above)
curl -s -X POST http://localhost:3000/api/order -H "Content-Type: application/json" \
  -d '{"utterance":"the first one","session_id":"<SID>"}'

# Turn 3 — add items
curl -s -X POST http://localhost:3000/api/order -H "Content-Type: application/json" \
  -d '{"utterance":"add 2 regular tacos to my cart","session_id":"<SID>"}'

# Turn 4 — attempt checkout (always refused, with a cart summary instead)
curl -s -X POST http://localhost:3000/api/order -H "Content-Type: application/json" \
  -d '{"utterance":"place the order now","session_id":"<SID>"}'
```

## How it works

1. **Session store** — an in-memory `Map` keyed by `session_id`, holding the full Claude message history for that conversation. No database; sessions are swept for inactivity on each request.
2. **Tool-use loop** — each turn, Claude is given two tools: `bash` (the only program it may invoke is `dd-cli`) and a custom `respond` tool it must call to end its turn (forced via `tool_choice`, so it can never reply with unstructured text). The loop runs up to `MAX_STEPS` iterations.
3. **Code-level allowlist** — every `bash` command is parsed (via `shell-quote`, no real shell involved) and checked against an explicit allowlist of dd-cli commands/subcommands before `execFile` ever runs it. Anything not on the list — most importantly the entire `order` command group and `login` — is rejected and logged with a `[SECURITY]` warning, regardless of what the model requests.
4. **Menu slimming** — `dd-cli menu` returns ~90+ items with long descriptions and image URLs per restaurant. That output is stripped down to just the fields the agent needs (item id, name, price, orderability, open/closed status) before it enters the conversation, to keep multi-restaurant lookups from blowing the context window.
5. **System prompt** — encodes the dd-cli command syntax, the open/closed-filtering and ranking logic, the cart-building and required-customization handling, the hard "never checkout" rule, and the text-to-speech-friendly response style.

Console output includes per-call timing (`console.time`/`console.timeEnd`) and a per-turn summary log (session id, dd-cli commands run, final message, clarification flag) for debugging.

## Known limitations

- Only ever uses one cached default delivery address (resolved once at server startup) — no support for switching addresses mid-conversation.
- No way to attach dietary notes / allergy info / delivery instructions — dd-cli's allowed command set has no field for it.
