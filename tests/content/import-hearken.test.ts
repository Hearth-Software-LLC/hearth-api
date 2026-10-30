import { describe, expect, it } from 'vitest';
import { bodySchema, listingSchema } from '../../src/content/model.js';
import { aboutFrom, convertAll, rebuild } from '../../scripts/import-hearken-subjects.js';
import type { BankFile, PathFile, Source, SubjectCatalog } from '../../scripts/import-hearken-subjects.js';

const catalog: SubjectCatalog = {
  contentVersion: 2,
  subjects: [
    { id: 'lds-doctrine', name: 'Latter-day Saint Doctrine', symbol: 'text.book.closed', summary: 'Sources, the Godhead and the plan of salvation, from Novice to Sage, with confessional claims labeled.', units: [], resources: [] },
    {
      id: 'bofm-history', name: 'Book of Mormon Narrative and Geography', symbol: 'book.closed', summary: 'Study the Book of Mormon’s narrated chronology and internal geography, as the text tells it.',
      units: [{ id: 'bofm.u3', number: 3, title: 'The reign of the judges', range: 'Alma – Helaman', readingChapterIDs: ['bofm.alma.32'] }],
      resources: [
        { id: 'bofm.r1', kind: 'scripture', title: 'Alma 32', author: 'Faith compared to a seed', chapterID: 'bofm.alma.32' },
        { id: 'bofm.r2', kind: 'article', title: 'Translation', author: 'Gospel Topics Essays', url: 'https://example.org/t', note: 'Official account.' },
      ],
    },
  ],
  questions: [{ id: 'q.bofm.0006', subjectID: 'bofm-history', unitID: 'bofm.u3', prompt: 'Alma compares the word to what?', options: ['A lamp', 'A seed', 'A river', 'A sword'], answer: 1, reference: 'Alma 32:28', chapterID: 'bofm.alma.32', explanation: 'A seed.' }],
};

