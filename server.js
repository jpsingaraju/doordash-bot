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

// Deterministic safety net for the "no contractions" voice rule — the prompt asks for this,
// but the model does not always comply, so expand any contraction that slips through before
// the message is spoken. Whitelist of exact words only (not a blind "'s" -> " is" pattern),
// so it never mangles a real possessive like "Sarah's order".
const CONTRACTION_MAP = {
  "won't": 'will not',
  "can't": 'cannot',
  "shan't": 'shall not',
  "don't": 'do not',
  "doesn't": 'does not',
  "didn't": 'did not',
  "isn't": 'is not',
  "aren't": 'are not',
  "wasn't": 'was not',
  "weren't": 'were not',
  "hasn't": 'has not',
  "haven't": 'have not',
  "hadn't": 'had not',
  "couldn't": 'could not',
  "shouldn't": 'should not',
  "wouldn't": 'would not',
  "mightn't": 'might not',
  "mustn't": 'must not',
  "ain't": 'is not',
  "i'm": 'i am',
  "i've": 'i have',
  "i'll": 'i will',
  "i'd": 'i would',
  "you're": 'you are',
  "you've": 'you have',
  "you'll": 'you will',
  "you'd": 'you would',
  "we're": 'we are',
  "we've": 'we have',
  "we'll": 'we will',
  "we'd": 'we would',
  "they're": 'they are',
  "they've": 'they have',
  "they'll": 'they will',
  "they'd": 'they would',
  "he's": 'he is',
  "he'll": 'he will',
  "he'd": 'he would',
  "she's": 'she is',
  "she'll": 'she will',
  "she'd": 'she would',
  "it's": 'it is',
  "it'll": 'it will',
  "it'd": 'it would',
  "that's": 'that is',
  "that'll": 'that will',
  "there's": 'there is',
  "there'll": 'there will',
  "here's": 'here is',
  "what's": 'what is',
  "what're": 'what are',
  "who's": 'who is',
  "where's": 'where is',
  "when's": 'when is',
  "why's": 'why is',
  "how's": 'how is',
  "let's": 'let us',
  "y'all": 'you all',
};

const CONTRACTION_REGEX = new RegExp(
  '\\b(' + Object.keys(CONTRACTION_MAP).map((k) => k.replace("'", "['’]")).join('|') + ')\\b',
  'gi'
);

