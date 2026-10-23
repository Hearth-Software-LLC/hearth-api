import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { readConfig } from '../../src/config.js';
import { googlePayload } from '../../src/ember/speech.js';
import type { ReserveQuota } from '../../src/services/quota.js';

const json = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' };
const mp3 = Buffer.from([0xff, 0xf3, 0x44, 0xc4, 0x00]);

function setup(fetcher: typeof fetch, apiKey: string | null = 'goog-test') {
  const reserveQuota = vi.fn<ReserveQuota>(async () => undefined);
  const app = createApp({
    config: readConfig({}),
    verifyToken: async () => 'user-7',
    reserveQuota,
    emberSpeech: { googleApiKey: apiKey ?? undefined, fetcher, log: () => undefined },
  });
  return { app, reserveQuota };
}

function speak(app: ReturnType<typeof setup>['app'], body: unknown) {
  return app.request('/v1/ember/speak', { method: 'POST', headers: json, body: JSON.stringify(body) });
}

describe('POST /v1/ember/speak', () => {
  it('returns MP3 from Google with a Chirp 3 HD voice and nothing about the person', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ audioContent: mp3.toString('base64') }));
    const { app, reserveQuota } = setup(fetcher);
    const response = await speak(app, { text: "Ella's practice is at five.", voice: 'Kore' });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('audio/mpeg');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(mp3);
    expect(reserveQuota).toHaveBeenCalledWith('user-7', 'ember-speech');

    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('https://texttospeech.googleapis.com/v1/text:synthesize');
    expect((init?.headers as Record<string, string>)['x-goog-api-key']).toBe('goog-test');
    const sent = JSON.parse(String(init?.body));
    expect(sent).toEqual({
      input: { text: "Ella's practice is at five." },
      voice: { languageCode: 'en-US', name: 'en-US-Chirp3-HD-Kore' },
      audioConfig: { audioEncoding: 'MP3', sampleRateHertz: 24000 },
    });
    expect(JSON.stringify(sent)).not.toContain('user-7');
  });

  it('refuses text that carries an identifier, before calling Google', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const { app } = setup(fetcher);
    const response = await speak(app, { text: 'Call her at (801) 555-0134.' });
    expect(response.status).toBe(422);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('answers 503 without a key and 502 when Google fails', async () => {
    expect((await speak(setup(vi.fn<typeof fetch>(), null).app, { text: 'Hi.' })).status).toBe(503);
    const failing = vi.fn<typeof fetch>(async () => new Response('nope', { status: 500 }));
    expect((await speak(setup(failing).app, { text: 'Hi.' })).status).toBe(502);
  });

  it('rejects unknown voices and long text', async () => {
    const { app } = setup(vi.fn<typeof fetch>());
    expect((await speak(app, { text: 'Hi.', voice: 'Bob' })).status).toBe(400);
    expect((await speak(app, { text: 'a'.repeat(601) })).status).toBe(400);
  });

  it('adds the speaking rate only when it changes', () => {
    expect(googlePayload({ text: 'Hi.' }).audioConfig).not.toHaveProperty('speakingRate');
    expect(googlePayload({ text: 'Hi.', rate: 1.1 }).audioConfig.speakingRate).toBe(1.1);
  });
});