const path: PathFile = {
  subjectID: 'lds-doctrine', ruleVersion: 1, title: 'LDS Doctrine: Novice to Sage', summary: 'Describes the doctrine.',
  stages: [{
    number: 1, title: 'Foundations', outcome: 'Read sources well.', published: true,
    advancementCheck: { id: 'lds-doctrine-stage-1-exam', questionPool: [], questionCount: 2, passPercent: 80, quiz: { questionPool: ['m1-q1', 'm1-tf'], questionCount: 2, passCount: 2, groups: [['m1-q1', 'm1-tf']] } },
    courses: [{
      id: 'lds-doctrine-c01', number: 1, title: 'Learning to Read LDS Doctrine', summary: 'Tell sources apart.', milestone: 'Recognize sources.', objectives: [],
      checkpoint: { id: 'lds-doctrine-c01-checkpoint', questionPool: ['lds-doctrine-c01-q01'], questionCount: 1, passPercent: 80 },
      books: [{ title: 'The Articles of Faith', url: 'https://example.org/aof', note: 'Historical companion.' }],
      videos: [{ id: 'c01-video', kind: 'video', title: 'The Plan', required: false, minutes: 15, prompt: 'Draw it.', completion: 'Explain it.', video: { provider: 'youtube', videoID: 'a5WbD_KyGZQ', speaker: 'L. Tom Perry', transcriptURL: 'https://example.org/talk' }, alternativeItemID: 'm1-article', equivalenceGroup: 'video:a5' }],
      modules: [{
        id: 'lds-doctrine-c01-m01', number: '1.1', title: 'Sources and authority', objectives: ['Distinguish canon and commentary.'], keyPoints: ['Canon', 'Commentary'],
        items: [
          { id: 'm1-article', kind: 'article', title: 'Sources and authority', required: true, minutes: 15, body: '# Sources\n\n## Why\n\nText.', prompt: '', sectionChecks: [{ section: 'Why', questionIDs: ['m1-q1'] }] },
          { id: 'm1-reading', kind: 'reading', title: 'Articles of Faith 1:1–13', required: true, minutes: 10, prompt: '', focusQuestions: ['Which articles describe God?'], passages: [{ chapterID: 'pgp.a-of-f.1', from: 1, to: 13 }], quiz: { questionPool: ['m1-q1', 'm1-tf'], questionCount: 2, passCount: 1, maxTrueFalse: 1 } },
          { id: 'm1-jsh', kind: 'reading', title: 'Joseph Smith—History 1', required: true, minutes: 10, prompt: 'What happened?', guide: 'The vision.', completion: 'Write.', passage: { chapterID: 'pgp.js-h.1', from: 15, to: 20 }, equivalenceGroup: 'jsh' },
          { id: 'm1-guide', kind: 'reading', title: 'Approaching Doctrine', required: true, minutes: 12, prompt: '', source: { title: 'Approaching Doctrine', url: 'https://example.org/a', note: 'Institutional' } },
          { id: 'm1-practice', kind: 'practice', title: 'What kind of source?', required: true, minutes: 10, prompt: '', questionID: 'm1-match' },
          { id: 'm1-essay', kind: 'essay', title: 'Essay', required: true, minutes: 20, prompt: '', essay: { minWords: 150, maxWords: 250, revisionsBeforeCompletion: 3, rubric: [{ id: 'accuracy', title: 'Accuracy', full: 'a', partial: 'b', none: 'c' }], prompts: [{ id: 'p1', prompt: 'Classify.', guide: 'Scripture is canon.' }] } },
        ],
      }],
    }],
  }],
  capstone: { id: 'lds-doctrine-capstone', title: 'A synthesis', summary: 'An essay.', requirements: ['One question.', 'Ten sources.'], rubric: ['Accuracy: 0–3'] },
  questions: [{ id: 'lds-doctrine-c01-q01', kind: 'shortAnswer', prompt: 'What evidence is needed?', guide: 'Identify commentary.', reference: 'Approaching Doctrine' }],
};

const bank: BankFile = {
  moduleID: 'lds-doctrine-c01-m01',
  questions: [
    { id: 'm1-q1', revision: 1, type: 'multiple_choice', prompt: 'Which are the standard works?', options: [{ id: 'o1', text: 'The four' }, { id: 'o2', text: 'Others' }], correctOptionID: 'o1', explanation: 'The guide names four.', questionFamilyID: 'f1', difficulty: 'introductory' },
    { id: 'm1-tf', revision: 2, type: 'true_false', prompt: 'Teachings can change.', options: [{ id: 'o1', text: 'True' }, { id: 'o2', text: 'False' }], correctOptionID: 'o1', explanation: 'Open canon.', questionFamilyID: 'f2', difficulty: 'application' },
    {
      id: 'm1-match', revision: 1, type: 'matching', prompt: 'Classify.', title: 'What kind of source?', instructions: 'Match each.', explanation: 'Roles differ.', questionFamilyID: 'f3', difficulty: 'introductory',
      leftItems: [{ id: 'l1', text: 'Article of Faith 4' }, { id: 'l2', text: 'A diary' }], rightItems: [{ id: 'r2', text: 'Historical record' }, { id: 'r1', text: 'Canon' }],
      correctPairs: [{ leftID: 'l1', rightID: 'r1' }, { leftID: 'l2', rightID: 'r2' }], overlapsWithQuestionIDs: ['m1-q1'],
    },
  ],
};

const titles: Record<string, string> = { 'bofm.alma.32': 'Alma 32', 'pgp.a-of-f.1': 'Articles of Faith 1', 'pgp.js-h.1': 'Joseph Smith—History 1' };
const source: Source = { catalog, paths: new Map([[path.subjectID, path]]), banks: new Map([[bank.moduleID, bank]]), chapterTitle: (id) => titles[id] ?? null };

