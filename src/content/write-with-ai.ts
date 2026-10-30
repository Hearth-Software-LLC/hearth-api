import { z } from '@hono/zod-openapi';
import { ApiError } from '../errors.js';
import { ACCESS, BLOCK_LIBRARY, COVERS, COVER_TEMPLATES, PALETTE_IDS, blockSchema, listingSchema, runChecks, slugify } from './model.js';
import type { Block, BlockKind, Body, FieldDef, Listing, Section, TypeDefinition } from './model.js';
import type { ContentService, ContentTypeView } from './service.js';

/**
 * Write with AI (POST /v1/content/entries/generate): an author describes what they want, and Claude
 * writes a complete draft of a content type: title, fields, sections and blocks, and for a
 * Collection its listing with a template cover. Nothing is submitted or published.
 *
 * It works in steps so long modules stay inside output limits: one outline call, then one call per
 * section (three at a time), each answering through a tool. Every block is checked with the
 * model's own schema and checks; the ones that fail go back once with the errors, and whatever
 * still fails is dropped with a warning. The draft is saved through the service like any other
 * (createEntry, saveDraft, saveListing) and the audit log notes it was generated.
 *
 * Claude gets the author's description, the app's name and the type's definition: never an
 * account id or anything else about the author.
 */

export const DEFAULT_CONTENT_MODEL = 'claude-sonnet-5-5';
/** The blocks Claude may write: never media (it can't make any), links, steps or assessments. */
export const AI_BLOCKS = ['text', 'callout', 'quiz', 'match', 'timeline'] as const;
export const LENGTHS = ['short', 'medium', 'long'] as const;
export type Length = typeof LENGTHS[number];
/** Section calls running at once. */
export const SECTION_CONCURRENCY = 3;
/** The whole generation has this long (Vercel stops a function at 300 s). */
export const DEFAULT_BUDGET_MS = 250_000;

export const generateRequestSchema = z.object({
  /** An app key, or null for a shared type (stored under "shared", like createEntry). */
  app: z.string().regex(/^[a-z0-9-]{1,40}$/).nullable(),
  typeId: z.uuid(),
  prompt: z.string().trim().min(10).max(4000),
  length: z.enum(LENGTHS).default('medium'),
  /** Only used for downloadable types. */
  access: z.enum(ACCESS).default('free'),
}).strict().openapi('WriteWithAiRequest');
export type GenerateRequest = z.infer<typeof generateRequestSchema>;

export type WriteEvent =
  | { type: 'status'; stage: 'outline' | 'sections' | 'saving'; message: string }
  | { type: 'outline'; title: string; sections: { title: string }[] }
  | { type: 'section'; index: number; title: string; blocks: number }
  | { type: 'done'; entryId: string; title: string; warnings: string[] }
  | { type: 'error'; code: string; message: string };

/** How much to write: sections for sectioned types, blocks per section, blocks for flat types. */
export const LENGTH_GUIDE: Record<Length, { sections: [number, number]; blocks: [number, number]; flat: [number, number] }> = {
  short: { sections: [3, 3], blocks: [3, 5], flat: [3, 6] },
  medium: { sections: [5, 6], blocks: [4, 7], flat: [6, 10] },
  long: { sections: [8, 10], blocks: [5, 8], flat: [10, 16] },
};

const APPS: Record<string, { name: string; about: string }> = {
  bigtable: { name: 'BigTable', about: 'family meal planning, recipes and groceries' },
  suffice: { name: 'Suffice', about: 'household budgeting and bills' },
  sated: { name: 'Sated', about: 'a food log' },
  caloma: { name: 'Caloma', about: 'family chores, allowance and calendar' },
  hearken: { name: 'Hearken', about: 'scripture and gospel study for members of The Church of Jesus Christ of Latter-day Saints' },
  shared: { name: 'every Hearth app', about: 'content shared by all the Hearth apps' },
};
const appOf = (key: string) => APPS[key] ?? { name: key.charAt(0).toUpperCase() + key.slice(1), about: '' };

type TypeLike = Pick<ContentTypeView, 'app' | 'name' | 'description' | 'definition'>;

/** The blocks Claude may use in a type: the AI blocks it allows, plus scripture for Hearken's types. */
export function aiBlocks(type: Pick<ContentTypeView, 'app' | 'definition'>): BlockKind[] {
  return type.definition.blocks.filter((kind) => (AI_BLOCKS as readonly string[]).includes(kind) || (kind === 'scripture' && type.app === 'hearken'));
}

// MARK: Prompts

