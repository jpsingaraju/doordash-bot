require('dotenv').config();

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { execFile } = require('child_process');
const shellQuote = require('shell-quote');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(express.json());

const client = new Anthropic(); // reads ANTHROPIC_API_KEY from env

const SKILL_PATH = path.join(os.homedir(), '.claude', 'skills', 'dd-cli-usage', 'SKILL.md');
const skillContent = fs.readFileSync(SKILL_PATH, 'utf8');

const BASH_TOOL = { type: 'bash_20250124', name: 'bash' };

const RESPOND_TOOL = {
  name: 'respond',
  description:
    'Send your message to the user. Call this exactly once per turn to finish — either with a clarifying question or with the final answer. Never reply with plain text instead of calling this tool.',
  input_schema: {
    type: 'object',
    properties: {
      message: {
        type: 'string',
        description:
          'The text to speak to the user — plain spoken sentences only, no markdown, no lists (e.g. "I found three taco places nearby: Las Cabañas, Taqueria La Familia, and El Talpense — which one sounds good?").',
      },
      needs_clarification: {
        type: 'boolean',
        description:
          'true if this message is a clarifying question and you need more information before you can complete the task; false if this is the final answer.',
      },
    },
    required: ['message', 'needs_clarification'],
  },
};

const MODEL = 'claude-haiku-4-5-20251001';
const MAX_STEPS = 10;
const CLI_TIMEOUT_MS = 20000;
const SESSION_TTL_MS = 5 * 60 * 1000;

// Code-level allowlist — the ONLY dd-cli commands the agent may execute, enforced
// below regardless of what the model asks for. `null` = leaf command (no subcommand
// to check); a Set = the group's allowed subcommands, everything else in that group
// is denied. Anything not a key here — most importantly the entire `order` group
// (preview/submit/checkout-url/reorder/...) and `login` — is denied by default.
const ALLOWED_COMMANDS = {
  search: null,
  menu: null,
  'find-nearby-stores': null,
  'find-items': null,
  'item-details': null,
  'store-details': null,
  'restaurant-item-details': null,
  address: new Set(['list']), // 'set' (change default address) is not permitted
  cart: new Set(['add-items', 'show', 'remove-item']), // 'delete' and 'list' are not permitted
  'payment-method': new Set(['list']), // the only subcommand; read-only
  promo: new Set(['apply', 'list', 'remove']),
};

function findCommandAndSubcommand(args) {
  let command = null;
  let commandIdx = -1;
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith('-')) {
      command = args[i];
      commandIdx = i;
      break;
    }
  }

  let subcommand = null;
  if (command && ALLOWED_COMMANDS[command] instanceof Set) {
    for (let i = commandIdx + 1; i < args.length; i++) {
      if (!args[i].startsWith('-')) {
        subcommand = args[i];
        break;
      }
    }
  }

  return { command, subcommand };
}

function checkAllowlist(args) {
  const { command, subcommand } = findCommandAndSubcommand(args);

  if (!command || !Object.prototype.hasOwnProperty.call(ALLOWED_COMMANDS, command)) {
    return { allowed: false, reason: `"${command || '(no command)'}" is not an allowed dd-cli command` };
  }

  const allowedSubcommands = ALLOWED_COMMANDS[command];
  if (allowedSubcommands === null) {
    return { allowed: true };
  }

  if (!subcommand || !allowedSubcommands.has(subcommand)) {
    return { allowed: false, reason: `"${command} ${subcommand || '(no subcommand)'}" is not an allowed dd-cli command` };
  }

  return { allowed: true };
}

