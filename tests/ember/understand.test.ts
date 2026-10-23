import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { readConfig } from '../../src/config.js';
import { understandPayload } from '../../src/ember/understand.js';
import type { ReserveQuota } from '../../src/services/quota.js';

const json = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' };

function claudeReply(input: Record<string, unknown>) {
  return Response.json({
    content: [{ type: 'tool_use', id: 'toolu_1', name: 'submit_request', input }],
    usage: { input_tokens: 900, output_tokens: 40 },
  });
}

function setup(fetcher: typeof fetch, apiKey: string | null = 'sk-test') {
  const reserveQuota = vi.fn<ReserveQuota>(async () => undefined);
  const app = createApp({
    config: readConfig({}),
    verifyToken: async () => 'user-7',
    reserveQuota,
    emberUnderstand: { anthropicApiKey: apiKey ?? undefined, fetcher, log: () => undefined },
  });
  return { app, reserveQuota };
}

function understand(app: ReturnType<typeof setup>['app'], body: unknown) {
  return app.request('/v1/ember/understand', { method: 'POST', headers: json, body: JSON.stringify(body) });
}

const base = { now: 'Thursday, October 22, 2026 at 12:00 PM', timeZone: 'America/Denver' };

describe('POST /v1/ember/understand', () => {
  it('returns the typed request from a forced tool call, sending nothing about the person', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => claudeReply({
      intent: 'spending', whenWords: 'on October 10', who: '', placeWords: '', townWords: '', budgetWords: '',
      items: [], amountWords: '', isFollowUp: false, clarify: '',
    }));
    const { app, reserveQuota } = setup(fetcher);
    const response = await understand(app, { question: 'How much did we spend on October 10?', ...base });

    expect(response.status).toBe(200);
    expect((await response.json()).request).toMatchObject({ intent: 'spending', whenWords: 'on October 10' });
    expect(reserveQuota).toHaveBeenCalledWith('user-7', 'ember');

    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('https://api.anthropic.com/v1/messages');
    const sent = JSON.parse(String(init?.body));
    expect(sent.tool_choice).toEqual({ type: 'tool', name: 'submit_request' });
    expect(sent.messages).toEqual([{ role: 'user', content: 'How much did we spend on October 10?' }]);
    expect(JSON.stringify(sent)).not.toContain('user-7');
    expect(sent).not.toHaveProperty('metadata');
  });

  it('fills fields Claude left out with empty values', async () => {
    const { app } = setup(vi.fn<typeof fetch>(async () => claudeReply({ intent: 'call', who: '[P2]' })));
    const response = await understand(app, { question: 'Call [P2]', ...base });
    expect(response.status).toBe(200);
    expect((await response.json()).request).toMatchObject({ intent: 'call', who: '[P2]', townWords: '', items: [] });
  });

  it('refuses a question that carries an identifier, before calling Claude', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const { app } = setup(fetcher);
    expect((await understand(app, { question: 'Text (801) 555-0134 that I’m late', ...base })).status).toBe(422);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('answers 502 for an unknown intent or a failed call, and 503 without a key', async () => {
    expect((await understand(setup(vi.fn<typeof fetch>(async () => claudeReply({ intent: 'launch_rocket' }))).app, { question: 'Hi', ...base })).status).toBe(502);
    expect((await understand(setup(vi.fn<typeof fetch>(async () => new Response('no', { status: 500 }))).app, { question: 'Hi', ...base })).status).toBe(502);
    expect((await understand(setup(vi.fn<typeof fetch>(), null).app, { question: 'Hi', ...base })).status).toBe(503);
  });

  it('mentions the previous question only for deciding a follow-up', () => {
    const payload = understandPayload({ question: 'What about last week?', previous: { question: 'How much at Costco?', intent: 'spending' }, ...base }, 'claude-haiku-5-5');
    expect(payload.messages[0]!.content).toContain('Use it only to decide isFollowUp');
    expect(payload.max_tokens).toBe(300);
  });
});
