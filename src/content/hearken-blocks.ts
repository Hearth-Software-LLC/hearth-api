import { z } from 'zod';

/**
 * Blocks a learning module needs to carry Hearken's study content (its Subjects and Scholar
 * Paths) without loss: a link (a resource or source), a step (one learning item of a Scholar Path
 * module: what kind it is, whether it's required, what the learner writes, the checks it opens)
 * and an assessment (a quiz drawn from a pool of questions, a rubric-scored essay, a checkpoint
 * or stage exam). See docs/hearken-collections-mapping.md.
 *
 * Kept apart from model.ts so the block library's core stays small; model.ts adds these to its
 * union. Nothing here imports model.ts.
 */

/** A block, section, option or pair id. Dots are allowed so Hearken's ids ("bofm.u1", "q.bofm.0001") are used as they are. */
export const blockId = z.string().regex(/^[A-Za-z0-9_.-]{1,80}$/);
const text = (max: number) => z.string().max(max).default('');
const count = z.number().int().min(0).max(400);

export const STEP_KINDS = ['lesson', 'reading', 'video', 'practice', 'article', 'quiz', 'essay'] as const;
export const ASSESSMENT_ROLES = ['item', 'checkpoint', 'advancement'] as const;

export const linkBlockSchema = z.object({
  id: blockId, type: z.literal('link'),
  /** What it is: article, book, manual, website, reference, scripture, video, source, transcript… */
  kind: text(24), title: text(200), author: text(200), note: text(1000), url: text(500),
  /** Hearken: the chapter it opens in the reader ("bofm.alma.32"). */
  chapterId: text(120),
}).strict();

/**
 * One learning item. The blocks after it in its section, up to the next step, are its content
 * (body text, scripture passages, video, source link, its quiz or essay); questions are never part
 * of a step (they're the section's question bank, referenced by id).
 */
export const stepBlockSchema = z.object({
  id: blockId, type: z.literal('step'), kind: z.enum(STEP_KINDS), title: text(200),
  required: z.boolean().default(true), minutes: z.number().int().min(0).max(600).nullable().default(null),
  /** What the learner writes to complete it. */
  prompt: text(2000), successCriteria: text(2000),
  /** For the on-device reviewer, never shown to the learner. */
  guide: text(4000), completion: text(2000),
  /** Alternative formats that share one award. */
  equivalenceGroup: text(120),
  /** A video's reading alternative: another step's id. */
  alternativeItemId: z.union([blockId, z.literal('')]).default(''),
  /** A practice set: the match block to work. */
  questionId: z.union([blockId, z.literal('')]).default(''),
  /** Whether the passages are one assigned passage or a list read together. */
  passageForm: z.enum(['single', 'list']).default('single'),
  focusQuestions: z.array(z.string().max(500)).max(20).default([]),
  /** An article's check questions after each of its "## " sections. */
  sectionChecks: z.array(z.object({ section: z.string().max(200), questionIds: z.array(blockId).max(40) }).strict()).max(40).default([]),
}).strict();

const quizRule = z.object({
  questionPool: z.array(blockId).max(400), questionCount: count, passCount: count,
  maxTrueFalse: count.nullable().default(null), maxMatching: count.nullable().default(null),
  /** The pool split by module, so every module is covered. */
  groups: z.array(z.array(blockId).max(400)).max(40).nullable().default(null),
}).strict();

const essayRule = z.object({
  minWords: z.number().int().min(0).max(10_000), maxWords: z.number().int().min(0).max(10_000),
  revisionsBeforeCompletion: z.number().int().min(0).max(20),
  rubric: z.array(z.object({ id: blockId, title: z.string().max(120), full: z.string().max(500), partial: z.string().max(500), none: z.string().max(500) }).strict()).max(12),
  prompts: z.array(z.object({ id: blockId, prompt: z.string().max(2000), guide: z.string().max(4000) }).strict()).max(12),
}).strict();

/**
 * A check. `item`: a step's quiz or essay. `checkpoint` / `advancement`: a course checkpoint or
 * stage exam, with an older pool of short-answer questions (`questionPool`, `questionCount`,
 * `passPercent`), a sampled quiz, an essay, or both.
 */
export const assessmentBlockSchema = z.object({
  id: blockId, type: z.literal('assessment'), role: z.enum(ASSESSMENT_ROLES),
  questionPool: z.array(blockId).max(400).default([]), questionCount: count.default(0),
  passPercent: z.number().int().min(0).max(100).default(80),
  quiz: quizRule.nullable().default(null), essay: essayRule.nullable().default(null),
}).strict();

type AnyBlock = { id: string; type: string } & Record<string, unknown>;

/**
 * Ids that steps and assessments point at but no block in the body has: a question missing from
 * a pool, a section check or a practice set, or a video's alternative that isn't a step.
 */
export function unresolvedReferences(blocks: AnyBlock[]): string[] {
  const questions = new Set(blocks.filter((block) => block.type === 'quiz' || block.type === 'match').map((block) => block.id));
  const steps = new Set(blocks.filter((block) => block.type === 'step').map((block) => block.id));
  const missing = new Set<string>();
  const need = (ids: Iterable<string>, among: Set<string>) => { for (const id of ids) if (id && !among.has(id)) missing.add(id); };
  for (const block of blocks) {
    if (block.type === 'step') {
      const step = block as unknown as z.infer<typeof stepBlockSchema>;
      need([step.questionId], questions);
      need(step.sectionChecks.flatMap((check) => check.questionIds), questions);
      need([step.alternativeItemId], steps);
    } else if (block.type === 'assessment') {
      const assessment = block as unknown as z.infer<typeof assessmentBlockSchema>;
      need(assessment.questionPool, questions);
      need([...(assessment.quiz?.questionPool ?? []), ...(assessment.quiz?.groups ?? []).flat()], questions);
    }
  }
  return [...missing];
}

// MARK: Optional keys on the core blocks

/**
 * Optional, so bodies saved before them parse (and bundle) byte for byte as before.
 * Scripture: the chapter Hearken opens and the verses assigned.
 */
export const scriptureExtras = {
  chapterId: z.string().max(120).optional(),
  from: z.number().int().min(1).max(999).optional(),
  to: z.number().int().min(1).max(999).optional(),
};

const questionMeta = {
  /** Where it's from: "Alma 32:28". */
  reference: z.string().max(200).optional(),
  /** A family a quiz draws one question from. */
  family: z.string().max(120).optional(),
  difficulty: z.string().max(40).optional(),
  revision: z.number().int().min(1).max(10_000).optional(),
  /** Questions it must not appear alongside in one quiz. */
  overlaps: z.array(blockId).max(40).optional(),
};

/**
 * Quiz: `style` choice (the default), trueFalse, or short (a short answer scored against `guide`,
 * no options); the chapter it opens; and the bank metadata above.
 */
export const questionExtras = {
  style: z.enum(['choice', 'trueFalse', 'short']).optional(),
  guide: z.string().max(4000).optional(),
  chapterId: z.string().max(120).optional(),
  ...questionMeta,
};

/** Match: a title, instructions and explanation, and the bank metadata. Pairs gain `rightId`. */
export const matchExtras = {
  title: z.string().max(200).optional(),
  instructions: z.string().max(1000).optional(),
  explanation: z.string().max(2000).optional(),
  ...questionMeta,
};
