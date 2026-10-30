import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { readConfig } from '../../src/config.js';
import { ApiError } from '../../src/errors.js';
import type { Body, Listing, TypeDefinition } from '../../src/content/model.js';
import type { ContentService, ContentTypeView } from '../../src/content/service.js';
import {
  aiBlocks, fieldValues, outlineMessage, outlineTool, sectionMessage, sectionTool, systemPrompt, toBlock, toListing, typeForAi,
} from '../../src/content/write-with-ai.js';
import type { Outline, WriteEvent } from '../../src/content/write-with-ai.js';
import type { ReserveQuota } from '../../src/services/quota.js';
import type { Member, TeamService } from '../../src/studio/team.js';

const teamId = '00000000-0000-4000-8000-000000000001';
const ids = { module: '00000000-0000-4000-8000-000000000101', article: '00000000-0000-4000-8000-000000000102', budget: '00000000-0000-4000-8000-000000000103', media: '00000000-0000-4000-8000-000000000104' };

const moduleDefinition: TypeDefinition = {
  fields: [{ key: 'subject', label: 'Subject', type: 'text', required: true }, { key: 'summary', label: 'Summary', type: 'text', required: false }],
  sections: { label: 'Lesson', fields: [{ key: 'objective', label: 'Objective', type: 'text', required: false }] },
  blocks: ['text', 'scripture', 'callout', 'quiz', 'match', 'timeline', 'image', 'video', 'link', 'step', 'assessment'],
  reviewSteps: ['Doctrine review'],
  listing: { downloadable: true, unit: { one: 'lesson', many: 'lessons' }, countFrom: 'sections' },
};
const types: Record<string, ContentTypeView> = {
  [ids.module]: { id: ids.module, slug: 'learning-module', app: 'hearken', name: 'Learning module', description: 'A subject unit made of ordered lessons.', schemaVersion: 2, definition: moduleDefinition, updatedAt: '' },
  [ids.article]: {
    id: ids.article, slug: 'help-article', app: null, name: 'Help article', description: 'A support article.', schemaVersion: 1, updatedAt: '',
    definition: { fields: [{ key: 'summary', label: 'Summary', type: 'text', required: true }], sections: null, blocks: ['text', 'callout', 'image', 'video'], reviewSteps: [], listing: null },
  },
  [ids.budget]: {
    id: ids.budget, slug: 'money-module', app: 'suffice', name: 'Money module', description: '', schemaVersion: 1, updatedAt: '',
    definition: { fields: [], sections: { label: 'Lesson', fields: [] }, blocks: ['text', 'scripture', 'quiz', 'timeline', 'link'], reviewSteps: [], listing: null },
  },
  [ids.media]: {
    id: ids.media, slug: 'gallery', app: 'suffice', name: 'Gallery', description: '', schemaVersion: 1, updatedAt: '',
    definition: { fields: [], sections: null, blocks: ['image', 'video'], reviewSteps: [], listing: null },
  },
};

// MARK: Prompts and checks

