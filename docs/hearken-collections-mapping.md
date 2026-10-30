# Hearken's study content as learning modules

Hearken stops bundling its Subjects and Scholar Path. Each subject becomes one learning-module
Collection in Hearth Content (app `hearken`, type `learning-module`, schema 2), made by
`scripts/import-hearken-subjects.ts`. Hearken's installer (HearthKit `HearthCollectionInstaller`)
rebuilds its own models from the bundle with the **same ids**, so progress, mastery, notes, reviews,
XP awards, completions, attempts and rank grants carry over untouched.

The importer proves the round trip: it rebuilds Hearken's models from every body (`rebuild()` in
the script, the reference for the installer) and compares them with the source files, field by
field as Hearken's Swift `Decodable` models read them. Every subject rebuilds exactly today; any
difference aborts the import.

## What I chose, and why

**New fields on the type (a schema 2 migration) plus three new blocks and optional keys on three
existing ones.** Not text smuggling: nothing is encoded into a text block or a field as JSON.

- Subject and path metadata (id, SF Symbol, order, Scholar Path title/summary/rule version,
  capstone) are plain item fields; unit/module/course/stage metadata are lesson fields. Fields are
  the right home: the editor shows them, and the type already has fields for this.
- Readings, questions and resources needed data the core blocks didn't hold (a chapter id, verse
  range, a question's reference, bank metadata, short-answer guides, matching right-item ids).
  Those are **optional keys** on `scripture`, `quiz` and `match`, so every saved body parses and
  bundles byte for byte as before (a test checks the hash).
- The Scholar Path's learning items and checks have no counterpart in the block library, so it
  gains `link`, `step` and `assessment` (`src/content/hearken-blocks.ts`). `step` and `assessment`
  are Hearken-only (like `scripture` and `timeline`).
- Block ids now allow `.` and up to 80 characters (were `[A-Za-z0-9_-]{1,40}`), so Hearken's ids
  (`bofm.u1`, `q.bofm.0001`, `lds-doctrine-c01-m01-bank-q001`) are the block ids themselves. That
  is the whole id-preservation story: **every Hearken id is a section id or a block id**, never
  derived. Widening a regex keeps every existing id valid.
- The scripture reference check now accepts an em dash in a book name (`Joseph Smith—History 1`).
- A new check, `references`, fails when a step or assessment names a question or step that isn't
  in the body.

Rejected: one JSON blob in a longtext field (unreviewable, no checks, breaks the editor and diff);
splitting the Scholar Path into its own entry or type (Hearken's subject card needs the subject
and its path together, and XP keys tie them by subject id); a separate `hearken-path` type (more
moving parts for no gain).

## The type, schema 2 (`20261031110000_learning_module_v2.sql`)

Item fields (existing: `subject` required, `summary`):
`subjectId`, `symbol`, `order`, `contentVersion`, `pathTitle`, `pathSummary`, `ruleVersion`,
`capstoneId`, `capstoneTitle`, `capstoneSummary`, `capstoneRequirements`, `capstoneRubric`.

Lesson fields (existing: `objective`): `kind` (`unit` | `module` | `course` | `stage` |
`resources`), `number`, `range`, `objectives`, `keyPoints`, `courseId`, `courseNumber`,
`courseTitle`, `courseSummary`, `courseMilestone`, `courseObjectives`, `stage`, `stageTitle`,
`stageOutcome`, `stagePublished`. List fields hold one entry per line (no entry contains a newline).

Blocks: the existing eight plus `link`, `step`, `assessment`. Review steps and listing settings are
unchanged.

## Subjects (`subjects.json`)

| Hearken | Learning module |
| --- | --- |
| `Subject.id` | `fields.subjectId`; also the entry **slug** (all ids are slug-safe) |
| `name` | `fields.subject` and the entry title |
| `symbol` | `fields.symbol` |
| `summary` | `fields.summary`; the listing's `about` is cut from it (whole sentences, ≤ 180) |
| position in `subjects` | `fields.order` (0-based) |
| `SubjectCatalog.contentVersion` | `fields.contentVersion` |
| `StudyUnit` | a section, `id` = unit id, `title`, `fields.kind = "unit"`, `fields.number` (as text), `fields.range` |
| `readingChapterIDs[i]` | a `scripture` block `"<unitID>.reading.<i+1>"`: `chapterId`, `ref` = "Alma 32" (whole chapter, no verses), `text` empty |
| `Question` (by `unitID`) | a `quiz` block in its unit's section, `id` = question id, `question` = prompt, options `a`–`d` with `correct` on `answer`, `explanation`, `reference`, `chapterId` |
| `Resource` | a `link` block (id = resource id) in a last section `"<subjectID>.resources"` (`kind = "resources"`): `kind`, `title`, `author`, `note`, `url`, `chapterId` |

