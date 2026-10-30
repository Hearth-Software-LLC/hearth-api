import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  assessmentBlockSchema, blockId, linkBlockSchema, matchExtras, questionExtras, scriptureExtras, stepBlockSchema, unresolvedReferences,
} from './hearken-blocks.js';

/**
 * Hearth Content's model: content types, the block library, a draft's body, the checks a version
 * must pass before it's published, what changed between two versions, and the bundle an app
 * downloads. Pure functions; the service and routes do the storage.
 */

export const FIELD_TYPES = ['text', 'longtext', 'number', 'boolean', 'image'] as const;
export type FieldType = typeof FIELD_TYPES[number];

export const BLOCK_KINDS = ['text', 'scripture', 'callout', 'quiz', 'match', 'timeline', 'image', 'video', 'link', 'step', 'assessment'] as const;
export type BlockKind = typeof BLOCK_KINDS[number];

/** The block library. `app`: only that app's types may use the block. */
export const BLOCK_LIBRARY: Record<BlockKind, { label: string; description: string; app?: string }> = {
  text: { label: 'Text', description: 'Paragraphs with simple formatting.' },
  scripture: { label: 'Scripture', description: 'A reference Hearken opens in its reader, with the verse text.', app: 'hearken' },
  callout: { label: 'Callout', description: 'A highlighted point, such as a key doctrine.' },
  quiz: { label: 'Quiz', description: 'A multiple-choice question with one correct answer.' },
  match: { label: 'Match game', description: 'Pairs to match.' },
  timeline: { label: 'Timeline', description: 'Dated events in order.', app: 'hearken' },
  image: { label: 'Image', description: 'An uploaded image with alt text.' },
  video: { label: 'Video', description: 'A video link.' },
  link: { label: 'Link', description: 'A resource: a book, article or website, or a chapter Hearken opens.' },
  step: { label: 'Step', description: 'A Scholar Path learning item; the blocks after it are its content.', app: 'hearken' },
  assessment: { label: 'Assessment', description: 'A quiz drawn from a question pool, a rubric-scored essay, a checkpoint or exam.', app: 'hearken' },
};

const key = z.string().regex(/^[a-z][A-Za-z0-9]{0,39}$/);
export const fieldDefSchema = z.object({
  key,
  label: z.string().trim().min(1).max(60),
  type: z.enum(FIELD_TYPES),
  required: z.boolean().default(false),
}).strict();
export type FieldDef = z.infer<typeof fieldDefSchema>;

/**
 * Whether a type's items are Collections people download in the apps, and what one item counts in
 * its lists ("6 lessons"). Null (the default, so older definitions stay valid): not downloadable.
 */
export const listingSettingsSchema = z.object({
  downloadable: z.boolean(),
  unit: z.object({ one: z.string().trim().min(1).max(20), many: z.string().trim().min(1).max(20) }).strict(),
  countFrom: z.enum(['sections', 'blocks']),
}).strict();
export type ListingSettings = z.infer<typeof listingSettingsSchema>;

export const definitionSchema = z.object({
  fields: z.array(fieldDefSchema).max(30).default([]),
  sections: z.object({ label: z.string().trim().min(1).max(30), fields: z.array(fieldDefSchema).max(20).default([]) }).strict().nullable().default(null),
  blocks: z.array(z.enum(BLOCK_KINDS)).min(1).max(BLOCK_KINDS.length),
  reviewSteps: z.array(z.string().trim().min(1).max(60)).max(5).default([]),
  listing: listingSettingsSchema.nullable().default(null),
}).strict().superRefine((value, context) => {
  const keys = value.fields.map((field) => field.key);
  if (new Set(keys).size !== keys.length) context.addIssue({ code: 'custom', message: 'Field keys must be unique' });
  if (new Set(value.blocks).size !== value.blocks.length) context.addIssue({ code: 'custom', message: 'Blocks are listed twice' });
  if (new Set(value.reviewSteps).size !== value.reviewSteps.length) context.addIssue({ code: 'custom', message: 'Review steps must be unique' });
});
export type TypeDefinition = z.infer<typeof definitionSchema>;

