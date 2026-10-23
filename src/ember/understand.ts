import { createRoute, z } from '@hono/zod-openapi';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { errorSchema } from '../contracts/common.js';
import type { ApiEnvironment } from '../contracts/common.js';
import { ApiError } from '../errors.js';
import type { ReserveQuota } from '../services/quota.js';
import { findIdentifiers } from './privacy.js';

// POST /v1/ember/understand — the first stage of every Ember question when Cloud Help allows
// Claude (Ember Assistant Architecture › Cloud understanding and privacy).
//
// The device sends one de-identified question (household names already swapped for tokens like
// [P2]) and, for a follow-up, the previous question and its intent. Claude fills in one fixed
// structure (the intent and words copied from the question) through a forced tool call, and
// nothing else: it never sees the household's data and never answers. The device checks every
// copied word against the question, restores the tokens, and does the rest on the device.
//
// Privacy: nothing is stored or logged but status, latency and token counts. No account id goes
// to Anthropic.

export const EMBER_INTENTS = [
  'spending', 'transactions', 'budgetStatus', 'bills', 'logPurchase',
  'call', 'text', 'findPlaces', 'directions',
  'calendar', 'addEvent', 'chores',
  'groceries', 'addGroceries', 'mealPlan',
  'foodLog', 'reading', 'remember', 'openApp', 'general', 'unsupported',
] as const;

const INTENT_MEANINGS: Record<(typeof EMBER_INTENTS)[number], string> = {
  spending: 'how much was spent: in a period, on a budget, at a store, or by a person ("how much did we spend last week", "what did we spend on October 10")',
  transactions: 'which purchases or charges there were, listed ("what did we buy yesterday", "show the Costco charges")',
  budgetStatus: "how a budget stands this month: left, over, on track (\"how's the grocery budget\")",
  bills: 'bills due or paid ("what bills are due this week", "is rent paid")',
  logPurchase: 'record a purchase in the budget ("log $40 at Costco")',
  call: 'phone a person or a business ("call Mom", "call Kristen")',
  text: 'send a text or email to someone',
  findPlaces: 'find restaurants, stores or businesses nearby',
  directions: 'directions to a place',
  calendar: "what's on the family calendar",
  addEvent: 'add an event to a calendar',
  chores: 'chores, approvals, allowance',
  groceries: "what's on the grocery list",
  addGroceries: 'add items to the grocery list',
  mealPlan: "meals planned, what's for dinner",
  foodLog: 'calories, protein, logging food',
  reading: 'scripture reading and study',
  remember: 'remember or forget a fact',
  openApp: 'open one of the apps',
  general: 'general knowledge or small talk',
  unsupported: "anything else Ember can't do",
};

const MAX_QUESTION = 600;

export const emberUnderstandSchema = z.object({
  question: z.string().min(1).max(MAX_QUESTION),
  previous: z.object({
    question: z.string().max(MAX_QUESTION),
    intent: z.enum(EMBER_INTENTS),
  }).optional(),
  now: z.string().max(80),
  timeZone: z.string().regex(/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/).max(64),
}).openapi('EmberUnderstandRequest');

const copied = (description: string) => z.string().max(200).describe(description);

export const emberRequestSchema = z.object({
  intent: z.enum(EMBER_INTENTS),
  whenWords: copied('The exact words used for when, or empty'),
  who: copied('The person, copied exactly, or empty (empty for we, us, me, I)'),
  placeWords: copied('A store, payee, kind of place or bill name, copied exactly, or empty'),
  townWords: copied('A town, only if one was said, copied exactly, or empty'),
  budgetWords: copied('A budget name, copied exactly, or empty'),
  items: z.array(z.string().max(200)).max(20),
  amountWords: copied('An amount of money, copied exactly, or empty'),
  isFollowUp: z.boolean(),
  clarify: z.string().max(200),
}).openapi('EmberRequest');

export type EmberUnderstanding = z.infer<typeof emberUnderstandSchema>;

export type EmberUnderstandDependencies = {
  reserveQuota: ReserveQuota;
  anthropicApiKey?: string | undefined;
  fetcher?: typeof fetch;
  /** A small, fast model: this is one short structured call per question. */
  model?: string;
  log?: (record: Record<string, unknown>) => void;
};

const DEFAULT_MODEL = 'claude-haiku-5-5';

/** The tool Claude must call: the request, and nothing else. */
export const SUBMIT_TOOL = {
  name: 'submit_request',
  description: 'Records what the request asks for. Call it exactly once.',
  input_schema: {
    type: 'object',
    properties: {
      intent: { type: 'string', enum: [...EMBER_INTENTS], description: 'What they want' },
      whenWords: { type: 'string', description: 'The exact words they used for when, copied from the request ("on October 10", "last week"), or empty' },
      who: { type: 'string', description: 'The person, copied exactly ("Kristen", "Mom", "[P2]"), or empty. Empty for we, us, me or I.' },
      placeWords: { type: 'string', description: 'A store, payee or kind of place, copied exactly ("Costco", "Mexican food"); for a bill asked about by name, the bill\'s name; otherwise empty' },
      townWords: { type: 'string', description: 'A town or city, ONLY if they said one, copied exactly, or empty. Never fill in where they are.' },
      budgetWords: { type: 'string', description: 'A budget name, copied exactly ("groceries"), or empty' },
      items: { type: 'array', items: { type: 'string' }, description: 'Grocery items to add, or the words of a message to send; empty otherwise' },
      amountWords: { type: 'string', description: 'An amount of money, copied exactly ("$40"), or empty' },
      isFollowUp: { type: 'boolean', description: 'True only when the request leans on the previous one ("what about last week?")' },
      clarify: { type: 'string', description: 'One short question to ask back only when it is impossible to tell what they want; otherwise empty' },
    },
    required: ['intent', 'whenWords', 'who', 'placeWords', 'townWords', 'budgetWords', 'items', 'amountWords', 'isFollowUp', 'clarify'],
  },
} as const;

