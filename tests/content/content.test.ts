import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { createApp } from '../../src/app.js';
import { createLibraryService } from '../../src/studio/library.js';
import type { StudioStorage } from '../../src/studio/library.js';
import { readConfig } from '../../src/config.js';
import { diffBodies, isScriptureRef, runChecks } from '../../src/content/model.js';
import type { Body, TypeDefinition } from '../../src/content/model.js';
import { createContentService } from '../../src/content/service.js';
import type { ContentStorage } from '../../src/content/service.js';
import type { GitHubApps } from '../../src/studio/github.js';
import { createTeamService } from '../../src/studio/team.js';
import { migrate, reset } from '../studio/database.js';

const module: TypeDefinition = {
  fields: [{ key: 'subject', label: 'Subject', type: 'text', required: true }],
  sections: { label: 'Lesson', fields: [] },
  blocks: ['text', 'scripture', 'quiz', 'image'],
  reviewSteps: ['Doctrine review'],
  listing: null,
};

const quiz = (correct: number) => ({
  id: 'q1', type: 'quiz' as const, question: 'Which member of the Godhead has no body of flesh and bones?',
  options: [{ id: 'a', text: 'The Father', correct: correct === 0 }, { id: 'b', text: 'The Holy Ghost', correct: correct === 1 }],
  explanation: '', hint: '', weight: 2, shuffle: true, mastery: true,
});

describe('content model', () => {
  it('knows a scripture reference when it sees one', () => {
    for (const ref of ['D&C 130:22', '1 Nephi 3:7', 'Moses 1:39', 'John 3:16-17, 19', 'Alma 32']) expect(isScriptureRef(ref)).toBe(true);
    for (const ref of ['', '130:22', 'D&C', 'see chapter four']) expect(isScriptureRef(ref)).toBe(false);
  });

  it('checks a version before it can be published', () => {
    const body: Body = { fields: {}, sections: [{ id: 's1', title: '', fields: {}, blocks: [quiz(-1), { id: 'r', type: 'scripture', ref: 'D&C', text: '', highlight: false }] }] };
    const failed = runChecks({ appKey: 'hearken', definition: module, body, media: new Map(), approvals: [{ step: 'Doctrine review', approved: false }] });
    expect(failed.filter((check) => check.state === 'fail').map((check) => check.id)).toEqual(['fields', 'sections', 'scripture', 'quiz', 'approvals']);
    const fixed: Body = { fields: { subject: 'Doctrinal Mastery' }, sections: [{ id: 's1', title: 'Three beings', fields: {}, blocks: [quiz(1), { id: 'r', type: 'scripture', ref: 'D&C 130:22', text: '', highlight: false }, { id: 'i', type: 'image', mediaId: '00000000-0000-4000-8000-000000000001', alt: '', caption: '' }] }] };
    const passed = runChecks({ appKey: 'hearken', definition: module, body: fixed, media: new Map([['00000000-0000-4000-8000-000000000001', { id: 'x', uploaded: true, alt: '' }]]), approvals: [{ step: 'Doctrine review', approved: true }] });
    expect(passed.filter((check) => check.state === 'fail')).toEqual([]);
    expect(passed.find((check) => check.id === 'alt')?.state).toBe('warn');
  });

  it('counts what changed between versions', () => {
    const before: Body = { fields: { subject: 'A' }, sections: [{ id: 's1', title: 'One', fields: {}, blocks: [{ id: 'b1', type: 'text', text: 'old' }, { id: 'b2', type: 'text', text: 'gone' }] }] };
    const after: Body = { fields: { subject: 'B' }, sections: [{ id: 's1', title: 'One', fields: {}, blocks: [{ id: 'b1', type: 'text', text: 'new' }, quiz(1)] }, { id: 's2', title: 'Two', fields: {}, blocks: [{ id: 'b3', type: 'text', text: 'x' }] }] };
    expect(diffBodies(before, after)).toMatchObject({ added: 2, removed: 1, edited: 1, fieldsChanged: ['subject'] });
  });
});

// Against a real Postgres: set SOCIAL_TEST_DATABASE_URL (or HEARKEN_TEST_DATABASE_URL) to an empty scratch database.
const url = process.env.SOCIAL_TEST_DATABASE_URL ?? process.env.HEARKEN_TEST_DATABASE_URL;

