import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { createApp } from '../../src/app.js';
import { readConfig } from '../../src/config.js';
import { analytics } from '../../src/social/routes.js';
import type { MetaClient } from '../../src/social/meta.js';
import type { SocialMedia } from '../../src/social/service.js';
import { createSocialStore } from '../../src/social/store.js';

// The analytics math runs everywhere; the routes run against a real Postgres: set
// SOCIAL_TEST_DATABASE_URL (or HEARKEN_TEST_DATABASE_URL) to an empty scratch database.
const url = process.env.SOCIAL_TEST_DATABASE_URL ?? process.env.HEARKEN_TEST_DATABASE_URL;

const steve = '00000000-0000-4000-8000-0000000000aa';
const stranger = '00000000-0000-4000-8000-0000000000bb';
const key = Buffer.alloc(32, 7).toString('base64');

function fakeMeta() {
  return {
    authorizeUrl: vi.fn((state: string) => `https://www.facebook.com/v24.0/dialog/oauth?state=${state}`),
    exchangeCode: vi.fn(async () => 'long-user-token'),
    accounts: vi.fn(async () => [
      { platform: 'facebook' as const, externalId: 'page-1', name: 'Sated', handle: null, avatarUrl: null, token: 'page-token' },
      { platform: 'instagram' as const, externalId: 'ig-1', name: 'satedapp', handle: 'satedapp', avatarUrl: null, token: 'page-token' },
    ]),
    publish: vi.fn(async (target: { platform: string }, _input?: unknown) => (target.platform === 'instagram'
      ? { state: 'processing' as const, containerId: 'container-1' }
      : { state: 'published' as const, remoteId: 'page-1_post-1', permalink: 'https://www.facebook.com/p/1', warning: null })),
    resume: vi.fn(async () => ({ state: 'published' as const, remoteId: 'media-1', permalink: 'https://www.instagram.com/p/1/', warning: null })),
    recentPosts: vi.fn(async (target: { platform: string }) => (target.platform === 'instagram'
      ? [
        { remoteId: 'media-1', text: 'Dinner', permalink: 'https://www.instagram.com/p/1/', mediaUrl: null, publishedAt: new Date().toISOString(), likes: 9, comments: 2, shares: null },
        { remoteId: 'media-0', text: 'Made in the app', permalink: null, mediaUrl: 'https://cdn/x.jpg', publishedAt: new Date(Date.now() - 86_400_000).toISOString(), likes: 3, comments: 0, shares: null },
      ]
      : [])),
    comments: vi.fn(async (_target: unknown, remoteId: string) => (remoteId === 'media-1'
      ? [{ remoteId: 'c1', parentRemoteId: null, author: 'pat', text: 'Is there a dark mode?', likes: 0, at: new Date().toISOString(), fromAccount: false }]
      : [])),
    reply: vi.fn(async () => 'c-reply'),
    hide: vi.fn(async () => undefined),
    accountMetrics: vi.fn(async () => [{ day: new Date().toISOString().slice(0, 10), metric: 'followers' as const, value: 500 }]),
    postMetrics: vi.fn(async () => [{ metric: 'reach' as const, value: 120 }]),
  };
}

const media: SocialMedia = {
  uploadUrl: async (path) => ({ url: `https://storage.test/upload/${path}`, token: 'upload-token' }),
  signedUrl: async (path) => `https://storage.test/signed/${path}`,
};

