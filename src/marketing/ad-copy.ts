import { createRoute, z } from '@hono/zod-openapi';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { errorSchema } from '../contracts/common.js';
import type { ApiEnvironment } from '../contracts/common.js';
import { ApiError } from '../errors.js';
import type { ReserveQuota } from '../services/quota.js';

// POST /v1/marketing/ad-copy — ad copy for Hearth Ship's Social tab (Hearth Ship › Social ads plan).
//
// Hearth Ship sends a campaign's brief, the app's App Store listing and the platforms the ads run
// on, each with its character limits. Claude writes a few versions through a tool call:
// two short lines for the image, a headline, the primary text and a button. Every field is then
// measured against the tightest limit it has to meet; anything too long gets one follow-up call
// that shortens only those fields, and whatever is still too long comes back flagged, never cut.
//
// Hearth+ only. Nothing is stored or logged but status, latency, token counts and the app id. No
// account id goes to Anthropic.

/** The two lines drawn on the ad image: short enough to set large on every size. */
export const ON_IMAGE_LIMIT = 28;
export const AD_CTAS = ['Download', 'Install now', 'Learn more'] as const;
export const AD_TONES = ['warm', 'playful', 'direct'] as const;

const TONE_MEANINGS: Record<(typeof AD_TONES)[number], string> = {
  warm: 'warm and reassuring, like a friend who has been there',
  playful: 'light and playful, with a wink; a single fitting emoji is fine',
  direct: 'plain and direct: the benefit first, no warm-up',
};

const text = (max: number) => z.string().max(max);

export const adCopyRequestSchema = z.object({
  app: z.string().regex(/^[a-z0-9-]{1,40}$/).openapi({ example: 'bigtable' }),
  appName: z.string().trim().min(1).max(60).openapi({ example: 'BigTable' }),
  listing: z.object({
    subtitle: text(60).optional(),
    promotionalText: text(400).optional(),
    description: text(4000).optional(),
    keywords: text(200).optional(),
  }).default({}),
  brief: text(1000).default(''),
  audience: text(300).default(''),
  tone: z.enum(AD_TONES).default('warm'),
  platforms: z.array(z.object({
    id: z.string().regex(/^[a-z0-9-]{1,40}$/),
    name: z.string().trim().min(1).max(40),
    /** Characters of primary text that show before "more"; 0 = the platform has none. */
    primary: z.number().int().min(0).max(3000),
    /** 0 = the platform has no headline. */
    headline: z.number().int().min(0).max(300),
  })).min(1).max(12),
  count: z.number().int().min(1).max(5).default(3),
  /** Lines already written, so another pass brings new ones. */
  avoid: z.array(text(300)).max(15).default([]),
}).openapi('AdCopyRequest');

export type AdCopyRequest = z.infer<typeof adCopyRequestSchema>;

const versionSchema = z.object({
  line1: z.string().max(200),
  line2: z.string().max(200),
  headline: z.string().max(400),
  primary: z.string().max(4000),
  cta: z.enum(AD_CTAS),
});

export const adCopyResponseSchema = z.object({
  versions: z.array(versionSchema.extend({
    /** Fields still over their limit after one shortening pass ("line1", "headline"…). */
    tooLong: z.array(z.enum(['line1', 'line2', 'headline', 'primary'])),
  })),
  limits: z.object({ line: z.number(), headline: z.number(), primary: z.number() }),
  model: z.string(),
}).openapi('AdCopy');

export type AdVersion = z.infer<typeof versionSchema>;

export type AdCopyDependencies = {
  reserveQuota: ReserveQuota;
  /** Throws 402 unless the caller has Hearth+. */
  requireHearthPlus: (userId: string) => Promise<void>;
  anthropicApiKey?: string | undefined;
  fetcher?: typeof fetch;
  /** Writing ads is a few calls per campaign, so quality wins over speed. */
  model?: string;
  log?: (record: Record<string, unknown>) => void;
};

