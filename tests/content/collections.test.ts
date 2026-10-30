import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { createApp } from '../../src/app.js';
import { readConfig } from '../../src/config.js';
import {
  COVERS, RATING_FLOOR, asCatalogV1, asCatalogV2, buildCatalogEntry, catalogRating, cropFits, definitionSchema, diffListings,
  initialsOf, listingSchema, runChecks,
} from '../../src/content/model.js';
import type { Body, CatalogEntry, Listing, MediaInfo, TypeDefinition } from '../../src/content/model.js';
import { APP_ITEM, PUBLIC_CATALOG } from '../../src/content/routes.js';
import { createContentService, defaultColor } from '../../src/content/service.js';
import type { ContentService, ContentStorage } from '../../src/content/service.js';
import { createCollectionAccess } from '../../src/services/entitlements.js';
import type { EffectiveEntitlement } from '../../src/services/subscriptions.js';
import { createTeamService } from '../../src/studio/team.js';
import { migrate, reset } from '../studio/database.js';

const ids = { portrait: '00000000-0000-4000-8000-000000000001', square: '00000000-0000-4000-8000-000000000002', wide: '00000000-0000-4000-8000-000000000003' };
const templateCover = { kind: 'template' as const, template: 'orbit' as const, palette: 'midnight' as const, title: 'The Godhead', mirror: false, italic: false };
const imageCover = { kind: 'image' as const, ...ids, focal: { x: 0.5, y: 0.4 }, showTitle: true, scrim: 'medium' as const, title: 'Sacred Grove' };
const about = 'Three distinct beings, one purpose: what the scriptures teach about the Godhead.';
const listing = (overrides: Partial<Listing> = {}): Listing => ({ title: 'The Godhead', about, categories: ['Doctrine'], access: 'free', cover: templateCover, ...overrides });

const module: TypeDefinition = {
  fields: [], sections: { label: 'Lesson', fields: [] }, blocks: ['text'], reviewSteps: [],
  listing: { downloadable: true, unit: { one: 'lesson', many: 'lessons' }, countFrom: 'sections' },
};
const article: TypeDefinition = { fields: [], sections: null, blocks: ['text'], reviewSteps: [], listing: null };
const body: Body = { fields: {}, sections: [
  { id: 's1', title: 'One', fields: {}, blocks: [{ id: 'b1', type: 'text', text: 'a' }, { id: 'b2', type: 'text', text: 'b' }] },
  { id: 's2', title: 'Two', fields: {}, blocks: [{ id: 'b3', type: 'text', text: 'c' }] },
] };
const bigEnough = new Map<string, MediaInfo>([
  [ids.portrait, { id: ids.portrait, uploaded: true, alt: '', width: 1600, height: 2000 }],
  [ids.square, { id: ids.square, uploaded: true, alt: '', width: 1200, height: 1200 }],
  [ids.wide, { id: ids.wide, uploaded: true, alt: '', width: 2400, height: 1000 }],
]);

