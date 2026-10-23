import { createRoute, z } from '@hono/zod-openapi';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { errorSchema } from '../contracts/common.js';
import type { ApiEnvironment } from '../contracts/common.js';
import { ApiError } from '../errors.js';
import type { ReserveQuota } from '../services/quota.js';
import { findIdentifiers } from './privacy.js';

// POST /v1/ember/speak — Ember's cloud voice, for Apple Watch (it can't run Kokoro). One
// sentence of an answer in, MP3 out, from Google Cloud Text-to-Speech (Chirp 3: HD).
//
// Privacy: the sentence is the answer as it will be heard, so it may carry household first names
// (the person chose this when turning on the Watch's cloud voice). Everything else that
// identifies someone is refused here, as for a turn: phone numbers, emails, addresses, links,
// card and account numbers. Nothing about the text is stored or logged (only its length,
// status and latency), and Google gets no account id, device id or IP address of the person.

export type EmberSpeechDependencies = {
  reserveQuota: ReserveQuota;
  /** Google Cloud API key with the Text-to-Speech API enabled; the route answers 503 without one. */
  googleApiKey?: string | undefined;
  fetcher?: typeof fetch;
  log?: (record: Record<string, unknown>) => void;
};

/** Chirp 3: HD voices offered in Ember (US English). */
export const EMBER_VOICES = ['Aoede', 'Kore', 'Leda', 'Zephyr', 'Puck', 'Charon', 'Fenrir', 'Orus'] as const;
export const DEFAULT_VOICE = 'Aoede';
const MAX_SPEECH_TEXT = 600;

export const emberSpeakSchema = z.object({
  text: z.string().trim().min(1).max(MAX_SPEECH_TEXT),
  voice: z.enum(EMBER_VOICES).optional(),
  /** 0.8 (slower) to 1.25 (faster); 1 when left out. */
  rate: z.number().min(0.8).max(1.25).optional(),
}).openapi('EmberSpeak');

export type EmberSpeak = z.infer<typeof emberSpeakSchema>;

export function registerEmberSpeech(app: OpenAPIHono<ApiEnvironment>, dependencies: EmberSpeechDependencies) {
  const fetcher = dependencies.fetcher ?? fetch;
  const log = dependencies.log ?? ((record) => { if (process.env.NODE_ENV !== 'test') console.info(JSON.stringify(record)); });

  app.openapi(createRoute({
    method: 'post',
    path: '/v1/ember/speak',
    tags: ['Ember'],
    summary: 'One sentence of an Ember answer, spoken (MP3)',
    description: 'For Apple Watch. Checked for identifiers like a turn; nothing is stored.',
    security: [{ BearerAuth: [] }],
    request: { body: { required: true, content: { 'application/json': { schema: emberSpeakSchema } } } },
    responses: {
      200: { description: 'audio/mpeg, 24 kHz mono', content: { 'audio/mpeg': { schema: z.string() } } },
      400: { description: 'Invalid request', content: { 'application/json': { schema: errorSchema } } },
      401: { description: 'Invalid or missing token', content: { 'application/json': { schema: errorSchema } } },
      422: { description: 'The text looks like it carries an identifier (PRIVACY_GUARD); nothing was sent', content: { 'application/json': { schema: errorSchema } } },
      429: { description: 'Too many requests', content: { 'application/json': { schema: errorSchema } } },
      502: { description: 'The voice service failed', content: { 'application/json': { schema: errorSchema } } },
      503: { description: 'The voice service is not configured, or quotas are unavailable', content: { 'application/json': { schema: errorSchema } } },
    },
  }), async (context) => {
    const request = context.req.valid('json');
    const found = findIdentifiers(request.text);
    if (found.length > 0) {
      log({ route: 'ember.speak', privacyGuard: found });
      throw new ApiError(422, 'PRIVACY_GUARD', 'The text looks like it contains personal details and was not sent');
    }
    if (!dependencies.googleApiKey) throw new ApiError(503, 'PROVIDER_NOT_CONFIGURED', 'The cloud voice is not configured');
    await dependencies.reserveQuota(context.get('userId'), 'ember-speech');

    const startedAt = performance.now();
    const upstream = await fetcher('https://texttospeech.googleapis.com/v1/text:synthesize', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': dependencies.googleApiKey },
      body: JSON.stringify(googlePayload(request)),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);

    const body = upstream?.ok ? await upstream.json().catch(() => null) as { audioContent?: string } | null : null;
    if (!body?.audioContent) {
      log({ route: 'ember.speak', upstreamStatus: upstream?.status ?? 'unreachable' });
      throw new ApiError(502, 'UPSTREAM_FAILED', 'The cloud voice is unavailable');
    }
    const audio = Buffer.from(body.audioContent, 'base64');
    log({ route: 'ember.speak', characters: request.text.length, bytes: audio.length, durationMs: Math.round(performance.now() - startedAt) });
    return context.body(new Uint8Array(audio), 200, { 'content-type': 'audio/mpeg', 'cache-control': 'no-store' });
  });
}

/** Google's request: the text, a Chirp 3: HD voice, MP3 at 24 kHz. Nothing about the person. */
export function googlePayload(request: EmberSpeak) {
  return {
    input: { text: request.text },
    voice: { languageCode: 'en-US', name: `en-US-Chirp3-HD-${request.voice ?? DEFAULT_VOICE}` },
    audioConfig: {
      audioEncoding: 'MP3',
      sampleRateHertz: 24_000,
      ...(request.rate && request.rate !== 1 ? { speakingRate: request.rate } : {}),
    },
  };
}
