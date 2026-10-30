import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { createApp } from '../../src/app.js';
import { readConfig } from '../../src/config.js';
import {
  BLOCK_LIBRARY, blockSchema, bodySchema, buildBundle, definitionSchema, imageFieldMediaIds, isRecipeType, mediaIds, runChecks,
} from '../../src/content/model.js';
import type { Body, MediaFile, MediaInfo, TypeDefinition } from '../../src/content/model.js';
import { MEASUREMENTS, MEASUREMENT_VALUES, recipeIssues } from '../../src/content/recipe-blocks.js';
import { createContentService } from '../../src/content/service.js';
import type { ContentStorage, ContentTypeView } from '../../src/content/service.js';
import { aiBlocks, sectionTool, systemPrompt, toBlock, toUnit, typeForAi } from '../../src/content/write-with-ai.js';
import { createTeamService } from '../../src/studio/team.js';
import { migrate, reset } from '../studio/database.js';

const MIGRATION = readFileSync(new URL('../../supabase/migrations/20261031120000_collections_app_types.sql', import.meta.url), 'utf8');

/** The four types the migration inserts: slug, app, name and parsed definition. */
const migrated = [...MIGRATION.matchAll(/\('([a-z-]+)', '([a-z]+)', '([^']+)', '((?:[^']|'')*)',\s*'(\{.*\})'\)/g)]
  .map(([, slug, app, name, , definition]) => ({ slug: slug!, app: app!, name: name!, definition: definitionSchema.parse(JSON.parse(definition!)) }));
const typeOf = (app: string, slug: string) => {
  const found = migrated.find((type) => type.app === app && type.slug === slug);
  if (!found) throw new Error(`no ${app} ${slug}`);
  return found;
};
const recipe = () => typeOf('bigtable', 'recipe-collection').definition;

const photo = '00000000-0000-4000-8000-000000000201';
const step = '00000000-0000-4000-8000-000000000202';
const uploaded = (...list: string[]) => new Map<string, MediaInfo>(list.map((id) => [id, { id, uploaded: true, alt: '', width: 1200, height: 900 }]));

const ingredients = (items: unknown[] = [{ id: 'i1', amount: 2, unit: 'cup', name: 'flour', note: 'sifted' }]) => ({ id: 'ing', type: 'ingredients', title: '', items });
const steps = (items: unknown[] = [{ id: 's1', text: 'Mix.' }]) => ({ id: 'stp', type: 'steps', title: '', items });
const recipeBody = (fields: Record<string, unknown> = { image: photo, servings: 4 }, blocks: unknown[] = [ingredients(), steps()]) =>
  bodySchema.parse({ fields: {}, sections: [{ id: 'r1', title: 'Pancakes', fields, blocks }] });
const checksOf = (body: Body, media = uploaded(photo), definition: TypeDefinition = recipe()) =>
  runChecks({ appKey: 'bigtable', definition, body, media, approvals: [] });
const check = (body: Body, id: string, media?: Map<string, MediaInfo>) => checksOf(body, media).find((entry) => entry.id === id);

describe('Recipe blocks', () => {
  it('uses BigTable’s measurement values, in its picker’s order', () => {
    expect(MEASUREMENT_VALUES).toEqual([
      'each', 'cup', 'cups', 'tsp', 'tbsp', 'floz', 'g', 'mg', 'kg', 'oz', 'lb', 'ml', 'l', 'pt', 'qt', 'gal',
      'pinch', 'dash', 'packet', 'bunch', 'sprig', 'stalk', 'clove', 'head', 'can', 'jar', 'bottle', 'fillet', 'slice', 'piece',
    ]);
    expect(MEASUREMENTS.find((measurement) => measurement.value === 'floz')).toEqual({ value: 'floz', label: 'Fluid Ounce', short: 'fl oz' });
  });

  it('are BigTable’s blocks', () => {
    expect(BLOCK_LIBRARY.ingredients.app).toBe('bigtable');
    expect(BLOCK_LIBRARY.steps.app).toBe('bigtable');
    expect(BLOCK_LIBRARY.timeline.app).toBeUndefined();
  });

  it('parse with their defaults', () => {
    expect(blockSchema.parse({ id: 'b', type: 'ingredients', items: [{ id: 'i1', name: 'salt' }] }))
      .toEqual({ id: 'b', type: 'ingredients', title: '', items: [{ id: 'i1', amount: null, unit: null, name: 'salt', note: '' }] });
    expect(blockSchema.parse({ id: 'b', type: 'steps' })).toEqual({ id: 'b', type: 'steps', title: '', items: [] });
    // The picker's "—" is no unit.
    expect(blockSchema.parse(ingredients([{ id: 'i1', amount: 1, unit: '', name: 'egg' }]))).toMatchObject({ items: [{ unit: null }] });
    // Half-written rows save, so the editor can save as the author types.
    expect(blockSchema.safeParse(ingredients([{ id: 'i1', amount: null, unit: null, name: '', note: '' }])).success).toBe(true);
  });

  it('turn away units BigTable doesn’t have and anything over the limits', () => {
    const bad: unknown[] = [
      ingredients([{ id: 'i1', amount: 1, unit: 'cupful', name: 'flour' }]),
      ingredients([{ id: 'i1', amount: 1, unit: 'Cup', name: 'flour' }]),
      ingredients([{ id: 'i1', amount: -1, unit: null, name: 'flour' }]),
      ingredients([{ id: 'i1', amount: '2', unit: null, name: 'flour' }]),
      ingredients([{ id: 'i1', amount: 1, unit: null, name: 'x'.repeat(121) }]),
      ingredients([{ id: 'i1', amount: 1, unit: null, name: 'flour', note: 'x'.repeat(121) }]),
      ingredients(Array.from({ length: 61 }, (_, n) => ({ id: `i${n}`, name: 'x' }))),
      { ...ingredients(), title: 'x'.repeat(61) },
      ingredients([{ id: 'i1', name: 'flour', extra: true }]),
      steps([{ id: 's1', text: 'x'.repeat(601) }]),
      steps(Array.from({ length: 41 }, (_, n) => ({ id: `s${n}`, text: 'x' }))),
    ];
    for (const value of bad) expect(blockSchema.safeParse(value).success, JSON.stringify(value).slice(0, 80)).toBe(false);
    expect(blockSchema.safeParse(ingredients(Array.from({ length: 60 }, (_, n) => ({ id: `i${n}`, name: 'x' })))).success).toBe(true);
    expect(blockSchema.safeParse(steps([{ id: 's1', text: 'x'.repeat(600) }])).success).toBe(true);
  });

  it('say what a recipe is missing', () => {
    expect(recipeIssues([], { hasServings: true, servings: 0, image: false })).toEqual(['no ingredients', 'no steps', 'servings must be more than 0', 'no image']);
    expect(recipeIssues([ingredients([{ id: 'i', name: ' ', amount: null, unit: null, note: '' }]), steps([{ id: 's', text: '' }])] as never, { hasServings: false, image: null }))
      .toEqual(['an ingredient without a name', 'an empty step']);
    expect(recipeIssues([ingredients(), steps()] as never, { hasServings: true, servings: 2, image: true })).toEqual([]);
  });
});

describe('Recipe checks', () => {
  it('passes a complete recipe', () => {
    const checks = checksOf(recipeBody());
    expect(checks.filter((entry) => entry.state === 'fail').map((entry) => entry.id)).toEqual(['listing-title', 'cover']);
    expect(check(recipeBody(), 'recipes')).toMatchObject({ state: 'pass', label: 'Every recipe has ingredients, steps, servings and an image' });
  });

  it('fails a recipe without ingredients, steps, servings or an image', () => {
    expect(check(recipeBody({ image: photo, servings: 4 }, [steps()]), 'recipes')).toMatchObject({ state: 'fail', detail: '“Pancakes”: no ingredients' });
    expect(check(recipeBody({ image: photo, servings: 4 }, [ingredients([])]), 'recipes')).toMatchObject({ state: 'fail', detail: '“Pancakes”: no ingredients, no steps' });
    expect(check(recipeBody({ image: photo, servings: 0 }), 'recipes')!.detail).toBe('“Pancakes”: servings must be more than 0');
    expect(check(recipeBody({ image: photo, servings: -2 }), 'recipes')!.state).toBe('fail');
    const noPhoto = recipeBody({ servings: 4 });
    expect(check(noPhoto, 'recipes')!.detail).toBe('“Pancakes”: no image');
    expect(check(noPhoto, 'fields')).toMatchObject({ state: 'fail', detail: 'Missing: Photo (Pancakes)' });
  });

  it('fails a photo that hasn’t finished uploading', () => {
    expect(check(recipeBody(), 'image-fields', new Map())).toMatchObject({ state: 'fail', detail: '1 image field without a finished upload' });
    expect(check(recipeBody(), 'recipes', new Map())!.detail).toBe('“Pancakes”: no image');
    expect(check(recipeBody(), 'image-fields')).toBeUndefined();
  });

  it('leaves other types alone', () => {
    const article = typeOf('sated', 'article').definition;
    expect(isRecipeType(article)).toBe(false);
    expect(isRecipeType(recipe())).toBe(true);
    const body = bodySchema.parse({ fields: {}, sections: [{ id: 'a', title: 'Fibre', fields: {}, blocks: [{ id: 't', type: 'text', text: 'Hi' }] }] });
    expect(checksOf(body, new Map(), article).some((entry) => entry.id === 'recipes')).toBe(false);
  });
});

describe('Image fields in bundles', () => {
  const files = new Map<string, MediaFile>([
    [photo, { id: photo, url: 'https://cdn.test/apps/bigtable/media/photo.jpg', width: 1200, height: 900, alt: 'Pancakes' }],
    [step, { id: step, url: 'https://cdn.test/apps/bigtable/media/step.jpg', width: 800, height: 600, alt: '' }],
  ]);
  const bundle = (body: Body, definition?: TypeDefinition) => JSON.parse(new TextDecoder().decode(buildBundle({
    entryId: 'e', app: 'bigtable', typeSlug: 'recipe-collection', slug: 'breakfasts', title: 'Breakfasts', version: 1, schemaVersion: 1,
    publishedAt: '2026-10-31T00:00:00.000Z', body, media: files, definition,
  }).bytes));

  it('collects image fields with image blocks', () => {
    const body = recipeBody({ image: photo, servings: 4 }, [ingredients(), steps(), { id: 'img', type: 'image', mediaId: step, alt: '', caption: '' }]);
    expect(imageFieldMediaIds(body, recipe())).toEqual([photo]);
    expect(mediaIds(body, recipe())).toEqual([step, photo]);
    // Without the definition, only blocks (as before).
    expect(mediaIds(body)).toEqual([step]);
    // Values that aren't media ids are skipped.
    expect(imageFieldMediaIds(recipeBody({ image: 'not an id', servings: 1 }), recipe())).toEqual([]);
  });

  it('lists every image the bundle uses, by id, so the apps download a recipe’s photo', () => {
    const body = recipeBody({ image: photo, servings: 4 }, [ingredients(), steps(), { id: 'img', type: 'image', mediaId: step, alt: '', caption: '' }]);
    const json = bundle(body, recipe());
    expect(json.body.sections[0].fields).toEqual({ image: photo, servings: 4 });
    expect(json.media).toEqual([
      { id: step, type: 'image', url: 'https://cdn.test/apps/bigtable/media/step.jpg', width: 800, height: 600, alt: '' },
      { id: photo, type: 'image', url: 'https://cdn.test/apps/bigtable/media/photo.jpg', width: 1200, height: 900, alt: 'Pancakes' },
    ]);
    expect(json.body.sections[0].blocks[0]).toEqual({ id: 'ing', type: 'ingredients', title: '', items: [{ id: 'i1', amount: 2, unit: 'cup', name: 'flour', note: 'sifted' }] });
    expect(json.body.sections[0].blocks[1]).toEqual({ id: 'stp', type: 'steps', title: '', items: [{ id: 's1', text: 'Mix.' }] });
  });

  it('leaves `media` out of bundles without images, so they stay as they were', () => {
    const body = bodySchema.parse({ fields: {}, sections: [{ id: 'a', title: 'One', fields: {}, blocks: [{ id: 't', type: 'text', text: 'Hi' }] }] });
    expect(bundle(body, typeOf('sated', 'article').definition)).not.toHaveProperty('media');
  });
});

describe('Collections types migration', () => {
  it('inserts the four types, all downloadable, with their units and blocks', () => {
    expect(migrated.map((type) => `${type.app}/${type.slug}`)).toEqual(['sated/article', 'suffice/article', 'suffice/learning-module', 'bigtable/recipe-collection']);
    const listing = (one: string, many: string) => ({ downloadable: true, unit: { one, many }, countFrom: 'sections' });
    expect(typeOf('sated', 'article')).toMatchObject({ name: 'Article collection', definition: { listing: listing('article', 'articles'), reviewSteps: ['Fact check', 'Copy edit'], blocks: ['text', 'callout', 'image', 'video', 'quiz'] } });
    expect(typeOf('suffice', 'article').definition).toEqual(typeOf('sated', 'article').definition);
    expect(typeOf('suffice', 'learning-module')).toMatchObject({ name: 'Learning module', definition: { listing: listing('lesson', 'lessons'), reviewSteps: ['Fact check', 'Copy edit'], blocks: ['text', 'callout', 'quiz', 'match', 'timeline', 'image', 'video'] } });
    expect(typeOf('bigtable', 'recipe-collection')).toMatchObject({ name: 'Recipe collection', definition: { listing: listing('recipe', 'recipes'), reviewSteps: ['Copy edit'], blocks: ['ingredients', 'steps', 'text', 'callout', 'image'] } });
  });

  it('gives each kind its fields', () => {
    const keys = (fields: { key: string; type: string; required: boolean }[]) => fields.map((field) => `${field.key}:${field.type}${field.required ? '!' : ''}`);
    expect(keys(typeOf('sated', 'article').definition.fields)).toEqual(['summary:longtext']);
    expect(typeOf('sated', 'article').definition.sections!.label).toBe('Article');
    expect(keys(typeOf('sated', 'article').definition.sections!.fields)).toEqual(['dek:text', 'readMinutes:number']);
    expect(keys(typeOf('suffice', 'learning-module').definition.fields)).toEqual(['subject:text!', 'summary:longtext']);
    expect(keys(typeOf('suffice', 'learning-module').definition.sections!.fields)).toEqual(['objective:text']);
    expect(recipe().sections!.label).toBe('Recipe');
    expect(keys(recipe().fields)).toEqual(['summary:longtext']);
    expect(keys(recipe().sections!.fields)).toEqual([
      'description:longtext', 'image:image!', 'servings:number!', 'prepMinutes:number', 'cookMinutes:number', 'difficulty:text', 'tags:text',
    ]);
  });

  it('only uses blocks each app may use', () => {
    for (const type of migrated) {
      for (const kind of type.definition.blocks) {
        const only = BLOCK_LIBRARY[kind].app;
        expect(only === undefined || only === type.app, `${type.app} ${kind}`).toBe(true);
      }
    }
  });
});

describe('Write with AI for the new types', () => {
  const view = (app: string, slug: string): ContentTypeView => {
    const type = typeOf(app, slug);
    return { id: '00000000-0000-4000-8000-000000000301', slug, app, name: type.name, description: '', schemaVersion: 1, definition: type.definition, updatedAt: '' };
  };

  it('offers ingredients and steps for BigTable’s recipes, and scripture to nobody but Hearken', () => {
    expect(aiBlocks(view('bigtable', 'recipe-collection'))).toEqual(['ingredients', 'steps', 'text', 'callout']);
    expect(aiBlocks(view('sated', 'article'))).toEqual(['text', 'callout', 'quiz']);
    expect(aiBlocks(view('suffice', 'learning-module'))).toEqual(['text', 'callout', 'quiz', 'match', 'timeline']);
    // A non-BigTable type that lists the recipe blocks still doesn't get them from Claude.
    const borrowed = view('sated', 'article');
    expect(aiBlocks({ ...borrowed, definition: { ...borrowed.definition, blocks: ['text', 'ingredients', 'steps', 'scripture'] } })).toEqual(['text']);
  });

  it('keeps every field of the Sated, Suffice and BigTable types', () => {
    for (const [app, slug] of [['sated', 'article'], ['suffice', 'article'], ['suffice', 'learning-module'], ['bigtable', 'recipe-collection']] as const) {
      const type = view(app, slug);
      expect(typeForAi(type)).toBe(type);
    }
  });

  it('briefs Claude on recipes: the shapes, the units, no photo and no doctrine', () => {
    const prompt = systemPrompt('bigtable', view('bigtable', 'recipe-collection'));
    expect(prompt).toContain('{"type": "ingredients"');
    expect(prompt).toContain('{"type": "steps"');
    expect(prompt).toContain('"tbsp"');
    expect(prompt).toContain('"piece"');
    expect(prompt).toContain('- servings (Servings): number, required');
    expect(prompt).not.toContain('- image (');
    expect(prompt).toContain('an ingredients block, then a steps block');
    expect(prompt).not.toContain('Scripture and doctrine');
    expect(prompt).not.toContain('{"type": "image"');
    expect(systemPrompt('sated', view('sated', 'article'))).not.toContain('Scripture and doctrine');
    const tool = sectionTool(view('bigtable', 'recipe-collection'));
    const kinds = (tool.input_schema.properties.blocks as { items: { anyOf: { properties: { type: { const: string } } }[] } }).items.anyOf.map((schema) => schema.properties.type.const);
    expect(kinds).toEqual(['ingredients', 'steps', 'text', 'callout']);
    expect(Object.keys((tool.input_schema.properties.fields as { properties: object }).properties)).not.toContain('image');
  });

  it('adds ids to Claude’s ingredients and steps and reads its units and fractions', () => {
    const type = view('bigtable', 'recipe-collection');
    const allowed = aiBlocks(type);
    const result = toBlock({
      type: 'ingredients', title: 'For the batter',
      items: [
        { amount: 2, unit: 'Cups', name: 'plain flour', note: 'sifted' },
        { amount: '1/2', unit: 'Tablespoon', name: 'sugar' },
        { amount: 1, unit: null, name: 'egg', note: '' },
        { amount: null, unit: '—', name: 'salt', note: 'to taste', extra: 1 },
      ],
    }, 's1b1', allowed, type.definition);
    expect(result.errors).toEqual([]);
    expect(result.block).toEqual({
      id: 's1b1', type: 'ingredients', title: 'For the batter',
      items: [
        { id: 's1b1i1', amount: 2, unit: 'cups', name: 'plain flour', note: 'sifted' },
        { id: 's1b1i2', amount: 0.5, unit: 'tbsp', name: 'sugar', note: '' },
        { id: 's1b1i3', amount: 1, unit: null, name: 'egg', note: '' },
        { id: 's1b1i4', amount: null, unit: null, name: 'salt', note: 'to taste' },
      ],
    });
    expect(toBlock({ type: 'steps', items: [{ text: 'Whisk.' }, { text: 'Fry.' }] }, 's2b2', allowed, type.definition).block)
      .toEqual({ id: 's2b2', type: 'steps', title: '', items: [{ id: 's2b2s1', text: 'Whisk.' }, { id: 's2b2s2', text: 'Fry.' }] });
    expect(toUnit('fl oz')).toBe('floz');
    expect(toUnit('TSP.')).toBe('tsp');
  });

  it('says what is wrong with recipe blocks that wouldn’t pass', () => {
    const type = view('bigtable', 'recipe-collection');
    const check = (raw: unknown) => toBlock(raw, 'b', aiBlocks(type), type.definition);
    expect(check({ type: 'ingredients', items: [{ amount: 1, unit: 'handful', name: 'basil' }] }).errors[0]).toMatch(/^items\.0\.unit/);
    expect(check({ type: 'ingredients', items: [] }).errors).toEqual(['needs at least one ingredient']);
    expect(check({ type: 'ingredients', items: [{ amount: 1, unit: null, name: '' }] }).errors).toEqual(['every ingredient needs a name']);
    expect(check({ type: 'steps', items: [] }).errors).toEqual(['needs at least one step']);
    expect(check({ type: 'steps', items: [{ text: ' ' }] }).errors).toEqual(['every step needs text']);
    expect(check({ type: 'image', alt: 'Pancakes' }).errors[0]).toContain('isn’t allowed');
  });
});

// MARK: Against a real Postgres: set SOCIAL_TEST_DATABASE_URL (or HEARKEN_TEST_DATABASE_URL) to an empty scratch database.

const url = process.env.SOCIAL_TEST_DATABASE_URL ?? process.env.HEARKEN_TEST_DATABASE_URL;
const steve = '00000000-0000-4000-8000-0000000000aa';

describe.skipIf(!url)('Recipe collections (Postgres)', () => {
  let sql: postgres.Sql;
  let release: (() => Promise<void>) | undefined;
  let stored: Map<string, string>;
  const storage: ContentStorage = {
    put: async (path, bytes) => { stored.set(path, new TextDecoder().decode(bytes)); },
    putPlus: async (path, bytes) => { stored.set(`plus:${path}`, new TextDecoder().decode(bytes)); },
    plusUrl: async (path, seconds) => `https://storage.test/signed/${path}?expires=${seconds}`,
    uploadUrl: async (path) => ({ url: `https://storage.test/upload/${path}`, token: 't' }),
    publicUrl: (path) => `https://cdn.test/${path}`,
  };
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    sql = postgres(url!, { max: 4, onnotice: () => undefined });
    release = await migrate(sql);
  });
  afterAll(async () => { await release?.(); await sql?.end(); });
  beforeEach(async () => {
    await reset(sql);
    stored = new Map();
    app = createApp({
      config: readConfig({ SOCIAL_OWNER_IDS: steve, ENFORCE_ENTITLEMENTS: 'false' }),
      verifyToken: async () => ({ userId: steve, isAnonymous: false, signedInAt: Date.now() / 1000 - 60 }),
      reserveQuota: async () => undefined,
      entitlements: async () => [],
      studio: { team: createTeamService(sql, { ownerIds: [steve] }), sql },
      content: { service: createContentService(sql, { storage }) },
    });
  });

  const call = async (method: string, path: string, payload?: unknown) => {
    const response = await app.request(path, {
      method,
      headers: { Authorization: 'Bearer steve', ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : undefined };
  };

  it('seeds the four types once, each app with its own slugs', async () => {
    const types = (await call('GET', '/v1/content/types')).body.types as { slug: string; app: string | null; definition: TypeDefinition }[];
    const keyed = types.map((type) => `${type.app ?? 'shared'}/${type.slug}`).sort();
    expect(keyed).toEqual(['bigtable/recipe-collection', 'hearken/learning-module', 'sated/article', 'shared/help-article', 'shared/onboarding', 'shared/whats-new', 'suffice/article', 'suffice/learning-module']);
    // Run again: nothing more.
    const reserved = await sql.reserve();
    try { await reserved.unsafe(MIGRATION); } finally { reserved.release(); }
    expect((await call('GET', '/v1/content/types')).body.types).toHaveLength(8);
    // Still one slug per app.
    const created = await call('POST', '/v1/content/types', { slug: 'article', app: 'sated', name: 'Another', description: '', definition: { blocks: ['text'] } });
    expect(created.body.error.code).toBe('SLUG_TAKEN');
  });

  it('publishes a recipe collection whose bundle lists the photo, and counts it in recipes', async () => {
    const types = (await call('GET', '/v1/content/types')).body.types as { id: string; slug: string; app: string | null }[];
    const type = types.find((entry) => entry.app === 'bigtable' && entry.slug === 'recipe-collection')!;
    const started = await call('POST', '/v1/content/media/uploads', { app: 'bigtable', sha256: 'a'.repeat(64), bytes: 250_000, contentType: 'image/jpeg', width: 1600, height: 1200 });
    await call('POST', `/v1/content/media/${started.body.id}/commit`);
    const image = started.body.id as string;

    const created = await call('POST', '/v1/content/entries', { app: 'bigtable', typeId: type.id, title: 'Weeknight breakfasts' });
    const id = created.body.entry.id as string;
    const draft = { fields: { summary: 'Quick ones.' }, sections: [{ id: 'r1', title: 'Pancakes', fields: { servings: 4, prepMinutes: 10, difficulty: 'easy', tags: 'breakfast, quick' }, blocks: [ingredients(), steps()] }] };
    const saved = await call('PUT', `/v1/content/entries/${id}/draft`, { body: draft, revision: 1 });
    expect(saved.status).toBe(200);
    const listing = { title: 'Weeknight breakfasts', about: 'Five breakfasts you can make before the school run, each in twenty minutes or less.', categories: ['Breakfast'], access: 'free', cover: { kind: 'template', template: 'orbit', palette: 'saffron', title: 'Breakfasts', mirror: false, italic: false } };
    const listed = await call('PUT', `/v1/content/entries/${id}/listing`, { revision: saved.body.version.revision, listing });
    expect(listed.status).toBe(200);

    // Without the photo, publishing is stopped by the recipe check.
    const blocked = await call('POST', `/v1/content/entries/${id}/publish`, { override: true });
    expect(blocked.body.error.code).toBe('CHECKS_FAILED');

    draft.sections[0]!.fields = { ...draft.sections[0]!.fields, image } as never;
    const again = await call('PUT', `/v1/content/entries/${id}/draft`, { body: draft, revision: listed.body.revision });
    expect(again.status).toBe(200);
    const published = await call('POST', `/v1/content/entries/${id}/publish`, { override: true });
    expect(published.status).toBe(200);

    const path = [...stored.keys()].find((key) => key.startsWith('apps/bigtable/recipe-collection/'))!;
    const bundle = JSON.parse(stored.get(path)!);
    expect(bundle.body.sections[0].fields.image).toBe(image);
    expect(bundle.media).toEqual([{ id: image, type: 'image', url: expect.stringMatching(/^https:\/\/cdn\.test\/apps\/bigtable\/media\/a{64}\.jpg$/), width: 1600, height: 1200, alt: '' }]);
    expect(bundle.body.sections[0].blocks.map((block: { type: string }) => block.type)).toEqual(['ingredients', 'steps']);

    const catalog = (await call('GET', '/v1/content/bigtable/catalog?format=2')).body;
    const entry = catalog.entries.find((candidate: { id: string }) => candidate.id === id);
    expect(entry).toMatchObject({ type: 'recipe-collection', downloadable: true, count: { n: 1, one: 'recipe', many: 'recipes' } });
    expect(entry.downloadBytes).toBe(entry.bytes + 250_000);
  });
});