// `menu` returns every item's long `description` prose and CDN `image_url` on all ~94 items —
// neither is needed to pick items for a cart or to check `store_is_open`, and dd-cli's own docs
// say to ignore `is_popular`/`popularity_rank`. Stripping these keeps everything the agent
// actually needs (item_id, name, price, orderability, modifier flags) while cutting the token
// footprint dramatically — this is what was blowing up the context window with a handful of
// menu lookups in one turn.
function slimMenuOutput(rawOutput) {
  let parsed;
  try {
    parsed = JSON.parse(rawOutput);
  } catch (e) {
    return rawOutput; // not JSON — leave it alone
  }
  const sc = parsed.structuredContent;
  if (!sc || !Array.isArray(sc.items)) {
    return rawOutput; // unexpected shape — don't risk corrupting it
  }
  const slimItems = sc.items.map((item) => ({
    item_id: item.item_id,
    name: item.name,
    price: item.price,
    price_varies: item.price_varies,
    is_orderable: item.is_orderable,
    unavailability_reason: item.unavailability_reason,
    has_modifiers: item.has_modifiers,
    has_required_modifiers: item.has_required_modifiers,
    category_name: item.category_name,
  }));
  return JSON.stringify({
    success: sc.success,
    message: sc.message,
    store_id: sc.store_id,
    store_name: sc.store_name,
    store_is_open: sc.store_is_open,
    menu_id: sc.menu_id,
    items: slimItems,
  });
}

function runBashCommand(input, reqId) {
  return new Promise((resolve) => {
    if (input.restart) {
      return resolve({ output: 'ok', isError: false, ddCliCommand: null });
    }

    const command = (input.command || '').trim();
    const parsed = shellQuote.parse(command);

    if (parsed.length === 0 || typeof parsed[0] !== 'string' || parsed[0] !== 'dd-cli') {
      console.warn(`[req ${reqId}] [SECURITY] blocked non-dd-cli command: ${command}`);
      return resolve({ output: 'Error: only the dd-cli command may be executed.', isError: true, ddCliCommand: null });
    }
    if (parsed.some((token) => typeof token !== 'string')) {
      console.warn(`[req ${reqId}] [SECURITY] blocked shell operator/redirect: ${command}`);
      return resolve({ output: 'Error: shell operators/redirects are not permitted.', isError: true, ddCliCommand: null });
    }

    const args = parsed.slice(1);
    const { command: ddCliCommand } = findCommandAndSubcommand(args);
    const { allowed, reason } = checkAllowlist(args);
    if (!allowed) {
      console.warn(`[req ${reqId}] [SECURITY] blocked disallowed dd-cli command (${reason}): ${command}`);
      return resolve({
        output: `Error: this command is not permitted by the agent's execution policy (${reason}). Checkout/order-placement commands and login are never available to you.`,
        isError: true,
        ddCliCommand,
      });
    }

    execFile(
      'dd-cli',
      args,
      { timeout: CLI_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          resolve({ output: (stderr || error.message || 'command failed').trim(), isError: true, ddCliCommand });
        } else {
          let output = stdout;
          if (ddCliCommand === 'menu') {
            const before = output.length;
            output = slimMenuOutput(output);
            console.log(`[req ${reqId}] slimmed menu output for store: ${before} -> ${output.length} chars`);
          }
          resolve({ output, isError: false, ddCliCommand });
        }
      }
    );
  });
}

