// Moves Hearken's bundled study content (its Subjects and Scholar Path) into Hearth Content as
// learning-module drafts, so Hearken can stop bundling it and install it as Collections.
// docs/hearken-collections-mapping.md has the mapping; README.md how to run it.
//
//   npm run import:hearken -- <Hearken/Resources/Content>                    dry run (the default)
//   npm run import:hearken -- <dir> --apply --author=<user id>               create or update drafts
//   options: --out=<dir> (dry run, default ./out/hearken-import)  --only=<subject id,…>
//
// Reads subjects.json, path-<subject>.json, bank-<module>.json and the scripture-*.json volumes (for
// book titles in references). Every body is checked with bodySchema and every listing with
// listingSchema, and rebuilt into Hearken's own models and compared with the source files; any
// failure aborts before anything is written.
//
// --apply creates DRAFT entries in the Hearken app owned by --author (a Hearth Studio team member),
// through the content service: never submitted, never published. Re-running updates the drafts
// it made (matched by slug) and leaves unchanged ones alone. Needs DATABASE_URL (the
// .env.hearth-production one) and the learning-module type at schema 2
// (supabase/migrations/20261031110000_learning_module_v2.sql).

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { bodySchema, definitionSchema, isScriptureRef, listingSchema, runChecks, stableJson } from '../src/content/model.js';
import type { Block, Body, Listing, Section, TypeDefinition } from '../src/content/model.js';

// MARK: Hearken's files (as its Swift models decode them)

type Json = Record<string, unknown>;
export type HearkenSubject = { id: string; name: string; symbol: string; summary: string; units: HearkenUnit[]; resources: HearkenResource[] };
type HearkenUnit = { id: string; number: number; title: string; range: string; readingChapterIDs: string[] };
type HearkenResource = { id: string; kind: string; title: string; author: string; note?: string | null; url?: string | null; chapterID?: string | null };
export type HearkenQuestion = { id: string; subjectID: string; unitID: string; prompt: string; options: string[]; answer: number; reference: string; explanation: string; chapterID?: string | null };
export type SubjectCatalog = { contentVersion: number; subjects: HearkenSubject[]; questions: HearkenQuestion[] };
type Passage = { chapterID: string; from: number; to: number };
type PathResource = { title: string; url?: string | null; note?: string | null };
type PathQuiz = { questionPool: string[]; questionCount: number; passCount: number; maxTrueFalse?: number | null; maxMatching?: number | null; groups?: string[][] | null };
type PathEssay = { minWords: number; maxWords: number; revisionsBeforeCompletion: number; rubric: { id: string; title: string; full: string; partial: string; none: string }[]; prompts: { id: string; prompt: string; guide: string }[] };
type PathAssessment = { id: string; questionPool: string[]; questionCount: number; passPercent: number; quiz?: PathQuiz | null; essay?: PathEssay | null };
type PathItem = {
  id: string; kind: string; title: string; required: boolean; minutes?: number | null; body?: string | null; prompt: string;
  successCriteria?: string | null; guide?: string | null; completion?: string | null; passage?: Passage | null; source?: PathResource | null;
  video?: { provider: string; videoID: string; speaker?: string | null; transcriptURL?: string | null } | null;
  alternativeItemID?: string | null; equivalenceGroup?: string | null; sectionChecks?: { section: string; questionIDs: string[] }[] | null;
  passages?: Passage[] | null; focusQuestions?: string[] | null; quiz?: PathQuiz | null; questionID?: string | null; essay?: PathEssay | null;
};
type PathModule = { id: string; number: string; title: string; objectives: string[]; keyPoints: string[]; items: PathItem[] };
type PathCourse = { id: string; number: number; title: string; summary: string; milestone?: string | null; objectives: string[]; modules: PathModule[]; checkpoint?: PathAssessment | null; videos: PathItem[]; books: PathResource[] };
type PathStage = { number: number; title: string; outcome: string; published: boolean; courses: PathCourse[]; advancementCheck?: PathAssessment | null };
type PathQuestion = { id: string; kind: 'multipleChoice' | 'shortAnswer'; prompt: string; options?: string[] | null; answer?: number | null; guide?: string | null; explanation?: string | null; reference?: string | null };
export type PathFile = { subjectID: string; ruleVersion: number; title: string; summary: string; stages: PathStage[]; capstone?: { id: string; title: string; summary: string; requirements: string[]; rubric: string[] } | null; questions: PathQuestion[] };
type Option = { id: string; text: string };
export type BankQuestion = {
  id: string; revision: number; type: 'multiple_choice' | 'true_false' | 'matching'; prompt: string; title?: string | null; instructions?: string | null;
  options?: Option[] | null; correctOptionID?: string | null; leftItems?: Option[] | null; rightItems?: Option[] | null;
  correctPairs?: { leftID: string; rightID: string }[] | null; explanation: string; questionFamilyID: string; difficulty: string; overlapsWithQuestionIDs?: string[] | null;
};
export type BankFile = { moduleID: string; questions: BankQuestion[] };

export type Source = { catalog: SubjectCatalog; paths: Map<string, PathFile>; banks: Map<string, BankFile>; chapterTitle: (chapterId: string) => string | null };

/** Keys in Hearken's bank files its app never reads; dropped, and counted in the summary. */
const BANK_KEYS_DROPPED = ['subjectID', 'courseID', 'moduleID', 'objectiveIDs', 'sourceIDs', 'sourceLocators', 'perspective', 'eligibleAssessmentTypes', 'scoring', 'presentation'];