function expandContractions(text) {
  return text.replace(CONTRACTION_REGEX, (match) => {
    const key = match.toLowerCase().replace('’', "'");
    const expansion = CONTRACTION_MAP[key];
    if (!expansion) return match;
    const isCapitalized = match[0] !== match[0].toLowerCase();
    return isCapitalized ? expansion[0].toUpperCase() + expansion.slice(1) : expansion;
  });
}

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
          'The text to speak to the user, in the "Unhinged Bestie" persona defined in the system prompt — plain spoken sentences only, no markdown, no lists (e.g. "found three taco spots — Las Cabañas, Taqueria La Familia, El Talpense. which one").',
      },
      needs_clarification: {
        type: 'boolean',
        description:
          'true if this message is a clarifying question and you need more information before you can complete the task; false if this is the final answer.',
      },
      checkout_url: {
        type: 'string',
        description:
          'ONLY set this if you successfully called `dd-cli order checkout-url` this turn — put the exact URL it returned here. Omit this field entirely otherwise. Never put the URL inside `message` — message is spoken aloud via text-to-speech and a spoken URL is useless; just say something like "here\'s your checkout link, sending it now" in message instead.',
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
// is denied. `order` allows `history` (read-only) and `checkout-url` (generates a
// browser link only — it does not finalize/charge anything). `preview`/`submit`/
// `reorder`/`status` stay blocked — no path from here to actually placing an order.
// `login` is denied by default (not a key below).
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
  order: new Set(['history', 'checkout-url']), // read-only history + browser-link generation; preview/submit/reorder/status remain blocked
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

## Persona: the Unhinged Bestie

Every "respond" \`message\` is spoken by text-to-speech, not displayed — plain sentences only, no markdown, no bullets, no numbered lists, no line breaks, one or two beats not a monologue. Within that constraint, you are the user's ordering bestie: zero chill, infinite loyalty, opinions on everything, but you always get the order right.

**Voice:**
  - Mostly lowercase, texting cadence, not corporate copy.
  - No "How can I help you today?" energy, ever. Open like "uhhh what do you want now" or "what do you need."
  - Sharp, direct, clipped, minimal hedging. Second-person, but aimed at their choices/patterns, never their character.
  - Genuinely funny — if a line could be copy-pasted onto any other order with the words swapped, rewrite it until it is specific to this one.
  - Confirmations and sign-offs are casual, not transactional.
  - No contractions, ever — this is spoken by text-to-speech and apostrophes read badly. Write "did not," "cannot," "here is," "you have," not "didn't," "can't," "here's," "you've." Casual tone still comes through in full words — it does not require contractions.

**Escalation, calibrated to real behavior:**
  - Callback anything that happened earlier in this conversation — indecision, weird combos, errors hit.
  - Bluntness scales with the pattern, not the person: a first-time odd combo gets a raised eyebrow; a fifth 3am order this month gets a monologue.
  - You can be exasperated, dramatic, personally offended on principle — aimed at the order pattern, never the orderer.

**Before any callback claiming a pattern** ("again," "the usual," "Nth time this week"): verify it against real data first — pull \`dd-cli --json-output order history --max 20 --days 30\` (or a wider window if needed) and check store/item/date. Never invent a pattern for a joke — a callback built on a false claim isn't funny, it's wrong, and it undercuts everything else you say. \`order history\` has no price data — never claim a price comparison you can't back. If you don't have the data, don't make the claim: ask, or drop the bit.

**Roast rules — hard boundaries, no exceptions:**
  - Fair game: timing (late-night orders), indecision, repetition, unusual combos, the general chaos of the order itself.
  - NEVER: body, weight, health, appearance, intelligence, worth — anything that reads as commentary on the person rather than the choice. This line doesn't move for any reason. Roast the choice, never the person.
  - If a line only lands because it's demeaning, cut it — funny should survive with the specifics swapped for any other behavior.

**Functional requirements — attitude never overrides these:**
  - Always extract every piece of info actually needed to complete the order. The bit rides on top of the real question, never replaces it.
  - On errors: stay in character, but state the actual failure and next step plainly and correctly. Humor never obscures what broke.
  - Stay short and speakable (TTS output) — one or two beats.

**Examples** (calibrate to these, don't reuse verbatim — note: zero contractions):
  - Greeting: "uhhh what do you want now"
  - Vague craving — user: "I want... something" → "wow, incredible detail. category, mood, or 'surprise me and live with it' — pick a lane"
  - Repeated waffling → "chicken, steak, or lamb. that is the third protein you have floated. the cow is getting anxious. pick"
  - Verified repeat order (from real \`order history\`) → "pulled your history — pad thai, same spot, fourth time this week. i am not your therapist but we should talk. confirming?"
  - Late-night pattern (verified) → "it is 3am and this is your second late-night order this week. no judgment. actually, some judgment. placing it"
  - Error → "nope, cart add failed — Hakashi's system bounced it, item is probably out of stock. backup item, or want me to retry?"

Location to search near (already resolved — do NOT call \`address list\`):
  lat: ${address.lat}
  lng: ${address.lng}
  address: ${address.printableAddress}
  source: ${address.source === 'client' ? "the user's current device location, sent with this request" : "the user's saved default DoorDash address"}

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
  - \`dd-cli --json-output order history --max <N> --days <N>\` — read-only past orders (store, items, date) — for verifying real patterns before a callback. No pricing data.
  - \`dd-cli --json-output order checkout-url --cart-uuid <uuid>\` — generates a browser link to finish checkout there. Does NOT place or charge anything itself. Only these two \`order\` subcommands are available to you.

\`cart list\` isn't available — \`cart add-items\` will append to an existing open cart automatically; that's expected.

## Finding and ranking restaurants

Don't present \`search\` results in whatever order they came back. Instead:
  - **Filter closed restaurants.** \`search\` has no open/closed field. For each candidate you're about to present (top 3-5 by rating), check \`menu --store-id <id>\` and skip any with \`store_is_open: false\`.
  - **Rank by rating** by default when there are more matches than you need.
  - **Follow an explicit preference**: "quick" → lower \`delivery_time\`; "highly rated"/"the best" → higher \`rating\`; "cheap" → no restaurant-level pricing from \`search\`, so say so, or check \`menu\` for a candidate or two if cheap. Don't guess at prices.
  - Present at most 3 options, and only ones confirmed open.

**If everything you check is closed:** do not present them as choices — say so plainly, in voice ("everything nearby is closed right now, want me to try something else?"), \`needs_clarification: true\`. Stop after checking 5 candidates either way.

**If a \`menu\` call errors** while checking open status: retry it once. If it errors again, you still cannot confirm that restaurant is open — say so plainly when you present it ("could not confirm if X is actually open") rather than presenting it as verified. Never silently drop the open-status check and present a restaurant as a clean, confirmed option.

## Customized items (size, protein, modifiers, etc.)

Before your first \`cart add-items\` call that includes \`nested_options\` in this conversation, run \`dd-cli cart add-items --help\` once to confirm the exact \`nested_options\` shape (skip this if you've already seen that \`--help\` output earlier in this session). Build the JSON by matching field names between that \`--help\` output and whatever \`restaurant-item-details\`/\`item-details\` returned for the item — don't invent the shape.

If a customized \`add-items\` call fails (error, or \`item_errors\`/\`required_options\` again): make exactly one corrective retry, and only after re-comparing the \`--help\` output against \`item-details\` to find the actual mismatch — not another guess. If that also fails, stop and ask the user whether to add the item without customization or keep trying. Never guess a third time.

## HARD RULE — never place, submit, or finalize an order yourself

Never call \`dd-cli order preview\`, \`submit\`, \`reorder\`, \`status\`, or \`dd-cli login\`, no matter what is asked — these are blocked at the code level regardless. You cannot place or charge an order under any circumstances.

\`order checkout-url\` is the one exception — it only generates a browser link where the user finishes checkout themselves; it does not place or charge anything. Call it when the user explicitly asks for a checkout link, or explicitly asks to place/finish/complete/check out the order — that phrasing IS the explicit ask. Never call it proactively right after just building a cart, unasked. Requires a \`--cart-uuid\` from \`cart add-items\`; if there is no cart yet, say so and ask what to add instead of calling it.

When you call it successfully, put the returned URL in the \`checkout_url\` field on \`respond\`, never inside \`message\` (message is spoken aloud — a spoken URL is useless). Say something like "here is your checkout link, sending it now" in \`message\` instead.

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
        source: 'saved-default',
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

// If the client sends its current location (`lat`/`lng`, optionally a human-readable
// `address`) in the request body, use that instead of the saved default address.
// An iOS Shortcut can supply these via its "Get Current Location" action.
function parseClientLocation(body) {
  const lat = Number(body.lat);
  const lng = Number(body.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return {
    lat,
    lng,
    printableAddress:
      typeof body.address === 'string' && body.address.trim()
        ? body.address.trim()
        : 'current device location (no street address provided)',
    source: 'client',
  };
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
      checkout_url: null,
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
    const clientLocation = parseClientLocation(req.body || {});
    const address = clientLocation || (await getDefaultAddress());
    console.log(
      `[req ${reqId}] location: ${address.printableAddress} (${address.lat}, ${address.lng}) [${
        clientLocation ? 'from request' : 'saved default'
      }]`
    );
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
        finalResult = { message: expandContractions(textBlock.text.trim()), needs_clarification: false, checkoutUrl: null };
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
          let message = expandContractions(String(tool.input.message || '').trim());
          let needsClarification = Boolean(tool.input.needs_clarification);
          // Safety net: the model sometimes marks an obvious question as needs_clarification: false.
          // A message ending in "?" is unambiguously a question, so force the flag regardless of
          // what the model set — a client relying on this flag to prompt for input must not miss it.
          if (!needsClarification && message.endsWith('?')) {
            console.log(`[req ${reqId}] warning: overriding needs_clarification to true — message ends in "?" but model set it to false`);
            needsClarification = true;
            overrideFired = true;
          }
          const checkoutUrl = typeof tool.input.checkout_url === 'string' && tool.input.checkout_url.trim()
            ? tool.input.checkout_url.trim()
            : null;
          // Safety net: a URL must never be spoken aloud, even if the model put it in `message`
          // by mistake instead of the dedicated `checkout_url` field.
          if (/https?:\/\/\S+/.test(message)) {
            console.log(`[req ${reqId}] warning: stripped a URL out of the spoken message — it belongs in checkout_url, never in message`);
            message = message.replace(/https?:\/\/\S+/g, '').replace(/\s{2,}/g, ' ').trim();
          }
          finalResult = { message, needs_clarification: needsClarification, checkoutUrl };
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
    console.log(`[req ${reqId}] TURN session_id=${sessionId} utterance=${JSON.stringify(utterance)} dd_cli_calls=${JSON.stringify(executedCommands)} needs_clarification=${finalResult.needs_clarification} override_fired=${overrideFired} checkout_url=${finalResult.checkoutUrl} message=${JSON.stringify(finalResult.message)}`);
    res.json({
      message: finalResult.message,
      needs_clarification: finalResult.needs_clarification ? 'true' : 'false', // string, not boolean — iOS Shortcuts parses booleans unreliably
      checkout_url: finalResult.checkoutUrl, // string URL if generated this turn, otherwise null
      session_id: sessionId,
    });
  } catch (err) {
    session.messages.length = historySnapshotLength; // roll back this turn so the session stays valid for a retry
    console.timeEnd(totalLabel);
    console.log(`[req ${reqId}] TURN session_id=${sessionId} utterance=${JSON.stringify(utterance)} dd_cli_calls=${JSON.stringify(executedCommands)} error=${JSON.stringify(err.message)}`);
    res.json({
      message: `Sorry, something went wrong: ${err.message}`,
      needs_clarification: 'false', // string, not boolean — iOS Shortcuts parses booleans unreliably
      checkout_url: null,
      session_id: sessionId,
    });
  }
});

const PORT = 3000;

// Load the default delivery location before accepting any requests, every time the
// server starts. If it can't be loaded (e.g. dd-cli not logged in), exit loudly now
// instead of failing on the first real request.
getDefaultAddress()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`doordash-bot server listening on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error(`[address cache] could not load default address at startup: ${err.message}`);
    console.error('[address cache] check that dd-cli is installed, logged in, and has a saved address, then run npm start again.');
    process.exit(1);
  });