/** Each block's shape as Claude writes it (ids are added here) and its rules. */
const BLOCK_SHAPES: Partial<Record<BlockKind, { shape: string; rules: string; schema: Record<string, unknown> }>> = {
  text: {
    shape: '{"type": "text", "text": "First paragraph.\\n\\nSecond paragraph."}',
    rules: 'Plain paragraphs separated by a blank line. No Markdown: no #, **, bullets or links. Up to about 150 words per block.',
    schema: { type: 'object', properties: { type: { const: 'text' }, text: { type: 'string' } }, required: ['type', 'text'] },
  },
  callout: {
    shape: '{"type": "callout", "label": "Key idea", "text": "One or two sentences."}',
    rules: 'A short label (60 characters at most) and the point itself, one or two sentences.',
    schema: { type: 'object', properties: { type: { const: 'callout' }, label: { type: 'string' }, text: { type: 'string' } }, required: ['type', 'label', 'text'] },
  },
  quiz: {
    shape: '{"type": "quiz", "question": "…?", "options": [{"text": "…", "correct": true}, {"text": "…", "correct": false}, {"text": "…", "correct": false}], "explanation": "Why the answer is right.", "hint": ""}',
    rules: 'Three or four options, exactly one with "correct": true, the wrong ones plausible. The explanation teaches; the hint is optional ("" for none). Ask about what this section taught.',
    schema: {
      type: 'object',
      properties: {
        type: { const: 'quiz' }, question: { type: 'string' },
        options: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, correct: { type: 'boolean' } }, required: ['text', 'correct'] } },
        explanation: { type: 'string' }, hint: { type: 'string' },
      },
      required: ['type', 'question', 'options', 'explanation'],
    },
  },
  match: {
    shape: '{"type": "match", "prompt": "Match each term to its meaning.", "pairs": [{"left": "…", "right": "…"}, {"left": "…", "right": "…"}, {"left": "…", "right": "…"}]}',
    rules: 'Three to six pairs; each side short (a few words to a sentence), every right side matching only its own left side.',
    schema: {
      type: 'object',
      properties: {
        type: { const: 'match' }, prompt: { type: 'string' },
        pairs: { type: 'array', items: { type: 'object', properties: { left: { type: 'string' }, right: { type: 'string' } }, required: ['left', 'right'] } },
      },
      required: ['type', 'prompt', 'pairs'],
    },
  },
  timeline: {
    shape: '{"type": "timeline", "events": [{"date": "1830", "label": "…"}, {"date": "1836", "label": "…"}, {"date": "1844", "label": "…"}]}',
    rules: 'Three to ten events in date order. Only dates you are sure of.',
    schema: {
      type: 'object',
      properties: {
        type: { const: 'timeline' },
        events: { type: 'array', items: { type: 'object', properties: { date: { type: 'string' }, label: { type: 'string' } }, required: ['date', 'label'] } },
      },
      required: ['type', 'events'],
    },
  },
  scripture: {
    shape: '{"type": "scripture", "ref": "Alma 32:21", "text": "The verse text.", "highlight": false}',
    rules: 'A complete reference ("1 Nephi 3:7", "D&C 130:22", "John 3:16-17"). Quote the verse text word for word from the Latter-day Saint edition of the scriptures; if you are not certain of the exact words, leave "text" empty ("") and the author will fill it in. "highlight": true for the one passage a section centres on.',
    schema: {
      type: 'object',
      properties: { type: { const: 'scripture' }, ref: { type: 'string' }, text: { type: 'string' }, highlight: { type: 'boolean' } },
      required: ['type', 'ref', 'text'],
    },
  },
};

const fieldLine = (field: FieldDef) => `- ${field.key} (${field.label}): ${field.type === 'longtext' ? 'a few sentences' : field.type === 'text' ? 'a short line' : field.type}${field.required ? ', required' : ''}`;
const writableFields = (fields: FieldDef[]) => fields.filter((field) => field.type !== 'image');

/** The system prompt, shared (and cached) by every call of one generation. */
export function systemPrompt(appKey: string, type: TypeLike): string {
  const app = appOf(appKey);
  const blocks = aiBlocks(type);
  const definition = type.definition;
  const sectionLabel = definition.sections?.label ?? null;
  const lines = [
    `You write content for ${app.name}${app.about ? ` (${app.about})` : ''}, one of the Hearth apps: small, well-made iPhone apps from one maker, Hearth Software. What you write becomes a draft an author reviews and edits before anyone sees it.`,
    'Answer only by calling the tool the request names, once. Write nothing else.',
    '',
    'House voice:',
    '- Clear, warm, plain language for a thoughtful general reader. Short sentences, concrete examples, no jargon without a quick explanation.',
    '- No hype, no superlatives, no exclamation marks, no emoji, no "unlock", "journey", "dive in" or "game-changer".',
    '- Accurate. Never invent statistics, studies, quotes, prices, names, links or dates. If you are unsure of a fact, leave it out.',
    '- Scripture and doctrine: stay descriptive and faithful to what the scriptures and The Church of Jesus Christ of Latter-day Saints teach; cite references; no speculation or personal interpretation presented as doctrine.',
    '- Money and health: general education only. No personalised financial, medical or nutritional advice; suggest a professional where it matters.',
    '- Address the reader as "you". Every section should teach something specific, not restate the title.',
    '',
    `The content type: ${type.name}${type.description ? `: ${type.description}` : ''}`,
  ];
  const itemFields = writableFields(definition.fields);
  if (itemFields.length) lines.push('Item fields:', ...itemFields.map(fieldLine));
  if (sectionLabel) {
    lines.push(`It is made of ${sectionLabel.toLowerCase()}s in order; each ${sectionLabel.toLowerCase()} has a title and a stack of blocks.`);
    const sectionFields = writableFields(definition.sections!.fields);
    if (sectionFields.length) lines.push(`Each ${sectionLabel.toLowerCase()}'s fields:`, ...sectionFields.map(fieldLine));
  } else {
    lines.push('It is one stack of blocks (no sections).');
  }
  lines.push('', 'The blocks you may use, and the JSON shape of each (no ids: they are added for you):');
  for (const kind of blocks) {
    const spec = BLOCK_SHAPES[kind]!;
    lines.push(`- ${kind}: ${BLOCK_LIBRARY[kind].description} ${spec.shape}`, `  ${spec.rules}`);
  }
  lines.push(
    'Use no other block types: no images, videos or links (you cannot make media; the author adds it).',
    blocks.length > 1 ? 'Mix the blocks: mostly text, with a callout for the key idea and a quiz or game where it helps people remember.' : '',
  );
  return lines.filter((line, index, all) => line !== '' || (all[index - 1] ?? '') !== '').join('\n').trim();
}