export function readSource(dir: string): Source {
  const read = <T>(name: string) => JSON.parse(readFileSync(join(dir, name), 'utf8')) as T;
  const files = readdirSync(dir);
  const paths = new Map<string, PathFile>();
  for (const name of files.filter((file) => /^path-.+\.json$/.test(file))) {
    const path = read<PathFile>(name);
    paths.set(path.subjectID, path);
  }
  const banks = new Map<string, BankFile>();
  for (const name of files.filter((file) => /^bank-.+\.json$/.test(file))) {
    const bank = read<BankFile>(name);
    banks.set(bank.moduleID, bank);
  }
  const titles = new Map<string, string>();
  for (const name of files.filter((file) => /^scripture-.+\.json$/.test(file))) {
    const volume = read<{ volume: { books: { title: string; chapters: { id: string; number: number }[] }[] } }>(name).volume;
    for (const book of volume.books) for (const chapter of book.chapters) titles.set(chapter.id, `${book.title} ${chapter.number}`);
  }
  return { catalog: read<SubjectCatalog>('subjects.json'), paths, banks, chapterTitle: (id) => titles.get(id) ?? null };
}

// MARK: Listings

type Look = { title: string; cover: string; template: 'orbit' | 'horizon' | 'eclipse' | 'type'; palette: 'midnight' | 'harbor' | 'pine' | 'olive' | 'terracotta' | 'tomato' | 'parchment' | 'saffron'; categories: string[]; mirror?: boolean };

/** Each subject's listing title (34 at most), cover title (22 or under), cover and categories. */
export const LOOKS: Record<string, Look> = {
  'lds-doctrine': { title: 'Latter-day Saint Doctrine', cover: 'Latter-day Saint Doctrine', template: 'orbit', palette: 'midnight', categories: ['Doctrine', 'Scholar Path'] },
  'doctrinal-mastery': { title: 'Doctrinal Mastery', cover: 'Doctrinal Mastery', template: 'type', palette: 'harbor', categories: ['Doctrine', 'Scripture'] },
  'bofm-history': { title: 'Book of Mormon Narrative', cover: 'Book of Mormon', template: 'horizon', palette: 'terracotta', categories: ['Scripture', 'History'] },
  'biblical-timeline': { title: 'Biblical Timeline', cover: 'Biblical Timeline', template: 'eclipse', palette: 'parchment', categories: ['Bible', 'History'] },
  'doctrine-and-covenants': { title: 'Doctrine and Covenants & History', cover: 'D&C and Church History', template: 'orbit', palette: 'pine', categories: ['Scripture', 'Church history'], mirror: true },
  'ancient-israel': { title: 'Ancient Israelite Theology', cover: 'Ancient Israel', template: 'horizon', palette: 'olive', categories: ['Bible', 'Theology'], mirror: true },
  'history-of-christianity': { title: 'History of Christianity', cover: 'Christian History', template: 'eclipse', palette: 'tomato', categories: ['History', 'Christianity'] },
  'world-faiths': { title: 'World Faiths', cover: 'World Faiths', template: 'orbit', palette: 'saffron', categories: ['World religions'] },
  'biblical-geography': { title: 'Biblical Geography', cover: 'Biblical Geography', template: 'horizon', palette: 'harbor', categories: ['Bible', 'Geography'] },
  'textual-scholarship': { title: 'Scriptural Texts & Transmission', cover: 'Scriptural Texts', template: 'type', palette: 'parchment', categories: ['Scripture', 'Scholarship'] },
  'early-church-fathers': { title: 'Early Christian Writers', cover: 'Early Christian Writers', template: 'eclipse', palette: 'midnight', categories: ['History', 'Christianity'], mirror: true },
};

/** The summary as an about (180 at most): whole sentences while they fit, else cut at a word. */
export function aboutFrom(summary: string, max = 180): string {
  const text = summary.trim().replace(/\s+/g, ' ');
  if (text.length <= max) return text;
  const sentences = text.match(/[^.!?]+[.!?]+(?:\s|$)/g) ?? [];
  let about = '';
  for (const sentence of sentences) {
    if ((about + sentence).trim().length > max) break;
    about += sentence;
  }
  if (about.trim()) return about.trim();
  return `${text.slice(0, max - 1).replace(/\s+\S*$/, '')}…`;
}

export function listingFor(subject: HearkenSubject): Listing {
  const look = LOOKS[subject.id] ?? { title: subject.name.slice(0, 34), cover: subject.name.slice(0, 40), template: 'orbit', palette: 'midnight', categories: [] };
  return {
    title: look.title, about: aboutFrom(subject.summary), categories: look.categories, access: 'free',
    cover: { kind: 'template', template: look.template, palette: look.palette, title: look.cover, mirror: look.mirror ?? false, italic: false },
  };
}

// MARK: Converting

const lines = (list: string[] | undefined | null) => (list ?? []).join('\n');
const LETTERS = 'abcdefgh';

function passageRef(source: Source, passage: Passage): string {
  const chapter = source.chapterTitle(passage.chapterID);
  if (!chapter) throw new Error(`No scripture chapter ${passage.chapterID}`);
  return `${chapter}:${passage.from}${passage.to !== passage.from ? `–${passage.to}` : ''}`;
}

function youtube(video: NonNullable<PathItem['video']>) {
  if (video.provider !== 'youtube') throw new Error(`Only YouTube videos convert (got ${video.provider})`);
  return `https://www.youtube.com/watch?v=${video.videoID}`;
}

function quizRule(quiz: PathQuiz) {
  return { questionPool: quiz.questionPool, questionCount: quiz.questionCount, passCount: quiz.passCount, maxTrueFalse: quiz.maxTrueFalse ?? null, maxMatching: quiz.maxMatching ?? null, groups: quiz.groups ?? null };
}

function assessment(id: string, role: 'item' | 'checkpoint' | 'advancement', check: Partial<PathAssessment>): Json {
  return {
    id, type: 'assessment', role, questionPool: check.questionPool ?? [], questionCount: check.questionCount ?? 0, passPercent: check.passPercent ?? 80,
    quiz: check.quiz ? quizRule(check.quiz) : null, essay: check.essay ?? null,
  };
}