describe('Collections listing', () => {
  it('accepts both cover kinds and every palette and template', () => {
    for (const palette of COVERS.palettes) {
      for (const template of COVERS.templates) {
        expect(listingSchema.safeParse(listing({ cover: { ...templateCover, palette: palette.id, template: template.id } })).success).toBe(true);
      }
    }
    expect(listingSchema.safeParse(listing({ cover: imageCover })).success).toBe(true);
    expect(listingSchema.safeParse(listing({ cover: { ...imageCover, title: '', showTitle: false } })).success).toBe(true);
    expect(listingSchema.safeParse(listing({ cover: null, access: 'plus' })).success).toBe(true);
  });

  it('turns away bad palettes, templates and anything over the limits', () => {
    const bad: unknown[] = [
      { ...listing(), cover: { ...templateCover, palette: 'crimson' } },
      { ...listing(), cover: { ...templateCover, template: 'spiral' } },
      { ...listing(), cover: { ...templateCover, title: '' } },
      { ...listing(), cover: { ...templateCover, title: 'x'.repeat(41) } },
      { ...listing(), cover: { ...imageCover, focal: { x: 1.2, y: 0 } } },
      { ...listing(), cover: { ...imageCover, scrim: 'heavy' } },
      { ...listing(), cover: { ...imageCover, portrait: 'not-a-uuid' } },
      { ...listing(), title: 'x'.repeat(35) },
      { ...listing(), about: 'x'.repeat(181) },
      { ...listing(), categories: ['a', 'b', 'c', 'd'] },
      { ...listing(), categories: ['x'.repeat(25)] },
      { ...listing(), categories: [''] },
      { ...listing(), categories: ['Doctrine', 'doctrine'] },
      { ...listing(), access: 'premium' },
      { ...listing(), extra: true },
    ];
    for (const value of bad) expect(listingSchema.safeParse(value).success).toBe(false);
  });

  it('keeps older type definitions valid', () => {
    expect(definitionSchema.parse({ fields: [], sections: null, blocks: ['text'], reviewSteps: [] }).listing).toBeNull();
    expect(definitionSchema.parse({ blocks: ['text'], listing: module.listing }).listing).toEqual(module.listing);
    expect(definitionSchema.safeParse({ blocks: ['text'], listing: { downloadable: true, unit: { one: 'lesson', many: '' }, countFrom: 'sections' } }).success).toBe(false);
  });

  it('serves one list of covers for both renderers', () => {
    expect(COVERS.version).toBe(1);
    expect(COVERS.templates.map((template) => template.id)).toEqual(['orbit', 'horizon', 'eclipse', 'type']);
    expect(COVERS.palettes.find((palette) => palette.id === 'saffron')).toEqual({ id: 'saffron', name: 'Saffron', bg: '#E8C547', ink: '#2A250F', accent: '#C79B1C' });
    expect(COVERS.monograms).toHaveLength(8);
    expect(COVERS.monograms).toContain(defaultColor('00000000-0000-4000-8000-0000000000aa'));
  });

  it('checks a Collection’s listing before it can be published', () => {
    const check = (value: Listing | null, definition = module, media = bigEnough) =>
      Object.fromEntries(runChecks({ appKey: 'hearken', definition, body, media, approvals: [], listing: value })
        .filter((entry) => ['listing-title', 'cover', 'cover-crops', 'cover-title', 'about'].includes(entry.id)).map((entry) => [entry.id, entry.state]));
    expect(check(null)).toEqual({ 'listing-title': 'fail', cover: 'fail' });
    expect(check(listing())).toEqual({ 'listing-title': 'pass', cover: 'pass' });
    expect(check(listing({ title: '', cover: null }))).toEqual({ 'listing-title': 'fail', cover: 'fail' });
    expect(check(listing({ cover: imageCover }))).toEqual({ 'listing-title': 'pass', cover: 'pass', 'cover-crops': 'pass' });
    const small = new Map(bigEnough);
    small.set(ids.wide, { id: ids.wide, uploaded: true, alt: '', width: 1200, height: 500 });
    small.set(ids.square, { id: ids.square, uploaded: true, alt: '', width: 1600, height: 2000 });
    const failed = runChecks({ appKey: 'hearken', definition: module, body, media: small, approvals: [], listing: listing({ cover: imageCover }) });
    expect(failed.find((entry) => entry.id === 'cover-crops')).toMatchObject({ state: 'fail', detail: 'square needs 1200×1200 or larger; wide needs 2400×1000 or larger' });
    expect(check(listing({ cover: { ...templateCover, title: 'A cover title that runs long' } }))['cover-title']).toBe('warn');
    expect(check(listing({ about: 'Short.' })).about).toBe('warn');
    // Types that aren't Collections don't check listings.
    expect(check(null, article)).toEqual({});
  });

  it('sizes crops by shape and pixels', () => {
    expect(cropFits('portrait', bigEnough.get(ids.portrait))).toBe(true);
    expect(cropFits('portrait', { id: 'x', uploaded: true, alt: '', width: 3200, height: 4000 })).toBe(true);
    expect(cropFits('portrait', { id: 'x', uploaded: true, alt: '', width: 1599, height: 1999 })).toBe(false);
    expect(cropFits('wide', { id: 'x', uploaded: false, alt: '', width: 2400, height: 1000 })).toBe(false);
    expect(cropFits('square', { id: 'x', uploaded: true, alt: '', width: null, height: null })).toBe(false);
    expect(cropFits('square', undefined)).toBe(false);
  });

  it('says which listing fields changed', () => {
    expect(diffListings(null, null)).toEqual({ listingChanged: false, listingFields: [] });
    expect(diffListings(listing(), listing())).toEqual({ listingChanged: false, listingFields: [] });
    expect(diffListings(null, listing())).toEqual({ listingChanged: true, listingFields: ['title', 'about', 'categories', 'access', 'cover'] });
    expect(diffListings(listing(), listing({ access: 'plus', cover: { ...templateCover, mirror: true } }))).toEqual({ listingChanged: true, listingFields: ['access', 'cover'] });
  });
});