describe('Write with AI prompts', () => {
  it('offers only the blocks Claude can write, scripture only to Hearken’s types', () => {
    expect(aiBlocks(types[ids.module]!)).toEqual(['text', 'scripture', 'callout', 'quiz', 'match', 'timeline']);
    expect(aiBlocks(types[ids.budget]!)).toEqual(['text', 'quiz', 'timeline']);
    expect(aiBlocks(types[ids.article]!)).toEqual(['text', 'callout']);
    expect(aiBlocks(types[ids.media]!)).toEqual([]);
  });

  it('builds the system prompt from the type’s definition', () => {
    const prompt = systemPrompt('hearken', types[ids.module]!);
    expect(prompt).toContain('Hearken (scripture and gospel study');
    expect(prompt).toContain('The content type: Learning module: A subject unit made of ordered lessons.');
    expect(prompt).toContain('- subject (Subject): a short line, required');
    expect(prompt).toContain('lessons in order');
    expect(prompt).toContain('- objective (Objective)');
    for (const kind of ['text', 'scripture', 'callout', 'quiz', 'match', 'timeline']) expect(prompt).toContain(`{"type": "${kind}"`);
    for (const kind of ['image', 'video', 'link', 'step', 'assessment']) expect(prompt).not.toContain(`{"type": "${kind}"`);
    expect(prompt).toContain('No hype');
    expect(prompt).toContain('cite references');
    expect(prompt).toContain('No personalised financial, medical or nutritional advice');

    const article = systemPrompt('shared', types[ids.article]!);
    expect(article).toContain('one stack of blocks (no sections)');
    expect(article).not.toContain('{"type": "quiz"');
    expect(systemPrompt('suffice', types[ids.budget]!)).not.toContain('{"type": "scripture"');
  });

  it('asks for the outline, the listing and a cover for Collections', () => {
    const message = outlineMessage('hearken', types[ids.module]!, { prompt: 'The Godhead for teens', length: 'medium', access: 'plus' });
    expect(message).toContain('Length: medium: 5 to 6 lessons');
    expect(message).toContain('Access: Plus');
    expect(message).toContain('The Godhead for teens');
    expect(message).toContain('orbit (Orbit)');
    expect(message).toContain('midnight (Midnight, #2C3766)');
    expect(message).toContain('22 characters at most');
    const flat = outlineMessage('shared', types[ids.article]!, { prompt: 'Resetting a password', length: 'short', access: 'free' });
    expect(flat).toContain('3 to 6 blocks (about one screen)');
    expect(flat).not.toContain('Access');
    expect(flat).not.toContain('Cover templates');

    const tool = outlineTool(types[ids.module]!);
    expect(tool.input_schema.required).toEqual(['title', 'fields', 'sections', 'listing']);
    expect(outlineTool(types[ids.article]!).input_schema.required).toEqual(['title', 'fields', 'plan']);
    expect((sectionTool(types[ids.module]!).input_schema.properties.blocks as { items: { anyOf: unknown[] } }).items.anyOf).toHaveLength(6);
  });

  it('points each section call at its place in the outline', () => {
    const outline: Outline = { title: 'The Godhead', fields: {}, plan: '', sections: [{ title: 'Three beings', plan: 'Who they are.' }, { title: 'One purpose', plan: 'How they work together.' }] };
    const message = sectionMessage(types[ids.module]!, { prompt: 'The Godhead for teens', length: 'long' }, outline, 1);
    expect(message).toContain('Write lesson 2 of 2: “One purpose”.');
    expect(message).toContain('2. One purpose  ← this one');
    expect(message).toContain('Its plan: How they work together.');
    expect(message).toContain('about 5 to 8 blocks');
    expect(message).toContain('Fill in its fields: objective.');
  });
});

