import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { readConfig } from '../../src/config.js';
import type { ReserveQuota } from '../../src/services/quota.js';

const json = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' };
const audio = Buffer.alloc(3200).toString('base64');

function setup(fetcher: typeof fetch, apiKey: string | null = 'goog-test') {
  const reserveQuota = vi.fn<ReserveQuota>(async () => undefined);
  const app = createApp({
    config: readConfig({}),
    verifyToken: async () => 'user-7',
    reserveQuota,
    emberTranscribe: { googleApiKey: apiKey ?? undefined, fetcher, log: () => undefined },
  });
  return { app, reserveQuota };
}

function transcribe(app: ReturnType<typeof setup>['app'], body: unknown) {
  return app.request('/v1/ember/transcribe', { method: 'POST', headers: json, body: JSON.stringify(body) });
}

describe('POST /v1/ember/transcribe', () => {
  it('sends the audio to Speech-to-Text and returns the words', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ results: [{ alternatives: [{ transcript: 'How much did we spend' }] }, { alternatives: [{ transcript: 'on October 10?' }] }] }));
    const { app, reserveQuota } = setup(fetcher);
    const response = await transcribe(app, { audio, hints: ['Kristen'] });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ text: 'How much did we spend on October 10?' });
    expect(reserveQuota).toHaveBeenCalledWith('user-7', 'ember-speech');
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('https://speech.googleapis.com/v1/speech:recognize');
    expect((init?.headers as Record<string, string>)['x-goog-api-key']).toBe('goog-test');
    const sent = JSON.parse(String(init?.body));
    expect(sent.config).toMatchObject({ encoding: 'LINEAR16', sampleRateHertz: 16000, languageCode: 'en-US', speechContexts: [{ phrases: ['Kristen'], boost: 8 }] });
    expect(JSON.stringify(sent)).not.toContain('user-7');
  });

  it('returns empty text when nothing was understood', async () => {
    const { app } = setup(vi.fn<typeof fetch>(async () => Response.json({})));
    expect(await (await transcribe(app, { audio })).json()).toEqual({ text: '' });
  });

  it('answers 503 without a key, 502 when Google fails, 400 for bad input', async () => {
    expect((await transcribe(setup(vi.fn<typeof fetch>(), null).app, { audio })).status).toBe(503);
    expect((await transcribe(setup(vi.fn<typeof fetch>(async () => new Response('no', { status: 403 }))).app, { audio })).status).toBe(502);
    expect((await transcribe(setup(vi.fn<typeof fetch>()).app, { audio, sampleRate: 44100 })).status).toBe(400);
  });
});