const DEFAULT_MODEL = 'claude-sonnet-5-5';

/** The limits every version must meet: the tightest of the chosen platforms, field by field. */
export function adLimits(platforms: AdCopyRequest['platforms']) {
  const tightest = (values: number[], fallback: number) => {
    const used = values.filter((value) => value > 0);
    return used.length ? Math.min(...used) : fallback;
  };
  return {
    line: ON_IMAGE_LIMIT,
    headline: tightest(platforms.map((p) => p.headline), 40),
    primary: tightest(platforms.map((p) => p.primary), 125),
  };
}

export type AdLimits = ReturnType<typeof adLimits>;

/** The fields of a version that are over their limit. */
export function overLimit(version: AdVersion, limits: AdLimits) {
  const over: Array<'line1' | 'line2' | 'headline' | 'primary'> = [];
  if ([...version.line1].length > limits.line) over.push('line1');
  if ([...version.line2].length > limits.line) over.push('line2');
  if ([...version.headline].length > limits.headline) over.push('headline');
  if ([...version.primary].length > limits.primary) over.push('primary');
  return over;
}

export const SUBMIT_TOOL = {
  name: 'submit_versions',
  description: 'Records the ad versions. Call it exactly once.',
  input_schema: {
    type: 'object',
    properties: {
      versions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            line1: { type: 'string', description: 'First line on the image: the hook' },
            line2: { type: 'string', description: 'Second line on the image, shown in a lighter color: the turn or payoff' },
            headline: { type: 'string', description: 'The headline shown beside the button' },
            primary: { type: 'string', description: 'The primary text above or below the ad' },
            cta: { type: 'string', enum: [...AD_CTAS], description: 'The button' },
          },
          required: ['line1', 'line2', 'headline', 'primary', 'cta'],
        },
      },
    },
    required: ['versions'],
  },
} as const;

export function adCopySystemPrompt(): string {
  return [
    'You write paid social ads for small, well-made iPhone apps from one maker, sold under the Hearth name.',
    'Answer only by calling submit_versions once, with every version. Write nothing else.',
    '',
    'House voice:',
    '- Plain, concrete words about what the app does for this person. No hype, no superlatives, no "revolutionary", "game-changer" or "unlock".',
    '- Never invent prices, ratings, awards, user counts, percentages or features. Use only what the listing and the brief say.',
    '- No hashtags. No emoji unless the tone allows one. No exclamation marks in the lines on the image.',
    '- The two lines on the image work as a pair, like "Feed the whole crew." / "Skip the 5 p.m. panic.": a hook, then the turn.',
    '- Each version leads with a different benefit or angle, not the same idea reworded.',
    '- Every field must fit its character limit. Count characters, spaces included. Shorter is fine.',
  ].join('\n');
}

export function adCopyUserMessage(body: AdCopyRequest, limits: AdLimits): string {
  const listing = body.listing;
  const lines = [
    `App: ${body.appName}`,
    listing.subtitle ? `App Store subtitle: ${listing.subtitle}` : '',
    listing.promotionalText ? `Promotional text: ${listing.promotionalText}` : '',
    listing.description ? `App Store description:\n${listing.description}` : '',
    listing.keywords ? `Keywords: ${listing.keywords}` : '',
    '',
    `Campaign brief: ${body.brief || '(none: pick the strongest benefit from the listing)'}`,
    body.audience ? `Who it's for: ${body.audience}` : '',
    `Tone: ${TONE_MEANINGS[body.tone]}`,
    `Runs on: ${body.platforms.map((p) => p.name).join(', ')}`,
    '',
    `Write ${body.count} versions. Character limits (the tightest of those platforms):`,
    `- line1 and line2: at most ${limits.line} each`,
    `- headline: at most ${limits.headline}`,
    `- primary: at most ${limits.primary}`,
    body.avoid.length ? `\nAlready written; don't reuse these or say the same thing again:\n${body.avoid.map((line) => `- ${line}`).join('\n')}` : '',
  ];
  return lines.filter((line, index, all) => line !== '' || (all[index - 1] ?? '') !== '').join('\n').trim();
}

