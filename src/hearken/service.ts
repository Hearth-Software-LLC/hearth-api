import { randomBytes, randomInt } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';
import { ApiError } from '../errors.js';
import type { ApnsEnvironment, ApnsSender } from '../integrations/apns.js';

/**
 * Hearken study groups: a group follows one reading plan together, sees each member's weekly
 * progress, shares highlights and reflections, discusses them in threads, and answers a weekly
 * question. Every read and write is scoped by the caller's membership; group ids from the
 * client never grant access on their own.
 */

export const LIMITS = {
  membersPerGroup: 50,
  groupsPerUser: 20,
  itemsPerPage: 50,
  commentsPerTarget: 500,
  questionsListed: 52,
  importItems: 500,
  importReactions: 2000,
} as const;

export type Role = 'owner' | 'leader' | 'member';
export type TargetType = 'item' | 'comment' | 'answer';
export type ReactionKind = 'heart' | 'insight';
export type NotifyKey = 'replies' | 'mentions' | 'allReplies' | 'question' | 'activity';
export type NotifyPrefs = Record<NotifyKey, boolean>;

export const defaultNotify: NotifyPrefs = { replies: true, mentions: true, allReplies: false, question: true, activity: true };

export type Progress = {
  weekStart: string | null;
  weekRead: number;
  weekTotal: number;
  lastDoneDay: string | null;
  chaptersRead: number;
  streak: number;
};

export type ReactionView = { kind: ReactionKind; userId: string };

export type MemberView = {
  userId: string;
  name: string;
  initials: string;
  role: Role;
  /** Still on the iCloud version: hasn't claimed a seat in this imported group yet. */
  pending: boolean;
  joinedAt: string | null;
  progress: (Progress & { updatedAt: string | null }) | null;
};

export type CommentView = {
  id: string;
  targetType: 'item' | 'answer';
  targetId: string;
  parentId: string | null;
  authorId: string;
  authorName: string;
  body: string;
  mentions: string[];
  mentionsEveryone: boolean;
  createdAt: string;
  reactions: ReactionView[];
};

export type ItemView = {
  id: string;
  kind: 'highlight' | 'reflection';
  chapterId: string;
  startVerse: number;
  endVerse: number;
  text: string;
  note: string;
  reference: string;
  authorId: string;
  authorName: string;
  createdAt: string;
  reactions: ReactionView[];
  commentCount: number;
  latestComment: CommentView | null;
};

export type AnswerView = {
  id: string;
  questionId: string;
  userId: string;
  authorName: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  reactions: ReactionView[];
  commentCount: number;
};

export type QuestionView = {
  id: string;
  text: string;
  reference: string;
  chapterId: string;
  authorId: string;
  authorName: string;
  postAt: string;
  closesAt: string;
  hideAnswers: boolean;
  isPosted: boolean;
  isClosed: boolean;
  answerCount: number;
  answeredUserIds: string[];
  /** Hidden answers stay hidden until the caller answers, or the question closes. */
  answersVisible: boolean;
  myAnswer: AnswerView | null;
  answers: AnswerView[];
};

export type GroupView = {
  id: string;
  name: string;
  symbol: string;
  planId: string;
  customPlan: Record<string, unknown> | null;
  startDate: string;
  ownerId: string;
  ownerName: string;
  role: Role;
  inviteCode: string;
  inviteURL: string;
  members: MemberView[];
  items: ItemView[];
  question: QuestionView | null;
  /** A question a leader scheduled for later. Only owners and leaders see it. */
  scheduledQuestion: QuestionView | null;
  notifications: NotifyPrefs;
  createdAt: string;
  updatedAt: string;
};

type Db = Sql | TransactionSql;

type GroupRow = {
  id: string; owner_id: string; name: string; symbol: string; plan_id: string; custom_plan: Record<string, unknown> | null;
  start_date: string; invite_code: string; migration_token: string | null; created_at: Date; updated_at: Date;
};
type MemberRow = {
  group_id: string; user_id: string; role: Role; display_name: string; initials: string; notify: Partial<NotifyPrefs>;
  joined_at: Date; week_start: string | null; week_read: number | null; week_total: number | null; last_done_day: string | null;
  chapters_read: number | null; streak: number | null; progress_updated_at: Date | null;
};
type LegacyMemberRow = { group_id: string; legacy_id: string; display_name: string; initials: string; progress: Partial<Progress> | null };
type ItemRow = {
  id: string; group_id: string; author_id: string | null; legacy_author_id: string | null; author_name: string; kind: 'highlight' | 'reflection';
  chapter_id: string; start_verse: number; end_verse: number; text: string; note: string; reference: string; created_at: Date;
};
type CommentRow = {
  id: string; group_id: string; target_type: 'item' | 'answer'; target_id: string; parent_id: string | null; author_id: string;
  author_name: string; body: string; mentions: string[]; mentions_everyone: boolean; created_at: Date;
};
type QuestionRow = {
  id: string; group_id: string; author_id: string; author_name: string; text: string; reference: string; chapter_id: string;
  post_at: Date; closes_at: Date; hide_answers: boolean; notified_at: Date | null;
};
type AnswerRow = {
  id: string; question_id: string; group_id: string; user_id: string; author_name: string; body: string; created_at: Date; updated_at: Date;
};
type ReactionRow = { target_type: TargetType; target_id: string; user_id: string | null; legacy_user_id: string | null; kind: ReactionKind };

type Alert = { title: string; subtitle?: string | undefined; body: string };
type Candidate = { pref: NotifyKey; alert: Alert; data: Record<string, string> };

export type HearkenServiceOptions = {
  sql: Sql;
  apns?: ApnsSender | undefined;
  apnsTopic: string;
  publicBaseUrl: string;
  now?: (() => Date) | undefined;
  /** Longest a request waits for its notifications to be handed to Apple. */
  pushTimeoutMs?: number | undefined;
};

const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const iso = (value: Date) => value.toISOString();
const legacyKey = (legacyId: string) => `legacy:${legacyId}`;
const snippet = (text: string, length = 120) => (text.length > length ? `${text.slice(0, length - 1).trimEnd()}…` : text);

function newInviteCode() {
  let code = '';
  for (let index = 0; index < 8; index += 1) code += INVITE_ALPHABET[randomInt(INVITE_ALPHABET.length)];
  return code;
}

function isUniqueViolation(error: unknown, constraint?: string) {
  const record = error as { code?: string | undefined; constraint_name?: string | undefined };
  return record?.code === '23505' && (!constraint || record.constraint_name === constraint);
}

function prefs(stored: Partial<NotifyPrefs> | null | undefined): NotifyPrefs {
  const result = { ...defaultNotify };
  for (const key of Object.keys(defaultNotify) as NotifyKey[]) {
    if (typeof stored?.[key] === 'boolean') result[key] = stored[key] as boolean;
  }
  return result;
}

export type CreateGroupInput = {
  clientId?: string | undefined; name: string; symbol: string; planId: string; customPlan?: Record<string, unknown> | null | undefined; startDate: string;
  displayName: string; initials: string;
};
export type ProgressInput = Progress & { displayName?: string | undefined; initials?: string | undefined };
export type ItemInput = {
  clientId?: string | undefined; kind: 'highlight' | 'reflection'; chapterId: string; startVerse: number; endVerse: number;
  text: string; note: string; reference?: string | undefined; authorName: string;
};
export type CommentInput = {
  clientId?: string | undefined; targetType: 'item' | 'answer'; targetId: string; parentId?: string | null | undefined; body: string;
  mentions?: string[] | undefined; mentionsEveryone?: boolean | undefined; authorName: string;
};
export type QuestionInput = {
  clientId?: string | undefined; text: string; reference?: string | undefined; chapterId?: string | undefined; postAt?: string | undefined; closesAt?: string | undefined;
  hideAnswers?: boolean | undefined; authorName: string;
};
export type ImportInput = {
  clientId: string; name: string; symbol: string; planId: string; customPlan?: Record<string, unknown> | null | undefined; startDate: string;
  displayName: string; initials: string; ownerLegacyId: string; progress?: Progress | undefined;
  members: { legacyId: string; displayName: string; initials: string; progress?: Progress | undefined }[];
  items: {
    legacyId: string; legacyAuthorId: string; authorName: string; kind: 'highlight' | 'reflection'; chapterId: string;
    startVerse: number; endVerse: number; text: string; note: string; reference?: string | undefined; createdAt: string;
  }[];
  reactions: { legacyItemId: string; legacyUserId: string; kind: ReactionKind }[];
};