/** A learning item: its step block, then its content. */
function itemBlocks(source: Source, item: PathItem): Json[] {
  const blocks: Json[] = [{
    id: item.id, type: 'step', kind: item.kind, title: item.title, required: item.required, minutes: item.minutes ?? null,
    prompt: item.prompt, successCriteria: item.successCriteria ?? '', guide: item.guide ?? '', completion: item.completion ?? '',
    equivalenceGroup: item.equivalenceGroup ?? '', alternativeItemId: item.alternativeItemID ?? '', questionId: item.questionID ?? '',
    passageForm: item.passages ? 'list' : 'single', focusQuestions: item.focusQuestions ?? [],
    sectionChecks: (item.sectionChecks ?? []).map((check) => ({ section: check.section, questionIds: check.questionIDs })),
  }];
  if (item.body != null) blocks.push({ id: `${item.id}.body`, type: 'text', text: item.body });
  const passages = item.passages ?? (item.passage ? [item.passage] : []);
  passages.forEach((passage, index) => blocks.push({
    id: `${item.id}.p${index + 1}`, type: 'scripture', ref: passageRef(source, passage), text: '', highlight: false,
    chapterId: passage.chapterID, from: passage.from, to: passage.to,
  }));
  if (item.source) blocks.push({ id: `${item.id}.source`, type: 'link', kind: 'source', title: item.source.title, author: '', note: item.source.note ?? '', url: item.source.url ?? '', chapterId: '' });
  if (item.video) {
    blocks.push({ id: `${item.id}.video`, type: 'video', url: youtube(item.video), title: item.video.speaker ?? '', caption: '' });
    if (item.video.transcriptURL) blocks.push({ id: `${item.id}.transcript`, type: 'link', kind: 'transcript', title: 'Transcript', author: '', note: '', url: item.video.transcriptURL, chapterId: '' });
  }
  if (item.quiz) blocks.push(assessment(`${item.id}.quiz`, 'item', { quiz: item.quiz }));
  if (item.essay) blocks.push(assessment(`${item.id}.essay`, 'item', { essay: item.essay }));
  return blocks;
}

function choiceOptions(options: string[], answer: number | null | undefined) {
  return options.map((text, index) => ({ id: LETTERS[index]!, text, correct: index === answer }));
}

function bankBlock(question: BankQuestion): Json {
  const meta = {
    family: question.questionFamilyID, difficulty: question.difficulty, revision: question.revision,
    ...(question.overlapsWithQuestionIDs ? { overlaps: question.overlapsWithQuestionIDs } : {}),
  };
  if (question.type === 'matching') {
    const right = new Map((question.rightItems ?? []).map((item) => [item.id, item.text]));
    const answer = new Map((question.correctPairs ?? []).map((pair) => [pair.leftID, pair.rightID]));
    return {
      id: question.id, type: 'match', prompt: question.prompt, title: question.title ?? '', instructions: question.instructions ?? '', explanation: question.explanation,
      pairs: (question.leftItems ?? []).map((left) => ({ id: left.id, left: left.text, right: right.get(answer.get(left.id) ?? '') ?? '', rightId: answer.get(left.id) ?? '' })),
      ...meta,
    };
  }
  return {
    id: question.id, type: 'quiz', style: question.type === 'true_false' ? 'trueFalse' : 'choice', question: question.prompt,
    options: (question.options ?? []).map((option) => ({ id: option.id, text: option.text, correct: option.id === question.correctOptionID })),
    explanation: question.explanation, hint: '', weight: 1, shuffle: true, mastery: true, ...meta,
  };
}

function pathQuestionBlock(question: PathQuestion): Json {
  return {
    id: question.id, type: 'quiz', style: question.kind === 'shortAnswer' ? 'short' : 'choice', question: question.prompt,
    options: choiceOptions(question.options ?? [], question.answer), explanation: question.explanation ?? '', hint: '', weight: 1, shuffle: true, mastery: true,
    ...(question.guide != null ? { guide: question.guide } : {}), ...(question.reference != null ? { reference: question.reference } : {}),
  };
}

const stageSectionId = (subjectId: string, number: number) => `${subjectId}-stage-${number}`;