/** The outline request: a title, the item's fields, the sections' plan and (Collections) the listing. */
export function outlineMessage(appKey: string, type: TypeLike, request: Pick<GenerateRequest, 'prompt' | 'length' | 'access'>): string {
  const guide = LENGTH_GUIDE[request.length];
  const label = type.definition.sections?.label.toLowerCase();
  const downloadable = type.definition.listing?.downloadable === true;
  const range = (pair: [number, number]) => (pair[0] === pair[1] ? `${pair[0]}` : `${pair[0]} to ${pair[1]}`);
  const lines = [
    `App: ${appOf(appKey).name}`,
    `Length: ${request.length}: ${label ? `${range(guide.sections)} ${label}s` : `${range(guide.flat)} blocks${request.length === 'short' ? ' (about one screen)' : ''}`}`,
    downloadable ? `Access: ${request.access === 'plus' ? 'Plus (for subscribers)' : 'Free'}` : '',
    '',
    'What the author wants:',
    request.prompt,
    '',
    label
      ? `Plan it: a title, the item fields, and the ${label}s in order, each with a title and a two- or three-sentence plan (what it teaches and which blocks it uses), building on each other without repeating.`
      : 'Plan it: a title, the item fields, and a plan for the body (what it covers, in order, and which blocks it uses).',
  ];
  if (downloadable) {
    lines.push(
      'Also write its listing, as people browsing the app see it: a title (34 characters at most), an about (one or two sentences, 60 to 180 characters), one to three short categories (24 characters at most each), and a cover.',
      `Cover templates: ${COVERS.templates.map((template) => `${template.id} (${template.name})`).join(', ')}.`,
      `Palettes: ${COVERS.palettes.map((palette) => `${palette.id} (${palette.name}, ${palette.bg})`).join(', ')}.`,
      'Pick the template and palette that suit the subject, and a cover title of 22 characters at most (it is set large on a small cover).',
    );
  }
  lines.push('Call submit_outline once.');
  return lines.filter((line, index, all) => line !== '' || (all[index - 1] ?? '') !== '').join('\n').trim();
}

export type Outline = {
  title: string;
  fields: Record<string, unknown>;
  sections: { title: string; plan: string }[];
  plan: string;
  listing?: OutlineListing | undefined;
};
type OutlineListing = {
  title?: string | undefined; about?: string | undefined; categories?: string[] | undefined;
  cover?: { template?: string | undefined; palette?: string | undefined; title?: string | undefined } | undefined;
};

/** One section's request (or, for a flat type, the body's: `index` null). */
export function sectionMessage(type: TypeLike, request: Pick<GenerateRequest, 'prompt' | 'length'>, outline: Outline, index: number | null): string {
  const guide = LENGTH_GUIDE[request.length];
  const label = type.definition.sections?.label.toLowerCase() ?? 'section';
  const lines = [`Writing: “${outline.title}” (${type.name})`, '', 'What the author wants:', request.prompt, ''];
  if (index === null) {
    lines.push(`The plan: ${outline.plan || 'cover what the author asked for, in a sensible order.'}`, '', `Write the body: about ${guide.flat[0]} to ${guide.flat[1]} blocks.`);
  } else {
    const section = outline.sections[index]!;
    lines.push(
      `The ${label}s:`,
      ...outline.sections.map((entry, n) => `${n + 1}. ${entry.title}${n === index ? '  ← this one' : ''}`),
      '',
      `Write ${label} ${index + 1} of ${outline.sections.length}: “${section.title}”.`,
      section.plan ? `Its plan: ${section.plan}` : '',
      `Use about ${guide.blocks[0]} to ${guide.blocks[1]} blocks. Don't repeat what the other ${label}s cover.`,
    );
    const fields = writableFields(type.definition.sections?.fields ?? []);
    if (fields.length) lines.push(`Fill in its fields: ${fields.map((field) => field.key).join(', ')}.`);
  }
  lines.push('Call submit_section once.');
  return lines.filter((line, index, all) => line !== '' || (all[index - 1] ?? '') !== '').join('\n').trim();
}

