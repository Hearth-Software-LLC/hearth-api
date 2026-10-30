import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { createApp } from '../../src/app.js';
import { readConfig } from '../../src/config.js';
import type { ApnsMessage } from '../../src/integrations/apns.js';
import { createSocialStore } from '../../src/social/store.js';
import { createDocumentsService } from '../../src/studio/documents.js';
import type { GitHubApps } from '../../src/studio/github.js';
import { createLibraryService } from '../../src/studio/library.js';
import type { StudioStorage } from '../../src/studio/library.js';
import { createStudioNotifier } from '../../src/studio/notify.js';
import type { AccountDetail, PlansBackend } from '../../src/studio/plans.js';
import { createTeamService } from '../../src/studio/team.js';
import { migrate, reset } from './database.js';

// Hearth Studio's team, plans, Library, campaigns, designs and pushes against a real Postgres:
// set SOCIAL_TEST_DATABASE_URL (or HEARKEN_TEST_DATABASE_URL) to an empty scratch database.
const url = process.env.SOCIAL_TEST_DATABASE_URL ?? process.env.HEARKEN_TEST_DATABASE_URL;

const steve = '00000000-0000-4000-8000-0000000000aa';
const kristen = '00000000-0000-4000-8000-0000000000cc';
const stranger = '00000000-0000-4000-8000-0000000000bb';
const account = '00000000-0000-4000-8000-0000000000dd';
const users: Record<string, string> = { steve, kristen, stranger };
const sha = (n: number) => n.toString(16).padStart(64, '0');
const token = (n: number) => n.toString(16).padStart(64, 'a');

function fakePlans() {
  const granted = new Map<string, string | null>();
  const detail = (): AccountDetail => ({
    id: account, name: 'Pat', email: 'pat@example.com', apple: true, role: 'solo', organizerName: null, householdSize: 1,
    plans: Object.fromEntries(granted),
    planStates: [{ key: 'hearth_plus', state: granted.has('hearth_plus') ? 'granted' : 'off', expiresAt: granted.get('hearth_plus') ?? null, store: null, willRenew: false }],
    household: null,
  });
  const backend: PlansBackend = {
    search: vi.fn(async () => [detail()]),
    detail: vi.fn(async (id: string) => (id === account ? detail() : undefined)),
    grant: vi.fn(async (_id: string, key: string, until: string | null) => { granted.set(key, until); }),
    revoke: vi.fn(async (_id: string, key: string) => { granted.delete(key); }),
  };
  return backend;
}