// MARK: Listing and covers

export const PALETTE_IDS = ['midnight', 'harbor', 'pine', 'olive', 'terracotta', 'tomato', 'parchment', 'saffron'] as const;
export type PaletteId = typeof PALETTE_IDS[number];
export const COVER_TEMPLATES = ['orbit', 'horizon', 'eclipse', 'type'] as const;
export const SCRIMS = ['light', 'medium', 'strong'] as const;
export const ACCESS = ['free', 'plus'] as const;
export type Access = typeof ACCESS[number];

/** The smallest each image crop may be, and its shape. */
export const CROP_SIZES = {
  portrait: { width: 1600, height: 2000 },
  square: { width: 1200, height: 1200 },
  wide: { width: 2400, height: 1000 },
} as const;
export type CropName = keyof typeof CROP_SIZES;

/** Cover titles longer than this get a warning; abouts shorter than this do. */
export const COVER_TITLE_SHORT = 22;
export const ABOUT_SHORT = 60;

/**
 * The cover templates, palettes and author colors: one list both renderers (web and iOS) read from
 * GET /v1/content/covers. The shapes' geometry is in the Collections contract.
 */
export const COVERS = {
  version: 1,
  templates: [
    { id: 'orbit', name: 'Orbit' },
    { id: 'horizon', name: 'Horizon' },
    { id: 'eclipse', name: 'Eclipse' },
    { id: 'type', name: 'Type' },
  ],
  palettes: [
    { id: 'midnight', name: 'Midnight', bg: '#2C3766', ink: '#EEF0FA', accent: '#5865A3' },
    { id: 'harbor', name: 'Harbor', bg: '#24384A', ink: '#EAF0F4', accent: '#4F7896' },
    { id: 'pine', name: 'Pine', bg: '#1F4A47', ink: '#E7F3F1', accent: '#4C8580' },
    { id: 'olive', name: 'Olive', bg: '#3E4A2C', ink: '#F3EBDD', accent: '#7F8C4C' },
    { id: 'terracotta', name: 'Terracotta', bg: '#6B3A2E', ink: '#F7ECE6', accent: '#A0604E' },
    { id: 'tomato', name: 'Tomato', bg: '#B8432F', ink: '#FBEFE6', accent: '#E2805F' },
    { id: 'parchment', name: 'Parchment', bg: '#C9B48A', ink: '#2A2212', accent: '#A08A55' },
    { id: 'saffron', name: 'Saffron', bg: '#E8C547', ink: '#2A250F', accent: '#C79B1C' },
  ],
  monograms: ['#2C3766', '#24384A', '#1F4A47', '#3E4A2C', '#6B3A2E', '#A63A28', '#4A3A5C', '#7A5A22'],
} as const satisfies { version: number; templates: { id: typeof COVER_TEMPLATES[number]; name: string }[]; palettes: { id: PaletteId; name: string; bg: string; ink: string; accent: string }[]; monograms: string[] };
export type MonogramColor = typeof COVERS.monograms[number];

const unit = z.number().min(0).max(1);
export const coverSpecSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('template'), template: z.enum(COVER_TEMPLATES), palette: z.enum(PALETTE_IDS),
    title: z.string().trim().min(1).max(40), mirror: z.boolean(), italic: z.boolean(),
  }).strict(),
  z.object({
    kind: z.literal('image'), portrait: z.uuid(), square: z.uuid(), wide: z.uuid(),
    focal: z.object({ x: unit, y: unit }).strict(), showTitle: z.boolean(), scrim: z.enum(SCRIMS),
    title: z.string().trim().max(40),
  }).strict(),
]);
export type CoverSpec = z.infer<typeof coverSpecSchema>;

/** A Collection's listing: saved on each version and reviewed with it. */
export const listingSchema = z.object({
  /** Empty while it's being written; a check stops publishing until it's set. */
  title: z.string().trim().max(34),
  about: z.string().trim().max(180),
  categories: z.array(z.string().trim().min(1).max(24)).max(3).refine((list) => new Set(list.map((entry) => entry.toLowerCase())).size === list.length, 'Categories are listed twice'),
  access: z.enum(ACCESS),
  cover: coverSpecSchema.nullable(),
}).strict();
export type Listing = z.infer<typeof listingSchema>;