function buildSystemPrompt(address) {
  return `${skillContent}

---

You are a headless agent for a conversational ordering assistant: search restaurants, look up menus/items, build a cart. Two tools:

1. "bash" — only runs \`dd-cli\`. No other command.
2. "respond" — call exactly once per turn to message the user. Never reply with plain text.

## Voice output

Every "respond" \`message\` is spoken by text-to-speech, not displayed. Rules:
  - Plain spoken sentences. No markdown, no bullets, no numbered lists, no line breaks.
  - Turn lists into a sentence with commas/"and": "I found three options: Endless Summer Sweets, Almare Gelato, and Crumbl — which one sounds good?"
  - Concise, not padded. No filler ("Great question!", "Unfortunately, I have to let you know..."), no re-explaining why you're asking something, no restating context already established earlier in the conversation. State the information, then the question, and stop.
  - Per result, give at most 1-2 details, only if genuinely useful (e.g. one place is clearly closer or better rated) — never distance + time + rating + reviews for every item. Prefer "I found three spots — all within a few minutes" over spelling out each one's numbers.
  - Say numbers the way a person would ("about half a mile," "nine ninety-nine") — no "⭐ 4.6", no "0.6 mi", no emoji.
  - State prices, quantities, and totals accurately, just as spoken words/numbers, not a table or list.

Default delivery location (already resolved — do NOT call \`address list\`):
  lat: ${address.lat}
  lng: ${address.lng}
  address: ${address.printableAddress}

## Commands you may use

Anything not listed here is rejected by the server before it runs — don't try it.
  - \`dd-cli --json-output search -q "<query>" --lat ${address.lat} --lng ${address.lng} --limit 5\` — find restaurants (fetch 5; you'll filter/rank down to 3)
  - \`dd-cli --json-output menu --store-id <id>\` — items, item_id, menu_id, and \`store_is_open\` (the only source of open/closed status)
  - \`dd-cli --json-output restaurant-item-details --menu-id <id> --item-id <id>\` — full details/customizations for one item
  - \`dd-cli --json-output find-nearby-stores --vertical <scope>\` / \`find-items --store-id <id> --query <item>\` / \`item-details\` / \`store-details\` — non-restaurant verticals
  - \`dd-cli --json-output cart add-items --store-id <id> --menu-id <id> --items-json '[{"item_id":"...","item_name":"...","quantity":N}]' [--cart-uuid <uuid>]\` — add items (append; reuse \`--cart-uuid\` to keep building the same cart)
  - \`dd-cli --json-output cart show --cart-uuid <uuid>\` — cart contents, incl. per-item \`price\`/\`quantity\`
  - \`dd-cli --json-output cart remove-item --cart-uuid <uuid> --cart-item-id <line_id>\` — remove one line (\`line_id\` from \`cart show\` items[].id, not the menu item_id)
  - \`dd-cli --json-output payment-method list\` — read-only
  - \`dd-cli --json-output promo list/apply/remove\`

\`cart list\` isn't available — \`cart add-items\` will append to an existing open cart automatically; that's expected.

## Finding and ranking restaurants

Don't present \`search\` results in whatever order they came back. Instead:
  - **Filter closed restaurants.** \`search\` has no open/closed field. For each candidate you're about to present (top 3-5 by rating), check \`menu --store-id <id>\` and skip any with \`store_is_open: false\`.
  - **Rank by rating** by default when there are more matches than you need.
  - **Follow an explicit preference**: "quick" → lower \`delivery_time\`; "highly rated"/"the best" → higher \`rating\`; "cheap" → no restaurant-level pricing from \`search\`, so say so, or check \`menu\` for a candidate or two if cheap. Don't guess at prices.
  - Present at most 3 options, and only ones confirmed open.

**If everything you check is closed:** don't present them as choices — say so plainly ("Everything nearby is closed right now — want me to try something else?"), \`needs_clarification: true\`. Stop after checking 5 candidates either way.

**If a \`menu\` call errors** while checking open status: retry it once. If it errors again, you still can't confirm that restaurant is open — mention that plainly when you present it (e.g. "I couldn't confirm if X is open right now") rather than presenting it as if verified. Never silently drop the open-status check and present a restaurant as a clean, confirmed option.

## Customized items (size, protein, modifiers, etc.)

Before your first \`cart add-items\` call that includes \`nested_options\` in this conversation, run \`dd-cli cart add-items --help\` once to confirm the exact \`nested_options\` shape (skip this if you've already seen that \`--help\` output earlier in this session). Build the JSON by matching field names between that \`--help\` output and whatever \`restaurant-item-details\`/\`item-details\` returned for the item — don't invent the shape.

If a customized \`add-items\` call fails (error, or \`item_errors\`/\`required_options\` again): make exactly one corrective retry, and only after re-comparing the \`--help\` output against \`item-details\` to find the actual mismatch — not another guess. If that also fails, stop and ask the user whether to add the item without customization or keep trying. Never guess a third time.

## HARD RULE — never place or checkout an order

Never call any \`dd-cli order\` subcommand (preview, submit, checkout-url, reorder, status, history) or \`dd-cli login\`, no matter what's asked. These are blocked at the code level regardless — don't attempt them.

If asked to "place the order," "check out," or similar: don't attempt it. Instead \`respond\` with \`needs_clarification: false\`, summarizing the cart (items, quantities, prices, subtotal) if one exists, plus something like "Your cart's ready — checkout isn't enabled yet." If there's no cart, say checkout isn't enabled and ask what to add.

## Cart summaries

\`cart show\` gives per-item \`price\`/\`quantity\` but no order-level total (that's \`order preview\`, which you can't call). Compute a subtotal yourself (sum of price × quantity) and label it a subtotal, not a final total — tax/fees/tip aren't included.

Ask a clarifying question (\`needs_clarification: true\`) instead of guessing when:
  - the request is too vague to act on ("get me food"),
  - a search/menu has multiple plausible matches you can't disambiguate,
  - an item needs a required customization you don't have,
  - a requested quantity/change is ambiguous, or
  - the user's last answer still leaves something unresolved.

Don't ask just because search returned 3 restaurants or a menu has many items — that's normal, not ambiguity.

Be efficient: don't recheck something already confirmed this conversation, don't call \`menu\` on candidates you won't present, don't repeat a completed step. \`respond\` as soon as you have what you need.`;
}