export function adCopyPayload(body: AdCopyRequest, model: string, limits: AdLimits) {
  return {
    model,
    max_tokens: 1600,
    system: [{ type: 'text', text: adCopySystemPrompt(), cache_control: { type: 'ephemeral' } }],
    tools: [SUBMIT_TOOL],
    // Newer models (Sonnet 5.5) refuse a forced tool call ("tool" and "any"), so the model is
    // told to answer only through the tool, and the reply is checked for it.
    tool_choice: { type: 'auto' },
    messages: [{ role: 'user', content: adCopyUserMessage(body, limits) }] as Array<Record<string, unknown>>,
  };
}

type ClaudeReply = {
  content?: Array<{ type: string; id?: string; name?: string; input?: unknown }>;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
};

const toolInputSchema = z.object({ versions: z.array(versionSchema).min(1).max(5) });

export function registerAdCopy(app: OpenAPIHono<ApiEnvironment>, dependencies: AdCopyDependencies) {
  const fetcher = dependencies.fetcher ?? fetch;
  const model = dependencies.model ?? DEFAULT_MODEL;
  const log = dependencies.log ?? ((record) => { if (process.env.NODE_ENV !== 'test') console.info(JSON.stringify(record)); });

  function send(payload: Record<string, unknown>) {
    return fetcher('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': dependencies.anthropicApiKey!,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(45_000),
    }).catch(() => null);
  }

  /** Anthropic's error type and message (never the request's content). */
  async function upstreamError(response: Response) {
    const body = await response.json().catch(() => null) as { error?: { type?: string; message?: string } } | null;
    return { type: body?.error?.type ?? 'unknown', message: (body?.error?.message ?? '').slice(0, 300) };
  }

  /** Thinking settings learned from a refusal, used for the rest of the request. */
  async function call(payload: Record<string, unknown>, extra: Record<string, unknown>) {
    let upstream = await send({ ...payload, ...extra });
    // A model that thinks by default refuses a forced tool call. Ask again with thinking off,
    // the way its error says to (`"thinking": {"type": "between_tools"}` on some models).
    if (upstream && upstream.status === 400 && !extra.thinking) {
      const error = await upstreamError(upstream.clone());
      if (/thinking|tool_choice/i.test(error.message)) {
        const suggested = /"thinking":\s*\{\s*"type":\s*"([a-z_]+)"\s*\}\s*instead/i.exec(error.message)?.[1] ?? 'disabled';
        extra.thinking = { type: suggested };
        log({ route: 'marketing.adCopy', upstreamStatus: 400, retry: `thinking-${suggested}` });
        upstream = await send({ ...payload, ...extra });
      }
    }
    if (!upstream || !upstream.ok) {
      const error = upstream ? await upstreamError(upstream) : { type: 'unreachable', message: '' };
      log({ route: 'marketing.adCopy', upstreamStatus: upstream?.status ?? 'unreachable', errorType: error.type, error: error.message });
      throw new ApiError(502, 'UPSTREAM_FAILED', error.message
        ? `Claude could not write the ads (${upstream?.status} ${error.type}: ${error.message})`
        : 'Claude could not write the ads');
    }
    const reply = await upstream.json().catch(() => null) as ClaudeReply | null;
    const block = reply?.content?.find((item) => item.type === 'tool_use' && item.name === SUBMIT_TOOL.name);
    const parsed = toolInputSchema.safeParse(block?.input);
    if (!block || !parsed.success) {
      log({ route: 'marketing.adCopy', shape: 'invalid' });
      throw new ApiError(502, 'UPSTREAM_FAILED', 'Claude answered out of shape');
    }
    return { block, content: reply?.content ?? [], versions: parsed.data.versions, usage: reply?.usage ?? {} };
  }

  app.openapi(createRoute({
    method: 'post',
    path: '/v1/marketing/ad-copy',
    tags: ['Marketing'],
    summary: 'Ad copy for a campaign, sized for every platform it runs on (Hearth+)',
    description: 'Versions of an ad: two lines for the image, a headline, the primary text and a button, each within the tightest limit of the chosen platforms. Fields still too long after one shortening pass are listed in `tooLong`.',
    security: [{ BearerAuth: [] }],
    request: { body: { required: true, content: { 'application/json': { schema: adCopyRequestSchema } } } },
    responses: {
      200: { description: 'The versions', content: { 'application/json': { schema: adCopyResponseSchema } } },
      400: { description: 'Invalid request', content: { 'application/json': { schema: errorSchema } } },
      401: { description: 'Invalid or missing token', content: { 'application/json': { schema: errorSchema } } },
      402: { description: 'Needs Hearth+', content: { 'application/json': { schema: errorSchema } } },
      429: { description: 'Too many requests', content: { 'application/json': { schema: errorSchema } } },
      502: { description: 'Claude failed or answered out of shape', content: { 'application/json': { schema: errorSchema } } },
      503: { description: 'Claude is not configured, or quotas or plans are unavailable', content: { 'application/json': { schema: errorSchema } } },
    },
  }), async (context) => {
    const body = context.req.valid('json');
    const userId = context.get('userId');
    await dependencies.requireHearthPlus(userId);
    if (!dependencies.anthropicApiKey) throw new ApiError(503, 'PROVIDER_NOT_CONFIGURED', 'Ad writing is not configured');
    await dependencies.reserveQuota(userId, 'marketing');

    const startedAt = performance.now();
    const limits = adLimits(body.platforms);
    const payload = adCopyPayload(body, model, limits);
    const extra: Record<string, unknown> = {};
    const first = await call(payload, extra);
    let versions = first.versions.slice(0, body.count);
    let usage = [first.usage];

    // One shortening pass for whatever is over its limit.
    const over = versions.map((version) => overLimit(version, limits));
    const retried = over.some((fields) => fields.length > 0);
    if (retried) {
      const notes = over.flatMap((fields, index) => fields.map((field) => {
        const max = field === 'headline' ? limits.headline : field === 'primary' ? limits.primary : limits.line;
        return `- Version ${index + 1} ${field}: ${[...versions[index]![field]].length} characters, at most ${max}`;
      }));
      const second = await call({
        ...payload,
        messages: [
          ...payload.messages,
          // Every block of the reply, thinking included, as the API expects it back.
          { role: 'assistant', content: first.content },
          { role: 'user', content: [{
            type: 'tool_result', tool_use_id: first.block.id,
            content: `These are too long:\n${notes.join('\n')}\nCall submit_versions again with every version, shortening only those fields and keeping the rest exactly as they are.`,
          }] },
        ],
      }, extra).catch(() => null);
      if (second && second.versions.length >= versions.length) {
        versions = second.versions.slice(0, versions.length);
        usage = [...usage, second.usage];
      }
    }

    log({
      route: 'marketing.adCopy',
      app: body.app,
      model,
      versions: versions.length,
      retried,
      inputTokens: usage.reduce((sum, u) => sum + (u.input_tokens ?? 0), 0),
      cacheReadTokens: usage.reduce((sum, u) => sum + (u.cache_read_input_tokens ?? 0), 0),
      outputTokens: usage.reduce((sum, u) => sum + (u.output_tokens ?? 0), 0),
      durationMs: Math.round(performance.now() - startedAt),
    });
    return context.json({
      versions: versions.map((version) => ({ ...version, tooLong: overLimit(version, limits) })),
      limits,
      model,
    }, 200);
  });
}