/** The cover's uploaded images, for checks and URLs. */
export function coverMediaIds(listing: Listing | null | undefined): string[] {
  const cover = listing?.cover;
  return cover?.kind === 'image' ? [...new Set([cover.portrait, cover.square, cover.wide])] : [];
}

// MARK: Body

/** Letters, digits, `_`, `-` and `.`, up to 80 (Hearken's ids, like "bofm.u1", are used as they are). */
const id = blockId;
const text = (max: number) => z.string().max(max).default('');

export const blockSchema = z.discriminatedUnion('type', [
  z.object({ id, type: z.literal('text'), text: text(20_000) }).strict(),
  z.object({ id, type: z.literal('scripture'), ref: text(120), text: text(4000), highlight: z.boolean().default(false), ...scriptureExtras }).strict(),
  z.object({ id, type: z.literal('callout'), label: text(60), text: text(4000) }).strict(),
  z.object({
    id, type: z.literal('quiz'), question: text(1000),
    options: z.array(z.object({ id, text: text(500), correct: z.boolean().default(false) }).strict()).max(8).default([]),
    explanation: text(2000), hint: text(500), weight: z.number().int().min(0).max(10).default(1),
    shuffle: z.boolean().default(true), mastery: z.boolean().default(true), ...questionExtras,
  }).strict(),
  z.object({ id, type: z.literal('match'), prompt: text(500), pairs: z.array(z.object({ id, left: text(200), right: text(200), rightId: id.optional() }).strict()).max(12).default([]), ...matchExtras }).strict(),
  z.object({ id, type: z.literal('timeline'), events: z.array(z.object({ id, date: text(40), label: text(300) }).strict()).max(40).default([]) }).strict(),
  z.object({ id, type: z.literal('image'), mediaId: z.uuid().nullable().default(null), alt: text(500), caption: text(500) }).strict(),
  z.object({ id, type: z.literal('video'), url: text(500), title: text(120), caption: text(500) }).strict(),
  linkBlockSchema,
  stepBlockSchema,
  assessmentBlockSchema,
]);
export type Block = z.infer<typeof blockSchema>;

const fieldValue = z.union([z.string().max(20_000), z.number(), z.boolean(), z.null()]);
export const sectionSchema = z.object({
  id, title: text(120), fields: z.record(key, fieldValue).default({}), blocks: z.array(blockSchema).max(200).default([]),
}).strict();
export type Section = z.infer<typeof sectionSchema>;

export const bodySchema = z.object({
  fields: z.record(key, fieldValue).default({}),
  /** Types with sections. */
  sections: z.array(sectionSchema).max(100).optional(),
  /** Types without sections. */
  blocks: z.array(blockSchema).max(400).optional(),
}).strict();
export type Body = z.infer<typeof bodySchema>;

/** A new item's empty body. */
export function emptyBody(definition: TypeDefinition): Body {
  return definition.sections
    ? { fields: {}, sections: [{ id: 's1', title: '', fields: {}, blocks: [] }] }
    : { fields: {}, blocks: [] };
}

/** Every block, with the section it sits in (null for types without sections). */
export function allBlocks(body: Body): { section: Section | null; block: Block }[] {
  if (body.sections) return body.sections.flatMap((section) => section.blocks.map((block) => ({ section, block })));
  return (body.blocks ?? []).map((block) => ({ section: null, block }));
}

export function mediaIds(body: Body): string[] {
  return [...new Set(allBlocks(body).flatMap(({ block }) => (block.type === 'image' && block.mediaId ? [block.mediaId] : [])))];
}

// MARK: Checks

export type Check = { id: string; label: string; state: 'pass' | 'warn' | 'fail'; detail?: string };
export type MediaInfo = { id: string; uploaded: boolean; alt: string; width?: number | null; height?: number | null };