/** Path sections: per stage, each course's modules then the course, then the stage. */
function pathSections(source: Source, path: PathFile): Json[] {
  const sections: Json[] = [];
  // Short-answer questions sit with the course or stage whose id they start with, else with the first check that uses them.
  const home = new Map<string, string>();
  for (const stage of path.stages) {
    for (const course of stage.courses) for (const id of course.checkpoint?.questionPool ?? []) if (!home.has(id)) home.set(id, course.id);
    for (const id of stage.advancementCheck?.questionPool ?? []) if (!home.has(id)) home.set(id, stageSectionId(path.subjectID, stage.number));
  }
  const sectionOf = (question: PathQuestion) => {
    for (const stage of path.stages) {
      if (question.id.startsWith(`${path.subjectID}-stage-${stage.number}-`)) return stageSectionId(path.subjectID, stage.number);
      for (const course of stage.courses) if (question.id.startsWith(`${course.id}-`)) return course.id;
    }
    return home.get(question.id) ?? stageSectionId(path.subjectID, path.stages.at(-1)?.number ?? 1);
  };
  const questionsIn = (sectionId: string) => path.questions.filter((question) => sectionOf(question) === sectionId).map(pathQuestionBlock);

  for (const stage of path.stages) {
    for (const course of stage.courses) {
      for (const module of course.modules) {
        sections.push({
          id: module.id, title: module.title,
          fields: { kind: 'module', number: module.number, objective: module.objectives[0] ?? '', objectives: lines(module.objectives), keyPoints: lines(module.keyPoints), courseId: course.id, stage: stage.number },
          blocks: [...module.items.flatMap((item) => itemBlocks(source, item)), ...(source.banks.get(module.id)?.questions ?? []).map(bankBlock)],
        });
      }
      sections.push({
        id: course.id, title: course.title,
        fields: {
          kind: 'course', courseId: course.id, courseNumber: course.number, courseTitle: course.title, courseSummary: course.summary,
          courseMilestone: course.milestone ?? '', courseObjectives: lines(course.objectives), objective: course.milestone ?? '', stage: stage.number,
        },
        blocks: [
          ...(course.checkpoint ? [assessment(course.checkpoint.id, 'checkpoint', course.checkpoint)] : []),
          ...course.books.map((book, index) => ({ id: `${course.id}.book.${index + 1}`, type: 'link', kind: 'book', title: book.title, author: '', note: book.note ?? '', url: book.url ?? '', chapterId: '' })),
          ...questionsIn(course.id),
          ...course.videos.flatMap((item) => itemBlocks(source, item)),
        ],
      });
    }
    const id = stageSectionId(path.subjectID, stage.number);
    sections.push({
      id, title: stage.title,
      fields: { kind: 'stage', stage: stage.number, stageTitle: stage.title, stageOutcome: stage.outcome, stagePublished: stage.published, objective: stage.outcome },
      blocks: [...(stage.advancementCheck ? [assessment(stage.advancementCheck.id, 'advancement', stage.advancementCheck)] : []), ...questionsIn(id)],
    });
  }
  return sections;
}

export type Converted = { slug: string; title: string; subjectId: string; body: Body; listing: Listing };

export function convertSubject(source: Source, subject: HearkenSubject, order: number): Converted {
  const path = source.paths.get(subject.id);
  const fields: Record<string, string | number | boolean | null> = {
    subject: subject.name, summary: subject.summary, subjectId: subject.id, symbol: subject.symbol, order, contentVersion: source.catalog.contentVersion,
  };
  if (path) {
    Object.assign(fields, { pathTitle: path.title, pathSummary: path.summary, ruleVersion: path.ruleVersion });
    if (path.capstone) {
      Object.assign(fields, {
        capstoneId: path.capstone.id, capstoneTitle: path.capstone.title, capstoneSummary: path.capstone.summary,
        capstoneRequirements: lines(path.capstone.requirements), capstoneRubric: lines(path.capstone.rubric),
      });
    }
  }
  const sections: Json[] = subject.units.map((unit) => ({
    id: unit.id, title: unit.title, fields: { kind: 'unit', number: String(unit.number), range: unit.range, objective: '' },
    blocks: [
      ...unit.readingChapterIDs.map((chapterId, index) => {
        const ref = source.chapterTitle(chapterId);
        if (!ref) throw new Error(`No scripture chapter ${chapterId} (unit ${unit.id})`);
        return { id: `${unit.id}.reading.${index + 1}`, type: 'scripture', ref, text: '', highlight: false, chapterId };
      }),
      ...source.catalog.questions.filter((question) => question.unitID === unit.id).map((question) => ({
        id: question.id, type: 'quiz', style: 'choice', question: question.prompt, options: choiceOptions(question.options, question.answer),
        explanation: question.explanation, hint: '', weight: 1, shuffle: true, mastery: true, reference: question.reference,
        ...(question.chapterID != null ? { chapterId: question.chapterID } : {}),
      })),
    ],
  }));
  if (path) sections.push(...pathSections(source, path));
  if (subject.resources.length) {
    sections.push({
      id: `${subject.id}.resources`, title: 'Resources', fields: { kind: 'resources', objective: '' },
      blocks: subject.resources.map((resource) => ({
        id: resource.id, type: 'link', kind: resource.kind, title: resource.title, author: resource.author,
        note: resource.note ?? '', url: resource.url ?? '', chapterId: resource.chapterID ?? '',
      })),
    });
  }
  const body = bodySchema.parse({ fields, sections });
  return { slug: subject.id, title: subject.name, subjectId: subject.id, body, listing: listingSchema.parse(listingFor(subject)) };
}

// MARK: Rebuilding (what Hearken's installer does)

