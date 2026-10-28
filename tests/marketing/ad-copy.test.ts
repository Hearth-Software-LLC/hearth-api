import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { readConfig } from '../../src/config.js';
import { adCopyUserMessage, adLimits, overLimit } from '../../src/marketing/ad-copy.js';
import type { ReserveQuota } from '../../src/services/quota.js';
import type { EffectiveEntitlement } from '../../src/services/subscriptions.js';

const json = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' };

const good = {
  line1: 'Feed the whole crew.', line2: 'Skip the 5 p.m. panic.',
  headline: 'Plan a week of dinners', primary: 'BigTable plans the week and writes the grocery list.', cta: 'Download' as const,
};

function claudeReply(versions: unknown[], id = 'toolu_1') {
  return Response.json({
    content: [{ type: 'tool_use', id, name: 'submit_versions', input: { versions } }],
    usage: { input_tokens: 1200, output_tokens: 300 },
  });
}

function setup(fetcher: typeof fetch, options: { apiKey?: string | null; enforce?: boolean; entitlements?: EffectiveEntitlement[] } = {}) {
  const reserveQuota = vi.fn<ReserveQuota>(async () => undefined);
  const app = createApp({
    config: readConfig(options.enforce ? { ENFORCE_ENTITLEMENTS: 'true' } : {}),
    verifyToken: async () => 'user-9',
    reserveQuota,
    entitlements: async () => options.entitlements ?? [],
    adCopy: { anthropicApiKey: options.apiKey === null ? undefined : (options.apiKey ?? 'sk-test'), fetcher, log: () => undefined },
  });
  return { app, reserveQuota };
}

const body = {
  app: 'bigtable',
  appName: 'BigTable',
  listing: { subtitle: 'Family meal planning', description: 'Plan meals and shop the list together.' },
  brief: 'Get busy parents to try planning a week of dinners.',
  audience: 'Parents with kids at home',
  tone: 'warm',
  platforms: [
    { id: 'instagram', name: 'Instagram', primary: 125, headline: 40 },
    { id: 'youtube', name: 'YouTube', primary: 90, headline: 40 },
    { id: 'snapchat', name: 'Snapchat', primary: 0, headline: 34 },
  ],
  count: 3,
  avoid: ['Feed the whole crew.'],
};

function write(app: ReturnType<typeof setup>['app'], payload: unknown = body) {
  return app.request('/v1/marketing/ad-copy', { method: 'POST', headers: json, body: JSON.stringify(payload) });
}