// MARK: Tools

const fieldSchema = (field: FieldDef) => ({
  type: field.type === 'number' ? 'number' : field.type === 'boolean' ? 'boolean' : 'string',
  description: field.label,
});
const fieldsObject = (fields: FieldDef[]) => ({
  type: 'object',
  properties: Object.fromEntries(writableFields(fields).map((field) => [field.key, fieldSchema(field)])),
  required: writableFields(fields).filter((field) => field.required).map((field) => field.key),
});

export function outlineTool(type: TypeLike) {
  const definition = type.definition;
  const properties: Record<string, unknown> = {
    title: { type: 'string', description: 'The item’s title, 120 characters at most' },
    fields: fieldsObject(definition.fields),
  };
  const required = ['title', 'fields'];
  if (definition.sections) {
    properties.sections = {
      type: 'array',
      items: { type: 'object', properties: { title: { type: 'string' }, plan: { type: 'string' } }, required: ['title', 'plan'] },
    };
    required.push('sections');
  } else {
    properties.plan = { type: 'string', description: 'What the body covers, in order' };
    required.push('plan');
  }
  if (definition.listing?.downloadable) {
    properties.listing = {
      type: 'object',
      properties: {
        title: { type: 'string', description: '34 characters at most' },
        about: { type: 'string', description: '60 to 180 characters' },
        categories: { type: 'array', items: { type: 'string' }, description: 'One to three, 24 characters at most each' },
        cover: {
          type: 'object',
          properties: { template: { type: 'string', enum: [...COVER_TEMPLATES] }, palette: { type: 'string', enum: [...PALETTE_IDS] }, title: { type: 'string', description: '22 characters at most' } },
          required: ['template', 'palette', 'title'],
        },
      },
      required: ['title', 'about', 'categories', 'cover'],
    };
    required.push('listing');
  }
  return { name: 'submit_outline', description: 'Records the plan. Call it exactly once.', input_schema: { type: 'object', properties, required } };
}

export function sectionTool(type: TypeLike) {
  const blocks = aiBlocks(type).map((kind) => BLOCK_SHAPES[kind]!.schema);
  const properties: Record<string, unknown> = { blocks: { type: 'array', items: { anyOf: blocks } } };
  const sectionFields = writableFields(type.definition.sections?.fields ?? []);
  if (sectionFields.length) properties.fields = fieldsObject(sectionFields);
  return { name: 'submit_section', description: 'Records the blocks. Call it exactly once.', input_schema: { type: 'object', properties, required: ['blocks'] } };
}

export function fixesTool(type: TypeLike) {
  return {
    name: 'submit_fixes',
    description: 'Records corrected blocks, by their number in the list you sent. Leave out any you cannot fix.',
    input_schema: {
      type: 'object',
      properties: {
        fixes: {
          type: 'array',
          items: { type: 'object', properties: { number: { type: 'integer' }, block: { anyOf: aiBlocks(type).map((kind) => BLOCK_SHAPES[kind]!.schema) } }, required: ['number', 'block'] },
        },
      },
      required: ['fixes'],
    },
  };
}

const outlineInput = z.object({
  title: z.string().trim().min(1),
  fields: z.record(z.string(), z.unknown()).default({}),
  sections: z.array(z.object({ title: z.string().trim().min(1), plan: z.string().default('') })).default([]),
  plan: z.string().default(''),
  listing: z.object({
    title: z.string().optional(), about: z.string().optional(), categories: z.array(z.string()).optional(),
    cover: z.object({ template: z.string().optional(), palette: z.string().optional(), title: z.string().optional() }).optional(),
  }).optional(),
});
const sectionInput = z.object({ blocks: z.array(z.unknown()).min(1), fields: z.record(z.string(), z.unknown()).default({}) });
const fixesInput = z.object({ fixes: z.array(z.object({ number: z.number().int(), block: z.unknown() })).default([]) });

// MARK: Checking blocks

const str = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
const cut = (value: string, max: number) => ([...value].length <= max ? value : [...value].slice(0, max).join('').trim());

/**
 * Claude's block as a library block: ids added, only known keys kept, then checked with the
 * block schema and the publish checks a single block has to pass. Errors say what's wrong in
 * words Claude can act on.
 */