describe('Hearken import', () => {
  it('converts every subject into a valid body and listing that rebuilds exactly', () => {
    const { results, errors } = convertAll(source);
    expect(errors).toEqual([]);
    expect(results.map((result) => result.converted.slug)).toEqual(['lds-doctrine', 'bofm-history']);
    for (const { converted, summary } of results) {
      expect(bodySchema.safeParse(converted.body).success).toBe(true);
      expect(listingSchema.safeParse(converted.listing).success).toBe(true);
      expect(summary.roundTrip).toEqual([]);
    }
  });

  it('keeps Hearken’s ids and lays out the path as modules, courses and stages', () => {
    const [doctrine, bofm] = convertAll(source).results.map((result) => result.converted);
    expect(doctrine!.body.sections!.map((section) => [section.id, section.fields.kind])).toEqual([
      ['lds-doctrine-c01-m01', 'module'], ['lds-doctrine-c01', 'course'], ['lds-doctrine-stage-1', 'stage'],
    ]);
    expect(bofm!.body.sections!.map((section) => section.id)).toEqual(['bofm.u3', 'bofm-history.resources']);
    const unit = bofm!.body.sections![0]!;
    expect(unit.blocks.map((block) => [block.id, block.type])).toEqual([['bofm.u3.reading.1', 'scripture'], ['q.bofm.0006', 'quiz']]);
    expect(unit.blocks[1]).toMatchObject({ reference: 'Alma 32:28', chapterId: 'bofm.alma.32', options: [{ id: 'a', correct: false }, { id: 'b', correct: true }, {}, {}] });
    const module = doctrine!.body.sections![0]!;
    expect(module.blocks.find((block) => block.id === 'm1-jsh.p1')).toMatchObject({ type: 'scripture', ref: 'Joseph Smith—History 1:15–20', chapterId: 'pgp.js-h.1', from: 15, to: 20 });
    expect(module.blocks.find((block) => block.id === 'm1-match')).toMatchObject({ type: 'match', pairs: [{ id: 'l1', right: 'Canon', rightId: 'r1' }, { id: 'l2', rightId: 'r2' }] });
  });

  it('rebuilds Hearken’s models field by field', () => {
    const doctrine = convertAll(source).results[0]!.converted;
    const back = rebuild(doctrine.body);
    expect(back.order).toBe(0);
    expect(back.contentVersion).toBe(2);
    expect(back.path?.capstone).toEqual(path.capstone);
    expect(back.path?.stages[0]?.advancementCheck).toEqual(path.stages[0]!.advancementCheck);
    expect(back.path?.stages[0]?.courses[0]?.videos[0]).toEqual(path.stages[0]!.courses[0]!.videos[0]);
    expect(back.path?.stages[0]?.courses[0]?.modules[0]?.items.find((item) => item.id === 'm1-reading')).toEqual(path.stages[0]!.courses[0]!.modules[0]!.items[1]);
    expect(back.banks[0]?.questions.find((question) => question.id === 'm1-tf')).toMatchObject({ type: 'true_false', revision: 2, correctOptionID: 'o1', questionFamilyID: 'f2' });
  });

  it('gives each subject a template cover and an about from its summary', () => {
    const listing = convertAll(source).results[1]!.converted.listing;
    expect(listing).toMatchObject({ title: 'Book of Mormon Narrative', access: 'free', cover: { kind: 'template', template: 'horizon', palette: 'terracotta', title: 'Book of Mormon' } });
    expect(aboutFrom('One. Two. ' + 'x'.repeat(200))).toBe('One. Two.');
    expect(aboutFrom('y'.repeat(300)).length).toBeLessThanOrEqual(180);
  });

  it('refuses a chapter it can’t name', () => {
    const broken: Source = { ...source, chapterTitle: () => null };
    expect(convertAll(broken).errors[0]).toMatch(/No scripture chapter/);
  });
});