describe('Write with AI block checks', () => {
  const allowed = aiBlocks(types[ids.module]!);
  const check = (raw: unknown) => toBlock(raw, 's1b1', allowed, moduleDefinition);

  it('adds ids and keeps only the keys the library knows', () => {
    const result = check({ type: 'quiz', question: 'Who has a body of flesh and bones?', options: [{ text: 'The Father', correct: true, why: 'x' }, { text: 'The Holy Ghost', correct: false }], explanation: 'D&C 130:22', hint: '', extra: 1 });
    expect(result.errors).toEqual([]);
    expect(result.block).toMatchObject({ id: 's1b1', type: 'quiz', options: [{ id: 's1b1o1', correct: true }, { id: 's1b1o2', correct: false }] });
    expect(result.block).not.toHaveProperty('extra');
    expect(check({ type: 'match', prompt: 'Match', pairs: [{ left: 'a', right: 'b' }, { left: 'c', right: 'd' }] }).block).toMatchObject({ pairs: [{ id: 's1b1p1' }, { id: 's1b1p2' }] });
  });

  it('says what is wrong with blocks that wouldn’t pass', () => {
    expect(check({ type: 'quiz', question: 'Q?', options: [{ text: 'a', correct: true }, { text: 'b', correct: true }] }).errors[0]).toContain('exactly one marked correct');
    expect(check({ type: 'match', prompt: 'Match', pairs: [{ left: 'a', right: 'b' }] }).errors[0]).toContain('two complete rows');
    expect(check({ type: 'timeline', events: [{ date: '1830', label: '' }, { date: '', label: 'x' }] }).errors[0]).toContain('two complete rows');
    expect(check({ type: 'scripture', ref: 'see chapter four', text: '' }).errors[0]).toContain('scripture references are complete');
    expect(check({ type: 'text', text: '  ' }).errors).toEqual(['text is empty']);
    expect(check({ type: 'callout', label: 'x'.repeat(61), text: 'y' }).errors[0]).toContain('label');
    expect(check({ type: 'image', alt: 'A grove' }).errors[0]).toContain('isn’t allowed');
    expect(check({ type: 'step', kind: 'lesson' }).errors[0]).toContain('isn’t allowed');
    expect(check('text').errors).toEqual(['is not an object']);
    expect(toBlock({ type: 'scripture', ref: 'Alma 32:21', text: '' }, 'b1', aiBlocks(types[ids.budget]!), types[ids.budget]!.definition).errors[0]).toContain('isn’t allowed');
  });

  it('keeps field values that fit their types', () => {
    const fields = [
      { key: 'subject', label: 'Subject', type: 'text' as const, required: true },
      { key: 'minutes', label: 'Minutes', type: 'number' as const, required: false },
      { key: 'featured', label: 'Featured', type: 'boolean' as const, required: false },
      { key: 'photo', label: 'Photo', type: 'image' as const, required: false },
    ];
    expect(fieldValues(fields, { subject: ' The Godhead ', minutes: '12', featured: 'yes', photo: 'x', other: 'y' })).toEqual({ subject: 'The Godhead', minutes: 12 });
  });

  it('fits the listing: lengths, a known cover and the access asked for', () => {
    const warnings: string[] = [];
    const listing = toListing({
      title: 'A very long listing title that goes on and on', about: `${'One sentence that is fine. '.repeat(5)}And then a much longer one that pushes it over the limit by a lot.`,
      categories: ['Doctrine', 'doctrine', 'Godhead', 'Teens', 'Extra'], cover: { template: 'spiral', palette: 'pine', title: 'The Godhead and the Plan' },
    }, 'Fallback', 'plus', warnings);
    expect([...listing.title].length).toBeLessThanOrEqual(34);
    expect(listing.about.length).toBeLessThanOrEqual(180);
    expect(listing.about.endsWith('.')).toBe(true);
    expect(listing.categories).toEqual(['Doctrine', 'Godhead', 'Teens']);
    expect(listing.access).toBe('plus');
    expect(listing.cover).toMatchObject({ kind: 'template', template: 'orbit', palette: 'pine' });
    expect([...listing.cover!.title].length).toBeLessThanOrEqual(22);
    expect(warnings).toEqual(['The cover title was shortened to fit: check it under Cover & listing']);
    expect(toListing(undefined, 'The Godhead', 'free', []).cover).toMatchObject({ title: 'The Godhead', template: 'orbit', palette: 'midnight' });
  });
});

// MARK: The route

const member = (userId: string, overrides: Partial<Member> = {}): Member => ({
  teamId, teamName: 'Hearth Software', userId, role: 'member', canPost: false, canPlans: false, canAccounts: false, canAffiliates: false,
  displayName: userId, avatarPath: null, notifyDue: false, notifyComments: false, notifyFailed: false, addedAt: '',
  contentRole: 'author', contentApps: ['hearken'], ...overrides,
});
const members: Record<string, Member> = {
  'user-author': member('user-author'),
  'user-everywhere': member('user-everywhere', { contentApps: null }),
  'user-reviewer': member('user-reviewer', { contentRole: 'reviewer', contentApps: ['hearken'] }),
  'user-sated': member('user-sated', { contentApps: ['sated'] }),
};

type Saved = { created: { app: string; typeId: string; title: string; slug?: string | undefined }[]; drafts: { id: string; body: Body; revision: number; title?: string | undefined }[]; listings: { id: string; listing: Listing; revision: number }[]; removed: string[]; notes: Record<string, unknown>[] };