export function toBlock(raw: unknown, id: string, allowed: BlockKind[], definition: TypeDefinition): { block?: Block; errors: string[] } {
  if (!raw || typeof raw !== 'object') return { errors: ['is not an object'] };
  const value = raw as Record<string, unknown>;
  const kind = value.type as BlockKind;
  if (typeof kind !== 'string' || !allowed.includes(kind)) return { errors: [`type "${String(value.type)}" isn’t allowed here; use one of ${allowed.join(', ')}`] };
  const list = (field: unknown) => (Array.isArray(field) ? field.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object') : []);
  let candidate: Record<string, unknown>;
  switch (kind) {
    case 'text': candidate = { id, type: kind, text: str(value.text) }; break;
    case 'callout': candidate = { id, type: kind, label: str(value.label), text: str(value.text) }; break;
    case 'scripture': candidate = { id, type: kind, ref: str(value.ref), text: str(value.text), highlight: value.highlight === true }; break;
    case 'quiz':
      candidate = {
        id, type: kind, question: str(value.question), explanation: str(value.explanation), hint: str(value.hint),
        options: list(value.options).map((option, n) => ({ id: `${id}o${n + 1}`, text: str(option.text), correct: option.correct === true })),
      };
      break;
    case 'match':
      candidate = { id, type: kind, prompt: str(value.prompt), pairs: list(value.pairs).map((pair, n) => ({ id: `${id}p${n + 1}`, left: str(pair.left), right: str(pair.right) })) };
      break;
    case 'timeline':
      candidate = { id, type: kind, events: list(value.events).map((event, n) => ({ id: `${id}e${n + 1}`, date: str(event.date), label: str(event.label) })) };
      break;
    default:
      return { errors: [`type "${kind}" isn’t allowed here; use one of ${allowed.join(', ')}`] };
  }
  const parsed = blockSchema.safeParse(candidate);
  if (!parsed.success) {
    return { errors: parsed.error.issues.map((issue) => `${issue.path.join('.') || 'block'}: ${issue.message}`) };
  }
  const block = parsed.data;
  const errors: string[] = [];
  if ((block.type === 'text' || block.type === 'callout') && !block.text) errors.push('text is empty');
  if (block.type === 'callout' && !block.label) errors.push('label is empty');
  // The publish checks a lone block must pass (quiz answers, game rows, scripture references).
  const checks = runChecks({
    appKey: '', definition: { ...definition, fields: [], sections: null, reviewSteps: [], listing: null },
    body: { fields: {}, blocks: [block] }, media: new Map(), approvals: [],
  });
  for (const check of checks) {
    if (check.state !== 'fail' || check.id === 'fields' || check.id === 'content') continue;
    errors.push(check.id === 'quiz' ? 'a quiz needs a question, at least two answers and exactly one marked correct'
      : check.id === 'games' ? 'needs at least two complete rows'
        : `${check.label.toLowerCase()}${check.detail ? ` (${check.detail})` : ''}`);
  }
  return errors.length ? { errors } : { block, errors };
}

/** Field values that fit the field types; anything else is left out (and the checks say so). */
export function fieldValues(fields: FieldDef[], raw: Record<string, unknown>): Record<string, string | number | boolean | null> {
  const values: Record<string, string | number | boolean | null> = {};
  for (const field of fields) {
    const value = raw[field.key];
    if (field.type === 'text' || field.type === 'longtext') {
      if (typeof value === 'string' && value.trim()) values[field.key] = cut(value.trim(), field.type === 'text' ? 500 : 20_000);
    } else if (field.type === 'number') {
      const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
      if (Number.isFinite(number)) values[field.key] = number;
    } else if (field.type === 'boolean') {
      if (typeof value === 'boolean') values[field.key] = value;
    }
  }
  return values;
}

/** The outline's listing, made to fit: cut to length, a known template and palette, the access asked for. */
export function toListing(raw: Outline['listing'], title: string, access: Listing['access'], warnings: string[]): Listing {
  const words = (value: string, max: number) => {
    if ([...value].length <= max) return value;
    const cutAt = cut(value, max);
    const space = cutAt.lastIndexOf(' ');
    return (space > max / 2 ? cutAt.slice(0, space) : cutAt).replace(/[\s,;:—–-]+$/, '');
  };
  const sentences = (value: string, max: number) => {
    if ([...value].length <= max) return value;
    const whole = value.match(/[^.!?]+[.!?]+/g) ?? [];
    let out = '';
    for (const sentence of whole) {
      if ([...(out + sentence)].length > max) break;
      out += sentence;
    }
    return out.trim() || words(value, max);
  };
  const seen = new Set<string>();
  const categories = (raw?.categories ?? []).map((category) => words(category.trim(), 24)).filter((category) => {
    const key = category.toLowerCase();
    if (!category || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 3);
  const template = (COVER_TEMPLATES as readonly string[]).includes(raw?.cover?.template ?? '') ? raw!.cover!.template as typeof COVER_TEMPLATES[number] : 'orbit';
  const palette = (PALETTE_IDS as readonly string[]).includes(raw?.cover?.palette ?? '') ? raw!.cover!.palette as typeof PALETTE_IDS[number] : 'midnight';
  const listingTitle = words(str(raw?.title) || title, 34);
  let coverTitle = str(raw?.cover?.title) || listingTitle;
  if ([...coverTitle].length > 22) {
    coverTitle = words(coverTitle, 22);
    warnings.push('The cover title was shortened to fit: check it under Cover & listing');
  }
  const listing = {
    title: listingTitle, about: sentences(str(raw?.about), 180), categories, access,
    cover: { kind: 'template' as const, template, palette, title: coverTitle || 'Untitled', mirror: false, italic: false },
  };
  return listingSchema.parse(listing);
}

// MARK: Claude

type Usage = { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
type ContentBlock = { type: string; id?: string; name?: string; input?: unknown } & Record<string, unknown>;
type Payload = { model: string; max_tokens: number; system: unknown; tools: unknown[]; tool_choice: unknown; messages: Array<Record<string, unknown>> };

export type WriteWithAiDependencies = {
  anthropicApiKey?: string | undefined;
  /** CONTENT_AI_MODEL, or the Sonnet ad copy uses. */
  model?: string | undefined;
  fetcher?: typeof fetch;
  log?: (record: Record<string, unknown>) => void;
  /** How long one generation may take in all. */
  budgetMs?: number;
  now?: () => number;
};

/** A Claude client for one generation: the thinking setting a refusal teaches is kept for its other calls. */
function claudeFor(options: { apiKey: string; fetcher: typeof fetch; log: (record: Record<string, unknown>) => void; usage: Usage[] }) {
  const extra: Record<string, unknown> = {};

  const send = (payload: Payload, timeoutMs: number) => options.fetcher('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': options.apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ ...payload, ...extra }),
    signal: AbortSignal.timeout(Math.max(1000, timeoutMs)),
  }).catch(() => null);

  const upstreamError = async (response: Response) => {
    const body = await response.json().catch(() => null) as { error?: { type?: string; message?: string } } | null;
    return { type: body?.error?.type ?? 'unknown', message: (body?.error?.message ?? '').slice(0, 300) };
  };

  return async function call<T>(payload: Payload, tool: string, schema: z.ZodType<T>, timeoutMs: number) {
    let upstream = await send(payload, timeoutMs);
    // A model that thinks by default refuses some tool settings; ask again the way its error says.
    if (upstream && upstream.status === 400 && !extra.thinking) {
      const error = await upstreamError(upstream.clone());
      if (/thinking|tool_choice/i.test(error.message)) {
        extra.thinking = { type: /"thinking":\s*\{\s*"type":\s*"([a-z_]+)"\s*\}\s*instead/i.exec(error.message)?.[1] ?? 'disabled' };
        upstream = await send(payload, timeoutMs);
      }
    }
    if (!upstream || !upstream.ok) {
      const error = upstream ? await upstreamError(upstream) : { type: 'unreachable', message: '' };
      options.log({ route: 'content.generate', upstreamStatus: upstream?.status ?? 'unreachable', errorType: error.type, error: error.message });
      throw new ApiError(502, 'UPSTREAM_FAILED', error.message ? `Claude could not write it (${upstream?.status} ${error.type}: ${error.message})` : 'Claude could not write it');
    }
    const reply = await upstream.json().catch(() => null) as { content?: ContentBlock[]; usage?: Usage; stop_reason?: string } | null;
    options.usage.push(reply?.usage ?? {});
    const block = reply?.content?.find((item) => item.type === 'tool_use' && item.name === tool);
    const parsed = schema.safeParse(block?.input);
    if (!block || !parsed.success) {
      options.log({ route: 'content.generate', shape: 'invalid', tool, stopReason: reply?.stop_reason ?? null });
      throw new ApiError(502, 'UPSTREAM_FAILED', reply?.stop_reason === 'max_tokens' ? 'Claude ran out of room writing it' : 'Claude answered out of shape');
    }
    return { block, content: reply?.content ?? [], input: parsed.data };
  };
}

// MARK: Writing a draft

/** Runs `work` over `items`, at most `limit` at a time. */
async function pool<T>(items: T[], limit: number, work: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await work(items[next++]!);
  }));
}