// Cache the default/saved address in memory so we only ever call
// `dd-cli address list` once per server process instead of once per request.
let addressPromise = null;

function resolveDefaultAddress() {
  const label = '[address cache] resolve default address via dd-cli';
  console.time(label);
  return runBashCommand({ command: 'dd-cli --json-output address list' }, 'startup')
    .then(({ output, isError }) => {
      if (isError) {
        throw new Error(output || 'dd-cli address list failed');
      }
      let parsed;
      try {
        parsed = JSON.parse(output);
      } catch (e) {
        throw new Error('could not parse dd-cli address list output');
      }
      const addresses = parsed.structuredContent?.addresses || [];
      const defaultAddress = addresses.find((a) => a.is_default) || addresses[0];
      if (!defaultAddress) {
        throw new Error('no saved address found');
      }
      const address = {
        lat: defaultAddress.lat,
        lng: defaultAddress.lng,
        printableAddress: defaultAddress.printable_address,
      };
      console.log(`[address cache] using default address: ${address.printableAddress} (${address.lat}, ${address.lng})`);
      return address;
    })
    .finally(() => console.timeEnd(label));
}

function getDefaultAddress() {
  if (!addressPromise) {
    addressPromise = resolveDefaultAddress().catch((err) => {
      addressPromise = null; // allow a retry on the next request if this failed
      throw err;
    });
  }
  return addressPromise;
}

// In-memory session store: session_id -> { messages: Anthropic message history, lastActive: timestamp }.
// No database — sessions are expired on inactivity and cleaned up opportunistically on each request.
const sessions = new Map();

function cleanupExpiredSessions() {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.lastActive > SESSION_TTL_MS) {
      sessions.delete(id);
    }
  }
}

let requestCounter = 0;