function fakeContent(saved: Saved, options: { failDraft?: boolean; takenSlugs?: string[] } = {}) {
  let revision = 1;
  return {
    type: async (_team: string, id: string) => {
      const type = types[id];
      if (!type) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'That content type doesn’t exist');
      return type;
    },
    createEntry: async (_team: string, _actor: string, input: Saved['created'][number]) => {
      if (options.takenSlugs?.includes(input.slug ?? '')) throw new ApiError(409, 'SLUG_TAKEN', 'Another item in this app already uses that slug');
      saved.created.push(input);
      return { entry: { id: 'entry-1' }, version: { revision } };
    },
    saveDraft: async (_team: string, _actor: string, id: string, input: { body: Body; revision: number; title?: string }) => {
      if (options.failDraft) throw new ApiError(422, 'BLOCK_NOT_ALLOWED', 'Nope');
      saved.drafts.push({ id, ...input });
      revision += 1;
      return { version: { revision } };
    },
    saveListing: async (_team: string, _actor: string, id: string, input: { listing: Listing; revision: number }) => {
      saved.listings.push({ id, ...input });
      revision += 1;
      return { revision };
    },
    remove: async (_team: string, _actor: string, id: string) => { saved.removed.push(id); },
    noteGenerated: async (_team: string, _actor: string, _id: string, detail: Record<string, unknown>) => { saved.notes.push(detail); },
  } as unknown as ContentService;
}

const toolReply = (name: string, input: unknown, id = 'toolu_1') => Response.json({
  content: [{ type: 'tool_use', id, name, input }],
  usage: { input_tokens: 2000, output_tokens: 900, cache_read_input_tokens: 1500 },
});

const outline = {
  title: 'The Godhead', fields: { subject: 'Doctrinal Mastery', summary: 'Who God is.' },
  sections: [{ title: 'Three beings', plan: 'Who they are.' }, { title: 'One purpose', plan: 'How they work.' }],
  listing: { title: 'The Godhead', about: 'Three distinct beings, one purpose: what the scriptures teach about the Godhead.', categories: ['Doctrine'], cover: { template: 'eclipse', palette: 'harbor', title: 'The Godhead' } },
};
const good = { type: 'text', text: 'The Father, the Son and the Holy Ghost are three distinct beings.' };
const goodQuiz = { type: 'quiz', question: 'Which member of the Godhead has no body of flesh and bones?', options: [{ text: 'The Father', correct: false }, { text: 'The Holy Ghost', correct: true }], explanation: 'D&C 130:22', hint: '' };
const badQuiz = { ...goodQuiz, options: [{ text: 'The Father', correct: true }, { text: 'The Holy Ghost', correct: true }] };

/** Answers like Claude, by which tool the request asks for. */
function claude(answer: (kind: 'outline' | 'section' | 'fixes', message: string, sent: Record<string, unknown>) => Response | Promise<Response>) {
  return vi.fn<typeof fetch>(async (_url, init) => {
    const sent = JSON.parse(String(init?.body)) as { messages: { content: unknown }[] };
    const last = sent.messages[sent.messages.length - 1]!.content;
    const message = typeof last === 'string' ? last : JSON.stringify(last);
    const kind = message.includes('submit_fixes') ? 'fixes' : message.includes('submit_outline') ? 'outline' : 'section';
    const first = sent.messages[0]!.content as string;
    return answer(kind, kind === 'section' ? first : message, sent);
  });
}

function setup(fetcher: typeof fetch, options: { apiKey?: string | null; failDraft?: boolean; takenSlugs?: string[]; quota?: ReserveQuota; now?: () => number } = {}) {
  const saved: Saved = { created: [], drafts: [], listings: [], removed: [], notes: [] };
  const reserveQuota = vi.fn<ReserveQuota>(options.quota ?? (async () => undefined));
  const team = { memberOf: async (userId: string) => members[userId] } as unknown as TeamService;
  const app = createApp({
    config: readConfig({}),
    verifyToken: async (bearer) => ({ userId: `user-${bearer}`, isAnonymous: false }),
    reserveQuota,
    entitlements: async () => [],
    studio: { team },
    content: {
      service: fakeContent(saved, options),
      writeWithAi: { anthropicApiKey: options.apiKey === null ? undefined : (options.apiKey ?? 'sk-test'), fetcher, log: () => undefined, ...(options.now ? { now: options.now } : {}) },
    },
  });
  return { app, saved, reserveQuota };
}

const request = { app: 'hearken', typeId: ids.module, prompt: 'A short module on the Godhead for teens', length: 'short', access: 'plus' };