describe('Collections catalog entries', () => {
  const base = {
    id: 'e1', typeSlug: 'learning-module', slug: 'the-godhead', title: 'The Godhead', version: 3, schemaVersion: 2,
    hash: 'a1b2c3', sha256: 'a1b2c3'.padEnd(64, '0'), bytes: 1234, url: 'https://cdn.test/b.json', publishedAt: '2026-10-31T09:00:00.000Z',
    mediaBytes: 4000, settings: module.listing, listing: listing(), body,
    mediaUrl: (mediaId: string) => `https://cdn.test/media/${mediaId}.jpg`, authorId: 'a1', rating: { average: 4.64, count: 58 },
  };

  it('builds a Collection’s entry', () => {
    expect(buildCatalogEntry(base)).toEqual({
      id: 'e1', type: 'learning-module', slug: 'the-godhead', title: 'The Godhead', version: 3, schemaVersion: 2,
      hash: 'a1b2c3', url: 'https://cdn.test/b.json', bytes: 1234, publishedAt: '2026-10-31T09:00:00.000Z',
      sha256: base.sha256, downloadBytes: 5234, access: 'free', downloadable: true,
      listing: { title: 'The Godhead', about, categories: ['Doctrine'], cover: templateCover },
      authorId: 'a1', count: { n: 2, one: 'lesson', many: 'lessons' }, rating: { average: 4.6, count: 58 }, updatedAt: '2026-10-31T09:00:00.000Z',
    });
  });

  it('resolves image covers, hides Plus URLs and counts blocks when asked', () => {
    const entry = buildCatalogEntry({ ...base, listing: listing({ access: 'plus', cover: imageCover }), settings: { ...module.listing!, countFrom: 'blocks' } });
    expect(entry.url).toBe('');
    expect(entry.access).toBe('plus');
    expect(entry.count).toEqual({ n: 3, one: 'lesson', many: 'lessons' });
    expect(entry.listing?.cover).toEqual({
      kind: 'image', portraitUrl: `https://cdn.test/media/${ids.portrait}.jpg`, squareUrl: `https://cdn.test/media/${ids.square}.jpg`,
      wideUrl: `https://cdn.test/media/${ids.wide}.jpg`, focal: { x: 0.5, y: 0.4 }, showTitle: true, scrim: 'medium', title: 'Sacred Grove',
    });
  });

  it('leaves ratings out under the floor', () => {
    expect(RATING_FLOOR).toBe(5);
    expect(catalogRating(4.5, 4)).toBeUndefined();
    expect(catalogRating(4.25, 5)).toEqual({ average: 4.3, count: 5 });
    expect('rating' in buildCatalogEntry({ ...base, rating: { average: 5, count: 4 } })).toBe(false);
    expect('rating' in buildCatalogEntry({ ...base, rating: { average: null, count: 0 } })).toBe(false);
  });

  it('keeps other types out of Collections', () => {
    const entry = buildCatalogEntry({ ...base, typeSlug: 'help-article', settings: null, listing: listing({ access: 'plus' }) });
    expect(entry).toMatchObject({ downloadable: false, listing: null, access: 'free', count: null, authorId: null, url: 'https://cdn.test/b.json' });
    expect('rating' in entry).toBe(false);
  });

  it('reads stored entries as either format', () => {
    const old: CatalogEntry = { id: 'e0', type: 'help-article', slug: 'privacy', title: 'Privacy', version: 1, schemaVersion: 1, hash: 'ffffff', url: 'https://cdn.test/p.json', bytes: 10, publishedAt: '2026-10-30T00:00:00.000Z' };
    const fresh = buildCatalogEntry(base);
    // Format 1: exactly today's fields, in their stored order, and no Plus items.
    expect(JSON.stringify(asCatalogV1(fresh))).toBe(JSON.stringify({ id: 'e1', type: 'learning-module', slug: 'the-godhead', title: 'The Godhead', version: 3, schemaVersion: 2, hash: 'a1b2c3', url: 'https://cdn.test/b.json', bytes: 1234, publishedAt: '2026-10-31T09:00:00.000Z' }));
    const shuffled = Object.fromEntries(Object.entries(old).reverse()) as CatalogEntry;
    expect(JSON.stringify(asCatalogV1(shuffled))).toBe(JSON.stringify(shuffled));
    expect(JSON.stringify(asCatalogV1(old))).toBe(JSON.stringify(old));
    expect(asCatalogV1(buildCatalogEntry({ ...base, listing: listing({ access: 'plus' }) }))).toBeNull();
    // Format 2: entries from before Collections get the defaults.
    expect(asCatalogV2(old)).toEqual({ ...old, sha256: '', downloadBytes: 10, access: 'free', downloadable: false, listing: null, authorId: null, count: null, updatedAt: old.publishedAt });
  });

  it('makes initials', () => {
    expect(initialsOf('Marisol Vega')).toBe('MV');
    expect(initialsOf('  steve  ')).toBe('S');
    expect(initialsOf('Ana María de la Cruz')).toBe('AC');
    expect(initialsOf('')).toBe('');
  });
});

describe('Collections access', () => {
  const plans: Record<string, EffectiveEntitlement[]> = {
    plus: [{ id: 'hearth_plus', expiresAt: null, source: 'own' }],
    hearken: [{ id: 'hearken_plus', expiresAt: null, source: 'own' }],
    household: [{ id: 'hearth_plus', expiresAt: null, source: 'household' }],
  };
  const source = async (userId: string) => plans[userId] ?? [];

  it('needs Hearth+ or the app’s plan when enforced', async () => {
    const gate = createCollectionAccess(true, source);
    await expect(gate('nobody', 'hearken')).rejects.toMatchObject({ status: 402, code: 'ENTITLEMENT_REQUIRED' });
    await expect(gate('plus', 'sated')).resolves.toBeUndefined();
    await expect(gate('household', 'sated')).resolves.toBeUndefined();
    await expect(gate('hearken', 'hearken')).resolves.toBeUndefined();
    await expect(gate('hearken', 'sated')).rejects.toMatchObject({ status: 402 });
  });

  it('lets everyone through when not enforced', async () => {
    await expect(createCollectionAccess(false, undefined)('nobody', 'hearken')).resolves.toBeUndefined();
  });

  it('keeps the public path to the catalog alone', () => {
    const item = '/v1/content/hearken/items/00000000-0000-4000-8000-000000000001';
    expect(PUBLIC_CATALOG.test('/v1/content/hearken/catalog')).toBe(true);
    for (const path of [`${item}/rating`, `${item}/download`, '/v1/content/hearken/catalog/x', '/v1/content/covers', '/v1/content/catalogs/hearken/featured']) {
      expect(PUBLIC_CATALOG.test(path)).toBe(false);
    }
    for (const suffix of ['rating', 'report', 'download']) expect(APP_ITEM.test(`${item}/${suffix}`)).toBe(true);
    expect(APP_ITEM.test(`${item}/publish`)).toBe(false);
    expect(APP_ITEM.test('/v1/content/entries/00000000-0000-4000-8000-000000000001/listing')).toBe(false);
  });
});

