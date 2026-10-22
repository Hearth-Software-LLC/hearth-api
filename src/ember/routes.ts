import { createRoute, z } from '@hono/zod-openapi';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { streamSSE } from 'hono/streaming';
import { errorSchema } from '../contracts/common.js';
import type { ApiEnvironment } from '../contracts/common.js';
import { ApiError } from '../errors.js';
import type { ReserveQuota } from '../services/quota.js';
import { EMBER_TOOLS, EMBER_TOOL_NAMES } from './tools.js';
import { findIdentifiers } from './privacy.js';
import { emberSystemPrompt } from './prompt.js';

// POST /v1/ember/turn — Ember's cloud turn (implementation plan › hearth-api changes).
//
// A stateless relay. The device sends a de-identified conversation and the names of the tools it
// will run; this adds the system prompt and the tool schemas, checks the text once more for
// identifiers, and streams Claude's reply back as Server-Sent Events:
//
//   event: text      data: {"text":"…"}
//   event: tool_use  data: {"id":"…","name":"…","input":{…}}   (the device runs it, then calls again)
//   event: done      data: {"stopReason":"end_turn"}
//   event: error     data: {"code":"UPSTREAM_FAILED"}
//
// Privacy: nothing about the conversation is stored or logged (only status, latency and token
// counts). Anthropic gets no account id, device id, IP address or `metadata.user_id`: the bearer
// token is used here only to check the account's quota.

export type EmberDependencies = {
  reserveQuota: ReserveQuota;
  /** Anthropic's API key; the route answers 503 without one. */
  anthropicApiKey?: string | undefined;
  fetcher?: typeof fetch;
  /** Models by profile. Haiku for everyday and every Watch turn, Sonnet for planning. */
  models?: { quick: string; plan: string };
  log?: (record: Record<string, unknown>) => void;
};

const DEFAULT_MODELS = { quick: 'claude-haiku-5-5', plan: 'claude-sonnet-5-5' };
const MAX_TEXT = 4000;
const MAX_TOTAL_TEXT = 24_000;

const blockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string().max(MAX_TEXT) }),
  z.object({
    type: z.literal('tool_use'),
    id: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
    name: z.enum(EMBER_TOOL_NAMES),
    input: z.record(z.string(), z.unknown()),
  }),
  z.object({
    type: z.literal('tool_result'),
    tool_use_id: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
    content: z.string().max(MAX_TEXT),
  }),
]);

export const emberTurnSchema = z.object({
  profile: z.enum(['quick', 'plan']),
  client: z.enum(['iphone', 'watch']),
  locale: z.string().regex(/^[A-Za-z]{2,3}([_-][A-Za-z0-9]{2,8})*$/).max(35),
  timeZone: z.string().regex(/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/).max(64),
  now: z.string().max(80),
  roster: z.array(z.object({
    token: z.string().regex(/^\[P\d{1,2}\]$/),
    role: z.enum(['parent', 'adult', 'kid']),
    ageBand: z.enum(['under 5', '5–12', '13–17', 'adult']).optional(),
  })).max(20),
  messages: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.array(blockSchema).min(1).max(20),
  })).min(1).max(30),
  tools: z.array(z.enum(EMBER_TOOL_NAMES)).max(EMBER_TOOL_NAMES.length),
  allowWebSearch: z.boolean(),
}).openapi('EmberTurn');

export type EmberTurn = z.infer<typeof emberTurnSchema>;