export function understandSystemPrompt(input: { now: string; timeZone: string }): string {
  return [
    "You read one request to a family's assistant and record what it asks for by calling submit_request. You never answer it.",
    `It is ${input.now} (${input.timeZone}).`,
    '',
    'Intents:',
    ...EMBER_INTENTS.map((intent) => `- ${intent}: ${INTENT_MEANINGS[intent]}`),
    '',
    'Rules:',
    '- Copy words exactly as they appear in the request. Never rephrase, never add words they did not say.',
    '- Leave a field empty when the request does not say it.',
    '- A person\'s name, a token like [P2], or a relation like Mom is "who", never a place.',
    '- Money questions about a specific day or period are "spending", or "transactions" when they want the list.',
    '- How a budget is doing is "budgetStatus" with the budget in budgetWords.',
  ].join('\n');
}

export function understandPayload(body: EmberUnderstanding, model: string) {
  const previous = body.previous
    ? `\n\n(The previous request was: "${body.previous.question}" — intent ${body.previous.intent}. Use it only to decide isFollowUp.)`
    : '';
  return {
    model,
    max_tokens: 300,
    system: [{ type: 'text', text: understandSystemPrompt(body), cache_control: { type: 'ephemeral' } }],
    tools: [SUBMIT_TOOL],
    tool_choice: { type: 'tool', name: SUBMIT_TOOL.name },
    messages: [{ role: 'user', content: body.question + previous }],
  };
}

export function registerEmberUnderstand(app: OpenAPIHono<ApiEnvironment>, dependencies: EmberUnderstandDependencies) {
  const fetcher = dependencies.fetcher ?? fetch;
  const model = dependencies.model ?? DEFAULT_MODEL;
  const log = dependencies.log ?? ((record) => { if (process.env.NODE_ENV !== 'test') console.info(JSON.stringify(record)); });

  app.openapi(createRoute({
    method: 'post',
    path: '/v1/ember/understand',
    tags: ['Ember'],
    summary: 'What an Ember question asks for, as a typed request',
    description: 'One de-identified question in; the intent and words copied from it out. Claude never sees household data and never answers.',
    security: [{ BearerAuth: [] }],
    request: { body: { required: true, content: { 'application/json': { schema: emberUnderstandSchema } } } },
    responses: {
      200: { description: 'The request', content: { 'application/json': { schema: z.object({ request: emberRequestSchema }) } } },
      400: { description: 'Invalid request', content: { 'application/json': { schema: errorSchema } } },
      401: { description: 'Invalid or missing token', content: { 'application/json': { schema: errorSchema } } },
      422: { description: 'The text looks like it carries an identifier (PRIVACY_GUARD); nothing was sent', content: { 'application/json': { schema: errorSchema } } },
      429: { description: 'Too many requests', content: { 'application/json': { schema: errorSchema } } },
      502: { description: 'Claude failed or answered out of shape', content: { 'application/json': { schema: errorSchema } } },
      503: { description: 'Claude is not configured, or quotas are unavailable', content: { 'application/json': { schema: errorSchema } } },
    },
  }), async (context) => {
    const body = context.req.valid('json');
    const found = findIdentifiers([body.question, body.previous?.question ?? ''].join('\n'));
    if (found.length > 0) {
      log({ route: 'ember.understand', privacyGuard: found });
      throw new ApiError(422, 'PRIVACY_GUARD', 'The request looks like it contains personal details and was not sent');
    }
    if (!dependencies.anthropicApiKey) throw new ApiError(503, 'PROVIDER_NOT_CONFIGURED', 'Ember is not configured');
    await dependencies.reserveQuota(context.get('userId'), 'ember');

    const startedAt = performance.now();
    const upstream = await fetcher('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': dependencies.anthropicApiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(understandPayload(body, model)),
      signal: AbortSignal.timeout(8_000),
    }).catch(() => null);

    if (!upstream || !upstream.ok) {
      log({ route: 'ember.understand', upstreamStatus: upstream?.status ?? 'unreachable' });
      throw new ApiError(502, 'UPSTREAM_FAILED', 'Claude could not read the request');
    }
    const reply = await upstream.json().catch(() => null) as {
      content?: Array<{ type: string; name?: string; input?: unknown }>;
      usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
    } | null;
    const call = reply?.content?.find((block) => block.type === 'tool_use' && block.name === SUBMIT_TOOL.name);
    const parsed = emberRequestSchema.safeParse(withDefaults(call?.input));
    if (!parsed.success) {
      log({ route: 'ember.understand', shape: 'invalid' });
      throw new ApiError(502, 'UPSTREAM_FAILED', 'Claude answered out of shape');
    }
    log({
      route: 'ember.understand',
      model,
      intent: parsed.data.intent,
      inputTokens: reply?.usage?.input_tokens ?? 0,
      cacheReadTokens: reply?.usage?.cache_read_input_tokens ?? 0,
      outputTokens: reply?.usage?.output_tokens ?? 0,
      durationMs: Math.round(performance.now() - startedAt),
    });
    return context.json({ request: parsed.data }, 200);
  });
}

/** Fields Claude left out are empty, not an error. */
function withDefaults(input: unknown): unknown {
  if (!input || typeof input !== 'object') return input;
  return {
    whenWords: '', who: '', placeWords: '', townWords: '', budgetWords: '', items: [], amountWords: '', isFollowUp: false, clarify: '',
    ...(input as Record<string, unknown>),
  };
}