const plural = (label: string) => `${label.toLowerCase()}s`;

/**
 * Writes and saves a draft, telling the caller each step through `emit`. Never throws: a failure
 * is an `error` event (and nothing is left saved, or the event says what was).
 */
export async function writeDraft(options: {
  content: ContentService; teamId: string; actor: string; app: string; type: ContentTypeView; request: GenerateRequest;
  dependencies: WriteWithAiDependencies & { anthropicApiKey: string }; emit: (event: WriteEvent) => Promise<void>;
}): Promise<void> {
  const { content, teamId, actor, app, type, request, dependencies, emit } = options;
  const now = dependencies.now ?? Date.now;
  const log = dependencies.log ?? ((record) => { if (process.env.NODE_ENV !== 'test') console.info(JSON.stringify(record)); });
  const model = dependencies.model || DEFAULT_CONTENT_MODEL;
  const startedAt = now();
  const deadline = startedAt + (dependencies.budgetMs ?? DEFAULT_BUDGET_MS);
  const remaining = (reserve = 0) => deadline - now() - reserve;
  const usage: Usage[] = [];
  const call = claudeFor({ apiKey: dependencies.anthropicApiKey, fetcher: dependencies.fetcher ?? fetch, log, usage });
  const definition = type.definition;
  const allowed = aiBlocks(type);
  const label = definition.sections?.label ?? null;
  const warnings: string[] = [];
  const stats = { repaired: 0, dropped: 0, sectionsFailed: 0 };
  const system = [{ type: 'text', text: systemPrompt(app, type), cache_control: { type: 'ephemeral' } }];
  const tools = [outlineTool(type), sectionTool(type), fixesTool(type)];
  // Newer models refuse a forced tool call, so the prompt asks for it and the reply is checked.
  const payload = (maxTokens: number, messages: Array<Record<string, unknown>>): Payload => ({ model, max_tokens: maxTokens, system, tools, tool_choice: { type: 'auto' }, messages });
  let outcome = 'done';

  try {
    await emit({ type: 'status', stage: 'outline', message: label ? `Planning the ${plural(label)}` : `Planning the ${type.name.toLowerCase()}` });
    const outlineReply = await call(payload(3000, [{ role: 'user', content: outlineMessage(app, type, request) }]), 'submit_outline', outlineInput, Math.min(90_000, remaining(30_000)));
    const guide = LENGTH_GUIDE[request.length];
    const outline: Outline = {
      ...outlineReply.input,
      title: cut(outlineReply.input.title, 120),
      sections: label ? outlineReply.input.sections.slice(0, Math.min(guide.sections[1] + 2, 12)).map((section) => ({ title: cut(section.title.trim(), 120), plan: section.plan })) : [],
    };
    if (label && outline.sections.length === 0) throw new ApiError(502, 'UPSTREAM_FAILED', `Claude planned no ${plural(label)}`);
    await emit({ type: 'outline', title: outline.title, sections: outline.sections.map((section) => ({ title: section.title })) });

    // One call per section (one for a flat body), then one repair call for the blocks that fail.
    const slots = label ? outline.sections.map((_, index) => index) : [null];
    const results: ({ title: string; fields: Record<string, string | number | boolean | null>; blocks: Block[] } | null)[] = slots.map(() => null);
    await emit({ type: 'status', stage: 'sections', message: label ? `Writing ${outline.sections.length} ${outline.sections.length === 1 ? label.toLowerCase() : plural(label)}` : 'Writing it' });

    await pool(slots, SECTION_CONCURRENCY, async (index) => {
      const slot = index ?? 0;
      const title = index === null ? outline.title : outline.sections[index]!.title;
      const where = index === null ? '' : `${label} ${index + 1} “${title}”: `;
      const prefix = index === null ? 'b' : `s${index + 1}b`;
      const maxTokens = index === null ? (request.length === 'long' ? 12_000 : 8000) : 6000;
      const messages: Array<Record<string, unknown>> = [{ role: 'user', content: sectionMessage(type, request, outline, index) }];
      let reply: Awaited<ReturnType<typeof call<z.infer<typeof sectionInput>>>> | null = null;
      for (let attempt = 0; attempt < 2 && !reply; attempt += 1) {
        if (remaining(20_000) < 15_000) break;
        reply = await call(payload(maxTokens, messages), 'submit_section', sectionInput, Math.min(150_000, remaining(20_000))).catch(() => null);
      }
      if (!reply) {
        stats.sectionsFailed += 1;
        warnings.push(`${where || ''}Claude couldn’t write ${index === null ? 'the body' : 'this one'}; it’s left out`);
        await emit({ type: 'section', index: slot, title, blocks: 0 });
        return;
      }
      const checked = reply.input.blocks.map((raw, n) => toBlock(raw, `${prefix}${n + 1}`, allowed, definition));
      const failing = checked.map((result, n) => ({ n, errors: result.errors })).filter((entry) => entry.errors.length > 0);
      if (failing.length && remaining(20_000) > 15_000) {
        const notes = failing.map((entry) => `- Block ${entry.n + 1}: ${entry.errors.join('; ')}`).join('\n');
        const fixes = await call(payload(4000, [
          ...messages,
          { role: 'assistant', content: reply.content },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: reply.block.id, content: `These blocks didn’t pass:\n${notes}\nCall submit_fixes once with a corrected version of each, by its number. Leave out any you can’t fix.` }] },
        ]), 'submit_fixes', fixesInput, Math.min(90_000, remaining(20_000))).catch(() => null);
        for (const fix of fixes?.input.fixes ?? []) {
          const at = fix.number - 1;
          if (!failing.some((entry) => entry.n === at)) continue;
          const result = toBlock(fix.block, `${prefix}${at + 1}`, allowed, definition);
          if (!result.errors.length) {
            checked[at] = result;
            stats.repaired += 1;
          }
        }
      }
      const blocks: Block[] = [];
      checked.forEach((result, n) => {
        if (result.block) blocks.push(result.block);
        else {
          stats.dropped += 1;
          const kind = (reply!.input.blocks[n] as { type?: unknown } | null)?.type;
          const name = typeof kind === 'string' && kind in BLOCK_LIBRARY ? `${BLOCK_LIBRARY[kind as BlockKind].label.toLowerCase()} block` : 'block';
          warnings.push(`${where}left out ${/^[aeiou]/.test(name) ? 'an' : 'a'} ${name} that didn’t pass (${result.errors[0]})`);
        }
      });
      results[slot] = { title, fields: fieldValues(definition.sections?.fields ?? [], reply.input.fields), blocks };
      await emit({ type: 'section', index: slot, title, blocks: blocks.length });
    });

    const body: Body = label
      ? {
        fields: fieldValues(definition.fields, outline.fields),
        sections: results.flatMap((result, index): Section[] => (result && result.blocks.length
          ? [{ id: `s${index + 1}`, title: result.title, fields: result.fields, blocks: result.blocks }] : [])),
      }
      : { fields: fieldValues(definition.fields, outline.fields), blocks: results[0]?.blocks ?? [] };
    const blockCount = (body.sections ?? []).reduce((sum, section) => sum + section.blocks.length, 0) + (body.blocks?.length ?? 0);
    if (blockCount === 0) throw new ApiError(502, 'UPSTREAM_FAILED', 'Claude couldn’t write any of it');
    const listing = definition.listing?.downloadable ? toListing(outline.listing, outline.title, request.access, warnings) : null;

    // What still stops it being published, besides the review it's yet to have.
    for (const check of runChecks({ appKey: app, definition, body, media: new Map(), approvals: [], listing })) {
      if (check.state === 'fail') warnings.push(`${check.label}${check.detail ? `: ${check.detail}` : ''}`);
    }

    await emit({ type: 'status', stage: 'saving', message: 'Saving the draft' });
    const entryId = await save({ content, teamId, actor, app, type, title: outline.title, body, listing });
    await content.noteGenerated(teamId, actor, entryId, {
      model, length: request.length, sections: body.sections?.length ?? null, blocks: blockCount,
      repaired: stats.repaired, dropped: stats.dropped, warnings: warnings.length,
    }).catch(() => undefined);
    await emit({ type: 'done', entryId, title: outline.title, warnings });
  } catch (error) {
    outcome = 'error';
    const known = error instanceof ApiError;
    if (!known) log({ route: 'content.generate', error: error instanceof Error ? error.message.slice(0, 300) : 'unknown' });
    await emit({ type: 'error', code: known ? error.code : 'GENERATION_FAILED', message: known ? error.message : 'Something went wrong writing the draft. Nothing was saved.' });
  } finally {
    log({
      route: 'content.generate', app, type: type.slug, model, length: request.length, outcome, ...stats, warnings: warnings.length,
      calls: usage.length,
      inputTokens: usage.reduce((sum, u) => sum + (u.input_tokens ?? 0), 0),
      cacheReadTokens: usage.reduce((sum, u) => sum + (u.cache_read_input_tokens ?? 0), 0),
      cacheWriteTokens: usage.reduce((sum, u) => sum + (u.cache_creation_input_tokens ?? 0), 0),
      outputTokens: usage.reduce((sum, u) => sum + (u.output_tokens ?? 0), 0),
      durationMs: Math.round(now() - startedAt),
    });
  }
}

