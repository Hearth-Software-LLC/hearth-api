import { describe, expect, it } from 'vitest';
import { BLOCK_LIBRARY, bodySchema, blockSchema, buildBundle, isScriptureRef, runChecks } from '../../src/content/model.js';
import type { Body, TypeDefinition } from '../../src/content/model.js';
import { unresolvedReferences } from '../../src/content/hearken-blocks.js';

const definition: TypeDefinition = {
  fields: [], sections: { label: 'Lesson', fields: [] },
  blocks: ['text', 'scripture', 'callout', 'quiz', 'match', 'timeline', 'image', 'video', 'link', 'step', 'assessment'],
  reviewSteps: [], listing: null,
};
const checks = (body: Body) => runChecks({ appKey: 'hearken', definition, body, media: new Map(), approvals: [] });
const section = (blocks: unknown[]) => bodySchema.parse({ fields: {}, sections: [{ id: 's1', title: 'One', blocks }] });

describe('Hearken blocks', () => {
  it('keeps bodies written before them valid and unchanged', () => {
    const old = {
      fields: { subject: 'The Godhead' },
      sections: [{ id: 's1', title: 'One', fields: {}, blocks: [
        { id: 'b1', type: 'scripture', ref: 'D&C 130:22', text: 'The Father has a body', highlight: false },
        { id: 'b2', type: 'quiz', question: 'Q?', options: [{ id: 'a', text: 'A', correct: true }, { id: 'b', text: 'B', correct: false }], explanation: '', hint: '', weight: 1, shuffle: true, mastery: true },
        { id: 'b3', type: 'match', prompt: 'Pair', pairs: [{ id: 'p1', left: 'a', right: 'b' }] },
      ] }],
    };
    expect(bodySchema.parse(old)).toEqual(old);
    const bundle = (body: Body) => buildBundle({ entryId: 'e', app: 'hearken', typeSlug: 'learning-module', slug: 's', title: 't', version: 1, schemaVersion: 1, publishedAt: '2026-10-31T00:00:00.000Z', body, media: new Map() });
    expect(bundle(bodySchema.parse(old)).sha256).toBe(bundle(old as Body).sha256);
  });

  it('accepts Hearken ids with dots, up to 80 characters', () => {
    expect(blockSchema.safeParse({ id: 'q.bofm.0001', type: 'text' }).success).toBe(true);
    expect(blockSchema.safeParse({ id: 'x'.repeat(80), type: 'text' }).success).toBe(true);
    expect(blockSchema.safeParse({ id: 'x'.repeat(81), type: 'text' }).success).toBe(false);
    expect(blockSchema.safeParse({ id: 'a b', type: 'text' }).success).toBe(false);
  });

  it('parses links, steps and assessments with their defaults', () => {
    const link = blockSchema.parse({ id: 'bofm.r1', type: 'link', kind: 'scripture', title: 'Alma 32', chapterId: 'bofm.alma.32' });
    expect(link).toMatchObject({ author: '', note: '', url: '' });
    const step = blockSchema.parse({ id: 'm1-reading', type: 'step', kind: 'reading', title: 'Articles of Faith' });
    expect(step).toMatchObject({ required: true, minutes: null, passageForm: 'single', sectionChecks: [], focusQuestions: [], questionId: '' });
    const assessment = blockSchema.parse({ id: 'c01-checkpoint', type: 'assessment', role: 'checkpoint', quiz: { questionPool: ['q1'], questionCount: 1, passCount: 1 } });
    expect(assessment).toMatchObject({ questionPool: [], passPercent: 80, essay: null, quiz: { maxTrueFalse: null, groups: null } });
    expect(blockSchema.safeParse({ id: 'x', type: 'step', kind: 'sermon' }).success).toBe(false);
  });

  it('keeps steps and assessments to Hearken', () => {
    expect(BLOCK_LIBRARY.step.app).toBe('hearken');
    expect(BLOCK_LIBRARY.assessment.app).toBe('hearken');
    expect(BLOCK_LIBRARY.link.app).toBeUndefined();
  });

  it('checks a short-answer quiz by its guide, not its options', () => {
    const short = (guide: string) => checks(section([{ id: 'q1', type: 'quiz', style: 'short', question: 'Why?', guide }]));
    expect(short('Names the source').find((check) => check.id === 'quiz')?.state).toBe('pass');
    expect(short('').find((check) => check.id === 'quiz')?.state).toBe('fail');
  });

  it('fails when a step or assessment points at a question that isn’t there', () => {
    const blocks = [
      { id: 'q1', type: 'quiz', question: 'Q?', options: [{ id: 'a', text: 'A', correct: true }, { id: 'b', text: 'B' }] },
      { id: 'step1', type: 'step', kind: 'article', sectionChecks: [{ section: 'Intro', questionIds: ['q1', 'q9'] }] },
      { id: 'quiz1', type: 'assessment', role: 'item', quiz: { questionPool: ['q1', 'q8'], questionCount: 1, passCount: 1 } },
    ];
    expect(unresolvedReferences(section(blocks).sections![0]!.blocks as never)).toEqual(['q9', 'q8']);
    const check = checks(section(blocks)).find((entry) => entry.id === 'references');
    expect(check).toMatchObject({ state: 'fail', detail: 'Missing: q9, q8' });
    const fixed = checks(section(blocks.slice(0, 1).concat([{ id: 'step1', type: 'step', kind: 'article', sectionChecks: [{ section: 'Intro', questionIds: ['q1'] }] }])));
    expect(fixed.find((entry) => entry.id === 'references')?.state).toBe('pass');
    expect(checks(section([{ id: 't', type: 'text', text: 'a' }])).find((entry) => entry.id === 'references')).toBeUndefined();
  });

  it('reads every reference form Hearken uses', () => {
    for (const ref of ['Joseph Smith—History 1', 'Joseph Smith—History 1:17', 'Articles of Faith 1:1–13', 'Doctrine and Covenants 1:37–39', '1 Nephi 3:7', 'D&C 130:22']) {
      expect(isScriptureRef(ref), ref).toBe(true);
    }
    expect(isScriptureRef('Alma')).toBe(false);
  });
});