export function registerEmber(app: OpenAPIHono<ApiEnvironment>, dependencies: EmberDependencies) {
  const fetcher = dependencies.fetcher ?? fetch;
  const models = dependencies.models ?? DEFAULT_MODELS;
  const log = dependencies.log ?? ((record) => { if (process.env.NODE_ENV !== 'test') console.info(JSON.stringify(record)); });

  app.openapi(createRoute({
    method: 'post',
    path: '/v1/ember/turn',
    tags: ['Ember'],
    summary: "One turn of Ember's conversation with Claude, streamed as Server-Sent Events",
    description: 'De-identified on the device and checked again here. The device runs every tool; `tool_use` events ask it to.',
    security: [{ BearerAuth: [] }],
    request: { body: { required: true, content: { 'application/json': { schema: emberTurnSchema } } } },
    responses: {
      200: { description: 'text/event-stream of text, tool_use, done and error events', content: { 'text/event-stream': { schema: z.string() } } },
      400: { description: 'Invalid request', content: { 'application/json': { schema: errorSchema } } },
      401: { description: 'Invalid or missing token', content: { 'application/json': { schema: errorSchema } } },
      422: { description: 'The text still looks like it carries an identifier (PRIVACY_GUARD); nothing was sent', content: { 'application/json': { schema: errorSchema } } },
      429: { description: 'Too many turns', content: { 'application/json': { schema: errorSchema } } },
      503: { description: 'Claude is not configured, or quotas are unavailable', content: { 'application/json': { schema: errorSchema } } },
    },
  }), async (context) => {
    const turn = context.req.valid('json');

    const text = conversationText(turn);
    if (text.length > MAX_TOTAL_TEXT) throw new ApiError(400, 'INVALID_REQUEST', 'The conversation is too long');
    const found = findIdentifiers(text);
    if (found.length > 0) {
      // The kinds only: never the text.
      log({ route: 'ember.turn', privacyGuard: found });
      throw new ApiError(422, 'PRIVACY_GUARD', 'The request looks like it contains personal details and was not sent');
    }
    if (!dependencies.anthropicApiKey) throw new ApiError(503, 'PROVIDER_NOT_CONFIGURED', 'Ember is not configured');
    await dependencies.reserveQuota(context.get('userId'), 'ember');

    const model = turn.client === 'watch' || turn.profile === 'quick' ? models.quick : models.plan;
    const payload = anthropicPayload(turn, model);
    const startedAt = performance.now();

    return streamSSE(context, async (stream) => {
      const upstream = await fetcher('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': dependencies.anthropicApiKey!,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30_000),
      }).catch(() => null);

      if (!upstream || !upstream.ok || !upstream.body) {
        log({ route: 'ember.turn', upstreamStatus: upstream?.status ?? 'unreachable' });
        await stream.writeSSE({ event: 'error', data: JSON.stringify({ code: upstream?.status === 429 ? 'RATE_LIMITED' : 'UPSTREAM_FAILED' }) });
        return;
      }

      const usage = { input: 0, output: 0, cacheRead: 0 };
      let stopReason = 'end_turn';
      const allowed = new Set(turn.tools);
      // Content blocks in progress, by index.
      const blocks = new Map<number, { type: string; id?: string; name?: string; json: string }>();

      for await (const event of readAnthropicEvents(upstream.body)) {
        switch (event.type) {
          case 'message_start': {
            const start = event.message as { usage?: { input_tokens?: number; cache_read_input_tokens?: number } } | undefined;
            usage.input = start?.usage?.input_tokens ?? 0;
            usage.cacheRead = start?.usage?.cache_read_input_tokens ?? 0;
            break;
          }
          case 'content_block_start': {
            const block = event.content_block as { type: string; id?: string; name?: string } | undefined;
            if (typeof event.index === 'number' && block) {
              blocks.set(event.index, { type: block.type, ...(block.id ? { id: block.id } : {}), ...(block.name ? { name: block.name } : {}), json: '' });
            }
            break;
          }
          case 'content_block_delta': {
            const delta = event.delta as { type: string; text?: string; partial_json?: string } | undefined;
            if (delta?.type === 'text_delta' && delta.text) {
              await stream.writeSSE({ event: 'text', data: JSON.stringify({ text: delta.text }) });
            } else if (delta?.type === 'input_json_delta' && typeof event.index === 'number') {
              const block = blocks.get(event.index);
              if (block) block.json += delta.partial_json ?? '';
            }
            break;
          }
          case 'content_block_stop': {
            const block = typeof event.index === 'number' ? blocks.get(event.index) : undefined;
            // Only the device's own tools go back; server tools (web search) ran upstream.
            if (block?.type === 'tool_use' && block.id && block.name && allowed.has(block.name)) {
              let input: unknown = {};
              try { input = block.json ? JSON.parse(block.json) : {}; } catch { input = {}; }
              await stream.writeSSE({ event: 'tool_use', data: JSON.stringify({ id: block.id, name: block.name, input }) });
            }
            break;
          }
          case 'message_delta': {
            const delta = event.delta as { stop_reason?: string } | undefined;
            const deltaUsage = event.usage as { output_tokens?: number } | undefined;
            if (delta?.stop_reason) stopReason = delta.stop_reason;
            usage.output = deltaUsage?.output_tokens ?? usage.output;
            break;
          }
          case 'error': {
            await stream.writeSSE({ event: 'error', data: JSON.stringify({ code: 'UPSTREAM_FAILED' }) });
            return;
          }
          default:
            break;
        }
      }

      await stream.writeSSE({ event: 'done', data: JSON.stringify({ stopReason }) });
      log({
        route: 'ember.turn',
        client: turn.client,
        profile: turn.profile,
        model,
        stopReason,
        inputTokens: usage.input,
        cacheReadTokens: usage.cacheRead,
        outputTokens: usage.output,
        durationMs: Math.round(performance.now() - startedAt),
      });
    });
  });
}

/** Every word the device sent, for the privacy guard. */
export function conversationText(turn: EmberTurn): string {
  const parts: string[] = [];
  for (const message of turn.messages) {
    for (const block of message.content) {
      if (block.type === 'text') parts.push(block.text);
      if (block.type === 'tool_result') parts.push(block.content);
      if (block.type === 'tool_use') parts.push(JSON.stringify(block.input));
    }
  }
  return parts.join('\n');
}

/** The Messages API request: cached system prompt and tools, no identity, no metadata. */
export function anthropicPayload(turn: EmberTurn, model: string) {
  const tools: Array<Record<string, unknown>> = turn.tools
    .map((name) => EMBER_TOOLS[name])
    .filter((tool): tool is NonNullable<typeof tool> => Boolean(tool))
    .map((tool) => ({ ...tool }));
  if (turn.allowWebSearch) tools.push({ type: 'web_search_20250305', name: 'web_search', max_uses: 2 });
  const last = tools.at(-1);
  if (last) last.cache_control = { type: 'ephemeral' };

  return {
    model,
    max_tokens: turn.profile === 'plan' ? 900 : 400,
    stream: true,
    system: [{
      type: 'text',
      text: emberSystemPrompt({ client: turn.client, now: turn.now, timeZone: turn.timeZone, roster: turn.roster }),
      cache_control: { type: 'ephemeral' },
    }],
    tools,
    messages: turn.messages,
  };
}

type AnthropicEvent = { type: string; index?: number; [key: string]: unknown };

/** The Messages API's Server-Sent Events, parsed. */
export async function* readAnthropicEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<AnthropicEvent> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const raw = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = raw.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('');
      if (data) {
        try {
          const parsed = JSON.parse(data) as AnthropicEvent;
          if (parsed && typeof parsed.type === 'string') yield parsed;
        } catch {
          // A malformed event is skipped; the stream carries on.
        }
      }
      boundary = buffer.indexOf('\n\n');
    }
  }
}