describe('social analytics', () => {
  it('sums daily numbers, compares with the period before, and ranks posts', () => {
    const rows = [
      { platform: 'instagram', postKey: '', day: '2026-09-25', metric: 'followers' as const, value: 400, source: 'api' as const },
      { platform: 'instagram', postKey: '', day: '2026-10-27', metric: 'followers' as const, value: 450, source: 'api' as const },
      { platform: 'instagram', postKey: '', day: '2026-09-20', metric: 'reach' as const, value: 10, source: 'api' as const },
      { platform: 'instagram', postKey: '', day: '2026-10-20', metric: 'reach' as const, value: 30, source: 'api' as const },
      { platform: 'instagram', postKey: '', day: '2026-10-21', metric: 'reach' as const, value: 20, source: 'api' as const },
      { platform: 'tiktok', postKey: 'https://tiktok.com/v/1', day: '2026-10-22', metric: 'views' as const, value: 900, source: 'import' as const },
      { platform: 'instagram', postKey: 'm1', day: '2026-10-21', metric: 'likes' as const, value: 5, source: 'api' as const },
      { platform: 'instagram', postKey: 'm1', day: '2026-10-22', metric: 'likes' as const, value: 8, source: 'api' as const },
    ];
    const target = (platform: 'instagram' | 'tiktok', remoteId: string, publishedAt: string) => ({
      id: remoteId, postId: null, app: 'hearth', platform, connectionId: null, delivery: 'api' as const, format: 'feed' as const, text: null,
      status: 'published' as const, scheduledFor: null, attempts: 0, containerId: null, remoteId, permalink: null, publishedAt, error: null,
      previewText: null, previewMediaUrl: null, likeCount: null, commentCount: 1, shareCount: null, updatedAt: publishedAt,
    });
    const result = analytics(rows, [target('instagram', 'm1', '2026-10-21T10:00:00Z'), target('tiktok', 'https://tiktok.com/v/1', '2026-10-22T10:00:00Z')], 28, '2026-10-01');
    expect(result.totals).toEqual(expect.arrayContaining([
      { metric: 'followers', value: 450, previous: 400 },
      { metric: 'reach', value: 50, previous: 10 },
      { metric: 'likes', value: 8, previous: null },
      { metric: 'views', value: 900, previous: null },
    ]));
    expect(result.posts.map((post) => post.target.remoteId)).toEqual(['m1', 'https://tiktok.com/v/1']);
    expect(result.posts[0]!.metrics).toEqual({ likes: 8, comments: 1 });
    expect(result.series.find((entry) => entry.metric === 'reach')!.points).toEqual([{ day: '2026-10-20', value: 30 }, { day: '2026-10-21', value: 20 }]);
  });
});

