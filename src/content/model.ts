import { createHash } from 'node:crypto';
import { z } from 'zod';

/**
 * Hearth Content's model: content types, the block library, a draft's body, the checks a version
 * must pass before it's published, what changed between two versions, and the bundle an app
 * downloads. Pure functions; the service and routes do the storage.
 */

export const FIELD_TYPES = ['text', 'longtext', 'number', 'boolean', 'image'] as const;
export type FieldType = typeof FIELD_TYPES[number];

export const BLOCK_KINDS = ['text', 'scripture', 'callout', 'quiz', 'match', 'timeline', 'image', 'video'] as const;
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
};

const key = z.string().regex(/^[a-z][A-Za-z0-9]{0,39}$/);
export const fieldDefSchema = z.object({
  key,
  label: z.string().trim().min(1).max(60),
  type: z.enum(FIELD_TYPES),
  required: z.boolean().default(false),
}).strict();
export type FieldDef = z.infer<typeof fieldDefSchema>;

export const definitionSchema = z.object({
  fields: z.array(fieldDefSchema).max(30).default([]),
  sections: z.object({ label: z.string().trim().min(1).max(30), fields: z.array(fieldDefSchema).max(20).default([]) }).strict().nullable().default(null),
  blocks: z.array(z.enum(BLOCK_KINDS)).min(1).max(BLOCK_KINDS.length),
  reviewSteps: z.array(z.string().trim().min(1).max(60)).max(5).default([]),
}).strict().superRefine((value, context) => {
  const keys = value.fields.map((field) => field.key);
  if (new Set(keys).size !== keys.length) context.addIssue({ code: 'custom', message: 'Field keys must be unique' });
  if (new Set(value.blocks).size !== value.blocks.length) context.addIssue({ code: 'custom', message: 'Blocks are listed twice' });
  if (new Set(value.reviewSteps).size !== value.reviewSteps.length) context.addIssue({ code: 'custom', message: 'Review steps must be unique' });
});
export type TypeDefinition = z.infer<typeof definitionSchema>;

// MARK: Body

const id = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/);
const text = (max: number) => z.string().max(max).default('');

export const blockSchema = z.discriminatedUnion('type', [
  z.object({ id, type: z.literal('text'), text: text(20_000) }).strict(),
  z.object({ id, type: z.literal('scripture'), ref: text(120), text: text(4000), highlight: z.boolean().default(false) }).strict(),
  z.object({ id, type: z.literal('callout'), label: text(60), text: text(4000) }).strict(),
  z.object({
    id, type: z.literal('quiz'), question: text(1000),
    options: z.array(z.object({ id, text: text(500), correct: z.boolean().default(false) }).strict()).max(8).default([]),
    explanation: text(2000), hint: text(500), weight: z.number().int().min(0).max(10).default(1),
    shuffle: z.boolean().default(true), mastery: z.boolean().default(true),
  }).strict(),
  z.object({ id, type: z.literal('match'), prompt: text(500), pairs: z.array(z.object({ id, left: text(200), right: text(200) }).strict()).max(12).default([]) }).strict(),
  z.object({ id, type: z.literal('timeline'), events: z.array(z.object({ id, date: text(40), label: text(300) }).strict()).max(40).default([]) }).strict(),
  z.object({ id, type: z.literal('image'), mediaId: z.uuid().nullable().default(null), alt: text(500), caption: text(500) }).strict(),
  z.object({ id, type: z.literal('video'), url: text(500), title: text(120), caption: text(500) }).strict(),
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
export type MediaInfo = { id: string; uploaded: boolean; alt: string };

/** "D&C 130:22", "1 Nephi 3:7", "Moses 1:39", "John 3:16-17, 19". */
const SCRIPTURE_REF = /^(?:[1-4]\s)?[A-Za-z][A-Za-z&.' ]{0,40}\s\d{1,3}(?::\d{1,3}(?:[-–]\d{1,3})?(?:,\s?\d{1,3}(?:[-–]\d{1,3})?)*)?$/;
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
    const bad = quizzes.filter(({ block }) => block.type === 'quiz'
      && (!block.question.trim() || block.options.filter((option) => option.text.trim()).length < 2 || block.options.filter((option) => option.correct).length !== 1));
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

  if (options.approvals.length) {
    const waiting = options.approvals.filter((approval) => !approval.approved).map((approval) => approval.step);
    checks.push(waiting.length
      ? { id: 'approvals', label: 'Required approvals are in', state: 'fail', detail: `Waiting on ${waiting.join(', ')}` }
      : { id: 'approvals', label: 'Required approvals are in', state: 'pass' });
  }
  return checks;
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
  const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 6);
  const folder = options.app === 'shared' ? 'shared' : `apps/${options.app}`;
  return { bytes, hash, path: `${folder}/${options.typeSlug}/${options.slug}.v${options.version}.${hash}.json` };
}

export type CatalogEntry = {
  id: string; type: string; slug: string; title: string; version: number; schemaVersion: number;
  hash: string; url: string; bytes: number; publishedAt: string;
};

export function slugify(title: string): string {
  return title.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'untitled';
}
