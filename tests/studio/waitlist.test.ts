import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { createApp } from '../../src/app.js';
import { readConfig } from '../../src/config.js';
import { createLinkService } from '../../src/affiliates/links.js';
import type { Resend } from '../../src/email/resend.js';
import { verifyResendWebhook } from '../../src/email/resend.js';
import { createTeamService } from '../../src/studio/team.js';
import { createWaitlistService, normalizeEmail, readToken, signToken } from '../../src/waitlist/service.js';
import { PUBLIC_BETA } from '../../src/waitlist/routes.js';
import { migrate, reset } from './database.js';

describe('waitlist helpers', () => {
  it('signs and reads confirm tokens, and refuses tampered or expired ones', () => {
    const key = Buffer.alloc(32, 1);
    const token = signToken(key, { id: 'abc', exp: 2_000 });
    expect(readToken(key, token, 1_000_000)).toEqual({ id: 'abc' });
    expect(readToken(key, token, 2_001_000)).toBeUndefined();
    expect(readToken(Buffer.alloc(32, 2), token, 1_000_000)).toBeUndefined();
    expect(readToken(key, `${token}x`, 1_000_000)).toBeUndefined();
    expect(readToken(key, 'nonsense', 1_000_000)).toBeUndefined();
  });

  it('normalizes addresses and rejects junk', () => {
    expect(normalizeEmail('  Pat@Example.COM ')).toBe('pat@example.com');
    expect(() => normalizeEmail('pat')).toThrow();
    expect(() => normalizeEmail('pat@localhost')).toThrow();
    expect(() => normalizeEmail('<script>@x.com')).toThrow();
  });

  it('verifies Resend (Svix) webhook signatures', () => {
    const secret = `whsec_${Buffer.alloc(24, 5).toString('base64')}`;
    const body = '{"type":"email.bounced"}';
    const now = 1_780_000_000_000;
    const timestamp = String(now / 1000);
    const signature = createHmac('sha256', Buffer.alloc(24, 5)).update(`msg_1.${timestamp}.${body}`).digest('base64');
    expect(verifyResendWebhook(secret, { id: 'msg_1', timestamp, signature: `v1,bogus v1,${signature}` }, body, now)).toBe(true);
    expect(verifyResendWebhook(secret, { id: 'msg_1', timestamp, signature: `v1,${signature}` }, `${body} `, now)).toBe(false);
    expect(verifyResendWebhook(secret, { id: 'msg_1', timestamp, signature: `v1,${signature}` }, body, now + 600_000)).toBe(false);
    expect(verifyResendWebhook(secret, { id: 'msg_1', timestamp }, body, now)).toBe(false);
  });

  it('knows which /v1 paths are public', () => {
    expect(PUBLIC_BETA.test('/v1/waitlist')).toBe(true);
    expect(PUBLIC_BETA.test('/v1/waitlist/confirm')).toBe(true);
    expect(PUBLIC_BETA.test('/v1/beta')).toBe(true);
    expect(PUBLIC_BETA.test('/v1/beta/sated')).toBe(true);
    expect(PUBLIC_BETA.test('/v1/studio/beta')).toBe(false);
    expect(PUBLIC_BETA.test('/v1/beta/sated/x')).toBe(false);
  });
});

// Against a real Postgres: set SOCIAL_TEST_DATABASE_URL (or HEARKEN_TEST_DATABASE_URL) to an empty scratch database.
const url = process.env.SOCIAL_TEST_DATABASE_URL ?? process.env.HEARKEN_TEST_DATABASE_URL;

const steve = '00000000-0000-4000-8000-0000000000aa';
const stranger = '00000000-0000-4000-8000-0000000000bb';
const users: Record<string, string> = { steve, stranger };

function fakeResend() {
  const sent: { to: string; subject: string; html: string; text: string }[] = [];
  const contacts = new Map<string, Set<string>>();
  const segments = new Map<string, string>();
  const broadcasts: { segmentId: string; subject: string; html: string }[] = [];
  const resend: Resend = {
    send: async (email) => { sent.push(email); return { id: `email-${sent.length}` }; },
    addToSegments: async (email, ids) => {
      const existing = contacts.get(email);
      const set = existing ?? new Set<string>();
      for (const id of ids) set.add(id);
      contacts.set(email, set);
      return { id: existing ? null : `contact-${email}` };
    },
    removeContact: async (email) => { contacts.delete(email); },
    segment: async (name) => {
      if (!segments.has(name)) segments.set(name, `segment-${segments.size + 1}`);
      return segments.get(name)!;
    },
    broadcast: async (input) => { broadcasts.push(input); return { id: `broadcast-${broadcasts.length}` }; },
  };
  return { resend, sent, contacts, segments, broadcasts };
}