/** Hearken's models from one converted body: the inverse of convertSubject. */
export function rebuild(body: Body) {
  const f = body.fields;
  const str = (value: unknown) => (typeof value === 'string' ? value : '');
  const opt = (value: unknown) => (typeof value === 'string' && value !== '' ? value : undefined);
  const list = (value: unknown) => (typeof value === 'string' && value !== '' ? value.split('\n') : []);
  const sections = body.sections ?? [];
  const kind = (section: Section) => str(section.fields.kind);
  const subjectId = str(f.subjectId);

  const subject: HearkenSubject = {
    id: subjectId, name: str(f.subject), symbol: str(f.symbol), summary: str(f.summary),
    units: sections.filter((section) => kind(section) === 'unit').map((section) => ({
      id: section.id, number: Number(section.fields.number), title: section.title, range: str(section.fields.range),
      readingChapterIDs: section.blocks.flatMap((block) => (block.type === 'scripture' && block.chapterId ? [block.chapterId] : [])),
    })),
    resources: sections.filter((section) => kind(section) === 'resources').flatMap((section) => section.blocks.flatMap((block) => (block.type === 'link' ? [{
      id: block.id, kind: block.kind, title: block.title, author: block.author,
      ...(block.note ? { note: block.note } : {}), ...(block.url ? { url: block.url } : {}), ...(block.chapterId ? { chapterID: block.chapterId } : {}),
    }] : []))),
  };
  const correct = (block: Extract<Block, { type: 'quiz' }>) => block.options.findIndex((option) => option.correct);
  const questions: HearkenQuestion[] = sections.filter((section) => kind(section) === 'unit').flatMap((section) => section.blocks.flatMap((block) => (block.type === 'quiz' ? [{
    id: block.id, subjectID: subjectId, unitID: section.id, prompt: block.question, options: block.options.map((option) => option.text),
    answer: correct(block), reference: block.reference ?? '', explanation: block.explanation, ...(block.chapterId ? { chapterID: block.chapterId } : {}),
  }] : [])));

  // Groups a section's blocks: questions, blocks before the first step, and each step with its content.
  const split = (section: Section) => {
    const questions: Block[] = [];
    const head: Block[] = [];
    const steps: { step: Extract<Block, { type: 'step' }>; content: Block[] }[] = [];
    for (const block of section.blocks) {
      if (block.type === 'quiz' || block.type === 'match') questions.push(block);
      else if (block.type === 'step') steps.push({ step: block, content: [] });
      else if (steps.length) steps.at(-1)!.content.push(block);
      else head.push(block);
    }
    return { questions, head, steps };
  };
  const quizOf = (rule: NonNullable<Extract<Block, { type: 'assessment' }>['quiz']>): PathQuiz => ({
    questionPool: rule.questionPool, questionCount: rule.questionCount, passCount: rule.passCount,
    ...(rule.maxTrueFalse != null ? { maxTrueFalse: rule.maxTrueFalse } : {}), ...(rule.maxMatching != null ? { maxMatching: rule.maxMatching } : {}),
    ...(rule.groups != null ? { groups: rule.groups } : {}),
  });
  const checkOf = (block: Extract<Block, { type: 'assessment' }>): PathAssessment => ({
    id: block.id, questionPool: block.questionPool, questionCount: block.questionCount, passPercent: block.passPercent,
    ...(block.quiz ? { quiz: quizOf(block.quiz) } : {}), ...(block.essay ? { essay: block.essay } : {}),
  });
  const itemOf = ({ step, content }: { step: Extract<Block, { type: 'step' }>; content: Block[] }): PathItem => {
    const passages = content.flatMap((block) => (block.type === 'scripture' && block.chapterId ? [{ chapterID: block.chapterId, from: block.from ?? 1, to: block.to ?? block.from ?? 1 }] : []));
    const link = (k: string) => content.find((block): block is Extract<Block, { type: 'link' }> => block.type === 'link' && block.kind === k);
    const video = content.find((block): block is Extract<Block, { type: 'video' }> => block.type === 'video');
    const assessments = content.filter((block): block is Extract<Block, { type: 'assessment' }> => block.type === 'assessment');
    const quiz = assessments.find((block) => block.quiz)?.quiz;
    const essay = assessments.find((block) => block.essay)?.essay;
    const text = content.find((block): block is Extract<Block, { type: 'text' }> => block.type === 'text');
    const source = link('source');
    const transcript = link('transcript');
    return {
      id: step.id, kind: step.kind, title: step.title, required: step.required, ...(step.minutes != null ? { minutes: step.minutes } : {}),
      ...(text ? { body: text.text } : {}), prompt: step.prompt,
      ...(opt(step.successCriteria) ? { successCriteria: step.successCriteria } : {}), ...(opt(step.guide) ? { guide: step.guide } : {}),
      ...(opt(step.completion) ? { completion: step.completion } : {}),
      ...(passages.length && step.passageForm === 'single' ? { passage: passages[0]! } : {}),
      ...(passages.length && step.passageForm === 'list' ? { passages } : {}),
      ...(source ? { source: { title: source.title, ...(source.url ? { url: source.url } : {}), ...(source.note ? { note: source.note } : {}) } } : {}),
      ...(video ? { video: {
        provider: 'youtube', videoID: new URL(video.url).searchParams.get('v') ?? '', ...(video.title ? { speaker: video.title } : {}),
        ...(transcript ? { transcriptURL: transcript.url } : {}),
      } } : {}),
      ...(opt(step.alternativeItemId) ? { alternativeItemID: step.alternativeItemId } : {}),
      ...(opt(step.equivalenceGroup) ? { equivalenceGroup: step.equivalenceGroup } : {}),
      ...(step.sectionChecks.length ? { sectionChecks: step.sectionChecks.map((check) => ({ section: check.section, questionIDs: check.questionIds })) } : {}),
      ...(step.focusQuestions.length ? { focusQuestions: step.focusQuestions } : {}),
      ...(quiz ? { quiz: quizOf(quiz) } : {}), ...(opt(step.questionId) ? { questionID: step.questionId } : {}),
      ...(essay ? { essay } : {}),
    };
  };
  const pathQuestion = (block: Block): PathQuestion | null => {
    if (block.type !== 'quiz') return null;
    const short = block.style === 'short';
    return {
      id: block.id, kind: short ? 'shortAnswer' : 'multipleChoice', prompt: block.question,
      ...(short ? {} : { options: block.options.map((option) => option.text), answer: correct(block) }),
      ...(block.guide != null ? { guide: block.guide } : {}), ...(block.explanation ? { explanation: block.explanation } : {}),
      ...(block.reference != null ? { reference: block.reference } : {}),
    };
  };
  const bankQuestion = (block: Block): BankQuestion | null => {
    if (block.type !== 'quiz' && block.type !== 'match') return null;
    const meta = { revision: block.revision ?? 1, explanation: block.explanation ?? '', questionFamilyID: block.family ?? '', difficulty: block.difficulty ?? '', ...(block.overlaps ? { overlapsWithQuestionIDs: block.overlaps } : {}) };
    if (block.type === 'match') {
      const right = [...new Map(block.pairs.map((pair) => [pair.rightId ?? '', pair.right])).entries()].map(([id, text]) => ({ id, text }));
      return {
        id: block.id, type: 'matching', prompt: block.prompt, title: block.title ?? null, instructions: block.instructions ?? null,
        leftItems: block.pairs.map((pair) => ({ id: pair.id, text: pair.left })), rightItems: right,
        correctPairs: block.pairs.map((pair) => ({ leftID: pair.id, rightID: pair.rightId ?? '' })), ...meta,
      };
    }
    const id = block.options.find((option) => option.correct)?.id ?? null;
    return { id: block.id, type: block.style === 'trueFalse' ? 'true_false' : 'multiple_choice', prompt: block.question, options: block.options.map(({ id, text }) => ({ id, text })), correctOptionID: id, ...meta };
  };

  let path: PathFile | null = null;
  const banks: BankFile[] = [];
  const stageSections = sections.filter((section) => kind(section) === 'stage');
  if (stageSections.length) {
    const courseSections = sections.filter((section) => kind(section) === 'course');
    const pathQuestions: PathQuestion[] = [];
    const stages: PathStage[] = stageSections.map((stageSection) => {
      const number = Number(stageSection.fields.stage);
      const stageParts = split(stageSection);
      pathQuestions.push(...stageParts.questions.map(pathQuestion).filter((question): question is PathQuestion => question !== null));
      const advancement = stageParts.head.find((block): block is Extract<Block, { type: 'assessment' }> => block.type === 'assessment' && block.role === 'advancement');
      return {
        number, title: str(stageSection.fields.stageTitle) || stageSection.title, outcome: str(stageSection.fields.stageOutcome), published: stageSection.fields.stagePublished === true,
        courses: courseSections.filter((courseSection) => Number(courseSection.fields.stage) === number).map((courseSection) => {
          const parts = split(courseSection);
          pathQuestions.push(...parts.questions.map(pathQuestion).filter((question): question is PathQuestion => question !== null));
          const checkpoint = parts.head.find((block): block is Extract<Block, { type: 'assessment' }> => block.type === 'assessment' && block.role === 'checkpoint');
          return {
            id: courseSection.id, number: Number(courseSection.fields.courseNumber), title: str(courseSection.fields.courseTitle) || courseSection.title,
            summary: str(courseSection.fields.courseSummary), ...(opt(courseSection.fields.courseMilestone) ? { milestone: str(courseSection.fields.courseMilestone) } : {}),
            objectives: list(courseSection.fields.courseObjectives),
            modules: sections.filter((section) => kind(section) === 'module' && section.fields.courseId === courseSection.id).map((moduleSection) => {
              const moduleParts = split(moduleSection);
              const bank = moduleParts.questions.map(bankQuestion).filter((question): question is BankQuestion => question !== null);
              if (bank.length) banks.push({ moduleID: moduleSection.id, questions: bank });
              return {
                id: moduleSection.id, number: str(moduleSection.fields.number), title: moduleSection.title,
                objectives: list(moduleSection.fields.objectives), keyPoints: list(moduleSection.fields.keyPoints), items: moduleParts.steps.map(itemOf),
              };
            }),
            ...(checkpoint ? { checkpoint: checkOf(checkpoint) } : {}),
            videos: parts.steps.map(itemOf),
            books: parts.head.flatMap((block) => (block.type === 'link' && block.kind === 'book' ? [{ title: block.title, ...(block.url ? { url: block.url } : {}), ...(block.note ? { note: block.note } : {}) }] : [])),
          };
        }),
        ...(advancement ? { advancementCheck: checkOf(advancement) } : {}),
      };
    });
    path = {
      subjectID: subjectId, ruleVersion: Number(f.ruleVersion ?? 1), title: str(f.pathTitle), summary: str(f.pathSummary), stages,
      ...(opt(f.capstoneId) ? { capstone: { id: str(f.capstoneId), title: str(f.capstoneTitle), summary: str(f.capstoneSummary), requirements: list(f.capstoneRequirements), rubric: list(f.capstoneRubric) } } : {}),
      questions: pathQuestions,
    };
  }
  return { subject, questions, path, banks, order: Number(f.order ?? 0), contentVersion: Number(f.contentVersion ?? 0) };
}