const steve = '00000000-0000-4000-8000-0000000000aa';
const kristen = '00000000-0000-4000-8000-0000000000cc';
const author = '00000000-0000-4000-8000-0000000000ee';
const reviewer = '00000000-0000-4000-8000-0000000000ff';
const stranger = '00000000-0000-4000-8000-0000000000bb';
const users: Record<string, string> = { steve, kristen, author, reviewer, stranger, 'kristen-stale': kristen, 'steve-stale': steve };

describe.skipIf(!url)('Hearth Content (Postgres)', () => {
  let sql: postgres.Sql;
  let release: (() => Promise<void>) | undefined;
  let app: ReturnType<typeof createApp>;
  let stored: Map<string, string>;
  let clock: number;

  const storage: ContentStorage = {
    put: async (path, bytes) => { stored.set(path, new TextDecoder().decode(bytes)); },
    uploadUrl: async (path) => ({ url: `https://storage.test/upload/${path}`, token: 't' }),
    publicUrl: (path) => `https://cdn.test/${path}`,
    putPlus: async (path, bytes) => { stored.set(`plus:${path}`, new TextDecoder().decode(bytes)); },
    plusUrl: async (path, seconds) => `https://storage.test/signed/${path}?expires=${seconds}`,
  };
  let removedAvatars: string[];
  const studioStorage: StudioStorage = {
    uploadUrl: async (path) => ({ url: `https://storage.test/upload/${path}`, token: 'upload-token' }),
    signedUrl: async (path) => `https://storage.test/signed/${path}`,
    remove: async (paths) => { removedAvatars.push(...paths); },
    put: async () => undefined,
  };
  const apps: GitHubApps = {
    list: async () => [
      { key: 'hearken', name: 'Hearken', accent: '#3B74D9', bundleId: 'com.stephenwarren.hearken', iconPath: null, repo: 'Hearth-Software-LLC/hearken', defaultBranch: 'main', icon: null },
      { key: 'sated', name: 'Sated', accent: '#F08A24', bundleId: 'com.stephenwarren.sated', iconPath: null, repo: 'Hearth-Software-LLC/sated', defaultBranch: 'main', icon: null },
    ],
  };

  beforeAll(async () => {
    sql = postgres(url!, { max: 4, onnotice: () => undefined });
    release = await migrate(sql);
  });
  afterAll(async () => { await release?.(); await sql?.end(); });

  beforeEach(async () => {
    await reset(sql);
    stored = new Map();
    removedAvatars = [];
    clock = Date.now();
    app = createApp({
      config: readConfig({ SOCIAL_OWNER_IDS: steve }),
      verifyToken: async (bearer) => ({
        userId: users[bearer] ?? stranger, isAnonymous: bearer === 'anonymous',
        signedInAt: bearer.endsWith('-stale') ? clock / 1000 - 13 * 3600 : clock / 1000 - 60,
      }),
      reserveQuota: async () => undefined,
      entitlements: async () => [],
      studio: { team: createTeamService(sql, { ownerIds: [steve] }), library: createLibraryService(sql, { storage: studioStorage, limitBytes: 1000 }), apps, sql },
      content: { service: createContentService(sql, { storage, now: () => clock }) },
    });
  });

  const call = async (who: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await app.request(path, {
      method,
      headers: { ...(who ? { Authorization: `Bearer ${who}` } : {}), ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : undefined };
  };

  async function join(who: string, invite: Record<string, unknown>) {
    const created = await call('steve', 'POST', '/v1/studio/invites', invite);
    expect(created.status).toBe(200);
    const joined = await call(who, 'POST', `/v1/studio/invites/${created.body.code}/join`, { displayName: who });
    expect(joined.status).toBe(200);
    return joined.body;
  }

  const moduleType = async () => {
    const types = await call('steve', 'GET', '/v1/content/types');
    return types.body.types.find((type: { slug: string; app: string | null }) => type.slug === 'learning-module' && type.app === 'hearken');
  };

  it('shares one profile photo between Hearth Studio and Hearth Content', async () => {
    await join('author', { post: false, content: { role: 'author', apps: ['hearken'] } });
    const hash = (n: number) => n.toString(16).padStart(64, '0');

    // Set in Hearth Studio, seen in Hearth Content.
    const studio = await call('steve', 'POST', '/v1/studio/me/avatar/upload', { sha256: hash(1), bytes: 2048, contentType: 'image/jpeg' });
    expect((await call('steve', 'PUT', '/v1/studio/me/avatar', { path: studio.body.path })).status).toBe(200);
    expect((await call('steve', 'GET', '/v1/content/me')).body.avatarUrl).toBe(`https://storage.test/signed/${studio.body.path}`);

    // Set in Hearth Content (a content-only member, who can't reach /v1/studio), seen by the team.
    const started = await call('author', 'POST', '/v1/content/me/avatar/upload', { sha256: hash(2), bytes: 2048, contentType: 'image/jpeg' });
    expect(started.status).toBe(200);
    expect(started.body.path).toMatch(new RegExp(`/avatars/${users.author}/${hash(2)}\\.jpg$`));
    const set = await call('author', 'PUT', '/v1/content/me/avatar', { path: started.body.path });
    expect(set.body.avatarUrl).toBe(`https://storage.test/signed/${started.body.path}`);
    const members = await call('steve', 'GET', '/v1/studio/members');
    expect(members.body.members.find((entry: { userId: string }) => entry.userId === users.author).avatarUrl).toBe(`https://storage.test/signed/${started.body.path}`);

    // Only your own uploads; replacing or removing cleans up the old file.
    expect((await call('author', 'PUT', '/v1/content/me/avatar', { path: studio.body.path })).body.error.code).toBe('INVALID_REQUEST');
    expect((await call('author', 'PUT', '/v1/content/me/avatar', { path: null })).body.avatarUrl).toBeNull();
    expect(removedAvatars).toEqual([started.body.path]);
    expect((await call('author', 'POST', '/v1/content/me/avatar/upload', { sha256: hash(3), bytes: 6 * 1024 * 1024, contentType: 'image/jpeg' })).body.error.code).toBe('FILE_TOO_LARGE');
  });

  it('brings in content-only people with a code and keeps Hearth Studio hidden from them', async () => {
    expect((await call('steve', 'POST', '/v1/studio/invites', { post: false })).body.error.code).toBe('INVITE_EMPTY');
    const joined = await join('author', { post: false, content: { role: 'author', apps: ['hearken'] } });
    expect(joined.content).toEqual({ role: 'author', apps: ['hearken'] });

    expect((await call('author', 'GET', '/v1/studio/me')).body.error.code).toBe('CONTENT_ONLY');
    expect((await call('author', 'GET', '/v1/social/connections')).body.error.code).toBe('CONTENT_ONLY');
    const me = await call('author', 'GET', '/v1/content/me');
    expect(me.body).toMatchObject({ teamRole: 'member', content: { role: 'author', apps: ['hearken'] }, studioAccess: false, canManageTypes: false });
    const visibleApps = await call('author', 'GET', '/v1/content/apps');
    expect(visibleApps.body.apps.map((entry: { key: string; accent: string }) => [entry.key, entry.accent])).toEqual([['hearken', '#3B74D9']]);
    expect(visibleApps.body.shared).toBeNull();

    // The owner sees and changes them from Hearth Studio.
    const members = await call('steve', 'GET', '/v1/studio/members');
    expect(members.body.members.find((entry: { userId: string }) => entry.userId === author).content).toEqual({ role: 'author', apps: ['hearken'] });
    const changed = await call('steve', 'PATCH', `/v1/studio/members/${author}`, { content: { role: 'reviewer', apps: null } });
    expect(changed.body.content).toEqual({ role: 'reviewer', apps: null });
    expect((await call('author', 'GET', '/v1/content/apps')).body.shared).toBe('reviewer');
    await call('steve', 'PATCH', `/v1/studio/members/${author}`, { content: { role: null, apps: null } });
    expect((await call('author', 'GET', '/v1/content/me')).body.error.code).toBe('NO_CONTENT_ACCESS');

    // Strangers are told to redeem a code; wrong codes run out.
    expect((await call('stranger', 'GET', '/v1/content/me')).body.error.code).toBe('NOT_ON_TEAM');
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await call('stranger', 'POST', '/v1/studio/invites/ABCDEFGH/join', {})).body.error.code).toBe('INVITE_NOT_FOUND');
    }
    const blocked = await call('stranger', 'POST', '/v1/studio/invites/ABCDEFGH/join', {});
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('Retry-After'))).toBeGreaterThan(0);
  });

  it('lets only owners change content types, and bumps the schema version on a new shape', async () => {
    await join('kristen', { post: true, content: { role: 'publisher', apps: null } });
    const definition = { fields: [], sections: null, blocks: ['text'], reviewSteps: [] };
    expect((await call('kristen', 'POST', '/v1/content/types', { slug: 'tips', app: 'sated', name: 'Tips', definition })).status).toBe(403);
    expect((await call('steve', 'POST', '/v1/content/types', { slug: 'tips', app: 'sated', name: 'Tips', definition: { ...definition, blocks: ['scripture'] } })).body.error.code).toBe('BLOCK_NOT_FOR_APP');
    const created = await call('steve', 'POST', '/v1/content/types', { slug: 'tips', app: 'sated', name: 'Tips', definition });
    expect(created.body).toMatchObject({ schemaVersion: 1, app: 'sated' });
    const renamed = await call('steve', 'PUT', `/v1/content/types/${created.body.id}`, { name: 'Kitchen tips' });
    expect(renamed.body.schemaVersion).toBe(1);
    const reshaped = await call('steve', 'PUT', `/v1/content/types/${created.body.id}`, { definition: { ...definition, blocks: ['text', 'image'] } });
    expect(reshaped.body.schemaVersion).toBe(2);
    // A type with no review steps is approved on submit.
    const item = await call('steve', 'POST', '/v1/content/entries', { app: 'sated', typeId: created.body.id, title: 'Sharp knives' });
    const wrongBlock = await call('steve', 'PUT', `/v1/content/entries/${item.body.entry.id}/draft`, { body: { fields: {}, blocks: [quiz(1)] }, revision: 1 });
    expect(wrongBlock.body.error.code).toBe('BLOCK_NOT_ALLOWED');
    await call('steve', 'PUT', `/v1/content/entries/${item.body.entry.id}/draft`, { body: { fields: {}, blocks: [{ id: 't', type: 'text', text: 'Hone weekly.' }] }, revision: 1 });
    expect((await call('steve', 'POST', `/v1/content/entries/${item.body.entry.id}/submit`)).body.entry.state).toBe('approved');
  });

  it('uploads images once', async () => {
    const sha = 'a'.repeat(64);
    const started = await call('steve', 'POST', '/v1/content/media/uploads', { app: 'hearken', sha256: sha, bytes: 1000, contentType: 'image/png', width: 800, height: 600 });
    expect(started.body).toMatchObject({ url: `https://cdn.test/apps/hearken/media/${sha}.png`, upload: { url: `https://storage.test/upload/apps/hearken/media/${sha}.png` } });
    const committed = await call('steve', 'POST', `/v1/content/media/${started.body.id}/commit`);
    expect(committed.body.uploaded).toBe(true);
    expect((await call('steve', 'POST', '/v1/content/media/uploads', { app: 'hearken', sha256: sha, bytes: 1000, contentType: 'image/png' })).body.upload).toBeNull();
    await call('steve', 'PATCH', `/v1/content/media/${started.body.id}`, { alt: 'Sacred Grove' });
    expect((await call('steve', 'GET', '/v1/content/media?app=hearken')).body.media[0]).toMatchObject({ alt: 'Sacred Grove', width: 800 });
  });

  it('takes an item from draft through review to the app, then back', async () => {
    await join('author', { post: false, content: { role: 'author', apps: ['hearken'] } });
    await join('reviewer', { post: false, content: { role: 'reviewer', apps: ['hearken'] } });
    await join('kristen', { post: true, content: { role: 'publisher', apps: null } });
    const type = await moduleType();

    const created = await call('author', 'POST', '/v1/content/entries', { app: 'hearken', typeId: type.id, title: 'The Godhead' });
    expect(created.status).toBe(200);
    const id = created.body.entry.id;
    expect(created.body.entry).toMatchObject({ slug: 'the-godhead', state: 'draft', latestVersion: 1, liveVersion: null });
    expect((await call('author', 'POST', '/v1/content/entries', { app: 'sated', typeId: type.id, title: 'Nope' })).status).toBe(403);
    expect((await call('author', 'POST', '/v1/content/entries', { app: 'hearken', typeId: type.id, title: 'The Godhead' })).body.error.code).toBe('SLUG_TAKEN');

    const body: Body = { fields: { subject: 'Doctrinal Mastery' }, sections: [{ id: 's1', title: 'Three distinct beings', fields: {}, blocks: [
      { id: 'b1', type: 'text', text: 'The Godhead is three separate beings.' },
      { id: 'b2', type: 'scripture', ref: 'D&C 130:22', text: 'The Father has a body of flesh and bones…', highlight: true },
      quiz(1),
    ] }] };
    const saved = await call('author', 'PUT', `/v1/content/entries/${id}/draft`, { body, revision: 1 });
    expect(saved.status).toBe(200);
    expect(saved.body.version).toMatchObject({ version: 1, revision: 2, state: 'draft' });
    const stale = await call('author', 'PUT', `/v1/content/entries/${id}/draft`, { body, revision: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.current.version.revision).toBe(2);
    // Learning modules are Collections: they need a listing with a cover too.
    const listing = { title: 'The Godhead', about: 'Three distinct beings, one purpose: what the scriptures teach about the Father, the Son and the Holy Ghost.', categories: ['Doctrine'], access: 'free', cover: { kind: 'template', template: 'orbit', palette: 'midnight', title: 'The Godhead', mirror: false, italic: false } };
    expect((await call('author', 'PUT', `/v1/content/entries/${id}/listing`, { revision: 2, listing })).body).toEqual({ revision: 3 });

    // Review.
    const checks = await call('author', 'GET', `/v1/content/entries/${id}/checks`);
    expect(checks.body.checks.filter((check: { state: string }) => check.state === 'fail').map((check: { id: string }) => check.id)).toEqual(['approvals']);
    const submitted = await call('author', 'POST', `/v1/content/entries/${id}/submit`);
    expect(submitted.body.entry.state).toBe('in_review');
    expect(submitted.body.reviews.map((review: { step: string; state: string }) => [review.step, review.state]).sort()).toEqual([['Copy edit', 'pending'], ['Doctrine review', 'pending']]);
    expect((await call('author', 'POST', `/v1/content/entries/${id}/reviews`, { step: 'Copy edit', decision: 'approve' })).status).toBe(403);
    await call('reviewer', 'POST', `/v1/content/entries/${id}/comments`, { body: 'Add verse 23 to the explanation', blockId: 'q1' });
    expect((await call('author', 'GET', `/v1/content/entries/${id}/comments`)).body.comments[0]).toMatchObject({ blockId: 'q1', authorName: 'reviewer' });
    await call('reviewer', 'POST', `/v1/content/entries/${id}/reviews`, { step: 'Doctrine review', decision: 'approve' });

    // A publisher can't skip the copy edit; an owner can, and it's recorded.
    expect((await call('kristen', 'POST', `/v1/content/entries/${id}/publish`, {})).body.error.code).toBe('CHECKS_FAILED');
    expect((await call('kristen', 'POST', `/v1/content/entries/${id}/publish`, { override: true })).body.error.code).toBe('PERMISSION_REQUIRED');
    await call('reviewer', 'POST', `/v1/content/entries/${id}/reviews`, { step: 'Copy edit', decision: 'approve' });
    expect((await call('author', 'GET', `/v1/content/entries/${id}`)).body.entry.state).toBe('approved');
    expect((await call('author', 'POST', `/v1/content/entries/${id}/publish`, {})).status).toBe(403);
    expect((await call('kristen-stale', 'POST', `/v1/content/entries/${id}/publish`, {})).body.error.code).toBe('REAUTHENTICATE');

    const published = await call('kristen', 'POST', `/v1/content/entries/${id}/publish`, {});
    expect(published.status).toBe(200);
    expect(published.body).toMatchObject({ scheduled: false, catalogVersion: 1 });
    const [path, json] = [...stored][0]!;
    expect(path).toMatch(/^apps\/hearken\/learning-module\/the-godhead\.v1\.[0-9a-f]{6}\.json$/);
    expect(JSON.parse(json)).toMatchObject({ app: 'hearken', type: 'learning-module', version: 1, body: { fields: { subject: 'Doctrinal Mastery' } } });

    // The app reads its catalog without a token, and gets a 304 when nothing changed.
    const catalog = await call(null, 'GET', '/v1/content/hearken/catalog');
    expect(catalog.status).toBe(200);
    expect(catalog.headers.get('Cache-Control')).toBe('public, max-age=60');
    expect(catalog.body.entries).toEqual([expect.objectContaining({ id, slug: 'the-godhead', version: 1, url: `https://cdn.test/${path}` })]);
    expect((await call(null, 'GET', '/v1/content/hearken/catalog', undefined, { 'If-None-Match': catalog.headers.get('ETag')! })).status).toBe(304);
    expect((await call(null, 'GET', '/v1/content/sated/catalog')).body.entries).toEqual([]);

    // Editing after publishing starts version 2; publishing it and rolling back moves the catalog.
    body.sections![0]!.blocks[0] = { id: 'b1', type: 'text', text: 'The Godhead is made up of three separate beings.' };
    const v2 = await call('author', 'PUT', `/v1/content/entries/${id}/draft`, { body, revision: 3 });
    expect(v2.body.version).toMatchObject({ version: 2, state: 'draft' });
    expect(v2.body.entry).toMatchObject({ latestVersion: 2, liveVersion: 1 });
    expect((await call('author', 'GET', `/v1/content/entries/${id}/diff`)).body).toMatchObject({ from: 1, to: 2, edited: 1, added: 0 });
    await call('author', 'POST', `/v1/content/entries/${id}/submit`);
    await call('steve', 'POST', `/v1/content/entries/${id}/publish`, { override: true });
    let releases = (await call('kristen', 'GET', `/v1/content/releases?entry=${id}`)).body.releases;
    expect(releases.map((entry: { version: number; override: boolean; live: boolean }) => [entry.version, entry.override, entry.live])).toEqual([[2, true, true], [1, false, false]]);
    expect((await call(null, 'GET', '/v1/content/hearken/catalog')).body.entries[0].version).toBe(2);

    const first = releases.find((entry: { version: number }) => entry.version === 1);
    await call('kristen', 'POST', `/v1/content/entries/${id}/rollback`, { releaseId: first.id });
    const rolled = await call(null, 'GET', '/v1/content/hearken/catalog');
    expect(rolled.body).toMatchObject({ version: 3, entries: [expect.objectContaining({ version: 1, url: `https://cdn.test/${path}` })] });
    expect(stored.size).toBe(2);

    expect((await call('author', 'DELETE', `/v1/content/entries/${id}`)).body.error.code).toBe('PUBLISHED');
    await call('kristen', 'POST', `/v1/content/entries/${id}/unpublish`);
    expect((await call(null, 'GET', '/v1/content/hearken/catalog')).body.entries).toEqual([]);
    releases = (await call('kristen', 'GET', '/v1/content/releases')).body.releases;
    expect(releases[0].action).toBe('unpublish');
  });

  it('schedules a publish and shares content with every app', async () => {
    const types = (await call('steve', 'GET', '/v1/content/types')).body.types;
    const help = types.find((type: { slug: string }) => type.slug === 'help-article');
    await join('author', { post: false, content: { role: 'author', apps: ['hearken'] } });
    expect((await call('author', 'POST', '/v1/content/entries', { app: 'shared', typeId: help.id, title: 'Privacy at a glance' })).status).toBe(403);

    const created = await call('steve', 'POST', '/v1/content/entries', { app: 'shared', typeId: help.id, title: 'Privacy at a glance' });
    const id = created.body.entry.id;
    await call('steve', 'PUT', `/v1/content/entries/${id}/draft`, { body: { fields: { summary: 'What we keep' }, blocks: [{ id: 't', type: 'text', text: 'Nothing you don’t give us.' }] }, revision: 1 });
    await call('steve', 'POST', `/v1/content/entries/${id}/submit`);
    const at = new Date(clock + 3600_000).toISOString();
    const scheduled = await call('steve', 'POST', `/v1/content/entries/${id}/publish`, { override: true, at });
    expect(scheduled.body).toMatchObject({ scheduled: true, scheduledFor: at });
    expect((await call('steve', 'GET', '/v1/content/entries')).body.entries[0].scheduledFor).toBe(at);
    expect((await call(null, 'GET', '/v1/content/sated/catalog')).body.entries).toEqual([]);

    clock += 3600_000 + 1000;
    const sated = await call(null, 'GET', '/v1/content/sated/catalog');
    expect(sated.body.entries.map((entry: { slug: string }) => entry.slug)).toEqual(['privacy-at-a-glance']);
    expect((await call(null, 'GET', '/v1/content/hearken/catalog')).body.entries.map((entry: { slug: string }) => entry.slug)).toEqual(['privacy-at-a-glance']);
    expect([...stored.keys()][0]).toMatch(/^shared\/help-article\/privacy-at-a-glance\.v1\./);
  });
});