`Question.subjectID` is the subject; `unitID` is the section the quiz sits in.

## The Scholar Path (`path-<subject>.json`, `bank-<module>.json`)

After the units (lds-doctrine has none), sections go stage by stage: each course's **modules**,
then the **course**, then the **stage**.

| Hearken | Learning module |
| --- | --- |
| `ScholarPathFile.title`, `summary`, `ruleVersion` | `fields.pathTitle`, `pathSummary`, `ruleVersion` |
| `capstone` | `fields.capstoneId`, `capstoneTitle`, `capstoneSummary`, `capstoneRequirements` / `capstoneRubric` (lines) |
| `PathModule` | section, `id` = module id, `title`, `fields.kind = "module"`, `number` ("1.1"), `objectives`, `keyPoints` (lines), `objective` (first objective), `courseId`, `stage` |
| `PathItem` | a `step` block (id = item id), followed by its content blocks (below) |
| `bank-<moduleID>.json` questions | blocks at the end of the module's section: `quiz` (multiple choice: `style: "choice"`; true/false: `style: "trueFalse"`) or `match` (matching) |
| `PathCourse` | section, `id` = course id, `kind = "course"`, `courseNumber`, `courseTitle`, `courseSummary`, `courseMilestone`, `courseObjectives`, `stage` |
| `checkpoint` | first block of the course section: `assessment`, `role: "checkpoint"`, id = checkpoint id |
| `books[i]` | `link` blocks `"<courseID>.book.<i+1>"`, `kind: "book"` |
| `videos` (course videos) | `step` blocks (+ content) after the books and questions in the course section |
| `PathStage` | section `"<subjectID>-stage-<n>"`, `kind = "stage"`, `stage`, `stageTitle`, `stageOutcome`, `stagePublished` |
| `advancementCheck` | first block of the stage section: `assessment`, `role: "advancement"` |
| `PathQuestion` (short answer / multiple choice) | `quiz` blocks in the course section whose id prefixes theirs (`lds-doctrine-c01-q01` → `lds-doctrine-c01`), or the stage's (`lds-doctrine-stage-1-…`); `style: "short"` with `guide`, `reference`, `explanation`, no options |

### A step and its content

A `step` holds the item's scalars: `kind` (lesson, reading, video, practice, article, quiz,
essay), `title`, `required`, `minutes`, `prompt`, `successCriteria`, `guide`, `completion`,
`equivalenceGroup`, `alternativeItemId`, `questionId` (a practice's matching set),
`focusQuestions`, `sectionChecks` (`[{ section, questionIds }]`) and `passageForm`
(`single` → `passage`, `list` → `passages`). Its content is the blocks after it up to the next
step or the section's questions, in this order:

| `PathItem` field | Block |
| --- | --- |
| `body` (Markdown) | `text` `"<itemID>.body"` (the Markdown as is; `## ` headings are what `sectionChecks.section` names) |
| `passage` / `passages[i]` | `scripture` `"<itemID>.p<i+1>"`: `chapterId`, `from`, `to`, `ref` = "Articles of Faith 1:1–13" |
| `source` | `link` `"<itemID>.source"`, `kind: "source"` (title, url, note) |
| `video` | `video` `"<itemID>.video"` (`url` = `https://www.youtube.com/watch?v=<videoID>`, `title` = speaker); `transcriptURL` → `link` `"<itemID>.transcript"`, `kind: "transcript"` |
| `quiz` | `assessment` `"<itemID>.quiz"`, `role: "item"`, `quiz` |
| `essay` | `assessment` `"<itemID>.essay"`, `role: "item"`, `essay` |

An assessment's `quiz` is `PathQuiz` (`questionPool`, `questionCount`, `passCount`,
`maxTrueFalse`, `maxMatching`, `groups`); `essay` is `PathEssay` unchanged (rubric ids and prompt
ids kept). Checkpoint/exam assessments also carry v1's `questionPool`, `questionCount`,
`passPercent`.