// MARK: Comparing with the source

/** Only what Hearken's Swift models decode, with absent, null and empty optional values alike. */
function decoded(value: unknown, keys?: string[]): unknown {
  if (Array.isArray(value)) return value.map((entry) => decoded(entry));
  if (value && typeof value === 'object') {
    const out: Json = {};
    for (const [key, entry] of Object.entries(value as Json)) {
      if (keys && !keys.includes(key)) continue;
      if (entry === null || entry === undefined || entry === '') continue;
      out[key] = decoded(entry);
    }
    return out;
  }
  return value;
}
const BANK_DECODED = ['id', 'revision', 'type', 'prompt', 'title', 'instructions', 'options', 'correctOptionID', 'leftItems', 'rightItems', 'correctPairs', 'explanation', 'questionFamilyID', 'difficulty', 'overlapsWithQuestionIDs'];
const byId = <T extends { id: string }>(list: T[]) => [...list].sort((a, b) => a.id.localeCompare(b.id));
/** Matching right items: Hearken shuffles them, so their order isn't compared. */
const bankForCompare = (question: BankQuestion) => decoded({ ...question, ...(question.rightItems ? { rightItems: byId(question.rightItems) } : {}) }, BANK_DECODED);

/** Differences between the source and what the body rebuilds into (empty: an exact round trip). */
export function compare(source: Source, subject: HearkenSubject, converted: Converted): string[] {
  const rebuilt = rebuild(converted.body);
  const problems: string[] = [];
  const check = (what: string, a: unknown, b: unknown) => { if (stableJson(a) !== stableJson(b)) problems.push(what); };
  check('subject', decoded(subject), decoded(rebuilt.subject));
  check('questions', decoded(byId(source.catalog.questions.filter((question) => question.subjectID === subject.id))), decoded(byId(rebuilt.questions)));
  const path = source.paths.get(subject.id);
  if (path || rebuilt.path) {
    const strip = (file: PathFile | null) => file && decoded({ ...file, questions: byId(file.questions) }, ['subjectID', 'ruleVersion', 'title', 'summary', 'stages', 'capstone', 'questions']);
    if (path && rebuilt.path) {
      for (const [index, stage] of path.stages.entries()) check(`stage ${stage.number}`, decoded(stage), decoded(rebuilt.path.stages[index]));
      check('path questions', decoded(byId(path.questions)), decoded(byId(rebuilt.path.questions)));
    }
    check('path', strip(path ?? null), strip(rebuilt.path));
    const moduleIds = new Set(path?.stages.flatMap((stage) => stage.courses.flatMap((course) => course.modules.map((module) => module.id))) ?? []);
    for (const moduleId of moduleIds) {
      const original = source.banks.get(moduleId);
      const back = rebuilt.banks.find((bank) => bank.moduleID === moduleId);
      check(`bank ${moduleId}`, original?.questions.map(bankForCompare) ?? [], back?.questions.map(bankForCompare) ?? []);
    }
  }
  return problems;
}

