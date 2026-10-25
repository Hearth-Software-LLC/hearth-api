import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { roomFor } from '../src/intercom/caloma.js';
import { createCloudflareTurn } from '../src/intercom/caloma.js';
import type { CalomaIntercomDependencies, IntercomDevice, IntercomStore, PlusUntil, TurnIssuer } from '../src/intercom/caloma.js';
import type { ApnsMessage, ApnsResult } from '../src/integrations/apns.js';

const secret = 'a'.repeat(43);
const phone = '11111111-1111-4111-8111-111111111111';
const ipad = '22222222-2222-4222-8222-222222222222';
const call = '33333333-3333-4333-8333-333333333333';
const token = (digit: string) => digit.repeat(64);

function memoryStore() {
  const rooms = new Map<string, Map<string, IntercomDevice>>();
  const plus = new Map<string, PlusUntil>();
  const store: IntercomStore = {
    async hasPlus(room) {
      return [...(rooms.get(room)?.keys() ?? [])].some((id) => {
        const until = plus.get(`${room}/${id}`);
        return until === 'forever' || (typeof until === 'string' && new Date(until) > new Date());
      });
    },
    async register(room, device, until) {
      if (until !== undefined) plus.set(`${room}/${device.device}`, until);
      for (const [other, devices] of rooms) {
        if (other === room) continue;
        for (const [id, saved] of devices) if (saved.token === device.token) devices.delete(id);
      }
      const devices = rooms.get(room) ?? new Map();
      const saved = devices.get(device.device);
      devices.set(device.device, { ...device, alertToken: device.alertToken ?? saved?.alertToken });
      rooms.set(room, devices);
    },
    async devices(room, ids) { return ids.flatMap((id) => rooms.get(room)?.get(id) ?? []); },
    async forget(room, ids) { for (const id of ids) rooms.get(room)?.delete(id); },
    async hasRoom(room) { return (rooms.get(room)?.size ?? 0) > 0; },
    async forgetAlerts(room, ids) {
      for (const id of ids) {
        const saved = rooms.get(room)?.get(id);
        if (saved) saved.alertToken = undefined;
      }
    },
  };
  return { store, rooms };
}

function setup(result: ApnsResult = 'sent', turn?: TurnIssuer, extra: Partial<CalomaIntercomDependencies> = {}) {
  const sent: ApnsMessage[] = [];
  const { store, rooms } = memoryStore();
  const app = createApp({
    calomaIntercom: {
      store,
      ...(turn ? { turn } : {}),
      ...extra,
      apns: async (messages) => { sent.push(...messages); return messages.map(() => result); },
    },
  });
  const post = (path: string, body: unknown, bearer?: string) => app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
    body: JSON.stringify(body),
  });
  return { post, sent, rooms };
}