async function generate(app: ReturnType<typeof setup>['app'], body: unknown = request, who = 'author') {
  return app.request('/v1/content/entries/generate', { method: 'POST', headers: { Authorization: `Bearer ${who}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

async function events(response: Response): Promise<WriteEvent[]> {
  const text = await response.text();
  return text.split('\n\n').filter((chunk) => chunk.trim()).map((chunk) => {
    expect(chunk.startsWith('data: ')).toBe(true);
    return JSON.parse(chunk.slice('data: '.length)) as WriteEvent;
  });
}

describe('POST /v1/content/entries/generate', () => {
  it('streams the outline, each section and done, and saves the draft and listing', async () => {
    const fetcher = claude((kind, message) => {
      if (kind === 'outline') return toolReply('submit_outline', outline);
      // The quiz can be fixed; the image can't.
      if (kind === 'fixes') return toolReply('submit_fixes', { fixes: message.includes('a quiz needs') ? [{ number: 2, block: goodQuiz }] : [] }, 'toolu_3');
      return message.includes('lesson 1 of 2')
        ? toolReply('submit_section', { fields: { objective: 'Know the three beings' }, blocks: [good, badQuiz] }, 'toolu_2')
        : toolReply('submit_section', { blocks: [good, { type: 'image', alt: 'A grove' }, { type: 'callout', label: 'Key idea', text: 'One purpose.' }] });
    });
    const { app, saved, reserveQuota } = setup(fetcher);
    const response = await generate(app);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const stream = await events(response);

    expect(stream.slice(0, 3)).toEqual([
      { type: 'status', stage: 'outline', message: 'Planning the lessons' },
      { type: 'outline', title: 'The Godhead', sections: [{ title: 'Three beings' }, { title: 'One purpose' }] },
      { type: 'status', stage: 'sections', message: 'Writing 2 lessons' },
    ]);
    expect(stream.slice(3, 5).sort((a, b) => ((a as { index: number }).index - (b as { index: number }).index))).toEqual([
      { type: 'section', index: 0, title: 'Three beings', blocks: 2 },
      { type: 'section', index: 1, title: 'One purpose', blocks: 2 },
    ]);
    expect(stream[5]).toEqual({ type: 'status', stage: 'saving', message: 'Saving the draft' });
    const done = stream[6] as Extract<WriteEvent, { type: 'done' }>;
    expect(done).toMatchObject({ type: 'done', entryId: 'entry-1', title: 'The Godhead' });
    expect(done.warnings).toEqual(['Lesson 2 “One purpose”: left out an image block that didn’t pass (type "image" isn’t allowed here; use one of text, scripture, callout, quiz, match, timeline)']);
    expect(stream).toHaveLength(7);

    expect(reserveQuota).toHaveBeenCalledWith('user-author', 'content-ai');
    expect(saved.created).toEqual([{ app: 'hearken', typeId: ids.module, title: 'The Godhead', slug: 'the-godhead' }]);
    const draft = saved.drafts[0]!;
    expect(draft.revision).toBe(1);
    expect(draft.body.fields).toEqual({ subject: 'Doctrinal Mastery', summary: 'Who God is.' });
    expect(draft.body.sections!.map((section) => [section.id, section.title, section.blocks.map((block) => block.id)])).toEqual([
      ['s1', 'Three beings', ['s1b1', 's1b2']],
      ['s2', 'One purpose', ['s2b1', 's2b3']],
    ]);
    expect(draft.body.sections![0]!.fields).toEqual({ objective: 'Know the three beings' });
    expect(draft.body.sections![0]!.blocks[1]).toMatchObject({ type: 'quiz', options: [{ correct: false }, { correct: true }] });
    expect(saved.listings[0]).toMatchObject({ revision: 2, listing: { title: 'The Godhead', access: 'plus', cover: { kind: 'template', template: 'eclipse', palette: 'harbor', title: 'The Godhead' } } });
    expect(saved.notes[0]).toMatchObject({ model: 'claude-sonnet-5-5', length: 'short', sections: 2, blocks: 4, repaired: 1, dropped: 1 });

    // An outline, two sections, a repair for each; Sonnet through a tool, nothing about the author.
    expect(fetcher).toHaveBeenCalledTimes(5);
    const sent = fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    for (const payload of sent) {
      expect(payload.model).toBe('claude-sonnet-5-5');
      expect(payload.tool_choice).toEqual({ type: 'auto' });
      expect(payload.system[0].cache_control).toEqual({ type: 'ephemeral' });
      expect(JSON.stringify(payload)).not.toContain('user-author');
      expect(JSON.stringify(payload)).not.toContain(teamId);
    }
    const repair = sent.find((payload) => JSON.stringify(payload.messages).includes('a quiz needs'))!;
    expect(repair.messages).toHaveLength(3);
    expect(repair.messages[1].content[0]).toMatchObject({ type: 'tool_use', id: 'toolu_2' });
    expect(repair.messages[2].content[0].content).toContain('- Block 2: a quiz needs');
  });

  it('writes a flat shared type in one call, with no listing', async () => {
    const fetcher = claude((kind) => (kind === 'outline'
      ? toolReply('submit_outline', { title: 'Resetting your password', fields: { summary: 'How to get back in.' }, plan: 'Steps, then a tip.' })
      : toolReply('submit_section', { blocks: [good, { type: 'callout', label: 'Tip', text: 'Use a password manager.' }] })));
    const { app, saved } = setup(fetcher);
    const stream = await events(await generate(app, { app: null, typeId: ids.article, prompt: 'How to reset a password in any Hearth app' }, 'everywhere'));
    expect(stream.map((event) => event.type)).toEqual(['status', 'outline', 'status', 'section', 'status', 'done']);
    expect(stream[0]).toEqual({ type: 'status', stage: 'outline', message: 'Planning the help article' });
    expect(stream[1]).toEqual({ type: 'outline', title: 'Resetting your password', sections: [] });
    expect(stream[3]).toEqual({ type: 'section', index: 0, title: 'Resetting your password', blocks: 2 });
    expect((stream[5] as { warnings: string[] }).warnings).toEqual([]);
    expect(saved.created[0]).toMatchObject({ app: 'shared' });
    expect(saved.drafts[0]!.body).toEqual({ fields: { summary: 'How to get back in.' }, blocks: [{ id: 'b1', ...good }, { id: 'b2', type: 'callout', label: 'Tip', text: 'Use a password manager.' }] });
    expect(saved.listings).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('writes at most three sections at once', async () => {
    let running = 0;
    let most = 0;
    const fetcher = claude(async (kind) => {
      if (kind === 'outline') return toolReply('submit_outline', { ...outline, sections: Array.from({ length: 7 }, (_, n) => ({ title: `Lesson ${n + 1}`, plan: '' })) });
      running += 1;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 10));
      running -= 1;
      return toolReply('submit_section', { blocks: [good] });
    });
    const { app, saved } = setup(fetcher);
    const stream = await events(await generate(app, { ...request, length: 'long' }));
    expect(stream.filter((event) => event.type === 'section')).toHaveLength(7);
    expect(most).toBe(3);
    expect(saved.drafts[0]!.body.sections).toHaveLength(7);
  });

  it('keeps writing and saves the draft when the client goes away', async () => {
    const fetcher = claude(async (kind) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return kind === 'outline' ? toolReply('submit_outline', outline) : toolReply('submit_section', { blocks: [good] });
    });
    const { app, saved } = setup(fetcher);
    const response = await generate(app);
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    await vi.waitFor(() => expect(saved.listings).toHaveLength(1), { timeout: 2000 });
    expect(saved.drafts[0]!.body.sections).toHaveLength(2);
  });

    it('numbers the slug when the title is taken', async () => {
    const fetcher = claude((kind) => (kind === 'outline' ? toolReply('submit_outline', outline) : toolReply('submit_section', { blocks: [good] })));
    const { app, saved } = setup(fetcher, { takenSlugs: ['the-godhead', 'the-godhead-2'] });
    const stream = await events(await generate(app));
    expect(stream.at(-1)).toMatchObject({ type: 'done' });
    expect(saved.created[0]!.slug).toBe('the-godhead-3');
  });

  it('leaves out a section Claude can’t write, and says so', async () => {
    const fetcher = claude((kind, message) => {
      if (kind === 'outline') return toolReply('submit_outline', outline);
      return message.includes('lesson 2 of 2') ? new Response('busy', { status: 529 }) : toolReply('submit_section', { blocks: [good] });
    });
    const { app, saved } = setup(fetcher);
    const stream = await events(await generate(app));
    expect(stream).toContainEqual({ type: 'section', index: 1, title: 'One purpose', blocks: 0 });
    const done = stream.at(-1) as Extract<WriteEvent, { type: 'done' }>;
    expect(done.warnings).toContain('Lesson 2 “One purpose”: Claude couldn’t write this one; it’s left out');
    expect(saved.drafts[0]!.body.sections!.map((section) => section.title)).toEqual(['Three beings']);
    // The section was tried twice.
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('sends an error event and saves nothing when the outline fails', async () => {
    const fetcher = claude(() => Response.json({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, { status: 529 }));
    const { app, saved } = setup(fetcher);
    const stream = await events(await generate(app));
    expect(stream).toEqual([
      { type: 'status', stage: 'outline', message: 'Planning the lessons' },
      { type: 'error', code: 'UPSTREAM_FAILED', message: 'Claude could not write it (529 overloaded_error: Overloaded)' },
    ]);
    expect(saved.created).toEqual([]);
  });

  it('answers out of shape as an error event', async () => {
    const fetcher = claude(() => Response.json({ content: [{ type: 'text', text: 'Here is an outline…' }] }));
    const stream = await events(await generate(setup(fetcher).app));
    expect(stream.at(-1)).toEqual({ type: 'error', code: 'UPSTREAM_FAILED', message: 'Claude answered out of shape' });
  });

  it('deletes the empty item again when saving the draft fails', async () => {
    const fetcher = claude((kind) => (kind === 'outline' ? toolReply('submit_outline', outline) : toolReply('submit_section', { blocks: [good] })));
    const { app, saved } = setup(fetcher, { failDraft: true });
    const stream = await events(await generate(app));
    expect(stream.at(-1)).toEqual({ type: 'error', code: 'BLOCK_NOT_ALLOWED', message: 'Nope' });
    expect(saved.removed).toEqual(['entry-1']);
  });

  it('asks again with thinking off when the model refuses the tool settings', async () => {
    let refused = false;
    const fetcher = claude((kind) => {
      if (!refused) {
        refused = true;
        return Response.json({ type: 'error', error: { type: 'invalid_request_error', message: 'Thinking may not be enabled when tool_choice forces tool use.' } }, { status: 400 });
      }
      return kind === 'outline' ? toolReply('submit_outline', outline) : toolReply('submit_section', { blocks: [good] });
    });
    const stream = await events(await generate(setup(fetcher).app));
    expect(stream.at(-1)).toMatchObject({ type: 'done' });
    for (const [, init] of fetcher.mock.calls.slice(1)) expect(JSON.parse(String(init?.body)).thinking).toEqual({ type: 'disabled' });
  });

  it('uses CONTENT_AI_MODEL when set', async () => {
    const fetcher = claude((kind) => (kind === 'outline' ? toolReply('submit_outline', outline) : toolReply('submit_section', { blocks: [good] })));
    const previous = process.env.CONTENT_AI_MODEL;
    process.env.CONTENT_AI_MODEL = 'claude-test-model';
    try {
      const { app } = setup(fetcher);
      await events(await generate(app));
    } finally {
      if (previous === undefined) delete process.env.CONTENT_AI_MODEL; else process.env.CONTENT_AI_MODEL = previous;
    }
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body)).model).toBe('claude-test-model');
  });

  it('stops starting sections when time runs out, and saves what it has', async () => {
    let clock = 0;
    const fetcher = claude((kind) => {
      clock += kind === 'outline' ? 1000 : 120_000;
      return kind === 'outline' ? toolReply('submit_outline', { ...outline, sections: Array.from({ length: 6 }, (_, n) => ({ title: `Lesson ${n + 1}`, plan: '' })) }) : toolReply('submit_section', { blocks: [good] });
    });
    const { app, saved } = setup(fetcher, { now: () => clock });
    const stream = await events(await generate(app, { ...request, length: 'medium' }));
    expect(stream.at(-1)).toMatchObject({ type: 'done' });
    const written = saved.drafts[0]!.body.sections!.length;
    expect(written).toBeGreaterThan(0);
    expect(written).toBeLessThan(6);
    expect((stream.at(-1) as { warnings: string[] }).warnings.some((warning) => warning.includes('left out'))).toBe(true);
  });
});

describe('POST /v1/content/entries/generate before the stream', () => {
  const never = () => vi.fn<typeof fetch>(async () => { throw new Error('should not call Claude'); });

  it('needs an author role on the app', async () => {
    const fetcher = never();
    const { app, reserveQuota } = setup(fetcher);
    const denied = await generate(app, request, 'sated');
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ error: { code: 'PERMISSION_REQUIRED' } });
    expect((await generate(app, request, 'stranger')).status).toBe(403);
    // Shared content needs a role on every app.
    expect((await generate(app, { ...request, app: null, typeId: ids.article }, 'author')).status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
    expect(reserveQuota).not.toHaveBeenCalled();
  });

  it('lets reviewers and up write drafts', async () => {
    const fetcher = claude((kind) => (kind === 'outline' ? toolReply('submit_outline', outline) : toolReply('submit_section', { blocks: [good] })));
    const response = await generate(setup(fetcher).app, request, 'reviewer');
    expect(response.status).toBe(200);
    expect((await events(response)).at(-1)).toMatchObject({ type: 'done' });
  });

  it('answers 503 AI_NOT_CONFIGURED without a key, before the quota', async () => {
    const { app, reserveQuota } = setup(never(), { apiKey: null });
    const response = await generate(app);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'AI_NOT_CONFIGURED' } });
    expect(reserveQuota).not.toHaveBeenCalled();
  });

  it('answers 429 when the day’s 20 are used', async () => {
    const fetcher = never();
    const { app } = setup(fetcher, { quota: async () => { throw new ApiError(429, 'RATE_LIMITED', 'Too many requests', 3600); } });
    const response = await generate(app);
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('checks the request, the type and that the type is for the app', async () => {
    const { app } = setup(never());
    expect((await generate(app, { ...request, prompt: 'too short' })).status).toBe(400);
    expect((await generate(app, { ...request, prompt: 'x'.repeat(4001) })).status).toBe(400);
    expect((await generate(app, { ...request, length: 'epic' })).status).toBe(400);
    expect((await generate(app, { ...request, extra: true })).status).toBe(400);
    expect((await generate(app, { ...request, typeId: '00000000-0000-4000-8000-000000000999' })).status).toBe(404);
    const everywhere = setup(never()).app;
    const wrongApp = await generate(everywhere, { ...request, typeId: ids.budget }, 'everywhere');
    expect(wrongApp.status).toBe(422);
    expect(await wrongApp.json()).toMatchObject({ error: { code: 'TYPE_NOT_FOR_APP' } });
    expect((await generate(everywhere, { ...request, typeId: ids.article }, 'everywhere')).status).toBe(422);
    const media = await generate(everywhere, { ...request, app: 'suffice', typeId: ids.media }, 'everywhere');
    expect(media.status).toBe(422);
    expect(await media.json()).toMatchObject({ error: { code: 'NO_AI_BLOCKS' } });
  });
});

describe('typeForAi', () => {
  const withPath: TypeDefinition = {
    ...moduleDefinition,
    fields: [...moduleDefinition.fields, { key: 'subjectId', label: 'Hearken subject ID', type: 'text', required: false }, { key: 'pathTitle', label: 'Scholar Path title', type: 'text', required: false }],
    sections: { label: 'Lesson', fields: [...moduleDefinition.sections!.fields, { key: 'kind', label: 'Kind', type: 'text', required: false }, { key: 'stage', label: 'Stage', type: 'number', required: false }, { key: 'courseId', label: 'Course ID', type: 'text', required: false }] },
  };

  it("hides Hearken's Scholar Path fields from Claude", () => {
    const type = typeForAi({ ...types[ids.module]!, definition: withPath });
    expect(type.definition.fields.map((field) => field.key)).toEqual(['subject', 'summary']);
    expect(type.definition.sections!.fields.map((field) => field.key)).toEqual(['objective']);
    expect(systemPrompt('hearken', type)).not.toMatch(/subjectId|pathTitle|courseId|\bkind\b/);
    expect(JSON.stringify(sectionTool(type))).not.toContain('"kind"');
  });

  it('leaves other types alone', () => {
    const other = { ...types[ids.module]!, app: 'suffice', definition: withPath };
    expect(typeForAi(other)).toBe(other);
  });
});