/** "D&C 130:22", "1 Nephi 3:7", "Moses 1:39", "John 3:16-17, 19", "Joseph Smith—History 1:17". */
const SCRIPTURE_REF = /^(?:[1-4]\s)?[A-Za-z][A-Za-z&.' —]{0,40}\s\d{1,3}(?::\d{1,3}(?:[-–]\d{1,3})?(?:,\s?\d{1,3}(?:[-–]\d{1,3})?)*)?$/;
export const isScriptureRef = (ref: string) => SCRIPTURE_REF.test(ref.trim());

const where = (section: Section | null, index: number, labelOf: string) =>
  section ? `${labelOf} “${section.title || 'Untitled'}”` : `block ${index + 1}`;

function filled(value: unknown) {
  return typeof value === 'string' ? value.trim().length > 0 : value !== null && value !== undefined;
}

/**
 * What must be true before a version is published. Fails block publishing; warnings don't.
 * `approvals`: the type's review steps and whether each is approved (none when it has no steps).
 */
export function runChecks(options: {
  appKey: string; definition: TypeDefinition; body: Body; media: Map<string, MediaInfo>;
  approvals: { step: string; approved: boolean }[];
  /** The version's listing; only read for downloadable types. */
  listing?: Listing | null;
}): Check[] {
  const { definition, body, media } = options;
  const sectionLabel = definition.sections?.label.toLowerCase() ?? 'section';
  const checks: Check[] = [];
  const missing = (fields: FieldDef[], values: Record<string, unknown>) =>
    fields.filter((field) => field.required && !filled(values[field.key])).map((field) => field.label);

  const missingFields = missing(definition.fields, body.fields);
  for (const section of body.sections ?? []) {
    missingFields.push(...missing(definition.sections?.fields ?? [], section.fields).map((label) => `${label} (${section.title || 'untitled'})`));
  }
  checks.push(missingFields.length
    ? { id: 'fields', label: 'Required fields are filled in', state: 'fail', detail: `Missing: ${missingFields.join(', ')}` }
    : { id: 'fields', label: 'Required fields are filled in', state: 'pass' });

  if (definition.sections) {
    const untitled = (body.sections ?? []).filter((section) => !section.title.trim()).length;
    const empty = (body.sections ?? []).filter((section) => section.blocks.length === 0).length;
    const label = `Every ${sectionLabel} has a title and content`;
    checks.push((body.sections ?? []).length === 0
      ? { id: 'sections', label, state: 'fail', detail: `Add a ${sectionLabel}` }
      : untitled || empty
        ? { id: 'sections', label, state: 'fail', detail: [untitled ? `${untitled} without a title` : '', empty ? `${empty} with no blocks` : ''].filter(Boolean).join(', ') }
        : { id: 'sections', label, state: 'pass' });
  }

  const blocks = allBlocks(body);
  if (blocks.length === 0) checks.push({ id: 'content', label: 'Has content', state: 'fail', detail: 'Add at least one block' });

  const notAllowed = [...new Set(blocks.map(({ block }) => block.type).filter((kind) => !definition.blocks.includes(kind)))];
  if (notAllowed.length) checks.push({ id: 'blocks', label: 'Uses only this type’s blocks', state: 'fail', detail: notAllowed.map((kind) => BLOCK_LIBRARY[kind].label).join(', ') });

  const scripture = blocks.filter(({ block }) => block.type === 'scripture');
  if (scripture.length) {
    const bad = scripture.filter(({ block }) => block.type === 'scripture' && !isScriptureRef(block.ref));
    checks.push(bad.length
      ? { id: 'scripture', label: 'Scripture references are complete', state: 'fail', detail: bad.map(({ block, section }, index) => `${block.type === 'scripture' && block.ref ? `“${block.ref}”` : 'An empty reference'} in ${where(section, index, sectionLabel)}`).join('; ') }
      : { id: 'scripture', label: `All ${scripture.length} scripture reference${scripture.length === 1 ? '' : 's'} are complete`, state: 'pass' });
  }

  const quizzes = blocks.filter(({ block }) => block.type === 'quiz');
  if (quizzes.length) {
    // A short-answer question has no options: it needs an answer guide instead.
    const bad = quizzes.filter(({ block }) => block.type === 'quiz' && (!block.question.trim() || (block.style === 'short'
      ? !block.guide?.trim()
      : block.options.filter((option) => option.text.trim()).length < 2 || block.options.filter((option) => option.correct).length !== 1)));
    checks.push(bad.length
      ? { id: 'quiz', label: 'Every quiz has exactly one correct answer', state: 'fail', detail: `${bad.length} quiz${bad.length === 1 ? '' : 'zes'} need a question, two answers and one marked correct` }
      : { id: 'quiz', label: 'Every quiz has exactly one correct answer', state: 'pass' });
  }

  const games = blocks.filter(({ block }) => (block.type === 'match' && block.pairs.filter((pair) => pair.left.trim() && pair.right.trim()).length < 2)
    || (block.type === 'timeline' && block.events.filter((event) => event.date.trim() && event.label.trim()).length < 2));
  if (games.length) checks.push({ id: 'games', label: 'Games are complete', state: 'fail', detail: `${games.length} match or timeline block${games.length === 1 ? '' : 's'} need at least two complete rows` });

  const images = blocks.flatMap(({ block }) => (block.type === 'image' ? [block] : []));
  if (images.length) {
    const unset = images.filter((image) => !image.mediaId || !media.get(image.mediaId)?.uploaded).length;
    const noAlt = images.filter((image) => !(image.alt.trim() || (image.mediaId && media.get(image.mediaId)?.alt.trim()))).length;
    if (unset) checks.push({ id: 'images', label: 'Images are uploaded', state: 'fail', detail: `${unset} image block${unset === 1 ? '' : 's'} without an uploaded image` });
    checks.push(noAlt
      ? { id: 'alt', label: 'Images have alt text', state: 'warn', detail: `${noAlt} image${noAlt === 1 ? '' : 's'} missing alt text` }
      : { id: 'alt', label: 'Images have alt text', state: 'pass' });
  }

  const videos = blocks.filter(({ block }) => block.type === 'video' && !/^https:\/\/\S+$/.test(block.url.trim()));
  if (videos.length) checks.push({ id: 'video', label: 'Videos have https links', state: 'fail', detail: `${videos.length} video block${videos.length === 1 ? '' : 's'} need an https link` });

  if (blocks.some(({ block }) => block.type === 'step' || block.type === 'assessment')) {
    const missing = unresolvedReferences(blocks.map(({ block }) => block));
    checks.push(missing.length
      ? { id: 'references', label: 'Steps and assessments point at questions that exist', state: 'fail', detail: `Missing: ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? ` and ${missing.length - 10} more` : ''}` }
      : { id: 'references', label: 'Steps and assessments point at questions that exist', state: 'pass' });
  }

  if (options.definition.listing?.downloadable) checks.push(...listingChecks(options.listing ?? null, media));

  if (options.approvals.length) {
    const waiting = options.approvals.filter((approval) => !approval.approved).map((approval) => approval.step);
    checks.push(waiting.length
      ? { id: 'approvals', label: 'Required approvals are in', state: 'fail', detail: `Waiting on ${waiting.join(', ')}` }
      : { id: 'approvals', label: 'Required approvals are in', state: 'pass' });
  }
  return checks;
}

/** The checks a Collection's listing adds: a cover, crops big enough, a title, and two nudges. */
export function listingChecks(listing: Listing | null, media: Map<string, MediaInfo>): Check[] {
  const checks: Check[] = [];
  checks.push(listing?.title.trim()
    ? { id: 'listing-title', label: 'The listing has a title', state: 'pass' }
    : { id: 'listing-title', label: 'The listing has a title', state: 'fail', detail: 'Add a title under Cover & listing' });
  const cover = listing?.cover ?? null;
  checks.push(cover
    ? { id: 'cover', label: 'A cover is set', state: 'pass' }
    : { id: 'cover', label: 'A cover is set', state: 'fail', detail: 'Pick a template or upload an image under Cover & listing' });
  if (cover?.kind === 'image') {
    const short = (Object.keys(CROP_SIZES) as CropName[]).filter((crop) => !cropFits(crop, media.get(cover[crop])));
    checks.push(short.length
      ? { id: 'cover-crops', label: 'Cover images are big enough', state: 'fail', detail: short.map((crop) => `${crop} needs ${CROP_SIZES[crop].width}×${CROP_SIZES[crop].height} or larger`).join('; ') }
      : { id: 'cover-crops', label: 'Cover images are big enough', state: 'pass' });
  }
  if (cover && cover.title.trim().length > COVER_TITLE_SHORT) {
    checks.push({ id: 'cover-title', label: 'The cover title is short', state: 'warn', detail: `Over ${COVER_TITLE_SHORT} characters can be hard to read on small covers` });
  }
  if (listing && listing.about.trim().length < ABOUT_SHORT) {
    checks.push({ id: 'about', label: 'The listing says what it’s about', state: 'warn', detail: `Under ${ABOUT_SHORT} characters: a sentence or two helps people choose` });
  }
  return checks;
}

/** Whether an uploaded image is big enough for a crop and close to its shape. */
export function cropFits(crop: CropName, info: MediaInfo | undefined): boolean {
  if (!info?.uploaded || !info.width || !info.height) return false;
  const want = CROP_SIZES[crop];
  const shape = Math.abs(info.width / info.height - want.width / want.height) <= 0.02 * (want.width / want.height);
  return shape && info.width >= want.width && info.height >= want.height;
}

// MARK: Diff

export type SectionChange = { id: string; title: string; change: 'added' | 'removed' | 'edited'; added: number; removed: number; edited: number; titleChanged: boolean };
export type Diff = { added: number; removed: number; edited: number; fieldsChanged: string[]; sections: SectionChange[] };

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function compareBlocks(before: Block[], after: Block[]) {
  const old = new Map(before.map((block) => [block.id, block]));
  const now = new Map(after.map((block) => [block.id, block]));
  return {
    added: after.filter((block) => !old.has(block.id)).length,
    removed: before.filter((block) => !now.has(block.id)).length,
    edited: after.filter((block) => old.has(block.id) && !same(old.get(block.id), block)).length,
  };
}

/** What changed from `before` (the live version; null for a first publish) to `after`. */
export function diffBodies(before: Body | null, after: Body): Diff {
  const fieldsChanged = [...new Set([...Object.keys(before?.fields ?? {}), ...Object.keys(after.fields)])]
    .filter((field) => !same(before?.fields[field] ?? null, after.fields[field] ?? null));
  const sections: SectionChange[] = [];
  if (after.sections || before?.sections) {
    const old = new Map((before?.sections ?? []).map((section) => [section.id, section]));
    const now = new Map((after.sections ?? []).map((section) => [section.id, section]));
    for (const section of after.sections ?? []) {
      const previous = old.get(section.id);
      if (!previous) {
        sections.push({ id: section.id, title: section.title, change: 'added', added: section.blocks.length, removed: 0, edited: 0, titleChanged: false });
        continue;
      }
      const counts = compareBlocks(previous.blocks, section.blocks);
      const titleChanged = previous.title !== section.title || !same(previous.fields, section.fields);
      if (counts.added || counts.removed || counts.edited || titleChanged) sections.push({ id: section.id, title: section.title, change: 'edited', ...counts, titleChanged });
    }
    for (const section of before?.sections ?? []) {
      if (!now.has(section.id)) sections.push({ id: section.id, title: section.title, change: 'removed', added: 0, removed: section.blocks.length, edited: 0, titleChanged: false });
    }
  } else {
    const counts = compareBlocks(before?.blocks ?? [], after.blocks ?? []);
    if (counts.added || counts.removed || counts.edited) sections.push({ id: 'body', title: 'Content', change: 'edited', ...counts, titleChanged: false });
  }
  return {
    added: sections.reduce((sum, section) => sum + section.added, 0),
    removed: sections.reduce((sum, section) => sum + section.removed, 0),
    edited: sections.reduce((sum, section) => sum + section.edited, 0),
    fieldsChanged,
    sections,
  };
}

const LISTING_FIELDS = ['title', 'about', 'categories', 'access', 'cover'] as const;

/** Which listing fields changed from the live version (null: no listing) to the latest. */
export function diffListings(before: Listing | null, after: Listing | null): { listingChanged: boolean; listingFields: string[] } {
  const listingFields = LISTING_FIELDS.filter((field) => !same(before?.[field] ?? null, after?.[field] ?? null));
  return { listingChanged: listingFields.length > 0, listingFields };
}

// MARK: Bundles

export type MediaFile = { id: string; url: string; width: number | null; height: number | null; alt: string };

/** JSON with keys in a fixed order, so the same content always hashes the same. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as object).sort().map((name) => `${JSON.stringify(name)}:${stableJson((value as Record<string, unknown>)[name])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** What an app downloads for one published version: images become URLs. */
export function buildBundle(options: {
  entryId: string; app: string; typeSlug: string; slug: string; title: string; version: number; schemaVersion: number;
  publishedAt: string; body: Body; media: Map<string, MediaFile>;
}) {
  const resolve = (block: Block) => {
    if (block.type !== 'image') return block;
    const file = block.mediaId ? options.media.get(block.mediaId) : undefined;
    return { id: block.id, type: 'image', url: file?.url ?? null, width: file?.width ?? null, height: file?.height ?? null, alt: block.alt.trim() || file?.alt || '', caption: block.caption };
  };
  const body = {
    fields: options.body.fields,
    ...(options.body.sections ? { sections: options.body.sections.map((section) => ({ ...section, blocks: section.blocks.map(resolve) })) } : {}),
    ...(options.body.blocks ? { blocks: options.body.blocks.map(resolve) } : {}),
  };
  const bundle = {
    id: options.entryId, app: options.app, type: options.typeSlug, slug: options.slug, title: options.title,
    version: options.version, schemaVersion: options.schemaVersion, publishedAt: options.publishedAt, body,
  };
  const json = stableJson(bundle);
  const bytes = new TextEncoder().encode(json);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const hash = sha256.slice(0, 6);
  const folder = options.app === 'shared' ? 'shared' : `apps/${options.app}`;
  return { bytes, hash, sha256, path: `${folder}/${options.typeSlug}/${options.slug}.v${options.version}.${hash}.json` };
}

/** A catalog entry as format 1 (today's apps) reads it. */
export type CatalogEntry = {
  id: string; type: string; slug: string; title: string; version: number; schemaVersion: number;
  hash: string; url: string; bytes: number; publishedAt: string;
};
const FORMAT_1 = new Set(['id', 'type', 'slug', 'title', 'version', 'schemaVersion', 'hash', 'url', 'bytes', 'publishedAt']);

export type CatalogCover =
  | Extract<CoverSpec, { kind: 'template' }>
  | { kind: 'image'; portraitUrl: string; squareUrl: string; wideUrl: string; focal: { x: number; y: number }; showTitle: boolean; scrim: 'light' | 'medium' | 'strong'; title: string };
export type Rating = { average: number; count: number };

/** A catalog entry as format 2 reads it (and as it's stored): format 1's fields plus the Collection's. */
export type CatalogEntryV2 = CatalogEntry & {
  sha256: string; downloadBytes: number; access: Access; downloadable: boolean;
  listing: { title: string; about: string; categories: string[]; cover: CatalogCover | null } | null;
  authorId: string | null;
  count: { n: number; one: string; many: string } | null;
  rating?: Rating;
  updatedAt: string;
};

/** Ratings show in the apps once there are this many. */
export const RATING_FLOOR = 5;

/** The rating the catalog shows: one decimal, and nothing under the floor. */
export function catalogRating(average: number | null, count: number): Rating | undefined {
  if (count < RATING_FLOOR || average === null) return undefined;
  return { average: Math.round(average * 10) / 10, count };
}

/**
 * One item's catalog entry, from its rows: images in the cover become public URLs, the count comes
 * from the body, and the rating only shows from five ratings. Plus items have no public URL.
 */
export function buildCatalogEntry(options: {
  id: string; typeSlug: string; slug: string; title: string; version: number; schemaVersion: number;
  hash: string; sha256: string; bytes: number; url: string; publishedAt: string;
  /** Bytes of the media files the bundle references. */
  mediaBytes: number;
  settings: ListingSettings | null; listing: Listing | null; body: Body;
  /** Public URL of an uploaded image, by media id. */
  mediaUrl: (mediaId: string) => string | null;
  authorId: string | null; rating: { average: number | null; count: number };
}): CatalogEntryV2 {
  const downloadable = options.settings?.downloadable === true;
  const listing = downloadable ? options.listing : null;
  const access: Access = listing?.access ?? 'free';
  const cover = listing?.cover ?? null;
  const n = !downloadable ? 0 : options.settings!.countFrom === 'sections' ? (options.body.sections ?? []).length : allBlocks(options.body).length;
  const rating = downloadable ? catalogRating(options.rating.average, options.rating.count) : undefined;
  return {
    id: options.id, type: options.typeSlug, slug: options.slug, title: options.title, version: options.version, schemaVersion: options.schemaVersion,
    hash: options.hash, url: access === 'plus' ? '' : options.url, bytes: options.bytes, publishedAt: options.publishedAt,
    sha256: options.sha256, downloadBytes: options.bytes + options.mediaBytes, access, downloadable,
    listing: listing ? {
      title: listing.title, about: listing.about, categories: listing.categories,
      cover: catalogCover(cover, options.mediaUrl),
    } : null,
    authorId: downloadable ? options.authorId : null,
    count: downloadable ? { n, one: options.settings!.unit.one, many: options.settings!.unit.many } : null,
    ...(rating ? { rating } : {}),
    updatedAt: options.publishedAt,
  };
}

/** A cover as the apps and the Content table read it: image media ids become URLs ("" when missing). */
export function catalogCover(cover: CoverSpec | null | undefined, mediaUrl: (mediaId: string) => string | null): CatalogCover | null {
  if (!cover) return null;
  if (cover.kind === 'template') return { ...cover };
  return {
    kind: 'image', portraitUrl: mediaUrl(cover.portrait) ?? '', squareUrl: mediaUrl(cover.square) ?? '',
    wideUrl: mediaUrl(cover.wide) ?? '', focal: cover.focal, showTitle: cover.showTitle, scrim: cover.scrim, title: cover.title,
  };
}

/** A stored entry as format 2 reads it; entries published before Collections get the defaults. */
export function asCatalogV2(entry: CatalogEntry & Partial<CatalogEntryV2>): CatalogEntryV2 {
  return {
    ...entry,
    sha256: entry.sha256 ?? '', downloadBytes: entry.downloadBytes ?? entry.bytes, access: entry.access ?? 'free',
    downloadable: entry.downloadable ?? false, listing: entry.listing ?? null, authorId: entry.authorId ?? null,
    count: entry.count ?? null, updatedAt: entry.updatedAt ?? entry.publishedAt,
  };
}

/**
 * A stored entry as format 1 reads it: only today's fields, in the order they're stored, so an entry
 * published before Collections comes out byte for byte as before. Plus items: null (left out).
 */
export function asCatalogV1(entry: CatalogEntry & Partial<CatalogEntryV2>): CatalogEntry | null {
  if (entry.access === 'plus') return null;
  return Object.fromEntries(Object.entries(entry).filter(([name]) => FORMAT_1.has(name))) as CatalogEntry;
}

/** "Marisol Vega" → "MV"; one word → its first letter. */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '';
  const first = [...words[0]!][0] ?? '';
  const last = words.length > 1 ? [...words[words.length - 1]!][0] ?? '' : '';
  return (first + last).toUpperCase();
}

export function slugify(title: string): string {
  return title.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'untitled';
}