describe('Caloma intercom relay', () => {
  it('saves a device under the hashed secret, without sign-in', async () => {
    const { post, rooms } = setup();
    const response = await post('/caloma/intercom/devices', { secret, device: ipad, token: token('B'), environment: 'sandbox' });
    expect(response.status).toBe(204);
    expect([...rooms.keys()]).toEqual([roomFor(secret)]);
    expect(rooms.get(roomFor(secret))?.get(ipad)).toEqual({ device: ipad, token: token('b'), environment: 'sandbox', alertToken: undefined });
  });

  it('wakes the called devices with a VoIP push, never the caller', async () => {
    const { post, sent } = setup();
    await post('/caloma/intercom/devices', { secret, device: ipad, token: token('b'), environment: 'production' });
    await post('/caloma/intercom/devices', { secret, device: phone, token: token('c'), environment: 'production' });
    const response = await post('/caloma/intercom/ring', { secret, call, from: phone, name: 'Kitchen', video: true, to: [ipad, phone] });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ woken: [ipad] });
    expect(sent).toEqual([{
      token: token('b'), environment: 'production', topic: 'com.stephenwarren.caloma.voip',
      pushType: 'voip', expiresIn: 0, collapseId: call,
      payload: { intercom: { call, from: phone, name: 'Kitchen', video: true } },
    }]);
  });

  it('only reaches devices in the same household', async () => {
    const { post, sent } = setup();
    await post('/caloma/intercom/devices', { secret: 'b'.repeat(43), device: ipad, token: token('b'), environment: 'sandbox' });
    const response = await post('/caloma/intercom/ring', { secret, call, from: phone, name: 'Kitchen', video: false, to: [ipad] });
    expect(await response.json()).toEqual({ woken: [] });
    expect(sent).toEqual([]);
  });

  it('forgets tokens Apple says are gone', async () => {
    const { post, rooms } = setup('gone');
    await post('/caloma/intercom/devices', { secret, device: ipad, token: token('b'), environment: 'sandbox' });
    await post('/caloma/intercom/ring', { secret, call, from: phone, name: 'Kitchen', video: false, to: [ipad] });
    expect(rooms.get(roomFor(secret))?.size).toBe(0);
  });

  it('moves a token to its new household', async () => {
    const { post, rooms } = setup();
    await post('/caloma/intercom/devices', { secret: 'b'.repeat(43), device: ipad, token: token('b'), environment: 'sandbox' });
    await post('/caloma/intercom/devices', { secret, device: ipad, token: token('b'), environment: 'sandbox' });
    expect(rooms.get(roomFor('b'.repeat(43)))?.size).toBe(0);
    expect(rooms.get(roomFor(secret))?.size).toBe(1);
  });

  it('rejects malformed requests', async () => {
    const { post } = setup();
    expect((await post('/caloma/intercom/devices', { secret: 'short', device: ipad, token: token('b'), environment: 'sandbox' })).status).toBe(400);
    expect((await post('/caloma/intercom/ring', { secret, call, from: phone, name: 'K', video: false, to: [] })).status).toBe(400);
  });

  it('says when the relay is not configured', async () => {
    const response = await createApp().request('/caloma/intercom/ring', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret, call, from: phone, name: 'Kitchen', video: false, to: [ipad] }),
    });
    expect(response.status).toBe(503);
  });

  it('tells devices off the network about a broadcast with an ordinary notification', async () => {
    const { post, sent } = setup();
    await post('/caloma/intercom/devices', { secret, device: ipad, token: token('b'), alertToken: token('d'), environment: 'production' });
    await post('/caloma/intercom/devices', { secret, device: phone, token: token('c'), environment: 'production' });
    const response = await post('/caloma/intercom/broadcast', { secret, call, from: phone, name: 'Steve', to: [ipad, phone] });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ notified: [ipad] });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      token: token('d'), topic: 'com.stephenwarren.caloma', expiresIn: 120, collapseId: call,
      payload: { aps: { alert: { title: 'Steve' } }, intercom: { broadcast: call, from: phone } },
    });
    expect(sent[0]?.pushType).toBeUndefined();
  });

  it('keeps the notification token when a device re-registers without one', async () => {
    const { post, rooms } = setup();
    await post('/caloma/intercom/devices', { secret, device: ipad, token: token('b'), alertToken: token('d'), environment: 'sandbox' });
    await post('/caloma/intercom/devices', { secret, device: ipad, token: token('e'), environment: 'sandbox' });
    expect(rooms.get(roomFor(secret))?.get(ipad)?.alertToken).toBe(token('d'));
  });

  const plusAccounts: Partial<CalomaIntercomDependencies> = {
    verifyToken: async (bearer) => ({ userId: bearer, isAnonymous: false }),
    entitlements: async (userId) => (userId === 'steve'
      ? [{ id: 'hearth_plus', expiresAt: '2999-01-01T00:00:00Z', source: 'own' }]
      : [{ id: 'caloma_plus', expiresAt: null, source: 'own' }]),
  };

  it('calls away from home (TURN) only for households with Hearth+', async () => {
    const turn: TurnIssuer = async () => [{ urls: ['turn:turn.example.com:3478'], username: 'u', credential: 'c' }];
    const { post } = setup('sent', turn, plusAccounts);
    expect((await post('/caloma/intercom/ice', { secret })).status).toBe(403);
    // A board, not signed in: home calls only.
    await post('/caloma/intercom/devices', { secret, device: ipad, token: token('b'), environment: 'sandbox' });
    expect(await (await post('/caloma/intercom/ice', { secret })).json()).toEqual({
      iceServers: [{ urls: ['stun:stun.cloudflare.com:3478'] }], ttl: 43200, awayCalls: false,
    });
    // Caloma Plus alone doesn't include it.
    await post('/caloma/intercom/devices', { secret, device: phone, token: token('c'), environment: 'sandbox' }, 'mom');
    expect((await (await post('/caloma/intercom/ice', { secret })).json() as { awayCalls: boolean }).awayCalls).toBe(false);
    // A phone signed in with Hearth+: the whole household.
    await post('/caloma/intercom/devices', { secret, device: phone, token: token('c'), environment: 'sandbox' }, 'steve');
    expect(await (await post('/caloma/intercom/ice', { secret })).json()).toEqual({
      iceServers: [{ urls: ['turn:turn.example.com:3478'], username: 'u', credential: 'c' }], ttl: 43200, awayCalls: true,
    });
    // Registering again without a token keeps it.
    await post('/caloma/intercom/devices', { secret, device: phone, token: token('c'), environment: 'sandbox' });
    expect((await (await post('/caloma/intercom/ice', { secret })).json() as { awayCalls: boolean }).awayCalls).toBe(true);
  });

  it('falls back to STUN when TURN fails', async () => {
    const { post } = setup('sent', async () => { throw new Error('down'); }, plusAccounts);
    await post('/caloma/intercom/devices', { secret, device: ipad, token: token('b'), environment: 'sandbox' }, 'steve');
    const body = await (await post('/caloma/intercom/ice', { secret })).json() as { iceServers: { urls: string[] }[] };
    expect(body.iceServers).toEqual([{ urls: ['stun:stun.cloudflare.com:3478'] }]);
  });

  it('asks Cloudflare for TURN and drops port 53', async () => {
    let request: { url: string; init: RequestInit | undefined } | undefined;
    const fetcher = (async (url: string, init?: RequestInit) => {
      request = { url, init };
      return new Response(JSON.stringify({ iceServers: [
        { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.cloudflare.com:53'] },
        { urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:53?transport=udp', 'turns:turn.cloudflare.com:5349?transport=tcp'], username: 'u', credential: 'c' },
      ] }), { status: 201 });
    }) as unknown as typeof fetch;
    const servers = await createCloudflareTurn('key', 'token', fetcher)(600);
    expect(request?.url).toBe('https://rtc.live.cloudflare.com/v1/turn/keys/key/credentials/generate-ice-servers');
    expect((request?.init?.headers as Record<string, string>).Authorization).toBe('Bearer token');
    expect(servers).toEqual([
      { urls: ['stun:stun.cloudflare.com:3478'] },
      { urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:5349?transport=tcp'], username: 'u', credential: 'c' },
    ]);
  });
});