### Bank questions

| `BankQuestion` | `quiz` / `match` block |
| --- | --- |
| `id`, `revision`, `questionFamilyID`, `difficulty`, `overlapsWithQuestionIDs` | `id`, `revision`, `family`, `difficulty`, `overlaps` |
| `prompt`, `explanation` | `question` (quiz) or `prompt` (match), `explanation` |
| `options[]` + `correctOptionID` | `options[]` with the same option ids (`o1`…), `correct` on the right one |
| matching `title`, `instructions` | `title`, `instructions` |
| `leftItems` + `rightItems` + `correctPairs` | `pairs[]` in left order: `id` = left id, `left`, `right` = its right item's text, `rightId` = its right item's id (Hearken's matching sets are 1:1) |

## What round-trips, and what doesn't

Exact: every field Hearken's Swift models decode, for all 11 subjects, 60 units, 155 resources,
44 questions, the path's 4 stages, 8 courses, 36 modules, 241 items, 47 checks, 100 short-answer
questions, 209 bank questions and the capstone.

Not kept (Hearken never reads them):
- Bank keys `subjectID`, `courseID`, `moduleID` (implied by the section), `objectiveIDs`,
  `sourceIDs`, `sourceLocators`, `perspective`, `eligibleAssessmentTypes`, `scoring`,
  `presentation`.
- The display order of a matching set's right-hand items (Hearken shuffles both lists).
- Absent vs `null` vs `""` for optional strings (Hearken's models treat them alike); `prompt` on
  an item is always present (`""` when there was none).
- Scripture verse text: blocks hold the reference and chapter id; Hearken still ships the
  standard works (scripture-*.json) and reads verses from them. Unit readings are whole chapters.
- Not part of this move: `scripture-*.json`, `chapter-words.json` and the reader stay bundled.

## Publishing notes

The importer only makes drafts. Before publishing, Hearth Content's checks will flag:
`history-of-christianity` (4 units) and `world-faiths` (5 units) have units with no readings or
questions (they're empty in Hearken too) and fail "Every lesson has a title and content";
`ancient-israel` and `history-of-christianity` have abouts under 60 characters (warnings). Review
steps (Doctrine review, Copy edit) still apply.

## Hearken's installer: rebuilding the models

Input: the bundle's `body` (`fields`, `sections`). Treat a missing optional key as absent. Sections
are typed by `fields.kind`; keep section and block order.

**Subject** (one per bundle): `id` = `fields.subjectId`; `name` = `fields.subject`;
`symbol` = `fields.symbol`; `summary` = `fields.summary`; sort subjects by `fields.order`;
`units` = sections with `kind == "unit"`; `resources` = the `link` blocks of the `kind ==
"resources"` section (none: `[]`). Subjects without a `kind == "stage"` section have no Scholar
Path (Coming Soon, as today).

**StudyUnit** (`kind == "unit"`): `id` = section id; `number` = `Int(fields.number)`;
`title` = section title; `range` = `fields.range`; `readingChapterIDs` = `chapterId` of its
`scripture` blocks, in order.

**Question** (each `quiz` block in a unit section): `id` = block id; `subjectID` = subject id;
`unitID` = section id; `prompt` = `question`; `options` = option texts in order; `answer` = index
of the option with `correct == true`; `reference`; `explanation`; `chapterID` = `chapterId` (absent
→ nil).

**Resource** (`link` in the resources section): `id`, `kind` (Resource.Kind raw value),
`title`, `author`; `note`, `url`, `chapterID` = `note`, `url`, `chapterId`, `""` → nil.

**ScholarPathFile**: `subjectID` = subject id; `ruleVersion` = `fields.ruleVersion`;
`title` = `fields.pathTitle`; `summary` = `fields.pathSummary`;
`stages` = `kind == "stage"` sections in order; `capstone` = when `fields.capstoneId` is set:
`id`, `title`, `summary` from `capstoneId/Title/Summary`, `requirements` / `rubric` = those fields
split on `\n`; `questions` = every `quiz` block in course and stage sections (below).

**PathStage** (`kind == "stage"`): `number` = `fields.stage`; `title` = `fields.stageTitle`;
`outcome` = `fields.stageOutcome`; `published` = `fields.stagePublished`; `courses` = course
sections whose `fields.stage` equals it, in order; `advancementCheck` = its `assessment` with
`role == "advancement"`.

**PathCourse** (`kind == "course"`): `id` = section id; `number` = `fields.courseNumber`;
`title` = `fields.courseTitle`; `summary` = `fields.courseSummary`; `milestone` =
`fields.courseMilestone` (`""` → nil); `objectives` = `fields.courseObjectives` split on `\n`
(`""` → `[]`); `modules` = module sections whose `fields.courseId` is this id, in order;
`checkpoint` = its `assessment` with `role == "checkpoint"`; `books` = its `link` blocks with
`kind == "book"` (`title`, `url`, `note`; `""` → nil); `videos` = the steps in its section.

**PathModule** (`kind == "module"`): `id` = section id; `number` = `fields.number`;
`title` = section title; `objectives`, `keyPoints` = those fields split on `\n` (`""` → `[]`);
`items` = its steps.

**Grouping a section**: walk the blocks; `quiz` and `match` are questions; a `step` starts an item;
any other block belongs to the latest step (before any step: the section's own blocks, i.e. the
checkpoint/advancement assessment and the books).

**PathItem** (a `step` and its content): `id`, `kind`, `title`, `required`, `minutes` (null → nil),
`prompt` (always a string); `successCriteria`, `guide`, `completion`, `equivalenceGroup`,
`alternativeItemID` (= `alternativeItemId`), `questionID` (= `questionId`): `""` → nil;
`body` = its `text` block's `text`; passages = its `scripture` blocks as `PathPassage(chapterID:
chapterId, from: from, to: to)`, set as `passage` (the first) when `passageForm == "single"`, else
`passages`; `source` = its `link` with `kind == "source"` (title, url, note); `video` = its `video`
block: provider `"youtube"`, `videoID` = the `v` query item of `url`, `speaker` = `title` (`""` →
nil), `transcriptURL` = the url of its `link` with `kind == "transcript"`; `sectionChecks` =
`[{section, questionIDs: questionIds}]` (empty → nil); `focusQuestions` (empty → nil); `quiz` = its
`assessment` with a `quiz`; `essay` = its `assessment` with an `essay`.

**PathQuiz** (from an assessment's `quiz`): `questionPool`, `questionCount`, `passCount`;
`maxTrueFalse`, `maxMatching`, `groups`: null → nil. **PathEssay**: the `essay` object as is.
**PathAssessment** (checkpoint / advancement): `id`, `questionPool`, `questionCount`,
`passPercent`, `quiz` (as above, null → nil), `essay`.

**PathQuestion** (each `quiz` block in a course or stage section): `id`; `kind` = `shortAnswer`
when `style == "short"`, else `multipleChoice` (then `options` = texts and `answer` = correct
index); `prompt` = `question`; `guide`; `explanation` (`""` → nil); `reference`.

**BankFile** (one per module section with questions): `moduleID` = section id; `questions` = its
`quiz` / `match` blocks. Each **BankQuestion**: `id`; `revision`; `questionFamilyID` = `family`;
`difficulty`; `overlapsWithQuestionIDs` = `overlaps`; `explanation`.
For `quiz`: `type` = `true_false` when `style == "trueFalse"`, else `multiple_choice`;
`prompt` = `question`; `options` = `[{id, text}]`; `correctOptionID` = id of the option with
`correct`. For `match`: `type` = `matching`; `prompt`; `title`; `instructions`;
`leftItems` = `[{id: pair.id, text: pair.left}]`; `rightItems` = the distinct
`[{id: pair.rightId, text: pair.right}]`; `correctPairs` = `[{leftID: pair.id, rightID: pair.rightId}]`.

Then register them where the bundled files were read: `ContentService.subjects` / `questions`
(and `questionsByID`), `PathCatalog.paths[subjectID]`, `QuestionBank.questions[id]`. Removing a
Collection removes its subject, questions, path and bank questions; keep the user's records
(they're keyed by these ids and come back when it's downloaded again).
