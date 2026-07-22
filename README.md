# doordash-bot

A local Express server that wraps [`dd-cli`](https://github.com/) with a Claude-driven conversational agent. Send it a natural-language utterance and it searches restaurants, checks menus, builds a DoorDash cart, and — after an explicit spoken confirmation — places the order on your behalf, over a single HTTP endpoint.

## What it does

`POST /api/order` runs a bounded tool-use loop where Claude (Haiku) decides which `dd-cli` commands to run, reads the results, and either asks a clarifying question or gives a final answer — all phrased as short, spoken-friendly sentences (this is designed to be read aloud by text-to-speech, e.g. from an iOS Shortcut).

Capabilities:
- Search restaurants near your saved DoorDash address
- Filter out closed restaurants and rank by rating / stated preference ("something quick", "highly rated")
- Look up menus and item details
- Build a cart (add items, handle required customizations, remove items, view cart + subtotal)
- Ask clarifying questions when a request is ambiguous (vague query, multiple item matches, required size/protein/modifier choices)
- Multi-turn conversations via a `session_id` — the agent remembers context across requests
- Place the order for real: preview the exact total, name the payment card ("your Visa ending 3626") and Dasher tip, ask for confirmation, submit on your explicit yes, then verify via `order status` before saying it's placed

**Ordering is guarded in code (not just prompted):**
- `order submit` is rejected by the server unless a successful `order preview` for that exact cart ran on an **earlier** turn — which guarantees a confirmation question (total + card + tip) actually reached the user and they answered before anything is charged.
- Each cart can only ever be submitted **once** — submit is not idempotent, so a retry would double-charge; the server blocks it and directs the agent to `order status` instead.
- Payment is always the account's **default payment method on file** — the CLI can't pick or change cards, so no payment data ever touches this server. To pay with a different card, you finish the (synced) cart in the DoorDash app.
- `ordered_status` in the response is only `"true"` if a submit actually succeeded that turn — the model can't claim an order it didn't place.
- `dd-cli login`, `order reorder`, `order receipt`, and `order checkout-url` remain blocked by the allowlist entirely.

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
  "ordered_status": "false",
  "session_id": "generated-or-reused-uuid"
}
```

`needs_clarification` and `ordered_status` are returned as the **string** `"true"`/`"false"` (not JSON booleans) — this is deliberate, to work around inconsistent boolean parsing in iOS Shortcuts. Sessions expire after 5 minutes of inactivity.

`ordered_status` is `"true"` only on the turn an order was actually submitted and verified — a Shortcut loop can use it as its stop signal: speak the message, and if `ordered_status` is `"true"`, end instead of prompting for another reply.

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

# Turn 4 — ask to order: the agent previews and asks for confirmation (total + card + tip)
curl -s -X POST http://localhost:3000/api/order -H "Content-Type: application/json" \
  -d '{"utterance":"place the order now","session_id":"<SID>"}'
# => {"message":"that is 24 dollars 60 total on your Visa ending 3626, suggested dasher tip is 4 dollars — place it?","needs_clarification":"true","ordered_status":"false",...}

# Turn 5 — confirm: the agent submits, verifies via order status, and reports
curl -s -X POST http://localhost:3000/api/order -H "Content-Type: application/json" \
  -d '{"utterance":"yes go ahead","session_id":"<SID>"}'
# => {"message":"order placed, food is on the way","needs_clarification":"false","ordered_status":"true",...}
```

## How it works

1. **Session store** — an in-memory `Map` keyed by `session_id`, holding the full Claude message history for that conversation. No database; sessions are swept for inactivity on each request.
2. **Tool-use loop** — each turn, Claude is given two tools: `bash` (the only program it may invoke is `dd-cli`) and a custom `respond` tool it must call to end its turn (forced via `tool_choice`, so it can never reply with unstructured text). The loop runs up to `MAX_STEPS` iterations.
3. **Code-level allowlist + submit guards** — every `bash` command is parsed (via `shell-quote`, no real shell involved) and checked against an explicit allowlist of dd-cli commands/subcommands before `execFile` ever runs it. `order submit` gets extra per-session guards: it must reference a cart that was successfully previewed on an earlier turn (proving the user was asked and answered), a cart is marked spent before submit even executes (so a timeout can never lead to a double-charge retry), and `--yes` is auto-appended so a non-TTY submit can't hang on the interactive prompt. Anything blocked is rejected and logged with a `[SECURITY]` warning, regardless of what the model requests.
4. **Menu slimming** — `dd-cli menu` returns ~90+ items with long descriptions and image URLs per restaurant. That output is stripped down to just the fields the agent needs (item id, name, price, orderability, open/closed status) before it enters the conversation, to keep multi-restaurant lookups from blowing the context window.
5. **System prompt** — encodes the dd-cli command syntax, the open/closed-filtering and ranking logic, the cart-building and required-customization handling, the strict preview → confirm → submit → verify ordering flow, and the text-to-speech-friendly response style.

Console output includes per-call timing (`console.time`/`console.timeEnd`) and a per-turn summary log (session id, dd-cli commands run, final message, clarification flag) for debugging.

## Known limitations

- Delivery always goes to the account's **default saved** DoorDash address — no address switching mid-conversation, no arbitrary addresses.
- Payment is always the account's default payment method — swapping cards, applying gift cards, or using wallets selectively isn't possible from the CLI; finish the synced cart in the DoorDash app for those cases.
- Age-restricted items can't be ordered agentically — DoorDash rejects them at submit; the agent will tell you to finish that cart in the app.
- No way to attach dietary notes / allergy info / delivery instructions — dd-cli's allowed command set has no field for it.