describe.skipIf(!url)('Hearth Studio (Postgres)', () => {
  let sql: postgres.Sql;
  let release: (() => Promise<void>) | undefined;
  let app: ReturnType<typeof createApp>;
  let plans: ReturnType<typeof fakePlans>;
  let removed: string[];
  let put: string[];
  let teamId: string;

  const storage: StudioStorage = {
    uploadUrl: async (path) => ({ url: `https://storage.test/upload/${path}`, token: 'upload-token' }),
    signedUrl: async (path) => `https://storage.test/signed/${path}`,
    remove: async (paths) => { removed.push(...paths); },
    put: async (path) => { put.push(path); },
  };
  const apps: GitHubApps = {
    list: async () => [{
      key: 'sated', name: 'Sated', accent: '#16778A', appStoreId: '1234567890', bundleId: 'com.stephenwarren.sated', iconPath: 'icon.png',
      repo: 'Hearth-Software-LLC/sated', defaultBranch: 'main', icon: { bytes: new Uint8Array([1, 2, 3]), sha256: sha(99), contentType: 'image/png' },
    }],
  };

  beforeAll(async () => {
    sql = postgres(url!, { max: 4, onnotice: () => undefined });
    release = await migrate(sql);
    teamId = String((await sql`select id from studio_teams where slug = 'hearth'`)[0]!.id);
  });
  afterAll(async () => { await release?.(); await sql?.end(); });

  beforeEach(async () => {
    await reset(sql);
    removed = [];
    put = [];
    plans = fakePlans();
    app = createApp({
      config: readConfig({ SOCIAL_OWNER_IDS: steve, SOCIAL_TOKEN_KEY: Buffer.alloc(32, 7).toString('base64') }),
      verifyToken: async (bearer) => ({ userId: users[bearer] ?? stranger, isAnonymous: bearer === 'anonymous' }),
      reserveQuota: async () => undefined,
      entitlements: async () => [],
      studio: {
        team: createTeamService(sql, { ownerIds: [steve] }),
        library: createLibraryService(sql, { storage, limitBytes: 1000 }),
        documents: createDocumentsService(sql),
        plans,
        apps,
        sql,
      },
      social: { store: createSocialStore(sql), media: storage },
    });
  });

  const call = async (who: string, method: string, path: string, body?: unknown) => {
    const response = await app.request(path, {
      method,
      headers: { Authorization: `Bearer ${who}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : undefined };
  };

  async function invite(permissions: { post?: boolean; plans?: boolean; accounts?: boolean } = {}) {
    const created = await call('steve', 'POST', '/v1/studio/invites', permissions);
    expect(created.status).toBe(200);
    return String(created.body.code);
  }

  it('lets the owner in, keeps strangers out, and brings someone in with an invite', async () => {
    const me = await call('steve', 'GET', '/v1/studio/me');
    expect(me.body).toMatchObject({ role: 'owner', team: { name: 'Hearth Software' }, permissions: { post: true, plans: true, accounts: true } });
    expect((await call('stranger', 'GET', '/v1/library/usage')).body.error.code).toBe('NOT_ON_TEAM');
    expect((await call('anonymous', 'GET', '/v1/studio/me')).body.error.code).toBe('REGISTERED_IDENTITY_REQUIRED');

    const code = await invite({ post: true, plans: true });
    expect(code).toMatch(/^[A-Z2-9]{8}$/);
    const joined = await call('kristen', 'POST', `/v1/studio/invites/${code}/join`, { displayName: 'Kristen' });
    expect(joined.status).toBe(200);
    expect(joined.body).toMatchObject({ role: 'member', displayName: 'Kristen', permissions: { post: true, plans: true, accounts: false } });
    // An invite works once.
    expect((await call('stranger', 'POST', `/v1/studio/invites/${code}/join`, {})).body.error.code).toBe('INVITE_NOT_FOUND');

    // Only an owner manages the team.
    expect((await call('kristen', 'POST', '/v1/studio/invites', {})).body.error.code).toBe('PERMISSION_REQUIRED');
    const members = await call('kristen', 'GET', '/v1/studio/members');
    expect(members.body.members.map((member: { userId: string }) => member.userId)).toEqual([steve, kristen]);
    const changed = await call('steve', 'PATCH', `/v1/studio/members/${kristen}`, { accounts: true });
    expect(changed.body.permissions).toEqual({ post: true, plans: true, accounts: true, affiliates: false, monetization: false, team: false });

    // An admin can do everything but manage the team.
    const promoted = await call('steve', 'PATCH', `/v1/studio/members/${kristen}`, { role: 'admin' });
    expect(promoted.body).toMatchObject({ role: 'admin', permissions: { post: true, plans: true, accounts: true, affiliates: true, monetization: true, team: false } });
    expect((await call('kristen', 'POST', '/v1/studio/invites', {})).body.error.code).toBe('PERMISSION_REQUIRED');
    expect((await call('kristen', 'PATCH', `/v1/studio/members/${kristen}`, { role: 'member' })).status).toBe(403);
    expect((await call('steve', 'PATCH', `/v1/studio/members/${steve}`, { role: 'member' })).status).toBe(409);
    expect((await call('steve', 'PATCH', `/v1/studio/members/${kristen}`, { role: 'member' })).body.permissions.monetization).toBe(false);
    expect((await call('steve', 'DELETE', `/v1/studio/members/${steve}`)).status).toBe(409);
    expect((await call('steve', 'DELETE', `/v1/studio/members/${kristen}`)).status).toBe(200);
    expect((await call('kristen', 'GET', '/v1/studio/me')).status).toBe(403);
  });

  it('keeps plan definitions with versions, and only admins change them', async () => {
    const definition = { monthly: { price: '4.99', trial: 'ONE_WEEK' }, annual: { price: '39.99' }, unlocks: 'Meal plans and imports.' };
    const created = await call('steve', 'PUT', '/v1/studio/monetization/plans/bigtable', { definition, version: 0 });
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ scope: 'bigtable', version: 1, definition });
    expect((await call('steve', 'PUT', '/v1/studio/monetization/plans/bigtable', { definition, version: 0 })).status).toBe(409);
    expect((await call('steve', 'PUT', '/v1/studio/monetization/plans/hearth', { definition: { lifetime: { price: '249' } }, version: 0 })).status).toBe(200);
    expect((await call('steve', 'PUT', '/v1/studio/monetization/plans/hearth', { definition: { monthly: { price: 'free' } }, version: 1 })).status).toBe(400);
    const listed = await call('steve', 'GET', '/v1/studio/monetization/plans');
    expect(listed.body.plans.map((plan: { scope: string }) => plan.scope)).toEqual(['bigtable', 'hearth']);

    await call('kristen', 'POST', `/v1/studio/invites/${await invite({ plans: true })}/join`, {});
    expect((await call('kristen', 'GET', '/v1/studio/monetization/plans')).status).toBe(200);
    expect((await call('kristen', 'PUT', '/v1/studio/monetization/plans/bigtable', { definition, version: 1 })).body.error.code).toBe('PERMISSION_REQUIRED');
  });

  it('checks permissions on social routes too', async () => {
    await call('kristen', 'POST', `/v1/studio/invites/${await invite({ post: false, plans: true })}/join`, {});
    const denied = await call('kristen', 'POST', '/v1/social/connections/meta/start', { app: 'hearth' });
    expect(denied.body.error.code).toBe('PERMISSION_REQUIRED');
    // Reading is fine for any member.
    expect((await call('kristen', 'GET', '/v1/social/connections')).status).not.toBe(403);
  });

  it('grants and removes plans, and keeps a history of who did it', async () => {
    await call('kristen', 'POST', `/v1/studio/invites/${await invite({ plans: true })}/join`, { displayName: 'Kristen' });
    const found = await call('kristen', 'GET', '/v1/studio/accounts?search=pat');
    expect(found.body.accounts[0].name).toBe('Pat');
    const until = new Date(Date.now() + 30 * 86_400_000).toISOString();
    const granted = await call('kristen', 'PUT', `/v1/studio/accounts/${account}/plans/hearth_plus`, { until });
    expect(granted.status).toBe(200);
    expect(plans.grant).toHaveBeenCalledWith(account, 'hearth_plus', until);
    expect(granted.body.history).toEqual([expect.objectContaining({ entitlement: 'hearth_plus', action: 'grant', by: { userId: kristen, name: 'Kristen' } })]);
    expect((await call('kristen', 'PUT', `/v1/studio/accounts/${account}/plans/hearth_plus`, { until: '2020-01-01T00:00:00Z' })).status).toBe(400);
    const revoked = await call('kristen', 'DELETE', `/v1/studio/accounts/${account}/plans/hearth_plus`);
    expect(revoked.body.history.map((entry: { action: string }) => entry.action)).toEqual(['revoke', 'grant']);

    // Without the plans permission, no.
    await call('steve', 'PATCH', `/v1/studio/members/${kristen}`, { plans: false });
    expect((await call('kristen', 'GET', '/v1/studio/accounts?search=pat')).body.error.code).toBe('PERMISSION_REQUIRED');
  });

  it('uploads into the Library once per file and syncs changes with a cursor', async () => {
    const start = await call('steve', 'POST', '/v1/library/uploads', { app: 'sated', kind: 'upload', sha256: sha(1), bytes: 100, contentType: 'image/webp' });
    expect(start.body).toMatchObject({ exists: false, path: `${teamId}/sated/upload/${sha(1)}.webp` });
    const created = await call('steve', 'POST', '/v1/library/assets', {
      app: 'sated', kind: 'upload', name: 'Hero', path: start.body.path, contentType: 'image/webp', bytes: 100, sha256: sha(1), width: 10, height: 20,
    });
    expect(created.status).toBe(201);
    expect((await call('steve', 'POST', '/v1/library/uploads', { app: 'sated', kind: 'upload', sha256: sha(1), bytes: 100, contentType: 'image/webp' })).body.exists).toBe(true);
    // A path that didn't come from /uploads is refused.
    expect((await call('steve', 'POST', '/v1/library/assets', {
      app: 'sated', kind: 'upload', name: 'X', path: `${teamId}/other/upload/${sha(1)}.webp`, contentType: 'image/webp', bytes: 1, sha256: sha(1),
    })).status).toBe(422);

    const all = await call('steve', 'GET', '/v1/library/assets?since=0');
    expect(all.body.assets.map((item: { name: string }) => item.name)).toEqual(['Hero']);
    const cursor = all.body.cursor;
    await call('steve', 'PATCH', `/v1/library/assets/${created.body.id}`, { name: 'Hero shot' });
    await call('steve', 'DELETE', `/v1/library/assets/${created.body.id}`);
    const changes = await call('steve', 'GET', `/v1/library/assets?since=${cursor}`);
    expect(changes.body.assets).toEqual([expect.objectContaining({ name: 'Hero shot', deleted: true })]);
    expect(removed).toEqual([start.body.path]);

    // Nearly full (90% of the 1000-byte budget here) refuses new files.
    expect((await call('steve', 'POST', '/v1/library/uploads', { app: 'sated', kind: 'upload', sha256: sha(2), bytes: 950, contentType: 'image/png' })).body.error.code).toBe('STORAGE_FULL');
    expect((await call('steve', 'GET', `/v1/library/assets/${created.body.id}/url`)).status).toBe(404);
  });

  it('keeps one version of each screenshot: a new capture replaces it, and old files go unless a post uses them', async () => {
    const run = async (pages: [string, number][], appearance = 'light') => {
      const started = await call('steve', 'POST', '/v1/library/runs', { app: 'sated', device: 'iPhone-17-Pro', appearance });
      const made: Record<string, { id: string; path: string }> = {};
      for (const [position, [name, n]] of pages.entries()) {
        const path = `${teamId}/sated/screenshot/${sha(n)}.webp`;
        const reply = await call('steve', 'POST', '/v1/library/assets', {
          app: 'sated', kind: 'screenshot', name, path, contentType: 'image/webp', bytes: 10, sha256: sha(n),
          device: 'iPhone-17-Pro', appearance, runId: started.body.id, position,
        });
        expect(reply.status).toBe(201);
        made[name] = { id: reply.body.id, path };
      }
      const done = await call('steve', 'POST', `/v1/library/runs/${started.body.id}/complete`);
      return { made, removed: done.body.removed as number };
    };
    const live = async () => (await call('steve', 'GET', '/v1/library/assets?since=0&kind=screenshot')).body.assets as
      { id: string; name: string; path: string; appearance: string }[];

    const first = await run([['01-home', 11], ['02-plan', 21]]);
    // A new capture of 01-home replaces it: same id, new file, the old file removed.
    const second = await run([['01-home', 12], ['02-plan', 21]]);
    expect(second.made['01-home']!.id).toBe(first.made['01-home']!.id);
    expect(removed).toEqual([first.made['01-home']!.path]);
    expect((await live()).map((item) => item.name).sort()).toEqual(['01-home', '02-plan']);

    // A post uses the current 01-home, so replacing it keeps that file.
    await sql`insert into social_posts (team_id, app, text, media) values (${teamId}, 'hearth', 'Look', ${sql.json([{ path: `library/${second.made['01-home']!.path}`, kind: 'image' }])})`;
    removed = [];
    await run([['01-home', 13], ['02-plan', 21]]);
    expect(removed).toEqual([]);

    // Landscape is its own version, not a replacement.
    await run([['01-home', 14]], 'light-landscape');
    expect((await live()).filter((item) => item.name === '01-home')).toHaveLength(2);

    // A page no longer captured goes once it's past the last two runs.
    await run([['01-home', 15]]);
    const last = await run([['01-home', 16]]);
    expect(last.removed).toBe(1);
    expect((await live()).filter((item) => item.appearance === 'light').map((item) => item.name)).toEqual(['01-home']);
  });

  it('keeps one version of each mockup, and any number of uploads', async () => {
    const add = (kind: string, n: number, device: string | null) => call('steve', 'POST', '/v1/library/assets', {
      app: 'sated', kind, name: '01-home', path: `${teamId}/sated/${kind}/${sha(n)}.webp`, contentType: 'image/webp', bytes: 10,
      sha256: sha(n), device, appearance: device ? 'light' : null,
    });
    const a = await add('mockup', 31, 'iPhone-18-Pro-Silver');
    const b = await add('mockup', 32, 'iPhone-18-Pro-Silver');
    expect(b.body.id).toBe(a.body.id);
    const other = await add('mockup', 33, 'iPhone-18-Pro-Black');
    expect(other.body.id).not.toBe(a.body.id);
    const u1 = await add('upload', 34, null);
    const u2 = await add('upload', 35, null);
    expect(u2.body.id).not.toBe(u1.body.id);
  });

  it('lets a post use a Library file', async () => {
    const created = await call('steve', 'POST', '/v1/social/posts', {
      app: 'hearth', text: 'From the Library', draft: true, media: [{ path: `library/${teamId}/sated/upload/${sha(5)}.webp`, kind: 'image' }], targets: [],
    });
    expect(created.status).not.toBe(422);
    const foreign = await call('steve', 'POST', '/v1/social/posts', {
      app: 'hearth', text: 'Not ours', draft: true, media: [{ path: `library/${stranger}/x.webp`, kind: 'image' }], targets: [],
    });
    expect(foreign.status).toBe(422);
  });

  it('saves campaigns with versions and answers a stale save with the current one', async () => {
    const created = await call('steve', 'PUT', '/v1/studio/campaigns/sated/fall', { name: 'Fall', document: { headline: 'A' }, baseVersion: 0 });
    expect(created.body).toMatchObject({ version: 1, name: 'Fall' });
    const updated = await call('steve', 'PUT', '/v1/studio/campaigns/sated/fall', { name: 'Fall', document: { headline: 'B' }, baseVersion: 1 });
    expect(updated.body.version).toBe(2);
    const stale = await call('steve', 'PUT', '/v1/studio/campaigns/sated/fall', { name: 'Fall', document: { headline: 'C' }, baseVersion: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ error: { code: 'VERSION_CONFLICT' }, current: { version: 2, document: { headline: 'B' } } });

    const listed = await call('steve', 'GET', '/v1/studio/campaigns?since=0');
    const cursor = listed.body.cursor;
    await call('steve', 'DELETE', '/v1/studio/campaigns/sated/fall');
    const changes = await call('steve', 'GET', `/v1/studio/campaigns?since=${cursor}`);
    expect(changes.body.campaigns).toEqual([expect.objectContaining({ slug: 'fall', deleted: true })]);

    const design = await call('steve', 'PUT', '/v1/studio/designs/sated', { document: { frames: [] }, baseVersion: 0 });
    expect(design.body.version).toBe(1);
    expect((await call('steve', 'PUT', '/v1/studio/designs/sated', { document: {}, baseVersion: 0 })).status).toBe(409);
  });

  it('lists the apps from GitHub with their icons in the Library', async () => {
    const listed = await call('steve', 'GET', '/v1/studio/apps');
    expect(listed.body.apps).toEqual([expect.objectContaining({ key: 'sated', name: 'Sated', iconUrl: expect.stringContaining('/icon/') })]);
    expect(listed.body.apps[0].icon).toBeUndefined();
    await call('steve', 'GET', '/v1/studio/apps');
    expect(put).toHaveLength(1);
  });

  it('pushes due hand-offs, failures and new comments to the members who want them', async () => {
    const team = createTeamService(sql, { ownerIds: [steve] });
    await team.memberOf(steve);
    await call('steve', 'POST', '/v1/studio/devices', { token: token(1), topic: 'com.stephenwarren.hearthstudio', environment: 'sandbox' });
    await call('kristen', 'POST', `/v1/studio/invites/${await invite()}/join`, {});
    await call('kristen', 'POST', '/v1/studio/devices', { token: token(2), topic: 'com.stephenwarren.hearthstudio', environment: 'production' });
    await call('kristen', 'PATCH', '/v1/studio/me', { notifications: { comments: false } });

    const [post] = await sql`insert into social_posts (team_id, app, text) values (${teamId}, 'hearth', 'Pasta night') returning id`;
    await sql`
      insert into social_targets (team_id, post_id, app, platform, delivery, format, status, scheduled_for)
      values (${teamId}, ${post!.id}, 'hearth', 'tiktok', 'handoff', 'feed', 'scheduled', now() - interval '1 minute')`;
    const [connection] = await sql`
      insert into social_connections (team_id, connected_by, platform, external_id, name, token_sealed)
      values (${teamId}, ${steve}, 'instagram', 'ig-1', 'Hearth', 'sealed') returning id`;
    await sql`
      insert into social_comments (team_id, connection_id, app, platform, remote_id, remote_post_id, author, text, commented_at)
      values (${teamId}, ${connection!.id}, 'hearth', 'instagram', 'c1', 'm1', 'pat', 'Love it', now())`;

    const sent: ApnsMessage[] = [];
    const notifier = createStudioNotifier(sql, team, async (messages) => {
      sent.push(...messages);
      return messages.map((message) => (message.token === token(2) ? 'gone' : 'sent'));
    });
    await notifier.run();
    const titles = sent.map((message) => `${message.token.slice(-1)} ${(message.payload as { aps: { alert: { title: string } } }).aps.alert.title}`);
    expect(titles.sort()).toEqual(['1 Time to post on TikTok', '1 pat commented', '2 Time to post on TikTok']);
    // APNs said Kristen's token is gone, so it's forgotten.
    expect(await sql`select token from studio_devices`).toHaveLength(1);
    // Nothing twice.
    sent.length = 0;
    await notifier.run();
    expect(sent).toEqual([]);
  });
});