describe('Collections routes (no database)', () => {
  const item = '00000000-0000-4000-8000-000000000001';
  const fake = (calls: string[]) => ({
    download: async (app: string, id: string, entitled: () => Promise<void>) => {
      calls.push(`${app}/${id}`);
      if (id !== item) return { url: 'https://cdn.test/free.json', expiresAt: null };
      await entitled();
      return { url: 'https://storage.test/signed/plus.json', expiresAt: '2026-10-31T09:10:00.000Z' };
    },
  }) as unknown as ContentService;
  const build = (enforce: boolean, entitlements: EffectiveEntitlement[], calls: string[]) => createApp({
    config: readConfig({ ENFORCE_ENTITLEMENTS: enforce ? 'true' : 'false' }),
    verifyToken: async (bearer) => ({ userId: '00000000-0000-4000-8000-0000000000bb', isAnonymous: bearer === 'anonymous' }),
    reserveQuota: async () => undefined,
    entitlements: async () => entitlements,
    content: { service: fake(calls) },
  });
  const post = (app: ReturnType<typeof createApp>, path: string, token: string | null = 'person') =>
    app.request(path, { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {} });

  it('signs Plus downloads for people with the plan, or for everyone when not enforced', async () => {
    const calls: string[] = [];
    const path = `/v1/content/hearken/items/${item}/download`;
    expect((await post(build(true, [], calls), path)).status).toBe(402);
    const signed = await post(build(true, [{ id: 'hearken_plus', expiresAt: null, source: 'household' }], calls), path);
    expect(await signed.json()).toEqual({ url: 'https://storage.test/signed/plus.json', expiresAt: '2026-10-31T09:10:00.000Z' });
    expect((await post(build(false, [], calls), path)).status).toBe(200);
    expect((await post(build(true, [], calls), path, null)).status).toBe(401);
    // A person who isn't on the content team still gets through to these.
    const free = await post(build(true, [], calls), '/v1/content/hearken/items/00000000-0000-4000-8000-000000000002/download');
    expect(await free.json()).toEqual({ url: 'https://cdn.test/free.json', expiresAt: null });
    expect(calls).toHaveLength(4);
  });
});

// Against a real Postgres: set SOCIAL_TEST_DATABASE_URL (or HEARKEN_TEST_DATABASE_URL) to an empty scratch database.
const url = process.env.SOCIAL_TEST_DATABASE_URL ?? process.env.HEARKEN_TEST_DATABASE_URL;

const steve = '00000000-0000-4000-8000-0000000000aa';
const author = '00000000-0000-4000-8000-0000000000ee';
const reviewer = '00000000-0000-4000-8000-0000000000ff';
const stranger = '00000000-0000-4000-8000-0000000000bb';
const raters = [1, 2, 3, 4, 5].map((n) => `00000000-0000-4000-8000-00000000010${n}`);
const users: Record<string, string> = { steve, author, reviewer, stranger, ...Object.fromEntries(raters.map((id, index) => [`r${index + 1}`, id])) };