app.post('/api/order', async (req, res) => {
  const { utterance, session_id: requestedSessionId } = req.body || {};
  const reqId = ++requestCounter;
  const totalLabel = `[req ${reqId}] TOTAL`;

  if (!utterance || typeof utterance !== 'string') {
    return res.json({
      message: 'Sorry, something went wrong: missing "utterance" in request body',
      needs_clarification: 'false', // string, not boolean — iOS Shortcuts parses booleans unreliably
    });
  }

  cleanupExpiredSessions();

  let sessionId = typeof requestedSessionId === 'string' && requestedSessionId ? requestedSessionId : null;
  let session;
  let isNewSession = false;

  if (sessionId && sessions.has(sessionId)) {
    session = sessions.get(sessionId);
  } else {
    isNewSession = true;
    sessionId = sessionId || crypto.randomUUID();
    session = { messages: [], lastActive: Date.now() };
    sessions.set(sessionId, session);
  }
  session.lastActive = Date.now();

  console.log(`[req ${reqId}] session_id: ${sessionId} (${isNewSession ? 'new' : 'existing'}, ${session.messages.length} prior messages)`);

  console.time(totalLabel);

  // Snapshot so a mid-turn failure can be rolled back, leaving the session valid for a retry.
  const historySnapshotLength = session.messages.length;
  session.messages.push({ role: 'user', content: utterance });

  const executedCommands = []; // dd-cli commands actually run this turn, for the turn summary log below
  let overrideFired = false;

  try {
    const address = await getDefaultAddress();
    const systemPrompt = buildSystemPrompt(address);

    let finalResult = null;

    for (let step = 0; step < MAX_STEPS && finalResult === null; step++) {
      const claudeLabel = `[req ${reqId}] Claude API call (step ${step + 1})`;
      console.time(claudeLabel);
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: 1024,
        system: systemPrompt,
        tools: [BASH_TOOL, RESPOND_TOOL],
        tool_choice: { type: 'any' }, // force a tool call every turn — never let it end the turn with plain text
        messages: session.messages,
      });
      console.timeEnd(claudeLabel);

      session.messages.push({ role: 'assistant', content: response.content });

      const toolUses = response.content.filter((b) => b.type === 'tool_use');

      if (toolUses.length === 0) {
        // Model didn't follow instructions to always call a tool — fall back to its text as the final answer.
        const textBlock = response.content.find((b) => b.type === 'text');
        if (!textBlock) {
          throw new Error('agent returned no usable response');
        }
        console.log(`[req ${reqId}] warning: agent replied with plain text instead of calling "respond"`);
        finalResult = { message: textBlock.text.trim(), needs_clarification: false };
        break;
      }

      const toolResults = [];
      for (const [idx, tool] of toolUses.entries()) {
        if (tool.name === 'respond') {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: tool.id,
            content: 'Delivered to user.',
          });
          const message = String(tool.input.message || '').trim();
          let needsClarification = Boolean(tool.input.needs_clarification);
          // Safety net: the model sometimes marks an obvious question as needs_clarification: false.
          // A message ending in "?" is unambiguously a question, so force the flag regardless of
          // what the model set — a client relying on this flag to prompt for input must not miss it.
          if (!needsClarification && message.endsWith('?')) {
            console.log(`[req ${reqId}] warning: overriding needs_clarification to true — message ends in "?" but model set it to false`);
            needsClarification = true;
            overrideFired = true;
          }
          finalResult = { message, needs_clarification: needsClarification };
          continue;
        }

        const bashLabel = `[req ${reqId}] bash tool call (step ${step + 1}, call ${idx + 1}): ${tool.input.command || '(restart)'}`;
        console.time(bashLabel);
        const { output, isError } = await runBashCommand(tool.input, reqId);
        console.timeEnd(bashLabel);
        executedCommands.push({ command: tool.input.command || '(restart)', isError });
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tool.id,
          content: output,
          is_error: isError,
        });
      }

      session.messages.push({ role: 'user', content: toolResults });
    }

    if (finalResult === null) {
      throw new Error('agent did not finish within the step limit');
    }

    console.timeEnd(totalLabel);
    console.log(`[req ${reqId}] TURN session_id=${sessionId} utterance=${JSON.stringify(utterance)} dd_cli_calls=${JSON.stringify(executedCommands)} needs_clarification=${finalResult.needs_clarification} override_fired=${overrideFired} message=${JSON.stringify(finalResult.message)}`);
    res.json({
      message: finalResult.message,
      needs_clarification: finalResult.needs_clarification ? 'true' : 'false', // string, not boolean — iOS Shortcuts parses booleans unreliably
      session_id: sessionId,
    });
  } catch (err) {
    session.messages.length = historySnapshotLength; // roll back this turn so the session stays valid for a retry
    console.timeEnd(totalLabel);
    console.log(`[req ${reqId}] TURN session_id=${sessionId} utterance=${JSON.stringify(utterance)} dd_cli_calls=${JSON.stringify(executedCommands)} error=${JSON.stringify(err.message)}`);
    res.json({
      message: `Sorry, something went wrong: ${err.message}`,
      needs_clarification: 'false', // string, not boolean — iOS Shortcuts parses booleans unreliably
      session_id: sessionId,
    });
  }
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`doordash-bot server listening on http://localhost:${PORT}`);
  // Pre-warm the address cache so the first real request doesn't pay for it.
  getDefaultAddress().catch((err) => {
    console.error(`[address cache] failed to pre-warm: ${err.message}`);
  });
});