// MARK: Summary

export type Summary = {
  slug: string; lessons: number; units: number; modules: number; courses: number; stages: number; resources: number;
  quizzes: number; shortAnswers: number; matches: number; scripture: number; links: number; steps: number; assessments: number;
  dropped: string[]; checks: string[]; roundTrip: string[];
};

export function summarize(source: Source, subject: HearkenSubject, converted: Converted, definition: TypeDefinition): Summary {
  const sections = converted.body.sections ?? [];
  const blocks = sections.flatMap((section) => section.blocks);
  const count = (type: string) => blocks.filter((block) => block.type === type).length;
  const kinds = (k: string) => sections.filter((section) => section.fields.kind === k).length;
  const dropped: string[] = [];
  const path = source.paths.get(subject.id);
  const moduleIds = new Set(path?.stages.flatMap((stage) => stage.courses.flatMap((course) => course.modules.map((module) => module.id))) ?? []);
  const bankQuestions = [...moduleIds].flatMap((id) => source.banks.get(id)?.questions ?? []) as unknown as Json[];
  for (const key of BANK_KEYS_DROPPED) {
    const n = bankQuestions.filter((question) => question[key] !== undefined).length;
    if (n) dropped.push(`bank ${key} on ${n} questions (Hearken doesn't read it)`);
  }
  const matching = bankQuestions.filter((question) => question.type === 'matching').length;
  if (matching) dropped.push(`display order of the right-hand items on ${matching} matching sets (Hearken shuffles them)`);
  const empty = sections.filter((section) => section.blocks.length === 0).map((section) => section.id);
  const checks = runChecks({ appKey: 'hearken', definition, body: converted.body, media: new Map(), approvals: [], listing: converted.listing })
    .filter((check) => check.state !== 'pass').map((check) => `${check.state}: ${check.label}${check.detail ? ` (${check.detail})` : ''}`);
  if (empty.length) checks.push(`note: ${empty.length} section(s) have no content in Hearken either: ${empty.join(', ')}`);
  return {
    slug: converted.slug, lessons: sections.length, units: kinds('unit'), modules: kinds('module'), courses: kinds('course'), stages: kinds('stage'), resources: kinds('resources') ? sections.find((section) => section.fields.kind === 'resources')!.blocks.length : 0,
    quizzes: blocks.filter((block) => block.type === 'quiz' && block.style !== 'short').length, shortAnswers: blocks.filter((block) => block.type === 'quiz' && block.style === 'short').length,
    matches: count('match'), scripture: count('scripture'), links: count('link'), steps: count('step'), assessments: count('assessment'),
    dropped, checks, roundTrip: compare(source, subject, converted),
  };
}

/** The learning-module type at schema 2, as the migration sets it (for the checks in a dry run). */
export const LEARNING_MODULE_V2: TypeDefinition = definitionSchema.parse({
  fields: [{ key: 'subject', label: 'Subject', type: 'text', required: true }],
  sections: { label: 'Lesson', fields: [] },
  blocks: ['text', 'scripture', 'callout', 'quiz', 'match', 'timeline', 'image', 'video', 'link', 'step', 'assessment'],
  reviewSteps: [],
  listing: { downloadable: true, unit: { one: 'lesson', many: 'lessons' }, countFrom: 'sections' },
});