describe('POST /v1/marketing/ad-copy', () => {
  it('writes versions through a forced tool call, sized to the tightest platform', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => claudeReply([good, good, good]));
    const { app, reserveQuota } = setup(fetcher);
    const response = await write(app);

    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.versions).toHaveLength(3);
    expect(result.versions[0]).toMatchObject({ ...good, tooLong: [] });
    expect(result.limits).toEqual({ line: 28, headline: 34, primary: 90 });
    expect(reserveQuota).toHaveBeenCalledWith('user-9', 'marketing');
    expect(fetcher).toHaveBeenCalledTimes(1);

    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('https://api.anthropic.com/v1/messages');
    const sent = JSON.parse(String(init?.body));
    expect(sent.model).toBe('claude-sonnet-5-5');
    expect(sent.tool_choice).toEqual({ type: 'tool', name: 'submit_versions' });
    expect(sent.messages[0].content).toContain('Family meal planning');
    expect(sent.messages[0].content).toContain('headline: at most 34');
    expect(sent.messages[0].content).toContain('- Feed the whole crew.');
    expect(JSON.stringify(sent)).not.toContain('user-9');
    expect(sent).not.toHaveProperty('metadata');
  });

  it('asks once to shorten only what is too long, then flags what still is', async () => {
    const long = { ...good, headline: 'A headline that is far too long for Snapchat ads' };
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(claudeReply([good, long]))
      .mockResolvedValueOnce(claudeReply([good, { ...long, headline: 'Still a bit too long for Snapchat' + '!!' }], 'toolu_2'));
    const { app } = setup(fetcher);
    const response = await write(app, { ...body, count: 2 });

    expect(response.status).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const retry = JSON.parse(String(fetcher.mock.calls[1]![1]?.body));
    expect(retry.messages).toHaveLength(3);
    expect(retry.messages[1].content[0]).toMatchObject({ type: 'tool_use', id: 'toolu_1' });
    expect(retry.messages[2].content[0].content).toContain('Version 2 headline');
    expect(retry.messages[2].content[0].content).not.toContain('Version 1');
    const result = await response.json();
    expect(result.versions[0].tooLong).toEqual([]);
    expect(result.versions[1].tooLong).toEqual(['headline']);
  });

  it('keeps the first versions when the shortening call fails', async () => {
    const long = { ...good, primary: 'x'.repeat(120) };
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(claudeReply([long]))
      .mockResolvedValueOnce(new Response('busy', { status: 529 }));
    const response = await write(setup(fetcher).app, { ...body, count: 1 });
    expect(response.status).toBe(200);
    expect((await response.json()).versions[0].tooLong).toEqual(['primary']);
  });

  it('needs Hearth+ when plans are enforced, and checks before calling Claude', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => claudeReply([good]));
    const denied = setup(fetcher, { enforce: true, entitlements: [{ id: 'bigtable_plus', expiresAt: null, source: 'own' }] });
    expect((await write(denied.app)).status).toBe(402);
    expect(fetcher).not.toHaveBeenCalled();
    expect(denied.reserveQuota).not.toHaveBeenCalled();

    const allowed = setup(fetcher, { enforce: true, entitlements: [{ id: 'hearth_plus', expiresAt: null, source: 'household' }] });
    expect((await write(allowed.app, { ...body, count: 1 })).status).toBe(200);
  });

  it('answers 502 out of shape or on failure, 503 without a key, 400 for a bad request', async () => {
    expect((await write(setup(vi.fn<typeof fetch>(async () => claudeReply([{ ...good, cta: 'Buy now' }]))).app)).status).toBe(502);
    expect((await write(setup(vi.fn<typeof fetch>(async () => new Response('no', { status: 500 }))).app)).status).toBe(502);
    expect((await write(setup(vi.fn<typeof fetch>(), { apiKey: null }).app)).status).toBe(503);
    expect((await write(setup(vi.fn<typeof fetch>()).app, { ...body, platforms: [] })).status).toBe(400);
  });
});

describe('ad limits', () => {
  it('uses the tightest platform for each field, ignoring platforms without one', () => {
    expect(adLimits([{ id: 'x', name: 'X', primary: 280, headline: 70 }])).toEqual({ line: 28, headline: 70, primary: 280 });
    expect(adLimits([{ id: 'snapchat', name: 'Snapchat', primary: 0, headline: 34 }])).toEqual({ line: 28, headline: 34, primary: 125 });
  });

  it('counts characters, not UTF-16 units', () => {
    expect(overLimit({ ...good, line1: '🍝'.repeat(28) }, { line: 28, headline: 40, primary: 125 })).toEqual([]);
  });

  it('leaves out listing fields that were not sent', () => {
    const message = adCopyUserMessage(
      { ...body, listing: {}, tone: 'direct', count: 3, avoid: [] } as never,
      { line: 28, headline: 40, primary: 125 },
    );
    expect(message).not.toContain('App Store description');
    expect(message).not.toContain('Already written');
    expect(message).toContain('benefit first');
  });
});

describe('ad copy upstream errors', () => {
  it('asks again with thinking off when the model refuses a forced tool call', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ type: 'error', error: { type: 'invalid_request_error', message: 'Thinking may not be enabled when tool_choice forces tool use.' } }, { status: 400 }))
      .mockResolvedValueOnce(claudeReply([good]));
    const response = await write(setup(fetcher).app, { ...body, count: 1 });
    expect(response.status).toBe(200);
    expect(JSON.parse(String(fetcher.mock.calls[1]![1]?.body)).thinking).toEqual({ type: 'disabled' });
  });

  it('says what Claude objected to', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ type: 'error', error: { type: 'not_found_error', message: 'model: claude-nope' } }, { status: 404 }));
    const response = await write(setup(fetcher).app);
    expect(response.status).toBe(502);
    expect(JSON.stringify(await response.json())).toContain('not_found_error: model: claude-nope');
  });
});