describe.skipIf(!url)('beta waitlist (Postgres)', () => {
  let sql: postgres.Sql;
  let release: (() => Promise<void>) | undefined;
  let app: ReturnType<typeof createApp>;
  let mail: ReturnType<typeof fakeResend>;
  let clock: number;
  let allowed: boolean;

  beforeAll(async () => {
    sql = postgres(url!, { max: 4, onnotice: () => undefined });
    release = await migrate(sql);
  });
  afterAll(async () => { await release?.(); await sql?.end(); });

  beforeEach(async () => {
    await reset(sql);
    mail = fakeResend();
    clock = Date.parse('2026-11-02T16:00:00Z');
    allowed = true;
    const now = () => clock;
    app = createApp({
      config: readConfig({ SOCIAL_OWNER_IDS: steve, SOCIAL_TOKEN_KEY: Buffer.alloc(32, 7).toString('base64') }),
      verifyToken: async (bearer) => ({ userId: users[bearer] ?? stranger, isAnonymous: bearer === 'anonymous' }),
      reserveQuota: async () => undefined,
      entitlements: async () => [],
      studio: { team: createTeamService(sql, { ownerIds: [steve] }), sql },
      affiliates: { links: createLinkService(sql, { shortBase: 'https://hearthapps.com/go', siteBase: 'https://hearthapps.com' }) },
      waitlist: {
        service: createWaitlistService(sql, {
          resend: mail.resend, tokenKey: Buffer.alloc(32, 9), apiBase: 'https://api.hearthapps.com', siteBase: 'https://hearthapps.com', now,
        }),
        allow: async () => allowed,
      },
    });
  });

  const call = async (who: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await app.request(path, {
      method,
      headers: {
        ...(who ? { Authorization: `Bearer ${who}` } : {}), ...headers,
        ...(body === undefined || typeof body === 'string' ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    });
    const text = await response.text();
    const json = response.headers.get('content-type')?.includes('json');
    return { status: response.status, body: text && json ? JSON.parse(text) : text, headers: response.headers };
  };
  const confirmLink = () => {
    const match = /https:\/\/api\.hearthapps\.com(\/v1\/waitlist\/confirm\?t=[^"\s]+)/.exec(mail.sent.at(-1)!.text);
    return decodeURI(match![1]!);
  };

  it('signs up, confirms once, and adds the person to each app’s segment', async () => {
    const joined = await call(null, 'POST', '/v1/waitlist', { email: 'Pat@Example.com', apps: ['sated', 'suffice'], page: '/beta/sated' });
    expect(joined.status).toBe(202);
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]).toMatchObject({ to: 'pat@example.com', subject: 'Confirm: hear when Sated and Suffice launches' });

    // Signing up again straight away doesn't send another email, and says nothing different.
    expect((await call(null, 'POST', '/v1/waitlist', { email: 'pat@example.com', apps: ['sated'] })).status).toBe(202);
    expect(mail.sent).toHaveLength(1);

    const confirmed = await call(null, 'GET', confirmLink());
    expect(confirmed.status).toBe(302);
    expect(confirmed.headers.get('location')).toBe('https://hearthapps.com/beta/confirmed?apps=sated,suffice');
    expect([...mail.contacts.get('pat@example.com')!]).toHaveLength(2);
    expect([...mail.segments.keys()].sort()).toEqual(['Waitlist · Sated', 'Waitlist · Suffice']);

    // Confirmed already: a new app goes straight into its segment, no email.
    await call(null, 'POST', '/v1/waitlist', { email: 'pat@example.com', apps: ['caloma'] });
    expect(mail.sent).toHaveLength(1);
    expect(mail.contacts.get('pat@example.com')!.size).toBe(3);

    await call('steve', 'GET', '/v1/studio/me');
    const summary = await call('steve', 'GET', '/v1/studio/beta/summary?days=7');
    expect(summary.status).toBe(200);
    expect(summary.body.apps.find((entry: { app: string }) => entry.app === 'sated').waitlist).toEqual({ confirmed: 1, pending: 0, new: 1 });
    expect(summary.body.totals.confirmed).toBe(3);
  });

  it('refuses expired and forged links, bad addresses and unknown apps', async () => {
    await call(null, 'POST', '/v1/waitlist', { email: 'pat@example.com', apps: ['sated'] });
    const link = confirmLink();
    clock += 8 * 86_400_000;
    expect((await call(null, 'GET', link)).headers.get('location')).toBe('https://hearthapps.com/beta/confirmed?status=expired');
    expect((await call(null, 'GET', '/v1/waitlist/confirm?t=abc.def')).headers.get('location')).toBe('https://hearthapps.com/beta/confirmed?status=expired');
    expect((await call(null, 'POST', '/v1/waitlist', { email: 'not-an-email', apps: ['sated'] })).status).toBe(400);
    expect((await call(null, 'POST', '/v1/waitlist', { email: 'pat@example.com', apps: ['bigtable'] })).status).toBe(400);
    expect((await call(null, 'POST', '/v1/waitlist', { email: 'pat@example.com', apps: [] })).status).toBe(400);
  });

  it('takes plain form posts, ignores the honeypot and rate-limits', async () => {
    const form = { 'Content-Type': 'application/x-www-form-urlencoded' };
    const posted = await call(null, 'POST', '/v1/waitlist', 'email=sam%40example.com&apps=sated&apps=trove&via=sated-launch-teaser', form);
    expect(posted.status).toBe(303);
    expect(posted.headers.get('location')).toBe('https://hearthapps.com/beta/thanks?apps=sated,trove');
    expect(mail.sent.at(-1)!.subject).toBe('Confirm: hear when Sated and Trove launches');
    const [row] = await sql`select apps, via from waitlist where email = 'sam@example.com'`;
    expect(row).toMatchObject({ apps: ['sated', 'trove'], via: 'sated-launch-teaser' });

    const invalid = await call(null, 'POST', '/v1/waitlist', 'email=nope&apps=sated', form);
    expect(invalid.headers.get('location')).toBe('https://hearthapps.com/beta/thanks?status=invalid');

    const bot = await call(null, 'POST', '/v1/waitlist', { email: 'bot@example.com', apps: ['sated'], company: 'Spam Inc' });
    expect(bot.status).toBe(202);
    expect((await sql`select 1 from waitlist where email = 'bot@example.com'`).length).toBe(0);

    allowed = false;
    expect((await call(null, 'POST', '/v1/waitlist', { email: 'lee@example.com', apps: ['sated'] })).status).toBe(429);
  });

  it('answers the website’s CORS preflight', async () => {
    const response = await app.request('/v1/waitlist', {
      method: 'OPTIONS', headers: { Origin: 'https://hearthapps.com', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('https://hearthapps.com');
  });

  it('serves beta pages and lets the team change what’s new', async () => {
    const pages = await call(null, 'GET', '/v1/beta');
    expect(pages.body.apps.map((entry: { key: string }) => entry.key)).toEqual(['caloma', 'ember', 'hearken', 'sated', 'suffice', 'trove']);
    expect(pages.headers.get('cache-control')).toBe('public, max-age=300');

    await call('steve', 'GET', '/v1/studio/me');
    const changed = await call('steve', 'PUT', '/v1/studio/beta/sated', { whatsNew: ['Restaurant menus read for you', '  '] });
    expect(changed.status).toBe(400);
    const ok = await call('steve', 'PUT', '/v1/studio/beta/sated', { whatsNew: ['Restaurant menus read for you'] });
    expect(ok.body.whatsNew).toEqual(['Restaurant menus read for you']);
    expect((await call(null, 'GET', '/v1/beta/sated')).body.whatsNew).toEqual(['Restaurant menus read for you']);
    expect((await call(null, 'GET', '/v1/beta/bigtable')).status).toBe(404);
    expect((await call('stranger', 'PUT', '/v1/studio/beta/sated', { whatsNew: [] })).status).toBe(403);
  });

  it('counts beta short links and TestFlight taps, and credits them to the post’s link', async () => {
    await call('steve', 'GET', '/v1/studio/me');
    const made = await call('steve', 'POST', '/v1/studio/links', { app: 'sated', name: 'Launch teaser', destination: 'beta', slug: 'sated-teaser' });
    expect(made.status).toBe(200);
    expect(made.body).toMatchObject({ destination: 'beta', appStoreId: null, url: 'https://hearthapps.com/beta/sated?via=sated-teaser', shortUrl: 'https://hearthapps.com/go/sated-teaser' });
    expect((await call('steve', 'POST', '/v1/studio/links', { app: 'bigtable', name: 'Nope', destination: 'beta' })).status).toBe(400);
    expect((await call('steve', 'POST', '/v1/studio/links', { app: 'sated', name: 'No id' })).status).toBe(400);

    const browser = { 'User-Agent': 'Mozilla/5.0 (iPhone)' };
    const go = await call(null, 'GET', '/go/sated-teaser', undefined, browser);
    expect(go.headers.get('location')).toBe('https://hearthapps.com/beta/sated?via=sated-teaser');
    const tf = await call(null, 'GET', '/go/tf/sated?via=sated-teaser', undefined, browser);
    expect(tf.status).toBe(302);
    expect(tf.headers.get('location')).toBe('https://testflight.apple.com/join/pp2V9MdA');
    await call(null, 'GET', '/go/tf/sated', undefined, browser);
    await call(null, 'GET', '/go/tf/sated', undefined, { 'User-Agent': 'facebookexternalhit/1.1' });
    expect((await call(null, 'GET', '/go/tf/nothing', undefined, browser)).status).toBe(404);

    const summary = await call('steve', 'GET', '/v1/studio/beta/summary');
    const sated = summary.body.apps.find((entry: { app: string }) => entry.app === 'sated');
    expect(sated).toMatchObject({ testflightTaps: 2, pageTaps: 1 });
    const [credited] = await sql`select sum(taps) as n from testflight_taps_daily where link_id is not null`;
    expect(Number(credited!.n)).toBe(1);

    // Old app builds list App Store links only; beta links when asked.
    expect((await call('steve', 'GET', '/v1/studio/links')).body.links).toHaveLength(0);
    expect((await call('steve', 'GET', '/v1/studio/links?destination=beta')).body.links).toHaveLength(1);
  });

  it('previews and sends the launch email once, to confirmed people only; owners and admins', async () => {
    await call(null, 'POST', '/v1/waitlist', { email: 'pat@example.com', apps: ['sated'] });
    await call(null, 'GET', confirmLink());
    await call(null, 'POST', '/v1/waitlist', { email: 'unconfirmed@example.com', apps: ['sated'] });
    await call('steve', 'GET', '/v1/studio/me');

    const body = { app: 'sated', appStoreUrl: 'https://apps.apple.com/app/id1234567890' };
    const preview = await call('steve', 'POST', '/v1/studio/waitlist/launch', body);
    expect(preview.body).toMatchObject({ subject: 'Sated is on the App Store', recipients: 1 });
    expect(preview.body.html).toContain('{{{RESEND_UNSUBSCRIBE_URL}}}');
    expect(mail.broadcasts).toHaveLength(0);

    expect((await call('stranger', 'POST', '/v1/studio/waitlist/launch', { ...body, send: true })).status).toBe(403);
    const sent = await call('steve', 'POST', '/v1/studio/waitlist/launch', { ...body, send: true });
    expect(sent.body).toEqual({ broadcastId: 'broadcast-1', recipients: 1 });
    expect(mail.broadcasts[0]!.segmentId).toBe(mail.segments.get('Waitlist · Sated'));
    expect((await call('steve', 'POST', '/v1/studio/waitlist/launch', { ...body, send: true })).status).toBe(409);
    expect((await call('steve', 'POST', '/v1/studio/waitlist/launch', { app: 'sated', appStoreUrl: 'https://evil.example.com' })).status).toBe(400);
  });

  it('removes people on request and stops email after bounces and unsubscribes', async () => {
    await call(null, 'POST', '/v1/waitlist', { email: 'pat@example.com', apps: ['sated'] });
    await call(null, 'GET', confirmLink());
    await call('steve', 'GET', '/v1/studio/me');
    expect((await call('steve', 'DELETE', '/v1/studio/waitlist?email=PAT@example.com')).status).toBe(200);
    expect((await sql`select 1 from waitlist`).length).toBe(0);
    expect(mail.contacts.has('pat@example.com')).toBe(false);

    const service = createWaitlistService(sql, { resend: mail.resend, tokenKey: Buffer.alloc(32, 9), apiBase: 'https://api.hearthapps.com', siteBase: 'https://hearthapps.com' });
    await service.join({ email: 'lee@example.com', apps: ['sated'] });
    expect(await service.webhook({ type: 'email.bounced', data: { to: ['Lee@example.com'] } })).toEqual({ handled: true });
    const sentBefore = mail.sent.length;
    await service.join({ email: 'lee@example.com', apps: ['trove'] });
    expect(mail.sent.length).toBe(sentBefore);
    expect(await service.webhook({ type: 'contact.updated', data: { email: 'lee@example.com', unsubscribed: true } })).toEqual({ handled: true });
    expect(await service.webhook({ type: 'email.delivered', data: { to: ['lee@example.com'] } })).toEqual({ handled: false });
  });
});