/**
 * createEntry → saveDraft → saveListing. A taken slug gets a number. If a later step fails the
 * empty item is deleted again, so a failure leaves nothing behind (or says what it left).
 */
async function save(options: { content: ContentService; teamId: string; actor: string; app: string; type: ContentTypeView; title: string; body: Body; listing: Listing | null }) {
  const { content, teamId, actor } = options;
  const base = slugify(options.title).slice(0, 72).replace(/-+$/, '') || 'untitled';
  let created: Awaited<ReturnType<ContentService['createEntry']>> | null = null;
  for (let attempt = 1; !created; attempt += 1) {
    const slug = attempt === 1 ? base : attempt <= 5 ? `${base}-${attempt}` : `${base}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      created = await content.createEntry(teamId, actor, { app: options.app, typeId: options.type.id, title: options.title, slug });
    } catch (error) {
      if (!(error instanceof ApiError && error.code === 'SLUG_TAKEN') || attempt >= 6) throw error;
    }
  }
  const entryId = created.entry.id;
  try {
    const saved = await content.saveDraft(teamId, actor, entryId, { title: options.title, body: options.body, revision: created.version.revision });
    if (options.listing) await content.saveListing(teamId, actor, entryId, { revision: saved.version.revision, listing: options.listing });
    return entryId;
  } catch (error) {
    const removed = await content.remove(teamId, actor, entryId).then(() => true, () => false);
    if (removed) throw error;
    const message = error instanceof ApiError ? error.message : 'Saving failed';
    throw new ApiError(503, error instanceof ApiError ? error.code : 'SAVE_FAILED', `${message}. An empty draft “${options.title}” was left in Content (${entryId}); delete it.`);
  }
}
