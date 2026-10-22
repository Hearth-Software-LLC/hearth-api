import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { readConfig } from '../../src/config.js';
import { findIdentifiers } from '../../src/ember/privacy.js';
import { anthropicPayload } from '../../src/ember/routes.js';
import type { EmberTurn } from '../../src/ember/routes.js';
import type { ReserveQuota } from '../../src/services/quota.js';

const json = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' };

const baseTurn: EmberTurn = {
  profile: 'quick',
  client: 'iphone',
  locale: 'en_US',
  timeZone: 'America/Denver',
  now: 'Thursday, October 22, 2026 at 5:40 PM',
  roster: [{ token: '[P1]', role: 'parent', ageBand: 'adult' }, { token: '[P2]', role: 'kid', ageBand: '5–12' }],
  messages: [{ role: 'user', content: [{ type: 'text', text: "What's for dinner? [P2] has practice at 5." }] }],
  tools: ['meals_planned', 'meal_fits_household'],
  allowWebSearch: false,
};

/** Anthropic's streamed reply, as Server-Sent Events. */
function anthropicStream(events: unknown[]) {
  const body = events.map((event) => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function setup(fetcher: typeof fetch, apiKey: string | null = 'sk-test') {
  const reserveQuota = vi.fn<ReserveQuota>(async () => undefined);
  const app = createApp({
    config: readConfig({}),
    verifyToken: async () => 'user-7',
    reserveQuota,
    ember: { anthropicApiKey: apiKey ?? undefined, fetcher, log: () => undefined },
  });
  return { app, reserveQuota };
}

function events(text: string) {
  return text.trim().split('\n\n').map((chunk) => {
    const event = /event: (.+)/.exec(chunk)?.[1];
    const data = /data: (.+)/.exec(chunk)?.[1];
    return { event, data: data ? JSON.parse(data) : undefined };
  });
}

describe('POST /v1/ember/turn', () => {
  it('streams text and the device tool calls, and sends Anthropic no identity', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => anthropicStream([
      { type: 'message_start', message: { usage: { input_tokens: 900, cache_read_input_tokens: 800 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Let me check. ' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'meals_planned', input: {} } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"days":"to' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'day","meal":"dinner"}' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 40 } },
      { type: 'message_stop' },
    ]));
    const { app, reserveQuota } = setup(fetcher);

    const response = await app.request('/v1/ember/turn', { method: 'POST', headers: json, body: JSON.stringify(baseTurn) });
    expect(response.status).toBe(200);
    expect(events(await response.text())).toEqual([
      { event: 'text', data: { text: 'Let me check. ' } },
      { event: 'tool_use', data: { id: 'toolu_1', name: 'meals_planned', input: { days: 'today', meal: 'dinner' } } },
      { event: 'done', data: { stopReason: 'tool_use' } },
    ]);
    expect(reserveQuota).toHaveBeenCalledWith('user-7', 'ember');

    const [, init] = fetcher.mock.calls[0]!;
    const sent = JSON.parse(String(init?.body));
    expect(sent.model).toBe('claude-haiku-5-5');
    expect(sent.metadata).toBeUndefined();
    expect(JSON.stringify(sent)).not.toContain('user-7');
    expect(JSON.stringify(sent)).not.toContain('test-token');
    expect(sent.tools.map((tool: { name: string }) => tool.name)).toEqual(['meals_planned', 'meal_fits_household']);
    expect(sent.system[0].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('refuses text that still carries an identifier, before calling Anthropic', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const { app, reserveQuota } = setup(fetcher);
    for (const leak of ['Text mom at 801-555-0134', 'Email sam@example.com the list', 'My card is 4111 1111 1111 1111', 'Meet at 1450 Maple Grove Drive']) {
      const turn = { ...baseTurn, messages: [{ role: 'user', content: [{ type: 'text', text: leak }] }] };
      const response = await app.request('/v1/ember/turn', { method: 'POST', headers: json, body: JSON.stringify(turn) });
      expect(response.status).toBe(422);
      expect((await response.json()).error.code).toBe('PRIVACY_GUARD');
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(reserveQuota).not.toHaveBeenCalled();
  });

  it('checks tool results too', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const { app } = setup(fetcher);
    const turn: EmberTurn = {
      ...baseTurn,
      messages: [
        ...baseTurn.messages,
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'meals_planned', input: { days: 'today', meal: 'dinner' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Dinner at https://example.com/menu' }] },
      ],
    };
    const response = await app.request('/v1/ember/turn', { method: 'POST', headers: json, body: JSON.stringify(turn) });
    expect(response.status).toBe(422);
  });

  it('rejects tools the server does not know and names in the roster', async () => {
    const { app } = setup(vi.fn<typeof fetch>());
    const unknownTool = await app.request('/v1/ember/turn', { method: 'POST', headers: json, body: JSON.stringify({ ...baseTurn, tools: ['read_messages'] }) });
    expect(unknownTool.status).toBe(400);
    const named = await app.request('/v1/ember/turn', { method: 'POST', headers: json, body: JSON.stringify({ ...baseTurn, roster: [{ token: 'Mia', role: 'kid' }] }) });
    expect(named.status).toBe(400);
  });

  it('uses the planning model for planning turns, and the quick one on Apple Watch', () => {
    expect(anthropicPayload({ ...baseTurn, profile: 'plan' }, 'plan-model').max_tokens).toBe(900);
    expect(anthropicPayload({ ...baseTurn, allowWebSearch: true }, 'm').tools.at(-1)).toMatchObject({ name: 'web_search', cache_control: { type: 'ephemeral' } });
  });

  it('answers 503 when Claude is not configured', async () => {
    const { app } = setup(vi.fn<typeof fetch>(), null);
    const response = await app.request('/v1/ember/turn', { method: 'POST', headers: json, body: JSON.stringify(baseTurn) });
    expect(response.status).toBe(503);
  });

  it('streams an error event when Anthropic fails', async () => {
    const { app } = setup(vi.fn<typeof fetch>(async () => new Response('{}', { status: 529 })));
    const response = await app.request('/v1/ember/turn', { method: 'POST', headers: json, body: JSON.stringify(baseTurn) });
    expect(events(await response.text())).toEqual([{ event: 'error', data: { code: 'UPSTREAM_FAILED' } }]);
  });
});

describe('Ember privacy guard', () => {
  it('lets tokens, times, money and dates through', () => {
    expect(findIdentifiers('[P1] has soccer at 5:40 PM; dinner is $86 left of $300 on 2026-10-24. [N1] is coming.')).toEqual([]);
  });
});