/** Every converted subject, checked: valid body and listing, unique block ids, references, exact round trip. */
export function convertAll(source: Source, only?: Set<string>) {
  const results: { converted: Converted; summary: Summary }[] = [];
  const errors: string[] = [];
  for (const [index, subject] of source.catalog.subjects.entries()) {
    if (only && !only.has(subject.id)) continue;
    let converted: Converted;
    try {
      converted = convertSubject(source, subject, index);
    } catch (error) {
      errors.push(`${subject.id}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const body = bodySchema.safeParse(converted.body);
    if (!body.success) errors.push(`${subject.id}: invalid body: ${body.error.issues.slice(0, 3).map((issue) => `${issue.path.join('.')} ${issue.message}`).join('; ')}`);
    const listing = listingSchema.safeParse(converted.listing);
    if (!listing.success) errors.push(`${subject.id}: invalid listing: ${listing.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join('; ')}`);
    const ids = (converted.body.sections ?? []).flatMap((section) => [section.id, ...section.blocks.map((block) => block.id)]);
    const twice = ids.filter((id, at) => ids.indexOf(id) !== at);
    if (twice.length) errors.push(`${subject.id}: ids used twice: ${[...new Set(twice)].slice(0, 5).join(', ')}`);
    const badRefs = (converted.body.sections ?? []).flatMap((section) => section.blocks).filter((block) => block.type === 'scripture' && !isScriptureRef(block.ref));
    if (badRefs.length) errors.push(`${subject.id}: scripture references Hearth Content won't accept: ${badRefs.map((block) => block.type === 'scripture' ? block.ref : '').join(', ')}`);
    const summary = summarize(source, subject, converted, LEARNING_MODULE_V2);
    if (summary.roundTrip.length) errors.push(`${subject.id}: doesn't rebuild exactly: ${summary.roundTrip.join(', ')}`);
    if (summary.checks.some((check) => check.startsWith('fail: Steps and assessments'))) errors.push(`${subject.id}: ${summary.checks.find((check) => check.startsWith('fail: Steps'))}`);
    results.push({ converted, summary });
  }
  return { results, errors };
}

// MARK: Applying

async function apply(results: { converted: Converted }[], author: string) {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) throw new Error('DATABASE_URL is required for --apply (run through npm run import:hearken, which loads .env.hearth-production)');
  const { createDatabase } = await import('../src/hearken/db.js');
  const { createContentService } = await import('../src/content/service.js');
  const sql = createDatabase(url);
  try {
    const service = createContentService(sql);
    const teamId = await service.teamId();
    const [member] = await sql`select 1 from studio_members where team_id = ${teamId} and user_id = ${author}`;
    if (!member) throw new Error(`${author} isn't a member of the Hearth Software team`);
    const type = (await service.types(teamId)).find((candidate) => candidate.slug === 'learning-module' && candidate.app === 'hearken');
    if (!type) throw new Error('No learning-module type for hearken');
    if (type.schemaVersion < 2 || !type.definition.blocks.includes('step')) throw new Error('The learning-module type is still schema 1: run supabase/migrations/20261031110000_learning_module_v2.sql first');
    const existing = new Map((await service.entries(teamId, { app: 'hearken', typeId: type.id })).map((entry) => [entry.slug, entry]));
    for (const { converted } of results) {
      const found = existing.get(converted.slug);
      let detail = found ? await service.entry(teamId, found.id) : await service.createEntry(teamId, author, { app: 'hearken', typeId: type.id, title: converted.title, slug: converted.slug });
      const sameBody = found && stableJson(detail.version.body) === stableJson(converted.body) && detail.entry.title === converted.title;
      if (!sameBody) detail = await service.saveDraft(teamId, author, detail.entry.id, { title: converted.title, body: converted.body, revision: detail.version.revision });
      const sameListing = stableJson(detail.version.listing) === stableJson(converted.listing);
      if (!sameListing) await service.saveListing(teamId, author, detail.entry.id, { revision: detail.version.revision, listing: converted.listing });
      const what = !found ? 'created' : sameBody && sameListing ? 'unchanged' : 'updated';
      console.log(`${converted.slug.padEnd(26)} ${what.padEnd(9)} ${detail.entry.id}${found && found.state !== 'draft' && what === 'updated' ? ` (was ${found.state}; now a draft)` : ''}`);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

// MARK: Main

function printSummary(results: { summary: Summary }[]) {
  for (const { summary: s } of results) {
    const shape = [s.units && `${s.units} units`, s.modules && `${s.modules} modules`, s.courses && `${s.courses} courses`, s.stages && `${s.stages} stages`, s.resources && `${s.resources} resources`].filter(Boolean).join(', ');
    console.log(`\n${s.slug}: ${s.lessons} lessons (${shape})`);
    console.log(`  quizzes ${s.quizzes}, short answers ${s.shortAnswers}, matching ${s.matches}, scripture ${s.scripture}, links ${s.links}, steps ${s.steps}, assessments ${s.assessments}`);
    console.log(`  round trip: ${s.roundTrip.length ? s.roundTrip.join(', ') : 'exact'}`);
    for (const line of s.dropped) console.log(`  dropped: ${line}`);
    for (const line of s.checks) console.log(`  ${line}`);
  }
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      apply: { type: 'boolean', default: false }, 'dry-run': { type: 'boolean', default: false },
      author: { type: 'string' }, out: { type: 'string' }, only: { type: 'string' }, help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help || positionals.length !== 1) {
    console.log('Usage: npm run import:hearken -- <Hearken/Resources/Content> [--dry-run | --apply --author=<user id>] [--out=<dir>] [--only=<subject id,…>]');
    process.exit(values.help ? 0 : 1);
  }
  if (values.apply && values['dry-run']) throw new Error('Use --dry-run or --apply, not both');
  if (values.apply && !values.author) throw new Error('--apply needs --author=<user id>');
  if (values.author && !/^[0-9a-f-]{36}$/i.test(values.author)) throw new Error('--author must be a user id (uuid)');

  const source = readSource(resolve(positionals[0]!));
  const only = values.only ? new Set(values.only.split(',').map((id) => id.trim())) : undefined;
  const { results, errors } = convertAll(source, only);
  printSummary(results);
  if (errors.length) {
    console.error(`\nNothing written: ${errors.length} problem${errors.length === 1 ? '' : 's'}`);
    for (const error of errors) console.error(`  ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`\n${results.length} subjects converted; every body and listing is valid and rebuilds exactly.`);

  if (values.apply) {
    await apply(results, values.author!);
    console.log('Done: drafts only (nothing submitted or published).');
    return;
  }
  const out = resolve(values.out ?? 'out/hearken-import');
  mkdirSync(out, { recursive: true });
  for (const { converted } of results) {
    writeFileSync(join(out, `${converted.slug}.json`), `${JSON.stringify({ slug: converted.slug, title: converted.title, app: 'hearken', type: 'learning-module', body: converted.body, listing: converted.listing }, null, 2)}\n`);
  }
  console.log(`Dry run: wrote ${results.length} files to ${out}. Nothing changed in the database.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(`import-hearken-subjects: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