export function createHearkenService(options: HearkenServiceOptions) {
  const { sql } = options;
  const now = options.now ?? (() => new Date());
  const pushTimeoutMs = options.pushTimeoutMs ?? 3000;
  const inviteURL = (code: string) => new URL(`/hearken/join/${code}`, options.publicBaseUrl).toString();

  // MARK: Access

  async function membership(db: Db, groupId: string, userId: string) {
    const [row] = await db<{ role: Role; display_name: string; owner_id: string; name: string }[]>`
      select m.role, m.display_name, g.owner_id, g.name
      from hk_members m join hk_groups g on g.id = m.group_id
      where m.group_id = ${groupId} and m.user_id = ${userId} and g.deleted_at is null`;
    if (!row) throw new ApiError(404, 'GROUP_NOT_FOUND', 'That group no longer exists, or you are not in it');
    return row;
  }

  const moderates = (role: Role) => role === 'owner' || role === 'leader';

  async function groupRows(db: Db, where: { userId: string; groupId?: string | undefined }) {
    if (where.groupId) {
      return db<GroupRow[]>`
        select g.id, g.owner_id, g.name, g.symbol, g.plan_id, g.custom_plan, g.start_date::text as start_date, g.invite_code,
               g.migration_token, g.created_at, g.updated_at
        from hk_groups g join hk_members m on m.group_id = g.id and m.user_id = ${where.userId}
        where g.id = ${where.groupId} and g.deleted_at is null`;
    }
    return db<GroupRow[]>`
      select g.id, g.owner_id, g.name, g.symbol, g.plan_id, g.custom_plan, g.start_date::text as start_date, g.invite_code,
             g.migration_token, g.created_at, g.updated_at
      from hk_groups g join hk_members m on m.group_id = g.id and m.user_id = ${where.userId}
      where g.deleted_at is null
      order by m.joined_at`;
  }

  // MARK: Views

  async function reactionsFor(db: Db, targetType: TargetType, ids: string[]) {
    const map = new Map<string, ReactionView[]>();
    if (ids.length === 0) return map;
    const rows = await db<ReactionRow[]>`
      select target_type, target_id, user_id, legacy_user_id, kind from hk_reactions
      where target_type = ${targetType} and target_id = any(${ids}::uuid[])
      order by created_at`;
    for (const row of rows) {
      const list = map.get(row.target_id) ?? [];
      list.push({ kind: row.kind, userId: row.user_id ?? legacyKey(row.legacy_user_id ?? '') });
      map.set(row.target_id, list);
    }
    return map;
  }

  async function commentViews(db: Db, rows: CommentRow[], names: Map<string, string>) {
    const reactions = await reactionsFor(db, 'comment', rows.map((row) => row.id));
    return rows.map((row): CommentView => ({
      id: row.id,
      targetType: row.target_type,
      targetId: row.target_id,
      parentId: row.parent_id,
      authorId: row.author_id,
      authorName: names.get(`${row.group_id}|${row.author_id}`) ?? row.author_name,
      body: row.body,
      mentions: row.mentions,
      mentionsEveryone: row.mentions_everyone,
      createdAt: iso(row.created_at),
      reactions: reactions.get(row.id) ?? [],
    }));
  }

  /** Comment count and latest comment per target, leaving out replies by people the reader blocked. */
  async function commentStats(db: Db, targetType: 'item' | 'answer', ids: string[], names: Map<string, string>, blocked: string[] = []) {
    const stats = new Map<string, { count: number; latest: CommentView | null }>();
    if (ids.length === 0) return stats;
    const counts = await db<{ target_id: string; count: number }[]>`
      select target_id, count(*)::int as count from hk_comments
      where target_type = ${targetType} and target_id = any(${ids}::uuid[]) and deleted_at is null
        and author_id <> all(${blocked}::uuid[])
      group by target_id`;
    const latest = await db<CommentRow[]>`
      select distinct on (target_id) id, group_id, target_type, target_id, parent_id, author_id, author_name, body, mentions,
             mentions_everyone, created_at
      from hk_comments
      where target_type = ${targetType} and target_id = any(${ids}::uuid[]) and deleted_at is null
        and author_id <> all(${blocked}::uuid[])
      order by target_id, created_at desc`;
    const latestViews = await commentViews(db, latest, names);
    for (const row of counts) stats.set(row.target_id, { count: row.count, latest: null });
    for (const view of latestViews) {
      const entry = stats.get(view.targetId) ?? { count: 0, latest: null };
      entry.latest = view;
      stats.set(view.targetId, entry);
    }
    return stats;
  }

  async function itemViews(db: Db, rows: ItemRow[], names: Map<string, string>, blocked: string[] = []) {
    const ids = rows.map((row) => row.id);
    const [reactions, stats] = await Promise.all([reactionsFor(db, 'item', ids), commentStats(db, 'item', ids, names, blocked)]);
    return rows.map((row): ItemView => {
      const authorId = row.author_id ?? legacyKey(row.legacy_author_id ?? '');
      return {
        id: row.id,
        kind: row.kind,
        chapterId: row.chapter_id,
        startVerse: row.start_verse,
        endVerse: row.end_verse,
        text: row.text,
        note: row.note,
        reference: row.reference,
        authorId,
        authorName: names.get(`${row.group_id}|${authorId}`) ?? row.author_name,
        createdAt: iso(row.created_at),
        reactions: reactions.get(row.id) ?? [],
        commentCount: stats.get(row.id)?.count ?? 0,
        latestComment: stats.get(row.id)?.latest ?? null,
      };
    });
  }

  async function questionViews(db: Db, me: string, rows: QuestionRow[], names: Map<string, string>, blocked: string[] = []) {
    if (rows.length === 0) return [];
    const answers = await db<AnswerRow[]>`
      select id, question_id, group_id, user_id, author_name, body, created_at, updated_at from hk_answers
      where question_id = any(${rows.map((row) => row.id)}::uuid[]) and user_id <> all(${blocked}::uuid[])
      order by created_at`;
    const answerIds = answers.map((row) => row.id);
    const [reactions, stats] = await Promise.all([
      reactionsFor(db, 'answer', answerIds), commentStats(db, 'answer', answerIds, names, blocked),
    ]);
    const at = now();
    return rows.map((row): QuestionView => {
      const own = answers.filter((answer) => answer.question_id === row.id);
      const views = own.map((answer): AnswerView => ({
        id: answer.id,
        questionId: answer.question_id,
        userId: answer.user_id,
        authorName: names.get(`${answer.group_id}|${answer.user_id}`) ?? answer.author_name,
        body: answer.body,
        createdAt: iso(answer.created_at),
        updatedAt: iso(answer.updated_at),
        reactions: reactions.get(answer.id) ?? [],
        commentCount: stats.get(answer.id)?.count ?? 0,
      }));
      const myAnswer = views.find((answer) => answer.userId === me) ?? null;
      const isClosed = row.closes_at <= at;
      const answersVisible = !row.hide_answers || myAnswer !== null || isClosed;
      return {
        id: row.id,
        text: row.text,
        reference: row.reference,
        chapterId: row.chapter_id,
        authorId: row.author_id,
        authorName: names.get(`${row.group_id}|${row.author_id}`) ?? row.author_name,
        postAt: iso(row.post_at),
        closesAt: iso(row.closes_at),
        hideAnswers: row.hide_answers,
        isPosted: row.post_at <= at,
        isClosed,
        answerCount: views.length,
        answeredUserIds: views.map((answer) => answer.userId),
        answersVisible,
        myAnswer,
        answers: answersVisible ? views : [],
      };
    });
  }

  async function memberNames(db: Db, groupIds: string[]) {
    const names = new Map<string, string>();
    if (groupIds.length === 0) return names;
    const members = await db<{ group_id: string; user_id: string; display_name: string }[]>`
      select group_id, user_id, display_name from hk_members where group_id = any(${groupIds}::uuid[])`;
    for (const row of members) names.set(`${row.group_id}|${row.user_id}`, row.display_name);
    const legacy = await db<{ group_id: string; legacy_id: string; display_name: string }[]>`
      select group_id, legacy_id, display_name from hk_legacy_members where group_id = any(${groupIds}::uuid[])`;
    for (const row of legacy) names.set(`${row.group_id}|${legacyKey(row.legacy_id)}`, row.display_name);
    return names;
  }

  /** The people the caller has blocked: their posts, replies and answers are left out of what the caller reads. */
  async function blockedBy(db: Db, me: string) {
    const rows = await db<{ blocked_id: string }[]>`select blocked_id from hk_blocks where blocker_id = ${me}`;
    return rows.map((row) => row.blocked_id);
  }

  async function buildViews(db: Db, me: string, groups: GroupRow[]): Promise<GroupView[]> {
    if (groups.length === 0) return [];
    const ids = groups.map((group) => group.id);
    const at = now();
    const blocked = await blockedBy(db, me);
    const [members, legacy, items, current, scheduled, names] = await Promise.all([
      db<MemberRow[]>`
        select m.group_id, m.user_id, m.role, m.display_name, m.initials, m.notify, m.joined_at,
               p.week_start::text as week_start, p.week_read, p.week_total, p.last_done_day::text as last_done_day,
               p.chapters_read, p.streak, p.updated_at as progress_updated_at
        from hk_members m left join hk_progress p on p.group_id = m.group_id and p.user_id = m.user_id
        where m.group_id = any(${ids}::uuid[])
        order by m.joined_at`,
      db<LegacyMemberRow[]>`
        select group_id, legacy_id, display_name, initials, progress from hk_legacy_members
        where group_id = any(${ids}::uuid[]) order by display_name`,
      db<ItemRow[]>`
        select id, group_id, author_id, legacy_author_id, author_name, kind, chapter_id, start_verse, end_verse, text, note,
               reference, created_at
        from (
          select i.*, row_number() over (partition by i.group_id order by i.created_at desc) as position
          from hk_items i where i.group_id = any(${ids}::uuid[]) and i.deleted_at is null
            and (i.author_id is null or i.author_id <> all(${blocked}::uuid[]))
        ) ranked
        where position <= ${LIMITS.itemsPerPage}
        order by created_at desc`,
      db<QuestionRow[]>`
        select distinct on (group_id) id, group_id, author_id, author_name, text, reference, chapter_id, post_at, closes_at,
               hide_answers, notified_at
        from hk_questions
        where group_id = any(${ids}::uuid[]) and deleted_at is null and post_at <= ${at}
        order by group_id, post_at desc`,
      db<QuestionRow[]>`
        select distinct on (group_id) id, group_id, author_id, author_name, text, reference, chapter_id, post_at, closes_at,
               hide_answers, notified_at
        from hk_questions
        where group_id = any(${ids}::uuid[]) and deleted_at is null and post_at > ${at}
        order by group_id, post_at`,
      memberNames(db, ids),
    ]);
    const [itemList, currentViews, scheduledViews] = await Promise.all([
      itemViews(db, items, names, blocked),
      questionViews(db, me, current, names, blocked),
      questionViews(db, me, scheduled, names, blocked),
    ]);

    // A question that reached its post time between cron runs: whoever looks first sends its notification.
    const unannounced = current.filter((row) => row.notified_at === null).map((row) => row.id);
    if (unannounced.length > 0) await withTimeout(announceQuestions(unannounced));

    return groups.map((group): GroupView => {
      const own = members.filter((member) => member.group_id === group.id);
      const mine = own.find((member) => member.user_id === me);
      const role = mine?.role ?? 'member';
      const memberViews: MemberView[] = own.map((member) => ({
        userId: member.user_id,
        name: member.display_name,
        initials: member.initials,
        role: member.role,
        pending: false,
        joinedAt: iso(member.joined_at),
        progress: member.progress_updated_at === null ? null : {
          weekStart: member.week_start,
          weekRead: member.week_read ?? 0,
          weekTotal: member.week_total ?? 0,
          lastDoneDay: member.last_done_day,
          chaptersRead: member.chapters_read ?? 0,
          streak: member.streak ?? 0,
          updatedAt: iso(member.progress_updated_at),
        },
      }));
      for (const row of legacy.filter((entry) => entry.group_id === group.id)) {
        memberViews.push({
          userId: legacyKey(row.legacy_id),
          name: row.display_name,
          initials: row.initials,
          role: 'member',
          pending: true,
          joinedAt: null,
          progress: row.progress ? {
            weekStart: row.progress.weekStart ?? null,
            weekRead: row.progress.weekRead ?? 0,
            weekTotal: row.progress.weekTotal ?? 0,
            lastDoneDay: row.progress.lastDoneDay ?? null,
            chaptersRead: row.progress.chaptersRead ?? 0,
            streak: row.progress.streak ?? 0,
            updatedAt: null,
          } : null,
        });
      }
      const owner = own.find((member) => member.user_id === group.owner_id);
      const questionIndex = current.findIndex((row) => row.group_id === group.id);
      const scheduledIndex = scheduled.findIndex((row) => row.group_id === group.id);
      return {
        id: group.id,
        name: group.name,
        symbol: group.symbol,
        planId: group.plan_id,
        customPlan: group.custom_plan,
        startDate: group.start_date,
        ownerId: group.owner_id,
        ownerName: owner?.display_name ?? '',
        role,
        inviteCode: group.invite_code,
        inviteURL: inviteURL(group.invite_code),
        members: memberViews,
        items: itemList.filter((_, index) => items[index]!.group_id === group.id),
        question: questionIndex >= 0 ? currentViews[questionIndex]! : null,
        scheduledQuestion: scheduledIndex >= 0 && moderates(role) ? scheduledViews[scheduledIndex]! : null,
        notifications: prefs(mine?.notify),
        createdAt: iso(group.created_at),
        updatedAt: iso(group.updated_at),
      };
    });
  }

  async function view(db: Db, me: string, groupId: string) {
    const [group] = await buildViews(db, me, await groupRows(db, { userId: me, groupId }));
    if (!group) throw new ApiError(404, 'GROUP_NOT_FOUND', 'That group no longer exists, or you are not in it');
    return group;
  }

  const touch = (db: Db, groupId: string) => db`update hk_groups set updated_at = now() where id = ${groupId}`;

  // MARK: Notifications

  async function withTimeout(work: Promise<unknown>) {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      work.catch(() => undefined),
      new Promise((resolve) => { timer = setTimeout(resolve, pushTimeoutMs); }),
    ]);
    clearTimeout(timer);
  }

  /** Each recipient gets the first candidate their settings for this group allow. */
  async function deliver(groupId: string, recipients: Map<string, Candidate[]>) {
    if (!options.apns || recipients.size === 0) return;
    const ids = [...recipients.keys()];
    const settings = await sql<{ user_id: string; notify: Partial<NotifyPrefs> }[]>`
      select user_id, notify from hk_members where group_id = ${groupId} and user_id = any(${ids}::uuid[])`;
    const chosen = new Map<string, Candidate>();
    for (const row of settings) {
      const allowed = prefs(row.notify);
      const candidate = recipients.get(row.user_id)?.find((entry) => allowed[entry.pref]);
      if (candidate) chosen.set(row.user_id, candidate);
    }
    if (chosen.size === 0) return;
    const tokens = await sql<{ token: string; user_id: string; environment: ApnsEnvironment }[]>`
      select token, user_id, environment from hk_push_tokens where user_id = any(${[...chosen.keys()]}::uuid[])`;
    const messages = tokens.map((row) => {
      const candidate = chosen.get(row.user_id)!;
      return {
        token: row.token,
        environment: row.environment,
        topic: options.apnsTopic,
        payload: {
          aps: { alert: candidate.alert, sound: 'default', 'thread-id': groupId },
          hearken: { groupId, ...candidate.data },
        },
      };
    });
    const results = await options.apns(messages);
    const gone = tokens.filter((_, index) => results[index] === 'gone').map((row) => row.token);
    if (gone.length > 0) await sql`delete from hk_push_tokens where token = any(${gone})`;
  }

  const notify = (groupId: string, recipients: Map<string, Candidate[]>) => withTimeout(deliver(groupId, recipients));

  async function otherMembers(groupId: string, me: string) {
    const rows = await sql<{ user_id: string }[]>`select user_id from hk_members where group_id = ${groupId} and user_id <> ${me}`;
    return rows.map((row) => row.user_id);
  }

  async function announceQuestions(ids: string[]) {
    const claimed = await sql<(QuestionRow & { group_name: string })[]>`
      update hk_questions q set notified_at = now()
      from hk_groups g
      where q.id = any(${ids}::uuid[]) and q.notified_at is null and g.id = q.group_id and g.deleted_at is null
      returning q.id, q.group_id, q.author_id, q.author_name, q.text, g.name as group_name`;
    for (const question of claimed) {
      const recipients = new Map<string, Candidate[]>();
      for (const userId of await otherMembers(question.group_id, question.author_id)) {
        recipients.set(userId, [{
          pref: 'question',
          alert: { title: "This week's question", subtitle: question.group_name, body: `${question.author_name.split(' ')[0] || question.author_name} asked: ${snippet(question.text)}` },
          data: { kind: 'question', questionId: question.id },
        }]);
      }
      await deliver(question.group_id, recipients);
    }
    return claimed.length;
  }

  // MARK: Groups

  async function listGroups(me: string) {
    return buildViews(sql, me, await groupRows(sql, { userId: me }));
  }

  async function getGroup(me: string, groupId: string) {
    return view(sql, me, groupId);
  }

  async function insertGroup(tx: TransactionSql, row: {
    ownerId: string; clientId: string | null; name: string; symbol: string; planId: string; customPlan: Record<string, unknown> | null;
    startDate: string; migrationToken: string | null;
  }) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        const [created] = await tx.savepoint((savepoint) => savepoint<{ id: string }[]>`
          insert into hk_groups (owner_id, client_id, name, symbol, plan_id, custom_plan, start_date, invite_code, migration_token)
          values (${row.ownerId}, ${row.clientId}, ${row.name}, ${row.symbol}, ${row.planId},
                  ${row.customPlan === null ? null : tx.json(row.customPlan as never)}, ${row.startDate}, ${newInviteCode()},
                  ${row.migrationToken})
          returning id`);
        return created!.id;
      } catch (error) {
        if (!isUniqueViolation(error, 'hk_groups_invite_code_key')) throw error;
      }
    }
    throw new ApiError(503, 'STORAGE_UNAVAILABLE', 'Could not create the group; try again');
  }

  async function checkGroupLimit(db: Db, me: string) {
    const [row] = await db<{ count: number }[]>`
      select count(*)::int as count from hk_members m join hk_groups g on g.id = m.group_id
      where m.user_id = ${me} and g.deleted_at is null`;
    if ((row?.count ?? 0) >= LIMITS.groupsPerUser) {
      throw new ApiError(409, 'GROUP_LIMIT_REACHED', `You can be in up to ${LIMITS.groupsPerUser} groups`);
    }
  }

  async function createGroup(me: string, input: CreateGroupInput) {
    return sql.begin(async (tx) => {
      if (input.clientId) {
        const [existing] = await tx<{ id: string }[]>`
          select id from hk_groups where owner_id = ${me} and client_id = ${input.clientId} and deleted_at is null`;
        if (existing) return view(tx, me, existing.id);
      }
      await checkGroupLimit(tx, me);
      const id = await insertGroup(tx, {
        ownerId: me, clientId: input.clientId ?? null, name: input.name, symbol: input.symbol, planId: input.planId,
        customPlan: input.customPlan ?? null, startDate: input.startDate, migrationToken: null,
      });
      await tx`
        insert into hk_members (group_id, user_id, role, display_name, initials)
        values (${id}, ${me}, 'owner', ${input.displayName}, ${input.initials})`;
      return view(tx, me, id);
    });
  }

  async function updateGroup(me: string, groupId: string, patch: { name?: string | undefined; symbol?: string | undefined; planId?: string | undefined; customPlan?: Record<string, unknown> | null | undefined; startDate?: string | undefined }) {
    const member = await membership(sql, groupId, me);
    if (member.role !== 'owner') throw new ApiError(403, 'NOT_ALLOWED', 'Only the group owner can change the group');
    await sql`
      update hk_groups set
        name = coalesce(${patch.name ?? null}, name),
        symbol = coalesce(${patch.symbol ?? null}, symbol),
        plan_id = coalesce(${patch.planId ?? null}, plan_id),
        custom_plan = case when ${patch.customPlan !== undefined} then ${patch.customPlan ? sql.json(patch.customPlan as never) : null} else custom_plan end,
        start_date = coalesce(${patch.startDate ?? null}::date, start_date),
        updated_at = now()
      where id = ${groupId}`;
    return view(sql, me, groupId);
  }

  async function deleteGroup(me: string, groupId: string) {
    const member = await membership(sql, groupId, me);
    if (member.role !== 'owner') throw new ApiError(403, 'NOT_ALLOWED', 'Only the group owner can delete the group');
    await sql`update hk_groups set deleted_at = now(), updated_at = now() where id = ${groupId}`;
  }

  async function rotateInvite(me: string, groupId: string) {
    const member = await membership(sql, groupId, me);
    if (!moderates(member.role)) throw new ApiError(403, 'NOT_ALLOWED', 'Only the owner or a leader can reset the invite');
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = newInviteCode();
      try {
        await sql`update hk_groups set invite_code = ${code}, updated_at = now() where id = ${groupId}`;
        return { inviteCode: code, inviteURL: inviteURL(code) };
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
      }
    }
    throw new ApiError(503, 'STORAGE_UNAVAILABLE', 'Could not reset the invite; try again');
  }

  async function previewInvite(me: string, code: string) {
    const [row] = await sql<{ id: string; name: string; symbol: string; plan_id: string; owner_name: string | null; member_count: number; is_member: boolean }[]>`
      select g.id, g.name, g.symbol, g.plan_id,
             (select display_name from hk_members where group_id = g.id and user_id = g.owner_id) as owner_name,
             (select count(*)::int from hk_members where group_id = g.id) as member_count,
             exists (select 1 from hk_members where group_id = g.id and user_id = ${me}) as is_member
      from hk_groups g where g.invite_code = ${code.toUpperCase()} and g.deleted_at is null`;
    if (!row) throw new ApiError(404, 'INVITE_NOT_FOUND', 'That invite code isn’t valid. Ask for a new one.');
    return {
      groupId: row.id, name: row.name, symbol: row.symbol, planId: row.plan_id, ownerName: row.owner_name ?? '',
      memberCount: row.member_count, isMember: row.is_member,
    };
  }

  /** Adds a member, holding the group's row lock so two joins can't both take the last seat. */
  async function addMember(tx: TransactionSql, groupId: string, me: string, displayName: string, initials: string, legacyId: string | null) {
    await tx`select id from hk_groups where id = ${groupId} for update`;
    const [existing] = await tx`select 1 from hk_members where group_id = ${groupId} and user_id = ${me}`;
    if (existing) return false;
    await checkGroupLimit(tx, me);
    const [count] = await tx<{ count: number }[]>`
      select (select count(*) from hk_members where group_id = ${groupId})
           + (select count(*) from hk_legacy_members where group_id = ${groupId}) as count`;
    if (Number(count?.count ?? 0) >= LIMITS.membersPerGroup) {
      throw new ApiError(409, 'GROUP_FULL', `This group already has ${LIMITS.membersPerGroup} members`);
    }
    await tx`
      insert into hk_members (group_id, user_id, role, display_name, initials, legacy_id)
      values (${groupId}, ${me}, 'member', ${displayName}, ${initials}, ${legacyId})`;
    return true;
  }

  async function join(me: string, code: string, input: { displayName: string; initials: string }) {
    const groupId = await sql.begin(async (tx) => {
      const [group] = await tx<{ id: string }[]>`
        select id from hk_groups where invite_code = ${code.toUpperCase()} and deleted_at is null`;
      if (!group) throw new ApiError(404, 'INVITE_NOT_FOUND', 'That invite code isn’t valid. Ask for a new one.');
      if (await addMember(tx, group.id, me, input.displayName, input.initials, null)) await touch(tx, group.id);
      return group.id;
    });
    return view(sql, me, groupId);
  }

  /** Removes a member. An owner who leaves hands the group to a leader (or the longest-standing member). */
  async function departMember(tx: TransactionSql, groupId: string, userId: string) {
    const [group] = await tx<{ owner_id: string }[]>`select owner_id from hk_groups where id = ${groupId} for update`;
    if (group?.owner_id === userId) {
      const [next] = await tx<{ user_id: string }[]>`
        select user_id from hk_members where group_id = ${groupId} and user_id <> ${userId}
        order by (role = 'leader') desc, joined_at limit 1`;
      if (next) {
        await tx`update hk_groups set owner_id = ${next.user_id}, updated_at = now() where id = ${groupId}`;
        await tx`update hk_members set role = 'owner' where group_id = ${groupId} and user_id = ${next.user_id}`;
      } else {
        await tx`update hk_groups set deleted_at = now(), updated_at = now() where id = ${groupId}`;
      }
    }
    await tx`delete from hk_members where group_id = ${groupId} and user_id = ${userId}`;
    await touch(tx, groupId);
  }

  async function removeMember(me: string, groupId: string, userId: string) {
    const member = await membership(sql, groupId, me);
    if (userId.startsWith('legacy:')) {
      if (!moderates(member.role)) throw new ApiError(403, 'NOT_ALLOWED', 'Only the owner or a leader can remove people');
      await sql`delete from hk_legacy_members where group_id = ${groupId} and legacy_id = ${userId.slice('legacy:'.length)}`;
      return;
    }
    if (userId !== me) {
      const [target] = await sql<{ role: Role }[]>`select role from hk_members where group_id = ${groupId} and user_id = ${userId}`;
      if (!target) throw new ApiError(404, 'MEMBER_NOT_FOUND', 'That person is not in this group');
      const allowed = member.role === 'owner' || (member.role === 'leader' && target.role === 'member');
      if (!allowed) throw new ApiError(403, 'NOT_ALLOWED', 'You can’t remove this person');
    }
    await sql.begin((tx) => departMember(tx, groupId, userId));
  }

  async function setRole(me: string, groupId: string, userId: string, role: Role) {
    const member = await membership(sql, groupId, me);
    if (member.role !== 'owner') throw new ApiError(403, 'NOT_ALLOWED', 'Only the group owner can change roles');
    if (userId === me) throw new ApiError(400, 'INVALID_REQUEST', 'Choose someone else');
    await sql.begin(async (tx) => {
      const [target] = await tx`select 1 from hk_members where group_id = ${groupId} and user_id = ${userId}`;
      if (!target) throw new ApiError(404, 'MEMBER_NOT_FOUND', 'That person is not in this group');
      if (role === 'owner') {
        await tx`update hk_members set role = 'leader' where group_id = ${groupId} and user_id = ${me}`;
        await tx`update hk_groups set owner_id = ${userId} where id = ${groupId}`;
      }
      await tx`update hk_members set role = ${role} where group_id = ${groupId} and user_id = ${userId}`;
      await touch(tx, groupId);
    });
    return view(sql, me, groupId);
  }

  async function putProgress(me: string, groupId: string, input: ProgressInput) {
    const member = await membership(sql, groupId, me);
    const [previous] = await sql<{ last_done_day: string | null }[]>`
      select last_done_day::text as last_done_day from hk_progress where group_id = ${groupId} and user_id = ${me}`;
    await sql.begin(async (tx) => {
      await tx`
        insert into hk_progress (group_id, user_id, week_start, week_read, week_total, last_done_day, chapters_read, streak, updated_at)
        values (${groupId}, ${me}, ${input.weekStart}, ${input.weekRead}, ${input.weekTotal}, ${input.lastDoneDay},
                ${input.chaptersRead}, ${input.streak}, now())
        on conflict (group_id, user_id) do update set
          week_start = excluded.week_start, week_read = excluded.week_read, week_total = excluded.week_total,
          last_done_day = excluded.last_done_day, chapters_read = excluded.chapters_read, streak = excluded.streak,
          updated_at = now()`;
      if (input.displayName || input.initials) {
        await tx`
          update hk_members set display_name = coalesce(${input.displayName ?? null}, display_name),
                                initials = coalesce(${input.initials ?? null}, initials)
          where group_id = ${groupId} and user_id = ${me}`;
      }
      await touch(tx, groupId);
    });
    const newlyDone = input.lastDoneDay !== null && (previous?.last_done_day ?? '') < input.lastDoneDay;
    if (newlyDone) {
      const name = (input.displayName ?? member.display_name).split(' ')[0] ?? member.display_name;
      const recipients = new Map<string, Candidate[]>();
      for (const userId of await otherMembers(groupId, me)) {
        recipients.set(userId, [{
          pref: 'activity',
          alert: { title: member.name, body: `${name} finished today's reading` },
          data: { kind: 'progress' },
        }]);
      }
      await notify(groupId, recipients);
    }
  }

  async function setNotifications(me: string, groupId: string, patch: { [K in NotifyKey]?: boolean | undefined }) {
    await membership(sql, groupId, me);
    const [row] = await sql<{ notify: Partial<NotifyPrefs> }[]>`
      update hk_members set notify = notify || ${sql.json(patch as never)}
      where group_id = ${groupId} and user_id = ${me}
      returning notify`;
    return prefs(row?.notify);
  }

  // MARK: Shared items

  async function listItems(me: string, groupId: string, before?: string) {
    await membership(sql, groupId, me);
    const blocked = await blockedBy(sql, me);
    const rows = await sql<ItemRow[]>`
      select id, group_id, author_id, legacy_author_id, author_name, kind, chapter_id, start_verse, end_verse, text, note, reference, created_at
      from hk_items
      where group_id = ${groupId} and deleted_at is null and created_at < ${before ? new Date(before) : now()}
        and (author_id is null or author_id <> all(${blocked}::uuid[]))
      order by created_at desc limit ${LIMITS.itemsPerPage}`;
    return itemViews(sql, rows, await memberNames(sql, [groupId]), blocked);
  }

  async function createItem(me: string, groupId: string, input: ItemInput) {
    const member = await membership(sql, groupId, me);
    let created = true;
    const id = await sql.begin(async (tx) => {
      if (input.clientId) {
        const [existing] = await tx<{ id: string }[]>`
          select id from hk_items where group_id = ${groupId} and client_id = ${input.clientId}`;
        if (existing) { created = false; return existing.id; }
      }
      const [row] = await tx<{ id: string }[]>`
        insert into hk_items (group_id, client_id, author_id, author_name, kind, chapter_id, start_verse, end_verse, text, note, reference)
        values (${groupId}, ${input.clientId ?? null}, ${me}, ${input.authorName}, ${input.kind}, ${input.chapterId},
                ${input.startVerse}, ${input.endVerse}, ${input.text}, ${input.note}, ${input.reference ?? ''})
        returning id`;
      await touch(tx, groupId);
      return row!.id;
    });
    const rows = await sql<ItemRow[]>`
      select id, group_id, author_id, legacy_author_id, author_name, kind, chapter_id, start_verse, end_verse, text, note, reference, created_at
      from hk_items where id = ${id}`;
    const [item] = await itemViews(sql, rows, await memberNames(sql, [groupId]));
    if (created) {
      const name = member.display_name.split(' ')[0] ?? member.display_name;
      const what = input.kind === 'highlight'
        ? `${name} highlighted ${input.reference || 'a verse'}`
        : `${name} shared a reflection${input.text ? ` on ${input.text}` : ''}`;
      const body = input.note ? `${what}: “${snippet(input.note)}”` : what;
      const recipients = new Map<string, Candidate[]>();
      for (const userId of await otherMembers(groupId, me)) {
        recipients.set(userId, [{ pref: 'activity', alert: { title: member.name, body }, data: { kind: 'item', itemId: id } }]);
      }
      await notify(groupId, recipients);
    }
    return item!;
  }

  async function deleteItem(me: string, groupId: string, itemId: string) {
    const member = await membership(sql, groupId, me);
    const [item] = await sql<{ author_id: string | null }[]>`
      select author_id from hk_items where id = ${itemId} and group_id = ${groupId} and deleted_at is null`;
    if (!item) throw new ApiError(404, 'ITEM_NOT_FOUND', 'That post no longer exists');
    if (item.author_id !== me && !moderates(member.role)) throw new ApiError(403, 'NOT_ALLOWED', 'You can only delete your own posts');
    await sql.begin(async (tx) => {
      await tx`update hk_items set deleted_at = now() where id = ${itemId}`;
      await touch(tx, groupId);
    });
  }

  // MARK: Reactions

  async function targetExists(db: Db, groupId: string, targetType: TargetType, targetId: string) {
    const rows = targetType === 'item'
      ? await db`select 1 from hk_items where id = ${targetId} and group_id = ${groupId} and deleted_at is null`
      : targetType === 'comment'
        ? await db`select 1 from hk_comments where id = ${targetId} and group_id = ${groupId} and deleted_at is null`
        : await db`select 1 from hk_answers where id = ${targetId} and group_id = ${groupId}`;
    return rows.length > 0;
  }

  async function react(me: string, groupId: string, targetType: TargetType, targetId: string, kind: ReactionKind, on: boolean) {
    await membership(sql, groupId, me);
    if (!(await targetExists(sql, groupId, targetType, targetId))) throw new ApiError(404, 'TARGET_NOT_FOUND', 'That post no longer exists');
    if (on) {
      await sql`
        insert into hk_reactions (group_id, target_type, target_id, user_id, kind)
        values (${groupId}, ${targetType}, ${targetId}, ${me}, ${kind})
        on conflict do nothing`;
    } else {
      await sql`
        delete from hk_reactions where target_type = ${targetType} and target_id = ${targetId} and user_id = ${me} and kind = ${kind}`;
    }
    await touch(sql, groupId);
  }

  // MARK: Discussion

  async function listComments(me: string, groupId: string, targetType: 'item' | 'answer', targetId: string) {
    await membership(sql, groupId, me);
    if (!(await targetExists(sql, groupId, targetType, targetId))) throw new ApiError(404, 'TARGET_NOT_FOUND', 'That post no longer exists');
    if (targetType === 'answer') await requireVisibleAnswer(me, targetId);
    const blocked = await blockedBy(sql, me);
    const rows = await sql<CommentRow[]>`
      select id, group_id, target_type, target_id, parent_id, author_id, author_name, body, mentions, mentions_everyone, created_at
      from hk_comments
      where target_type = ${targetType} and target_id = ${targetId} and deleted_at is null
        and author_id <> all(${blocked}::uuid[])
      order by created_at limit ${LIMITS.commentsPerTarget}`;
    return commentViews(sql, rows, await memberNames(sql, [groupId]));
  }

  /** Comments on a hidden answer are as hidden as the answer. */
  async function requireVisibleAnswer(me: string, answerId: string) {
    const [row] = await sql<{ hide_answers: boolean; closes_at: Date; answered: boolean }[]>`
      select q.hide_answers, q.closes_at,
             exists (select 1 from hk_answers mine where mine.question_id = q.id and mine.user_id = ${me}) as answered
      from hk_answers a join hk_questions q on q.id = a.question_id
      where a.id = ${answerId}`;
    if (row && row.hide_answers && !row.answered && row.closes_at > now()) {
      throw new ApiError(403, 'ANSWER_FIRST', 'Answer the question to see what others said');
    }
  }

  async function createComment(me: string, groupId: string, input: CommentInput) {
    const member = await membership(sql, groupId, me);
    if (input.targetType === 'answer') await requireVisibleAnswer(me, input.targetId);
    let created = true;
    const result = await sql.begin(async (tx) => {
      if (input.clientId) {
        const [existing] = await tx<{ id: string }[]>`
          select id from hk_comments where group_id = ${groupId} and client_id = ${input.clientId}`;
        if (existing) { created = false; return { id: existing.id, targetAuthor: null as string | null, parentAuthor: null as string | null, parentId: null as string | null }; }
      }
      const [target] = input.targetType === 'item'
        ? await tx<{ author_id: string | null }[]>`
            select author_id from hk_items where id = ${input.targetId} and group_id = ${groupId} and deleted_at is null`
        : await tx<{ author_id: string | null }[]>`
            select user_id as author_id from hk_answers where id = ${input.targetId} and group_id = ${groupId}`;
      if (!target) throw new ApiError(404, 'TARGET_NOT_FOUND', 'That post no longer exists');
      let parentId: string | null = null;
      let parentAuthor: string | null = null;
      if (input.parentId) {
        const [parent] = await tx<{ id: string; parent_id: string | null; author_id: string }[]>`
          select id, parent_id, author_id from hk_comments
          where id = ${input.parentId} and target_type = ${input.targetType} and target_id = ${input.targetId} and deleted_at is null`;
        if (!parent) throw new ApiError(404, 'COMMENT_NOT_FOUND', 'The reply you answered was deleted');
        // Two levels: a reply to a reply joins the same top-level comment.
        parentId = parent.parent_id ?? parent.id;
        parentAuthor = parent.author_id;
      }
      const members = await tx<{ user_id: string }[]>`select user_id from hk_members where group_id = ${groupId}`;
      const memberIds = new Set(members.map((row) => row.user_id));
      const mentions = [...new Set(input.mentions ?? [])].filter((id) => memberIds.has(id) && id !== me);
      const everyone = (input.mentionsEveryone ?? false) && moderatesOrSmall(member.role, memberIds.size);
      const [row] = await tx<{ id: string }[]>`
        insert into hk_comments (group_id, client_id, target_type, target_id, parent_id, author_id, author_name, body, mentions, mentions_everyone)
        values (${groupId}, ${input.clientId ?? null}, ${input.targetType}, ${input.targetId}, ${parentId}, ${me}, ${input.authorName},
                ${input.body}, ${mentions}::uuid[], ${everyone})
        returning id`;
      await touch(tx, groupId);
      return { id: row!.id, targetAuthor: target.author_id, parentAuthor, parentId };
    });
    const rows = await sql<CommentRow[]>`
      select id, group_id, target_type, target_id, parent_id, author_id, author_name, body, mentions, mentions_everyone, created_at
      from hk_comments where id = ${result.id}`;
    const [comment] = await commentViews(sql, rows, await memberNames(sql, [groupId]));
    if (created && comment) {
      const name = member.display_name.split(' ')[0] ?? member.display_name;
      const data = { kind: 'comment', targetType: comment.targetType, targetId: comment.targetId, commentId: comment.id };
      const body = snippet(comment.body);
      const recipients = new Map<string, Candidate[]>();
      const add = (userId: string | null, candidate: Candidate) => {
        if (!userId || userId === me) return;
        recipients.set(userId, [...(recipients.get(userId) ?? []), candidate]);
      };
      const everyoneIds = comment.mentionsEveryone ? await otherMembers(groupId, me) : [];
      for (const userId of new Set([...comment.mentions, ...everyoneIds])) {
        add(userId, { pref: 'mentions', alert: { title: `${name} mentioned you`, subtitle: member.name, body }, data });
      }
      add(result.parentAuthor, { pref: 'replies', alert: { title: `${name} replied to you`, subtitle: member.name, body }, data });
      add(result.targetAuthor, { pref: 'replies', alert: { title: `${name} replied to your post`, subtitle: member.name, body }, data });
      for (const userId of await otherMembers(groupId, me)) {
        add(userId, { pref: 'allReplies', alert: { title: `${name} replied`, subtitle: member.name, body }, data });
      }
      await notify(groupId, recipients);
    }
    return comment!;
  }

  /** "Everyone" mentions: owners and leaders, or anyone in a group of 12 or fewer. */
  function moderatesOrSmall(role: Role, size: number) {
    return moderates(role) || size <= 12;
  }

  async function deleteComment(me: string, groupId: string, commentId: string) {
    const member = await membership(sql, groupId, me);
    const [comment] = await sql<{ author_id: string }[]>`
      select author_id from hk_comments where id = ${commentId} and group_id = ${groupId} and deleted_at is null`;
    if (!comment) throw new ApiError(404, 'COMMENT_NOT_FOUND', 'That reply no longer exists');
    if (comment.author_id !== me && !moderates(member.role)) throw new ApiError(403, 'NOT_ALLOWED', 'You can only delete your own replies');
    await sql.begin(async (tx) => {
      await tx`update hk_comments set deleted_at = now() where id = ${commentId} or parent_id = ${commentId}`;
      await touch(tx, groupId);
    });
  }

  // MARK: Weekly question

  async function questionView(db: Db, me: string, groupId: string, questionId: string) {
    const rows = await db<QuestionRow[]>`
      select id, group_id, author_id, author_name, text, reference, chapter_id, post_at, closes_at, hide_answers, notified_at from hk_questions where id = ${questionId} and group_id = ${groupId} and deleted_at is null`;
    if (rows.length === 0) throw new ApiError(404, 'QUESTION_NOT_FOUND', 'That question no longer exists');
    const [result] = await questionViews(db, me, rows, await memberNames(db, [groupId]), await blockedBy(db, me));
    return result!;
  }

  async function createQuestion(me: string, groupId: string, input: QuestionInput) {
    const member = await membership(sql, groupId, me);
    if (!moderates(member.role)) throw new ApiError(403, 'NOT_ALLOWED', 'Only the owner or a leader can post the weekly question');
    const postAt = input.postAt ? new Date(input.postAt) : now();
    const closesAt = input.closesAt ? new Date(input.closesAt) : new Date(postAt.getTime() + 7 * 24 * 3600 * 1000);
    if (closesAt <= postAt) throw new ApiError(400, 'INVALID_REQUEST', 'The question must close after it posts');
    const id = await sql.begin(async (tx) => {
      if (input.clientId) {
        const [existing] = await tx<{ id: string }[]>`
          select id from hk_questions where group_id = ${groupId} and client_id = ${input.clientId}`;
        if (existing) return existing.id;
      }
      // A new question replaces any that hasn't posted yet.
      await tx`update hk_questions set deleted_at = now() where group_id = ${groupId} and post_at > ${now()} and deleted_at is null`;
      const [row] = await tx<{ id: string }[]>`
        insert into hk_questions (group_id, client_id, author_id, author_name, text, reference, chapter_id, post_at, closes_at, hide_answers)
        values (${groupId}, ${input.clientId ?? null}, ${me}, ${input.authorName}, ${input.text}, ${input.reference ?? ''},
                ${input.chapterId ?? ''}, ${postAt}, ${closesAt}, ${input.hideAnswers ?? true})
        returning id`;
      await touch(tx, groupId);
      return row!.id;
    });
    if (postAt <= now()) await withTimeout(announceQuestions([id]));
    return questionView(sql, me, groupId, id);
  }

  async function updateQuestion(me: string, groupId: string, questionId: string, patch: { text?: string | undefined; reference?: string | undefined; hideAnswers?: boolean | undefined }) {
    const member = await membership(sql, groupId, me);
    const [question] = await sql<{ author_id: string; answers: number }[]>`
      select author_id, (select count(*)::int from hk_answers where question_id = q.id) as answers
      from hk_questions q where id = ${questionId} and group_id = ${groupId} and deleted_at is null`;
    if (!question) throw new ApiError(404, 'QUESTION_NOT_FOUND', 'That question no longer exists');
    if (question.author_id !== me && member.role !== 'owner') throw new ApiError(403, 'NOT_ALLOWED', 'Only the person who asked can edit it');
    if (question.answers > 0 && patch.text !== undefined) {
      throw new ApiError(409, 'QUESTION_ANSWERED', 'Someone has already answered, so the question can’t change');
    }
    await sql`
      update hk_questions set text = coalesce(${patch.text ?? null}, text), reference = coalesce(${patch.reference ?? null}, reference),
             hide_answers = coalesce(${patch.hideAnswers ?? null}, hide_answers)
      where id = ${questionId}`;
    await touch(sql, groupId);
    return questionView(sql, me, groupId, questionId);
  }

  async function deleteQuestion(me: string, groupId: string, questionId: string) {
    const member = await membership(sql, groupId, me);
    const [question] = await sql<{ author_id: string }[]>`
      select author_id from hk_questions where id = ${questionId} and group_id = ${groupId} and deleted_at is null`;
    if (!question) throw new ApiError(404, 'QUESTION_NOT_FOUND', 'That question no longer exists');
    if (question.author_id !== me && member.role !== 'owner') throw new ApiError(403, 'NOT_ALLOWED', 'Only the person who asked can delete it');
    await sql`update hk_questions set deleted_at = now() where id = ${questionId}`;
    await touch(sql, groupId);
  }

  async function listQuestions(me: string, groupId: string) {
    await membership(sql, groupId, me);
    const rows = await sql<QuestionRow[]>`
      select id, group_id, author_id, author_name, text, reference, chapter_id, post_at, closes_at, hide_answers, notified_at from hk_questions
      where group_id = ${groupId} and deleted_at is null and post_at <= ${now()}
      order by post_at desc limit ${LIMITS.questionsListed}`;
    return questionViews(sql, me, rows, await memberNames(sql, [groupId]), await blockedBy(sql, me));
  }

  async function answer(me: string, groupId: string, questionId: string, input: { body: string; authorName: string }) {
    const member = await membership(sql, groupId, me);
    const [question] = await sql<{ author_id: string; post_at: Date; closes_at: Date }[]>`
      select author_id, post_at, closes_at from hk_questions where id = ${questionId} and group_id = ${groupId} and deleted_at is null`;
    if (!question || question.post_at > now()) throw new ApiError(404, 'QUESTION_NOT_FOUND', 'That question no longer exists');
    if (question.closes_at <= now()) throw new ApiError(409, 'QUESTION_CLOSED', 'This question has closed');
    const [row] = await sql<{ inserted: boolean }[]>`
      insert into hk_answers (question_id, group_id, user_id, author_name, body)
      values (${questionId}, ${groupId}, ${me}, ${input.authorName}, ${input.body})
      on conflict (question_id, user_id) do update set body = excluded.body, updated_at = now()
      returning (xmax = 0) as inserted`;
    await touch(sql, groupId);
    if (row?.inserted && question.author_id !== me) {
      const name = member.display_name.split(' ')[0] ?? member.display_name;
      await notify(groupId, new Map([[question.author_id, [{
        pref: 'question' as const,
        alert: { title: `${name} answered your question`, subtitle: member.name, body: snippet(input.body) },
        data: { kind: 'answer', questionId },
      }]]]));
    }
    return questionView(sql, me, groupId, questionId);
  }

  async function deleteAnswer(me: string, groupId: string, questionId: string) {
    await membership(sql, groupId, me);
    await sql`delete from hk_answers where question_id = ${questionId} and group_id = ${groupId} and user_id = ${me}`;
    await touch(sql, groupId);
  }

  // MARK: Devices

  async function registerPushToken(me: string, token: string, environment: ApnsEnvironment, enabled: boolean) {
    const normalized = token.toLowerCase();
    if (enabled) {
      await sql`
        insert into hk_push_tokens (token, user_id, environment, updated_at) values (${normalized}, ${me}, ${environment}, now())
        on conflict (token) do update set user_id = excluded.user_id, environment = excluded.environment, updated_at = now()`;
    } else {
      await sql`delete from hk_push_tokens where token = ${normalized} and user_id = ${me}`;
    }
  }

  // MARK: Moving from CloudKit

  async function importGroup(me: string, input: ImportInput) {
    if (input.items.length > LIMITS.importItems || input.reactions.length > LIMITS.importReactions
      || input.members.length + 1 > LIMITS.membersPerGroup) {
      throw new ApiError(400, 'INVALID_REQUEST', 'The group is too large to import');
    }
    const groupId = await sql.begin(async (tx) => {
      const [existing] = await tx<{ id: string }[]>`
        select id from hk_groups where owner_id = ${me} and client_id = ${input.clientId}`;
      if (existing) return existing.id;
      await checkGroupLimit(tx, me);
      const id = await insertGroup(tx, {
        ownerId: me, clientId: input.clientId, name: input.name, symbol: input.symbol, planId: input.planId,
        customPlan: input.customPlan ?? null, startDate: input.startDate, migrationToken: randomBytes(24).toString('base64url'),
      });
      await tx`
        insert into hk_members (group_id, user_id, role, display_name, initials, legacy_id)
        values (${id}, ${me}, 'owner', ${input.displayName}, ${input.initials}, ${input.ownerLegacyId})`;
      if (input.progress) {
        const p = input.progress;
        await tx`
          insert into hk_progress (group_id, user_id, week_start, week_read, week_total, last_done_day, chapters_read, streak)
          values (${id}, ${me}, ${p.weekStart}, ${p.weekRead}, ${p.weekTotal}, ${p.lastDoneDay}, ${p.chaptersRead}, ${p.streak})`;
      }
      const others = new Map(input.members.filter((member) => member.legacyId !== input.ownerLegacyId).map((member) => [member.legacyId, member]));
      for (const member of others.values()) {
        await tx`
          insert into hk_legacy_members (group_id, legacy_id, display_name, initials, progress)
          values (${id}, ${member.legacyId}, ${member.displayName}, ${member.initials},
                  ${member.progress ? tx.json(member.progress as never) : null})`;
      }
      const itemIds = new Map<string, string>();
      for (const item of input.items) {
        const mine = item.legacyAuthorId === input.ownerLegacyId;
        const [row] = await tx<{ id: string }[]>`
          insert into hk_items (group_id, client_id, author_id, legacy_author_id, author_name, kind, chapter_id, start_verse, end_verse,
                                text, note, reference, created_at)
          values (${id}, ${`ck:${item.legacyId}`}, ${mine ? me : null}, ${mine ? null : item.legacyAuthorId}, ${item.authorName},
                  ${item.kind}, ${item.chapterId}, ${item.startVerse}, ${item.endVerse}, ${item.text}, ${item.note},
                  ${item.reference ?? ''}, ${new Date(item.createdAt)})
          on conflict (group_id, client_id) do nothing
          returning id`;
        if (row) itemIds.set(item.legacyId, row.id);
      }
      for (const reaction of input.reactions) {
        const itemId = itemIds.get(reaction.legacyItemId);
        if (!itemId) continue;
        const mine = reaction.legacyUserId === input.ownerLegacyId;
        await tx`
          insert into hk_reactions (group_id, target_type, target_id, user_id, legacy_user_id, kind)
          values (${id}, 'item', ${itemId}, ${mine ? me : null}, ${mine ? null : reaction.legacyUserId}, ${reaction.kind})
          on conflict do nothing`;
      }
      return id;
    });
    const [token] = await sql<{ migration_token: string }[]>`select migration_token from hk_groups where id = ${groupId}`;
    return { group: await view(sql, me, groupId), migrationToken: token!.migration_token };
  }

  async function claimGroup(me: string, input: { migrationToken: string; legacyUserId: string; displayName: string; initials: string }) {
    const groupId = await sql.begin(async (tx) => {
      const [group] = await tx<{ id: string }[]>`
        select id from hk_groups where migration_token = ${input.migrationToken} and deleted_at is null`;
      if (!group) throw new ApiError(404, 'GROUP_NOT_FOUND', 'That group no longer exists');
      const [legacy] = await tx<LegacyMemberRow[]>`
        delete from hk_legacy_members where group_id = ${group.id} and legacy_id = ${input.legacyUserId}
        returning group_id, legacy_id, display_name, initials, progress`;
      const added = await addMember(tx, group.id, me, input.displayName, input.initials, input.legacyUserId);
      if (!added && !legacy) return group.id;
      if (!legacy) return group.id;
      const p = legacy.progress;
      if (p) {
        await tx`
          insert into hk_progress (group_id, user_id, week_start, week_read, week_total, last_done_day, chapters_read, streak)
          values (${group.id}, ${me}, ${p.weekStart ?? null}, ${p.weekRead ?? 0}, ${p.weekTotal ?? 0}, ${p.lastDoneDay ?? null},
                  ${p.chaptersRead ?? 0}, ${p.streak ?? 0})
          on conflict (group_id, user_id) do nothing`;
      }
      await tx`
        update hk_items set author_id = ${me}, legacy_author_id = null
        where group_id = ${group.id} and legacy_author_id = ${input.legacyUserId} and author_id is null`;
      await tx`
        update hk_reactions r set user_id = ${me}, legacy_user_id = null
        where r.group_id = ${group.id} and r.legacy_user_id = ${input.legacyUserId} and r.user_id is null
          and not exists (select 1 from hk_reactions o where o.target_type = r.target_type and o.target_id = r.target_id
                          and o.user_id = ${me} and o.kind = r.kind)`;
      await tx`delete from hk_reactions where group_id = ${group.id} and legacy_user_id = ${input.legacyUserId}`;
      await touch(tx, group.id);
      return group.id;
    });
    return view(sql, me, groupId);
  }

  // MARK: Blocking

  async function listBlocks(me: string) {
    const rows = await sql<{ blocked_id: string }[]>`
      select blocked_id from hk_blocks where blocker_id = ${me} order by created_at`;
    return rows.map((row) => row.blocked_id);
  }

  async function block(me: string, userId: string) {
    if (userId.toLowerCase() === me.toLowerCase()) throw new ApiError(400, 'INVALID_REQUEST', 'You can’t block yourself');
    await sql`insert into hk_blocks (blocker_id, blocked_id) values (${me}, ${userId}) on conflict do nothing`;
  }

  async function unblock(me: string, userId: string) {
    await sql`delete from hk_blocks where blocker_id = ${me} and blocked_id = ${userId}`;
  }

  // MARK: Account deletion

  /** For DELETE /v1/hearken/me: hands groups on and removes what the person wrote (purged for good after 30 days). */
  async function deleteUser(me: string) {
    await sql.begin(async (tx) => {
      const groups = await tx<{ group_id: string }[]>`select group_id from hk_members where user_id = ${me}`;
      for (const { group_id } of groups) await departMember(tx, group_id, me);
      await tx`delete from hk_answers where user_id = ${me}`;
      await tx`delete from hk_reactions where user_id = ${me}`;
      await tx`update hk_items set deleted_at = coalesce(deleted_at, now()), note = '', text = '' where author_id = ${me}`;
      await tx`update hk_comments set deleted_at = coalesce(deleted_at, now()) where author_id = ${me}`;
      await tx`delete from hk_blocks where blocker_id = ${me} or blocked_id = ${me}`;
      await tx`delete from hk_push_tokens where user_id = ${me}`;
    });
  }

  /**
   * For deleting the whole Hearth account (DELETE /v1/me): everything deleteUser does, but what the
   * person wrote is deleted now instead of after 30 days: their posts, replies, answers, reactions
   * and questions, with the replies and reactions that hang off them, and their blocks either way.
   */
  async function purgeUser(me: string) {
    await sql.begin(async (tx) => {
      const groups = await tx<{ group_id: string }[]>`select group_id from hk_members where user_id = ${me}`;
      for (const { group_id } of groups) await departMember(tx, group_id, me);
      // Answers go with the questions they answer, so note those before the questions go.
      const questionAnswers = await tx<{ id: string }[]>`
        select a.id from hk_answers a join hk_questions q on q.id = a.question_id where q.author_id = ${me}`;
      const answers = await tx<{ id: string }[]>`delete from hk_answers where user_id = ${me} returning id`;
      await tx`delete from hk_questions where author_id = ${me}`;
      const items = await tx<{ id: string }[]>`delete from hk_items where author_id = ${me} returning id`;
      const answerIds = [...questionAnswers, ...answers].map((row) => row.id);
      const itemIds = items.map((row) => row.id);
      // The person's replies and every reply on what's gone; replies to those go with them (two levels deep).
      const comments = await tx<{ id: string }[]>`
        with doomed as (
          select id from hk_comments
          where author_id = ${me}
             or (target_type = 'item' and target_id = any(${itemIds}::uuid[]))
             or (target_type = 'answer' and target_id = any(${answerIds}::uuid[]))
        )
        select id from hk_comments where id in (select id from doomed) or parent_id in (select id from doomed)`;
      const commentIds = comments.map((row) => row.id);
      await tx`
        delete from hk_reactions
        where user_id = ${me}
           or (target_type = 'item' and target_id = any(${itemIds}::uuid[]))
           or (target_type = 'answer' and target_id = any(${answerIds}::uuid[]))
           or (target_type = 'comment' and target_id = any(${commentIds}::uuid[]))`;
      await tx`delete from hk_comments where id = any(${commentIds}::uuid[])`;
      await tx`delete from hk_blocks where blocker_id = ${me} or blocked_id = ${me}`;
      await tx`delete from hk_push_tokens where user_id = ${me}`;
    });
  }

  // MARK: Scheduled work

  async function runScheduled() {
    const due = await sql<{ id: string }[]>`
      select id from hk_questions where notified_at is null and deleted_at is null and post_at <= ${now()}`;
    const announced = due.length > 0 ? await announceQuestions(due.map((row) => row.id)) : 0;

    // Two days in, people who haven't answered a hidden-answer question hear that answers are waiting. Once per question.
    const waiting = await sql<{ id: string; group_id: string; group_name: string; answered: string[] }[]>`
      update hk_questions q set waiting_notified_at = now()
      from hk_groups g
      where g.id = q.group_id and g.deleted_at is null and q.deleted_at is null and q.hide_answers
        and q.waiting_notified_at is null and q.post_at <= ${new Date(now().getTime() - 2 * 24 * 3600 * 1000)}
        and q.closes_at > ${now()} and exists (select 1 from hk_answers a where a.question_id = q.id)
      returning q.id, q.group_id, g.name as group_name,
        array(select user_id::text from hk_answers a where a.question_id = q.id) as answered`;
    for (const question of waiting) {
      const answered = new Set(question.answered);
      const members = await sql<{ user_id: string }[]>`select user_id from hk_members where group_id = ${question.group_id}`;
      const count = answered.size;
      const recipients = new Map<string, Candidate[]>();
      for (const { user_id } of members) {
        if (answered.has(user_id)) continue;
        recipients.set(user_id, [{
          pref: 'question',
          alert: {
            title: `${count} ${count === 1 ? 'answer is' : 'answers are'} waiting`,
            subtitle: question.group_name,
            body: "Add yours to this week's question to read theirs.",
          },
          data: { kind: 'question', questionId: question.id },
        }]);
      }
      await deliver(question.group_id, recipients).catch(() => undefined);
    }

    // Deleted groups and posts are kept 30 days, then removed for good.
    const cutoff = new Date(now().getTime() - 30 * 24 * 3600 * 1000);
    const purged = await sql`delete from hk_groups where deleted_at < ${cutoff}`;
    await sql`delete from hk_comments where deleted_at < ${cutoff}`;
    await sql`delete from hk_items where deleted_at < ${cutoff}`;
    await sql`delete from hk_questions where deleted_at < ${cutoff}`;
    return { announced, nudged: waiting.length, purgedGroups: purged.count };
  }

  return {
    listGroups, getGroup, createGroup, updateGroup, deleteGroup, rotateInvite, previewInvite, join, removeMember, setRole,
    putProgress, setNotifications, listItems, createItem, deleteItem, react, listComments, createComment, deleteComment,
    createQuestion, updateQuestion, deleteQuestion, listQuestions, answer, deleteAnswer, registerPushToken, importGroup,
    claimGroup, listBlocks, block, unblock, deleteUser, purgeUser, runScheduled,
  };
}

export type HearkenService = ReturnType<typeof createHearkenService>;