describe.skipIf(!url)('social pages (Postgres)', () => {
  let sql: postgres.Sql;
  let meta: ReturnType<typeof fakeMeta>;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    sql = postgres(url!, { max: 2, onnotice: () => undefined });
    await sql.unsafe('drop table if exists social_metrics, social_comments, social_targets, social_posts, social_connections cascade');
    const reserved = await sql.reserve();
    try {
      await reserved.unsafe(readFileSync(new URL('../../supabase/migrations/20261029000000_social_pages.sql', import.meta.url), 'utf8'));
    } finally {
      reserved.release();
    }
  });
  afterAll(async () => { await sql?.end(); });

  beforeEach(async () => {
    await sql`truncate social_metrics, social_comments, social_targets, social_posts, social_connections cascade`;
    meta = fakeMeta();
    app = createApp({
      config: readConfig({ SOCIAL_TOKEN_KEY: key, SOCIAL_OWNER_IDS: steve, CRON_SECRET: 'cron-secret-cron-secret' }),
      verifyToken: async (token) => ({ userId: token === 'steve' ? steve : stranger, isAnonymous: false }),
      reserveQuota: async () => undefined,
      entitlements: async () => [],
      social: { store: createSocialStore(sql), meta: meta as unknown as MetaClient, media },
    });
  });

  const call = async (who: 'steve' | 'stranger', method: string, path: string, body?: unknown) => {
    const response = await app.request(path, {
      method,
      headers: { Authorization: `Bearer ${who}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : undefined, headers: response.headers };
  };

  /** Logs in with Facebook and puts both accounts on Sated. */
  async function connect() {
    const start = await call('steve', 'POST', '/v1/social/connections/meta/start', { app: 'hearth' });
    const state = new URL(start.body.url).searchParams.get('state')!;
    const back = await app.request(`/oauth/meta/callback?code=abc&state=${encodeURIComponent(state)}`);
    expect(back.status).toBe(302);
    expect(back.headers.get('location')).toBe('hearthship://social/connected?count=2');
    const list = await call('steve', 'GET', '/v1/social/connections');
    return list.body.connections as { id: string; platform: string; app: string | null }[];
  }

  it('is only for the owners in SOCIAL_OWNER_IDS', async () => {
    expect((await call('stranger', 'GET', '/v1/social/connections')).status).toBe(403);
    expect((await call('steve', 'GET', '/v1/social/connections')).body).toEqual({ connections: [], metaConfigured: true });
  });

  it('connects a Page and its Instagram account to the app the login was for', async () => {
    const connections = await connect();
    expect(connections.map((item) => [item.platform, item.app])).toEqual([['facebook', 'hearth'], ['instagram', 'hearth']]);
    expect(JSON.stringify(connections)).not.toContain('token');
    const raw = await sql`select token_sealed from social_connections`;
    expect(raw.every((row) => String(row.token_sealed).startsWith('v1.'))).toBe(true);
  });

  it('refuses a tampered or missing login state', async () => {
    const back = await app.request('/oauth/meta/callback?code=abc&state=bogus.state');
    expect(back.headers.get('location')).toMatch(/^hearthship:\/\/social\/connected\?error=/);
    const cancelled = await app.request('/oauth/meta/callback?error=access_denied');
    expect(cancelled.headers.get('location')).toContain('error=access_denied');
  });

  it('posts now to Facebook, leaves Instagram video processing for the cron, and keeps hand-off targets for you', async () => {
    const [facebook, instagram] = await connect();
    const upload = await call('steve', 'POST', '/v1/social/media', { extension: 'mp4' });
    expect(upload.body.path).toMatch(new RegExp(`^${steve}/`));
    const created = await call('steve', 'POST', '/v1/social/posts', {
      app: 'hearth', about: 'sated', text: 'New in Sated', media: [{ path: upload.body.path, kind: 'video' }], draft: false, firstComment: '#food',
      targets: [
        { platform: 'facebook', connectionId: facebook!.id },
        { platform: 'instagram', connectionId: instagram!.id, format: 'reel' },
        { platform: 'tiktok' },
      ],
    });
    expect(created.status).toBe(201);
    expect(created.body.about).toBe('sated');
    const status = Object.fromEntries(created.body.targets.map((target: { platform: string; status: string }) => [target.platform, target.status]));
    expect(status).toEqual({ facebook: 'published', instagram: 'processing', tiktok: 'scheduled' });
    expect(created.body.media[0].previewUrl).toContain('https://storage.test/signed/');
    expect(meta.publish.mock.calls[1]![1]).toMatchObject({ text: 'New in Sated', firstComment: '#food', format: 'reel', link: null });

    const cron = await app.request('/internal/social/cron', { headers: { Authorization: 'Bearer cron-secret-cron-secret' } });
    expect(cron.status).toBe(200);
    expect(meta.resume).toHaveBeenCalledWith(expect.objectContaining({ platform: 'instagram' }), 'container-1', '#food');
    const after = await call('steve', 'GET', '/v1/social/posts?app=hearth');
    const ig = after.body.posts[0].targets.find((target: { platform: string }) => target.platform === 'instagram');
    expect(ig).toMatchObject({ status: 'published', remoteId: 'media-1', permalink: 'https://www.instagram.com/p/1/' });

    const tiktok = after.body.posts[0].targets.find((target: { platform: string }) => target.platform === 'tiktok');
    expect((await call('steve', 'POST', `/v1/social/targets/${tiktok.id}/publish`)).status).toBe(422);
    const posted = await call('steve', 'POST', `/v1/social/targets/${tiktok.id}/posted`, { permalink: 'https://www.tiktok.com/@sated/video/1' });
    expect(posted.body).toMatchObject({ status: 'published', permalink: 'https://www.tiktok.com/@sated/video/1', remoteId: 'https://www.tiktok.com/@sated/video/1' });
  });

  it('schedules a post for later and lets the cron publish it once it’s due', async () => {
    const [facebook] = await connect();
    const later = new Date(Date.now() + 3_600_000).toISOString();
    const created = await call('steve', 'POST', '/v1/social/posts', {
      app: 'hearth', text: 'Soon', media: [], draft: false, scheduledFor: later, targets: [{ platform: 'facebook', connectionId: facebook!.id }],
    });
    expect(created.body.targets[0]).toMatchObject({ status: 'scheduled' });
    expect(Date.parse(created.body.targets[0].scheduledFor)).toBe(Date.parse(later));
    await app.request('/internal/social/cron', { headers: { Authorization: 'Bearer cron-secret-cron-secret' } });
    expect(meta.publish).not.toHaveBeenCalled();
    await sql`update social_targets set scheduled_for = now() - interval '1 minute'`;
    await app.request('/internal/social/cron', { headers: { Authorization: 'Bearer cron-secret-cron-secret' } });
    expect(meta.publish).toHaveBeenCalledTimes(1);
  });

  it('keeps drafts as drafts, and only lets a post go to the app’s own accounts', async () => {
    const [facebook] = await connect();
    const draft = await call('steve', 'POST', '/v1/social/posts', {
      app: 'hearth', text: 'Idea', media: [], draft: true, targets: [{ platform: 'facebook', connectionId: facebook!.id }, { platform: 'x' }],
    });
    expect(draft.body.targets.map((target: { status: string }) => target.status)).toEqual(['draft', 'draft']);
    expect(meta.publish).not.toHaveBeenCalled();
    const wrong = await call('steve', 'POST', '/v1/social/posts', {
      app: 'bigtable', text: 'Nope', media: [], draft: true, targets: [{ platform: 'facebook', connectionId: facebook!.id }],
    });
    expect(wrong.status).toBe(422);
    const edited = await call('steve', 'PUT', `/v1/social/posts/${draft.body.id}`, {
      app: 'hearth', text: 'Idea, edited', media: [], draft: true, targets: [{ platform: 'x' }],
    });
    expect(edited.body).toMatchObject({ text: 'Idea, edited', targets: [{ platform: 'x', status: 'draft' }] });
    expect((await call('steve', 'DELETE', `/v1/social/posts/${draft.body.id}`)).status).toBe(200);
  });

  it('syncs posts, comments and numbers, and replies from the Inbox', async () => {
    await connect();
    const synced = await call('steve', 'POST', '/v1/social/sync', { app: 'hearth' });
    expect(synced.body).toMatchObject({ posts: 2, comments: 1 });
    const posts = await call('steve', 'GET', '/v1/social/posts?app=hearth');
    expect(posts.body.found.map((target: { remoteId: string }) => target.remoteId)).toEqual(['media-1', 'media-0']);
    const inbox = await call('steve', 'GET', '/v1/social/comments?app=hearth&status=open');
    expect(inbox.body.comments).toHaveLength(1);
    const comment = inbox.body.comments[0];
    expect((await call('steve', 'POST', `/v1/social/comments/${comment.id}/reply`, { text: 'Not yet, but soon!' })).status).toBe(200);
    expect(meta.reply).toHaveBeenCalledWith(expect.objectContaining({ platform: 'instagram' }), 'c1', 'Not yet, but soon!');
    const all = await call('steve', 'GET', '/v1/social/comments?app=hearth');
    expect(all.body.comments.map((item: { author: string; status: string }) => [item.author, item.status]))
      .toEqual(expect.arrayContaining([['pat', 'done'], ['satedapp', 'done']]));
    expect((await call('steve', 'PATCH', `/v1/social/comments/${comment.id}`, { status: 'hidden' })).status).toBe(200);
    expect(meta.hide).toHaveBeenCalledWith(expect.anything(), 'c1', true);

    const numbers = await call('steve', 'GET', '/v1/social/analytics?app=hearth&days=7');
    expect(numbers.body.totals).toEqual(expect.arrayContaining([{ metric: 'followers', value: 1000, previous: null }]));
    expect(numbers.body.posts[0].metrics).toMatchObject({ likes: 9, comments: 2, reach: 120 });
  });

  it('imports a platform’s CSV numbers with their posts', async () => {
    const imported = await call('steve', 'POST', '/v1/social/metrics/import', {
      app: 'hearth', platform: 'tiktok',
      rows: [{ day: new Date().toISOString().slice(0, 10), metric: 'followers', value: 80 }, { postKey: 'https://tiktok.com/v/9', day: new Date().toISOString().slice(0, 10), metric: 'views', value: 1500 }],
      posts: [{ key: 'https://tiktok.com/v/9', text: 'Pasta night', permalink: 'https://tiktok.com/v/9', publishedAt: new Date().toISOString() }],
    });
    expect(imported.body).toEqual({ rows: 2, posts: 1 });
    const numbers = await call('steve', 'GET', '/v1/social/analytics?app=hearth&days=28');
    expect(numbers.body.totals).toEqual(expect.arrayContaining([{ metric: 'followers', value: 80, previous: null }, { metric: 'views', value: 1500, previous: null }]));
    expect(numbers.body.posts[0].target).toMatchObject({ platform: 'tiktok', delivery: 'handoff', previewText: 'Pasta night' });
  });

  it('marks an account for reconnecting when Meta rejects its token', async () => {
    const [facebook] = await connect();
    const { MetaError } = await import('../../src/social/meta.js');
    meta.recentPosts.mockRejectedValueOnce(new MetaError('Session has expired', 190, true));
    await call('steve', 'POST', '/v1/social/sync', { app: 'hearth' });
    const list = await call('steve', 'GET', '/v1/social/connections');
    expect(list.body.connections.find((item: { id: string }) => item.id === facebook!.id)).toMatchObject({ status: 'needs_reconnect', lastError: 'Session has expired' });
  });

  it('requires the cron secret', async () => {
    expect((await app.request('/internal/social/cron')).status).toBe(401);
  });
});