describe.skipIf(!url)('Collections (Postgres)', () => {
  let sql: postgres.Sql;
  let release: (() => Promise<void>) | undefined;
  let stored: Map<string, string>;
  let plans: Record<string, EffectiveEntitlement[]>;
  const storage: ContentStorage = {
    put: async (path, bytes) => { stored.set(path, new TextDecoder().decode(bytes)); },
    putPlus: async (path, bytes) => { stored.set(`plus:${path}`, new TextDecoder().decode(bytes)); },
    plusUrl: async (path, seconds) => `https://storage.test/signed/${path}?expires=${seconds}`,
    uploadUrl: async (path) => ({ url: `https://storage.test/upload/${path}`, token: 't' }),
    publicUrl: (path) => `https://cdn.test/${path}`,
  };
  const build = (enforce: boolean) => createApp({
    config: readConfig({ SOCIAL_OWNER_IDS: steve, ENFORCE_ENTITLEMENTS: enforce ? 'true' : 'false' }),
    verifyToken: async (bearer) => ({ userId: users[bearer] ?? stranger, isAnonymous: bearer === 'anonymous', signedInAt: Date.now() / 1000 - 60 }),
    reserveQuota: async () => undefined,
    entitlements: async (userId) => plans[userId] ?? [],
    studio: { team: createTeamService(sql, { ownerIds: [steve] }), sql },
    content: { service: createContentService(sql, { storage }) },
  });
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    sql = postgres(url!, { max: 4, onnotice: () => undefined });
    release = await migrate(sql);
  });
  afterAll(async () => { await release?.(); await sql?.end(); });
  beforeEach(async () => {
    await reset(sql);
    stored = new Map();
    plans = {};
    app = build(true);
  });

  const call = async (who: string | null, method: string, path: string, payload?: unknown, headers: Record<string, string> = {}, on = app) => {
    const response = await on.request(path, {
      method,
      headers: { ...(who ? { Authorization: `Bearer ${who}` } : {}), ...headers, ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    const text = await response.text();
    return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : undefined };
  };

  async function join(who: string, invite: Record<string, unknown>) {
    const created = await call('steve', 'POST', '/v1/studio/invites', invite);
    expect((await call(who, 'POST', `/v1/studio/invites/${created.body.code}/join`, { displayName: who === 'author' ? 'Marisol Vega' : who })).status).toBe(200);
  }

  const upload = async (n: number, width: number, height: number) => {
    const started = await call('steve', 'POST', '/v1/content/media/uploads', { app: 'hearken', sha256: n.toString(16).padStart(64, '0'), bytes: 1000 * n, contentType: 'image/jpeg', width, height });
    await call('steve', 'POST', `/v1/content/media/${started.body.id}/commit`);
    return started.body.id as string;
  };

  /** Makes, lists and publishes a learning module as `who` (steve publishes). */
  async function publishModule(who: string, title: string, value: Listing | null, extraBlocks: unknown[] = []) {
    const types = (await call('steve', 'GET', '/v1/content/types')).body.types;
    const type = types.find((entry: { slug: string }) => entry.slug === 'learning-module');
    const created = await call(who, 'POST', '/v1/content/entries', { app: 'hearken', typeId: type.id, title });
    const id = created.body.entry.id as string;
    const lessons = { fields: { subject: 'Doctrine' }, sections: [
      { id: 's1', title: 'One', fields: {}, blocks: [{ id: 'b1', type: 'text', text: 'Hello' }, ...extraBlocks] },
      { id: 's2', title: 'Two', fields: {}, blocks: [{ id: 'b2', type: 'text', text: 'Again' }] },
    ] };
    const saved = await call(who, 'PUT', `/v1/content/entries/${id}/draft`, { body: lessons, revision: 1 });
    if (value) expect((await call(who, 'PUT', `/v1/content/entries/${id}/listing`, { revision: saved.body.version.revision, listing: value })).status).toBe(200);
    await call(who, 'POST', `/v1/content/entries/${id}/submit`);
    const published = await call('steve', 'POST', `/v1/content/entries/${id}/publish`, { override: true });
    return { id, published };
  }

  it('saves listings like drafts and checks them before publishing', async () => {
    await join('author', { post: false, content: { role: 'author', apps: ['hearken'] } });
    const types = (await call('steve', 'GET', '/v1/content/types')).body.types;
    expect(types.find((entry: { slug: string }) => entry.slug === 'learning-module').definition.listing).toEqual({ downloadable: true, unit: { one: 'lesson', many: 'lessons' }, countFrom: 'sections' });
    expect(types.find((entry: { slug: string }) => entry.slug === 'help-article').definition.listing).toBeNull();

    const { id, published } = await publishModule('author', 'The Godhead', null);
    expect(published.body.error.code).toBe('CHECKS_FAILED');
    expect(published.body.error.message).toContain('A cover is set');
    const item = (await call('author', 'GET', `/v1/content/entries/${id}`)).body;
    expect(item.version.listing).toBeNull();

    expect((await call('author', 'PUT', `/v1/content/entries/${id}/listing`, { revision: 1, listing: listing() })).status).toBe(409);
    expect((await call('author', 'PUT', `/v1/content/entries/${id}/listing`, { revision: item.version.revision, listing: { ...listing(), cover: { ...templateCover, palette: 'crimson' } } })).status).toBe(400);
    const saved = await call('author', 'PUT', `/v1/content/entries/${id}/listing`, { revision: item.version.revision, listing: listing() });
    expect(saved.body).toEqual({ revision: item.version.revision + 1 });
    // Saving the listing sent it back to draft, like a draft save.
    const after = (await call('author', 'GET', `/v1/content/entries/${id}`)).body;
    expect(after).toMatchObject({ entry: { state: 'draft' }, version: { listing: listing() } });
    expect((await call('author', 'GET', `/v1/content/entries/${id}/diff`)).body).toMatchObject({ listingChanged: true, listingFields: ['title', 'about', 'categories', 'access', 'cover'] });

    // A cover image must be one of the app's uploads.
    const missing = await call('author', 'PUT', `/v1/content/entries/${id}/listing`, { revision: saved.body.revision, listing: listing({ cover: imageCover }) });
    expect(missing.body.error.code).toBe('MEDIA_NOT_FOUND');

    // Help articles aren't Collections.
    const help = types.find((entry: { slug: string }) => entry.slug === 'help-article');
    const article = await call('steve', 'POST', '/v1/content/entries', { app: 'shared', typeId: help.id, title: 'Privacy' });
    expect((await call('steve', 'PUT', `/v1/content/entries/${article.body.entry.id}/listing`, { revision: 1, listing: listing() })).body.error.code).toBe('NOT_DOWNLOADABLE');
  });

  it('publishes free and Plus Collections into both catalog formats', async () => {
    await join('author', { post: false, content: { role: 'author', apps: ['hearken'] } });
    const crops = { portrait: await upload(1, 1600, 2000), square: await upload(2, 1200, 1200), wide: await upload(3, 2400, 1000) };
    const photo = await upload(4, 800, 600);

    const free = await publishModule('author', 'The Godhead', listing());
    expect(free.published.status).toBe(200);
    const plus = await publishModule('steve', 'Temples', listing({ title: 'Temples', access: 'plus', cover: { ...imageCover, ...crops } }),
      [{ id: 'img', type: 'image', mediaId: photo, alt: 'A temple', caption: '' }]);
    expect(plus.published.status).toBe(200);
    const plusPath = [...stored.keys()].find((path) => path.startsWith('plus:'))!;
    expect(plusPath).toMatch(/^plus:apps\/hearken\/learning-module\/temples\.v1\.[0-9a-f]{6}\.json$/);
    expect([...stored.keys()].filter((path) => !path.startsWith('plus:'))).toHaveLength(1);

    // A shared help article stays a plain item.
    const help = (await call('steve', 'GET', '/v1/content/types')).body.types.find((entry: { slug: string }) => entry.slug === 'help-article');
    const article = await call('steve', 'POST', '/v1/content/entries', { app: 'shared', typeId: help.id, title: 'Privacy' });
    await call('steve', 'PUT', `/v1/content/entries/${article.body.entry.id}/draft`, { body: { fields: { summary: 'What we keep' }, blocks: [{ id: 't', type: 'text', text: 'Nothing.' }] }, revision: 1 });
    await call('steve', 'POST', `/v1/content/entries/${article.body.entry.id}/submit`);
    await call('steve', 'POST', `/v1/content/entries/${article.body.entry.id}/publish`, { override: true });

    // Format 1: today's fields only, and no Plus items.
    const v1 = await call(null, 'GET', '/v1/content/hearken/catalog');
    expect(v1.body.entries.map((entry: { slug: string }) => entry.slug)).toEqual(['the-godhead', 'privacy']);
    for (const entry of v1.body.entries) expect(Object.keys(entry).sort()).toEqual(['bytes', 'hash', 'id', 'publishedAt', 'schemaVersion', 'slug', 'title', 'type', 'url', 'version']);
    expect(Object.keys(v1.body)).toEqual(['app', 'version', 'sharedVersion', 'minAppVersion', 'updatedAt', 'entries']);

    // Format 2: everything, with listings, authors and Plus without a URL.
    const v2 = await call(null, 'GET', '/v1/content/hearken/catalog?format=2');
    expect(v2.status).toBe(200);
    expect(v2.body).toMatchObject({ app: 'hearken', format: 2, coversVersion: 1, featured: [] });
    const byslug = Object.fromEntries(v2.body.entries.map((entry: { slug: string }) => [entry.slug, entry]));
    expect(byslug['the-godhead']).toMatchObject({
      access: 'free', downloadable: true, url: expect.stringMatching(/^https:\/\/cdn\.test\/apps\/hearken\//),
      listing: { title: 'The Godhead', about, categories: ['Doctrine'], cover: templateCover },
      count: { n: 2, one: 'lesson', many: 'lessons' }, sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(byslug['the-godhead'].sha256.slice(0, 6)).toBe(byslug['the-godhead'].hash);
    expect(byslug['the-godhead'].downloadBytes).toBe(byslug['the-godhead'].bytes);
    expect(byslug.temples).toMatchObject({
      access: 'plus', downloadable: true, url: '',
      listing: { cover: { kind: 'image', portraitUrl: `https://cdn.test/apps/hearken/media/${'1'.padStart(64, '0')}.jpg`, scrim: 'medium' } },
    });
    expect(byslug.temples.downloadBytes).toBe(byslug.temples.bytes + 4000);
    expect(byslug.privacy).toMatchObject({ downloadable: false, listing: null, access: 'free', count: null, authorId: null });
    expect('rating' in byslug['the-godhead']).toBe(false);
    expect(v2.body.authors).toHaveLength(2);
    const marisol = v2.body.authors.find((entry: { id: string }) => entry.id === byslug['the-godhead'].authorId);
    expect(marisol).toMatchObject({ name: 'Marisol Vega', initials: 'MV', photoUrl: null, bio: '' });
    expect(COVERS.monograms).toContain(marisol.color);
    expect((await call(null, 'GET', '/v1/content/hearken/catalog?format=2', undefined, { 'If-None-Match': v2.headers.get('ETag')! })).status).toBe(304);
    expect(v2.headers.get('ETag')).not.toBe(v1.headers.get('ETag'));

    // A new author name changes the format-2 ETag (and leaves format 1 alone).
    const me = await call('author', 'PUT', '/v1/content/authors/me', { name: 'Marisol Vega-Ruiz', bio: 'Seminary teacher.', color: '#3E4A2C', photoMediaId: null });
    expect(me.body).toMatchObject({ name: 'Marisol Vega-Ruiz', initials: 'MV', bio: 'Seminary teacher.', color: '#3E4A2C', photoUrl: null, published: true });
    expect((await call(null, 'GET', '/v1/content/hearken/catalog?format=2', undefined, { 'If-None-Match': v2.headers.get('ETag')! })).status).toBe(200);
    expect((await call(null, 'GET', '/v1/content/hearken/catalog', undefined, { 'If-None-Match': v1.headers.get('ETag')! })).status).toBe(304);
    expect((await call('author', 'PUT', '/v1/content/authors/me', { name: 'M', bio: '', color: '#123456', photoMediaId: null })).status).toBe(400);

    // Rolling back keeps the full hash and download size.
    const releases = (await call('steve', 'GET', `/v1/content/releases?entry=${plus.id}`)).body.releases;
    await call('steve', 'POST', `/v1/content/entries/${plus.id}/rollback`, { releaseId: releases[0].id });
    const rolled = (await call(null, 'GET', '/v1/content/hearken/catalog?format=2')).body.entries.find((entry: { slug: string }) => entry.slug === 'temples');
    expect(rolled).toMatchObject({ sha256: byslug.temples.sha256, downloadBytes: byslug.temples.downloadBytes, url: '', access: 'plus' });
  });

  it('features up to five published items', async () => {
    await join('author', { post: false, content: { role: 'author', apps: ['hearken'] } });
    const { id } = await publishModule('steve', 'The Godhead', listing());
    const before = await call(null, 'GET', '/v1/content/hearken/catalog?format=2');
    expect((await call('steve', 'GET', '/v1/content/catalogs/hearken/featured')).body).toEqual({ items: [] });
    expect((await call('author', 'PUT', '/v1/content/catalogs/hearken/featured', { items: [{ id, label: null }] })).status).toBe(403);
    expect((await call('steve', 'PUT', '/v1/content/catalogs/hearken/featured', { items: [{ id: stranger, label: null }] })).body.error.code).toBe('NOT_PUBLISHED');
    expect((await call('steve', 'PUT', '/v1/content/catalogs/sated/featured', { items: [{ id, label: null }] })).body.error.code).toBe('NOT_PUBLISHED');
    expect((await call('steve', 'PUT', '/v1/content/catalogs/hearken/featured', { items: Array.from({ length: 6 }, () => ({ id, label: null })) })).status).toBe(400);
    expect((await call('steve', 'PUT', '/v1/content/catalogs/hearken/featured', { items: [{ id, label: 'Best ever' }] })).status).toBe(400);

    const set = await call('steve', 'PUT', '/v1/content/catalogs/hearken/featured', { items: [{ id, label: 'Editor’s pick' }] });
    expect(set.body).toEqual({ items: [{ id, label: 'Editor’s pick' }] });
    expect((await call('author', 'GET', '/v1/content/catalogs/hearken/featured')).body).toEqual({ items: [{ id, label: 'Editor’s pick' }] });
    const after = await call(null, 'GET', '/v1/content/hearken/catalog?format=2');
    expect(after.body.version).toBe(before.body.version + 1);
    expect(after.body.featured).toEqual([{ id, label: 'Editor’s pick' }]);
    expect(after.headers.get('ETag')).not.toBe(before.headers.get('ETag'));
    // Unpublished items drop out of the featured list the apps see.
    await call('steve', 'POST', `/v1/content/entries/${id}/unpublish`);
    expect((await call(null, 'GET', '/v1/content/hearken/catalog?format=2')).body.featured).toEqual([]);
  });

  it('rates Collections and shows the average from five ratings', async () => {
    await join('author', { post: false, content: { role: 'author', apps: ['hearken'] } });
    const { id } = await publishModule('author', 'The Godhead', listing());
    const path = `/v1/content/hearken/items/${id}/rating`;
    expect((await call(null, 'PUT', path, { stars: 5 })).status).toBe(401);
    expect((await call('anonymous', 'PUT', path, { stars: 5 })).status).toBe(401);
    expect((await call('r1', 'PUT', path, { stars: 6 })).status).toBe(400);
    expect((await call('r1', 'PUT', `/v1/content/sated/items/${id}/rating`, { stars: 5 })).status).toBe(404);
    expect((await call('r1', 'GET', path)).body).toEqual({ mine: null });

    expect((await call('r1', 'PUT', path, { stars: 2 })).body).toEqual({ average: 2, count: 1, mine: 2 });
    expect((await call('r1', 'PUT', path, { stars: 4 })).body).toEqual({ average: 4, count: 1, mine: 4 });
    expect((await call('r1', 'GET', path)).body).toEqual({ mine: 4 });
    for (const who of ['r2', 'r3', 'r4']) await call(who, 'PUT', path, { stars: 5 });
    const four = await call(null, 'GET', '/v1/content/hearken/catalog?format=2');
    expect('rating' in four.body.entries[0]).toBe(false);
    expect((await call('r5', 'PUT', path, { stars: 4 })).body).toEqual({ average: 4.6, count: 5, mine: 4 });
    const five = await call(null, 'GET', '/v1/content/hearken/catalog?format=2');
    expect(five.body.entries[0].rating).toEqual({ average: 4.6, count: 5 });
    expect(five.body.version).toBe(four.body.version + 1);
    expect(five.headers.get('ETag')).not.toBe(four.headers.get('ETag'));
    // Format 1 never shows ratings.
    expect('rating' in (await call(null, 'GET', '/v1/content/hearken/catalog')).body.entries[0]).toBe(false);

    const mine = await call('author', 'GET', '/v1/content/authors/me/collections');
    expect(mine.body).toEqual([{ entryId: id, title: 'The Godhead', app: 'hearken', state: 'published', liveVersion: 1, latestVersion: 1, rating: { average: 4.6, count: 5 }, openReports: 0 }]);

    // A new version keeps the rating.
    await call('author', 'PUT', `/v1/content/entries/${id}/listing`, { revision: (await call('author', 'GET', `/v1/content/entries/${id}`)).body.version.revision, listing: listing({ about: `${about} Now with more.` }) });
    await call('author', 'POST', `/v1/content/entries/${id}/submit`);
    await call('steve', 'POST', `/v1/content/entries/${id}/publish`, { override: true });
    expect((await call(null, 'GET', '/v1/content/hearken/catalog?format=2')).body.entries[0]).toMatchObject({ version: 2, rating: { average: 4.6, count: 5 }, listing: { about: `${about} Now with more.` } });
  });

  it('takes reports and lets publishers dismiss them without seeing who sent them', async () => {
    await join('author', { post: false, content: { role: 'author', apps: ['hearken'] } });
    const { id } = await publishModule('author', 'The Godhead', listing());
    const path = `/v1/content/hearken/items/${id}/report`;
    expect((await call('anonymous', 'POST', path, { reason: 'broken', details: '' })).status).toBe(401);
    expect((await call('r1', 'POST', path, { reason: 'spam', details: '' })).status).toBe(400);
    expect((await call('r1', 'POST', path, { reason: 'broken', details: 'Lesson two is empty' })).status).toBe(202);
    expect((await call('r1', 'POST', path, { reason: 'other', details: 'Again' })).status).toBe(202);
    expect((await call('r2', 'POST', path, { reason: 'copyright' })).status).toBe(202);

    expect((await call('author', 'GET', '/v1/content/reports?state=open')).status).toBe(403);
    const open = await call('steve', 'GET', '/v1/content/reports?state=open');
    expect(open.body).toEqual([{
      entryId: id, title: 'The Godhead', app: 'hearken', type: 'learning-module', authorName: 'Marisol Vega', liveVersion: 1, rating: null,
      reports: [
        { id: expect.any(String), reason: 'broken', details: 'Lesson two is empty', createdAt: expect.any(String) },
        { id: expect.any(String), reason: 'copyright', details: '', createdAt: expect.any(String) },
      ],
    }]);
    const text = JSON.stringify(open.body);
    for (const who of raters) expect(text).not.toContain(who);
    expect((await call('author', 'GET', '/v1/content/authors/me/collections')).body[0].openReports).toBe(2);

    expect((await call('author', 'POST', `/v1/content/reports/${id}/dismiss`)).status).toBe(403);
    expect((await call('steve', 'POST', `/v1/content/reports/${id}/dismiss`)).status).toBe(204);
    expect((await call('steve', 'GET', '/v1/content/reports')).body).toEqual([]);
    const [closed] = await sql`select state, closed_by from content_collection_reports limit 1`;
    expect(closed).toMatchObject({ state: 'dismissed', closed_by: steve });
  });

  it('hands out free URLs and signs Plus links for people with the plan', async () => {
    const free = await publishModule('steve', 'The Godhead', listing());
    const plus = await publishModule('steve', 'Temples', listing({ title: 'Temples', access: 'plus' }));
    const freeUrl = (await call(null, 'GET', '/v1/content/hearken/catalog?format=2')).body.entries.find((entry: { id: string }) => entry.id === free.id).url;

    expect((await call(null, 'POST', `/v1/content/hearken/items/${free.id}/download`)).status).toBe(401);
    expect((await call('r1', 'POST', `/v1/content/hearken/items/${free.id}/download`)).body).toEqual({ url: freeUrl, expiresAt: null });
    expect((await call('r1', 'POST', `/v1/content/sated/items/${free.id}/download`)).status).toBe(404);

    const path = `/v1/content/hearken/items/${plus.id}/download`;
    const denied = await call('r1', 'POST', path);
    expect(denied.status).toBe(402);
    expect(denied.body.error.code).toBe('ENTITLEMENT_REQUIRED');
    plans[raters[0]!] = [{ id: 'hearken_plus', expiresAt: null, source: 'household' }];
    const signed = await call('r1', 'POST', path);
    expect(signed.body.url).toMatch(/^https:\/\/storage\.test\/signed\/apps\/hearken\/learning-module\/temples\.v1\.[0-9a-f]{6}\.json\?expires=600$/);
    expect(Date.parse(signed.body.expiresAt) - Date.now()).toBeGreaterThan(590_000);
    expect((await call('r2', 'POST', path, undefined, {}, build(false))).status).toBe(200);
  });

  it('forgets a deleted account’s ratings and reports', async () => {
    const { id } = await publishModule('steve', 'The Godhead', listing());
    const service = createContentService(sql, { storage });
    for (const who of ['r1', 'r2']) await call(who, 'PUT', `/v1/content/hearken/items/${id}/rating`, { stars: who === 'r1' ? 1 : 5 });
    await call('r1', 'POST', `/v1/content/hearken/items/${id}/report`, { reason: 'other', details: '' });
    await service.forgetUser(raters[0]!);
    const [entry] = await sql`select rating_count, rating_average from content_entries where id = ${id}`;
    expect({ count: entry!.rating_count, average: Number(entry!.rating_average) }).toEqual({ count: 1, average: 5 });
    expect(await sql`select 1 from content_collection_reports`).toHaveLength(0);
  });
});
