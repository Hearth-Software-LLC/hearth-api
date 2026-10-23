import { createRoute, z } from '@hono/zod-openapi';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { errorSchema } from '../contracts/common.js';
import type { ApiEnvironment } from '../contracts/common.js';
import { ApiError } from '../errors.js';
import type { ReserveQuota } from '../services/quota.js';

// POST /v1/ember/transcribe — what was said to Ember on Apple Watch, as text.
//
// watchOS has no speech recognition for apps (no Speech framework, no SpeechAnalyzer), only the
// system dictation sheet. So the Watch records the question itself, stops when the person stops
// talking, and sends the audio here: 16-bit mono PCM, a few seconds long. It goes to Google
// Cloud Speech-to-Text (the same Google project and key as the cloud voice) and the text comes
// straight back. Only when Cloud Help is on; nothing is stored or logged but status and timing.

const MAX_AUDIO_BASE64 = 1_400_000; // about 40 seconds at 16 kHz

export const emberTranscribeSchema = z.object({
  /** Base64 of 16-bit little-endian mono PCM. */
  audio: z.string().min(16).max(MAX_AUDIO_BASE64),
  sampleRate: z.union([z.literal(8000), z.literal(16000)]).default(16000),
  language: z.string().regex(/^[a-z]{2,3}(-[A-Z]{2})?$/).max(10).default('en-US'),
  /** Words likely in this question (household first names, app names), to help recognition. */
  hints: z.array(z.string().max(40)).max(40).optional(),
}).openapi('EmberTranscribeRequest');

export type EmberTranscribeDependencies = {
  reserveQuota: ReserveQuota;
  googleApiKey?: string | undefined;
  fetcher?: typeof fetch;
  log?: (record: Record<string, unknown>) => void;
};

export function googleRecognizePayload(body: z.infer<typeof emberTranscribeSchema>) {
  return {
    config: {
      encoding: 'LINEAR16',
      sampleRateHertz: body.sampleRate,
      languageCode: body.language,
      model: 'latest_short',
      enableAutomaticPunctuation: true,
      ...(body.hints?.length ? { speechContexts: [{ phrases: body.hints, boost: 8 }] } : {}),
    },
    audio: { content: body.audio },
  };
}

export function registerEmberTranscribe(app: OpenAPIHono<ApiEnvironment>, dependencies: EmberTranscribeDependencies) {
  const fetcher = dependencies.fetcher ?? fetch;
  const log = dependencies.log ?? ((record) => { if (process.env.NODE_ENV !== 'test') console.info(JSON.stringify(record)); });

  app.openapi(createRoute({
    method: 'post',
    path: '/v1/ember/transcribe',
    tags: ['Ember'],
    summary: 'What was said to Ember on Apple Watch, as text',
    security: [{ BearerAuth: [] }],
    request: { body: { required: true, content: { 'application/json': { schema: emberTranscribeSchema } } } },
    responses: {
      200: { description: 'The words, or empty when nothing was understood', content: { 'application/json': { schema: z.object({ text: z.string() }) } } },
      400: { description: 'Invalid request', content: { 'application/json': { schema: errorSchema } } },
      401: { description: 'Invalid or missing token', content: { 'application/json': { schema: errorSchema } } },
      429: { description: 'Too many requests', content: { 'application/json': { schema: errorSchema } } },
      502: { description: 'Speech-to-Text failed', content: { 'application/json': { schema: errorSchema } } },
      503: { description: 'Not configured, or quotas are unavailable', content: { 'application/json': { schema: errorSchema } } },
    },
  }), async (context) => {
    const body = context.req.valid('json');
    if (!dependencies.googleApiKey) throw new ApiError(503, 'PROVIDER_NOT_CONFIGURED', 'Transcription is not configured');
    await dependencies.reserveQuota(context.get('userId'), 'ember-speech');

    const startedAt = performance.now();
    const upstream = await fetcher('https://speech.googleapis.com/v1/speech:recognize', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': dependencies.googleApiKey },
      body: JSON.stringify(googleRecognizePayload(body)),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);

    if (!upstream || !upstream.ok) {
      log({ route: 'ember.transcribe', upstreamStatus: upstream?.status ?? 'unreachable' });
      throw new ApiError(502, 'UPSTREAM_FAILED', 'Speech-to-Text failed');
    }
    const reply = await upstream.json().catch(() => null) as { results?: Array<{ alternatives?: Array<{ transcript?: string }> }> } | null;
    const text = (reply?.results ?? [])
      .map((result) => result.alternatives?.[0]?.transcript?.trim() ?? '')
      .filter(Boolean)
      .join(' ');
    log({ route: 'ember.transcribe', seconds: Math.round(body.audio.length * 0.75 / (2 * body.sampleRate)), heard: text.length > 0, durationMs: Math.round(performance.now() - startedAt) });
    return context.json({ text }, 200);
  });
}
