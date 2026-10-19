import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { createApp } from '../../src/app.js';
import { readConfig } from '../../src/config.js';
import type { ApnsMessage, ApnsResult } from '../../src/integrations/apns.js';
import { LIMITS, createHearkenService } from '../../src/hearken/service.js';

// Runs against a real Postgres: set HEARKEN_TEST_DATABASE_URL to an empty scratch database.
// The migration is applied once; every test starts with empty tables.
const url = process.env.HEARKEN_TEST_DATABASE_URL;

const users = {
  sarah: '00000000-0000-4000-8000-000000000001',
  david: '00000000-0000-4000-8000-000000000002',
  lily: '00000000-0000-4000-8000-000000000003',
  ben: '00000000-0000-4000-8000-000000000004',
  guest: '00000000-0000-4000-8000-000000000009',
};
type Who = keyof typeof users;

describe.skipIf(!url)('Hearken study groups', () => {
  const sql = postgres(url ?? 'postgres://unused', { onnotice: () => undefined, max: 4 });
  let clock = new Date('2026-10-19T15:00:00Z');
  const sent: ApnsMessage[] = [];
  let apnsResult: ApnsResult = 'sent';
  const service = createHearkenService({
    sql,
    apns: async (messages) => { sent.push(...messages); return messages.map(() => apnsResult); },
    apnsTopic: 'com.stephenwarren.hearken',
    publicBaseUrl: 'https://api.hearthapps.com',
    now: () => clock,
  });
  const app = createApp({
    config: readConfig({ CRON_SECRET: 'cron-secret-0123456789' }),
    verifyToken: async (token) => {
      if (token === 'anonymous') return { userId: users.guest, isAnonymous: true };
      const userId = users[token as Who];
      if (!userId) throw new Error('unknown test token');
      return { userId, isAnonymous: false };
    },
    hearken: service,
  });

  async function call(who: Who | 'anonymous', method: string, path: string, body?: unknown) {
    const response = await app.request(path, {
      method,
      headers: {
        Authorization: `Bearer ${who}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : undefined };
  }

  const progress = { weekStart: '2026-10-19', weekRead: 2, weekTotal: 9, lastDoneDay: '2026-10-19', chaptersRead: 40, streak: 5 };

  async function familyGroup() {
    const created = await call('sarah', 'POST', '/v1/hearken/groups', {
      clientId: 'device-group-1', name: 'Jensen Family', symbol: 'house.fill', planId: 'bofm-90', startDate: '2026-08-30',
      displayName: 'Sarah Jensen', initials: 'SJ',
    });
    expect(created.status).toBe(201);
    const code = created.body.inviteCode as string;
    for (const [who, display, initials] of [['david', 'David Jensen', 'DJ'], ['lily', 'Lily Jensen', 'LJ']] as const) {
      const joined = await call(who, 'POST', `/v1/hearken/invites/${code}/join`, { displayName: display, initials });
      expect(joined.status).toBe(200);
    }
    sent.length = 0;
    return created.body as { id: string; inviteCode: string };
  }

  beforeAll(async () => {
    const [exists] = await sql`select to_regclass('public.hk_groups') as name`;
    if (!exists?.name) {
      await sql.unsafe(readFileSync(new URL('../../supabase/migrations/20261019190345_hearken_study_groups.sql', import.meta.url), 'utf8'));
    }
  });
  beforeEach(async () => {
    // Everything else belongs to a group and goes with it. (DELETE, not TRUNCATE, so the tests
    // also run as the API's own restricted role.)
    await sql`delete from hk_groups`;
    await sql`delete from hk_push_tokens`;
    sent.length = 0;
    apnsResult = 'sent';
    clock = new Date('2026-10-19T15:00:00Z');
    for (const [index, who] of (['sarah', 'david', 'lily', 'ben'] as const).entries()) {
      await call(who, 'PUT', '/v1/hearken/push-tokens', { token: `${index + 1}`.repeat(64), environment: 'sandbox', enabled: true });
    }
  });
  afterAll(async () => { await sql.end(); });

  const tokenOwner = (message: ApnsMessage) => (['sarah', 'david', 'lily', 'ben'] as const)[Number(message.token[0]) - 1];

  describe('groups and membership', () => {
    it('creates a group idempotently and lists it with members', async () => {
      const group = await familyGroup();
      const again = await call('sarah', 'POST', '/v1/hearken/groups', {
        clientId: 'device-group-1', name: 'Jensen Family', symbol: 'house.fill', planId: 'bofm-90', startDate: '2026-08-30',
        displayName: 'Sarah Jensen', initials: 'SJ',
      });
      expect(again.body.id).toBe(group.id);
      const list = await call('david', 'GET', '/v1/hearken/groups');
      expect(list.status).toBe(200);
      expect(list.body.items).toHaveLength(1);
      const [view] = list.body.items;
      expect(view).toMatchObject({ name: 'Jensen Family', role: 'member', ownerName: 'Sarah Jensen', ownerId: users.sarah });
      expect(view.inviteURL).toBe(`https://api.hearthapps.com/hearken/join/${group.inviteCode}`);
      expect(view.members.map((member: { name: string }) => member.name)).toEqual(['Sarah Jensen', 'David Jensen', 'Lily Jensen']);
      expect(view.notifications).toEqual({ replies: true, mentions: true, allReplies: false, question: true, activity: true });
    });

    it('refuses anonymous sessions and people outside the group', async () => {
      const group = await familyGroup();
      expect((await call('anonymous', 'GET', '/v1/hearken/groups')).status).toBe(403);
      const outsider = await call('ben', 'GET', `/v1/hearken/groups/${group.id}`);
      expect(outsider.status).toBe(404);
      expect(outsider.body.error.code).toBe('GROUP_NOT_FOUND');
      expect((await call('ben', 'POST', `/v1/hearken/groups/${group.id}/items`, {
        kind: 'reflection', chapterId: 'bofm.alma.34', startVerse: 0, endVerse: 0, text: 'Alma 34', note: 'Hi', authorName: 'Ben',
      })).status).toBe(404);
    });

    it('previews invites and rejects bad codes', async () => {
      const group = await familyGroup();
      const preview = await call('ben', 'GET', `/v1/hearken/invites/${group.inviteCode.toLowerCase()}`);
      expect(preview.body).toMatchObject({ name: 'Jensen Family', ownerName: 'Sarah Jensen', memberCount: 3, isMember: false });
      expect((await call('ben', 'GET', '/v1/hearken/invites/ZZZZZZZZ')).status).toBe(404);
      const rotated = await call('sarah', 'POST', `/v1/hearken/groups/${group.id}/invite-code`);
      expect(rotated.body.inviteCode).not.toBe(group.inviteCode);
      expect((await call('ben', 'GET', `/v1/hearken/invites/${group.inviteCode}`)).status).toBe(404);
      expect((await call('david', 'POST', `/v1/hearken/groups/${group.id}/invite-code`)).status).toBe(403);
    });

    it('caps a group at its member limit', async () => {
      const group = await familyGroup();
      for (let index = 0; index < LIMITS.membersPerGroup - 3; index += 1) {
        await sql`insert into hk_members (group_id, user_id, role, display_name, initials)
                  values (${group.id}, gen_random_uuid(), 'member', 'Filler', 'F')`;
      }
      const full = await call('ben', 'POST', `/v1/hearken/invites/${group.inviteCode}/join`, { displayName: 'Ben', initials: 'BJ' });
      expect(full.status).toBe(409);
      expect(full.body.error.code).toBe('GROUP_FULL');
    });

    it('hands the group on when the owner leaves, and deletes it when the last person does', async () => {
      const group = await familyGroup();
      expect((await call('sarah', 'PUT', `/v1/hearken/groups/${group.id}/members/${users.lily}/role`, { role: 'leader' })).status).toBe(200);
      expect((await call('sarah', 'DELETE', `/v1/hearken/groups/${group.id}/members/${users.sarah}`)).status).toBe(204);
      const view = await call('lily', 'GET', `/v1/hearken/groups/${group.id}`);
      expect(view.body).toMatchObject({ ownerId: users.lily, role: 'owner' });
      // A leader can remove members but not the owner.
      expect((await call('david', 'DELETE', `/v1/hearken/groups/${group.id}/members/${users.lily}`)).status).toBe(403);
      await call('david', 'DELETE', `/v1/hearken/groups/${group.id}/members/${users.david}`);
      await call('lily', 'DELETE', `/v1/hearken/groups/${group.id}/members/${users.lily}`);
      const [row] = await sql`select deleted_at from hk_groups where id = ${group.id}`;
      expect(row?.deleted_at).not.toBeNull();
    });

    it('notifies the group when someone finishes the day, once', async () => {
      const group = await familyGroup();
      expect((await call('david', 'PUT', `/v1/hearken/groups/${group.id}/progress`, progress)).status).toBe(204);
      expect(sent.map(tokenOwner).sort()).toEqual(['lily', 'sarah']);
      expect(sent[0]!.payload).toMatchObject({ aps: { alert: { title: 'Jensen Family', body: "David finished today's reading" } } });
      sent.length = 0;
      await call('david', 'PUT', `/v1/hearken/groups/${group.id}/progress`, { ...progress, weekRead: 3 });
      expect(sent).toHaveLength(0);
      const view = await call('sarah', 'GET', `/v1/hearken/groups/${group.id}`);
      expect(view.body.members[1].progress).toMatchObject({ weekRead: 3, lastDoneDay: '2026-10-19' });
    });

    it('accepts progress without a finished day', async () => {
      const group = await familyGroup();
      const { lastDoneDay: _unused, ...rest } = progress;
      expect((await call('david', 'PUT', `/v1/hearken/groups/${group.id}/progress`, rest)).status).toBe(204);
      expect((await call('david', 'PUT', `/v1/hearken/groups/${group.id}/progress`, { ...rest, lastDoneDay: null, weekStart: null })).status).toBe(204);
      expect(sent).toHaveLength(0);
    });

    it('respects per-group notification settings and drops dead tokens', async () => {
      const group = await familyGroup();
      const settings = await call('lily', 'PUT', `/v1/hearken/groups/${group.id}/notifications`, { activity: false });
      expect(settings.body).toMatchObject({ activity: false, replies: true });
      apnsResult = 'gone';
      await call('david', 'PUT', `/v1/hearken/groups/${group.id}/progress`, progress);
      expect(sent.map(tokenOwner)).toEqual(['sarah']);
      const tokens = await sql`select user_id from hk_push_tokens where user_id = ${users.sarah}`;
      expect(tokens).toHaveLength(0);
    });
  });

  describe('discussion', () => {
    async function reflection(groupId: string) {
      const posted = await call('lily', 'POST', `/v1/hearken/groups/${groupId}/items`, {
        clientId: 'item-1', kind: 'reflection', chapterId: 'bofm.alma.34', startVerse: 0, endVerse: 0, text: 'Alma 34',
        note: 'Nothing is too ordinary to pray about.', authorName: 'Lily Jensen',
      });
      expect(posted.status).toBe(201);
      sent.length = 0;
      return posted.body as { id: string };
    }

    it('threads replies two levels deep and shows the latest on the post', async () => {
      const group = await familyGroup();
      const item = await reflection(group.id);
      const first = await call('david', 'POST', `/v1/hearken/groups/${group.id}/comments`, {
        clientId: 'c1', targetType: 'item', targetId: item.id, body: 'Same. Even the boring meetings.', authorName: 'David Jensen',
      });
      expect(first.status).toBe(201);
      const second = await call('lily', 'POST', `/v1/hearken/groups/${group.id}/comments`, {
        targetType: 'item', targetId: item.id, parentId: first.body.id, body: 'They need it most.', mentions: [users.david],
        authorName: 'Lily Jensen',
      });
      const third = await call('sarah', 'POST', `/v1/hearken/groups/${group.id}/comments`, {
        targetType: 'item', targetId: item.id, parentId: second.body.id, body: 'Agreed!', authorName: 'Sarah Jensen',
      });
      expect(third.body.parentId).toBe(first.body.id);
      const thread = await call('david', 'GET', `/v1/hearken/groups/${group.id}/comments?targetType=item&targetId=${item.id}`);
      expect(thread.body.items.map((comment: { body: string }) => comment.body)).toEqual([
        'Same. Even the boring meetings.', 'They need it most.', 'Agreed!',
      ]);
      const view = await call('sarah', 'GET', `/v1/hearken/groups/${group.id}`);
      expect(view.body.items[0]).toMatchObject({ commentCount: 3, latestComment: { body: 'Agreed!', authorName: 'Sarah Jensen' } });
      // Retrying with the same clientId doesn't duplicate.
      await call('david', 'POST', `/v1/hearken/groups/${group.id}/comments`, {
        clientId: 'c1', targetType: 'item', targetId: item.id, body: 'Same. Even the boring meetings.', authorName: 'David Jensen',
      });
      expect((await call('david', 'GET', `/v1/hearken/groups/${group.id}/comments?targetType=item&targetId=${item.id}`)).body.items).toHaveLength(3);
    });

    it('notifies the post author, the person replied to, and mentions', async () => {
      const group = await familyGroup();
      const item = await reflection(group.id);
      await call('david', 'POST', `/v1/hearken/groups/${group.id}/comments`, {
        targetType: 'item', targetId: item.id, body: 'Same here', authorName: 'David Jensen',
      });
      expect(sent.map((message) => [tokenOwner(message), (message.payload.aps as { alert: { title: string } }).alert.title])).toEqual([
        ['lily', 'David replied to your post'],
      ]);
      sent.length = 0;
      const parent = (await call('david', 'GET', `/v1/hearken/groups/${group.id}/comments?targetType=item&targetId=${item.id}`)).body.items[0];
      await call('sarah', 'POST', `/v1/hearken/groups/${group.id}/comments`, {
        targetType: 'item', targetId: item.id, parentId: parent.id, body: 'Love this @Lily', mentions: [users.lily, users.ben],
        authorName: 'Sarah Jensen',
      });
      const titles = Object.fromEntries(sent.map((message) => [tokenOwner(message), (message.payload.aps as { alert: { title: string } }).alert.title]));
      // Ben isn't in the group, so his mention is dropped.
      expect(titles).toEqual({ lily: 'Sarah mentioned you', david: 'Sarah replied to you' });
      expect(sent[0]!.payload.hearken).toMatchObject({ groupId: group.id, kind: 'comment', targetType: 'item', targetId: item.id });
    });

    it('toggles reactions on posts and replies, and lets moderators delete', async () => {
      const group = await familyGroup();
      const item = await reflection(group.id);
      for (let index = 0; index < 2; index += 1) {
        expect((await call('sarah', 'PUT', `/v1/hearken/groups/${group.id}/reactions/item/${item.id}/heart`)).status).toBe(204);
      }
      let view = await call('david', 'GET', `/v1/hearken/groups/${group.id}`);
      expect(view.body.items[0].reactions).toEqual([{ kind: 'heart', userId: users.sarah }]);
      await call('sarah', 'DELETE', `/v1/hearken/groups/${group.id}/reactions/item/${item.id}/heart`);
      view = await call('david', 'GET', `/v1/hearken/groups/${group.id}`);
      expect(view.body.items[0].reactions).toEqual([]);
      const comment = await call('david', 'POST', `/v1/hearken/groups/${group.id}/comments`, {
        targetType: 'item', targetId: item.id, body: 'Yes', authorName: 'David Jensen',
      });
      expect((await call('lily', 'PUT', `/v1/hearken/groups/${group.id}/reactions/comment/${comment.body.id}/heart`)).status).toBe(204);
      expect((await call('lily', 'DELETE', `/v1/hearken/groups/${group.id}/comments/${comment.body.id}`)).status).toBe(403);
      expect((await call('sarah', 'DELETE', `/v1/hearken/groups/${group.id}/comments/${comment.body.id}`)).status).toBe(204);
      expect((await call('david', 'DELETE', `/v1/hearken/groups/${group.id}/items/${item.id}`)).status).toBe(403);
      expect((await call('lily', 'DELETE', `/v1/hearken/groups/${group.id}/items/${item.id}`)).status).toBe(204);
      expect((await call('sarah', 'GET', `/v1/hearken/groups/${group.id}`)).body.items).toEqual([]);
    });
  });

  describe('weekly question', () => {
    const asked = {
      clientId: 'q1', text: "What's one seed you've planted this year?", reference: 'Alma 32:28–43', chapterId: 'bofm.alma.32',
      authorName: 'Sarah Jensen',
    };

    it('lets only the owner and leaders ask, and notifies everyone else', async () => {
      const group = await familyGroup();
      expect((await call('david', 'POST', `/v1/hearken/groups/${group.id}/questions`, { ...asked, authorName: 'David' })).status).toBe(403);
      await call('sarah', 'PUT', `/v1/hearken/groups/${group.id}/members/${users.david}/role`, { role: 'leader' });
      const question = await call('david', 'POST', `/v1/hearken/groups/${group.id}/questions`, { ...asked, authorName: 'David Jensen' });
      expect(question.status).toBe(201);
      expect(question.body).toMatchObject({ isPosted: true, isClosed: false, hideAnswers: true, closesAt: '2026-10-26T15:00:00.000Z' });
      expect(sent.map(tokenOwner).sort()).toEqual(['lily', 'sarah']);
      expect(sent[0]!.payload.aps).toMatchObject({ alert: { title: "This week's question", body: `David asked: ${asked.text}` } });
    });

    it('hides answers until you answer, including their replies', async () => {
      const group = await familyGroup();
      const question = (await call('sarah', 'POST', `/v1/hearken/groups/${group.id}/questions`, asked)).body;
      const david = await call('david', 'PUT', `/v1/hearken/groups/${group.id}/questions/${question.id}/answer`, {
        body: 'No phone for the first hour.', authorName: 'David Jensen',
      });
      expect(david.body).toMatchObject({ answersVisible: true, answerCount: 1 });
      const lilyView = (await call('lily', 'GET', `/v1/hearken/groups/${group.id}`)).body.question;
      expect(lilyView).toMatchObject({ answersVisible: false, answerCount: 1, answers: [], answeredUserIds: [users.david] });
      const answerId = david.body.myAnswer.id;
      expect((await call('lily', 'POST', `/v1/hearken/groups/${group.id}/comments`, {
        targetType: 'answer', targetId: answerId, body: 'Peeking', authorName: 'Lily',
      })).body.error.code).toBe('ANSWER_FIRST');
      const lily = await call('lily', 'PUT', `/v1/hearken/groups/${group.id}/questions/${question.id}/answer`, {
        body: 'A gratitude journal.', authorName: 'Lily Jensen',
      });
      expect(lily.body.answers.map((answer: { authorName: string }) => answer.authorName)).toEqual(['David Jensen', 'Lily Jensen']);
      expect((await call('lily', 'POST', `/v1/hearken/groups/${group.id}/comments`, {
        targetType: 'answer', targetId: answerId, body: 'Love that', authorName: 'Lily Jensen',
      })).status).toBe(201);
      // The question can't be reworded once answered.
      expect((await call('sarah', 'PATCH', `/v1/hearken/groups/${group.id}/questions/${question.id}`, { text: 'Changed' })).status).toBe(409);
      // After it closes, everyone can read the answers.
      clock = new Date('2026-10-27T00:00:00Z');
      expect((await call('ben', 'GET', `/v1/hearken/groups/${group.id}`)).status).toBe(404);
      expect((await call('sarah', 'GET', `/v1/hearken/groups/${group.id}/questions`)).body.items[0]).toMatchObject({
        isClosed: true, answersVisible: true, answerCount: 2,
      });
      expect((await call('sarah', 'PUT', `/v1/hearken/groups/${group.id}/questions/${question.id}/answer`, {
        body: 'Late', authorName: 'Sarah',
      })).body.error.code).toBe('QUESTION_CLOSED');
    });

    it('holds scheduled questions until their time, then the job announces them', async () => {
      const group = await familyGroup();
      const scheduled = await call('sarah', 'POST', `/v1/hearken/groups/${group.id}/questions`, {
        ...asked, postAt: '2026-10-26T13:00:00Z',
      });
      expect(scheduled.body.isPosted).toBe(false);
      expect(sent).toHaveLength(0);
      expect((await call('david', 'GET', `/v1/hearken/groups/${group.id}`)).body).toMatchObject({ question: null, scheduledQuestion: null });
      expect((await call('sarah', 'GET', `/v1/hearken/groups/${group.id}`)).body.scheduledQuestion.id).toBe(scheduled.body.id);

      expect((await app.request('/internal/hearken/cron')).status).toBe(401);
      clock = new Date('2026-10-26T13:00:00Z');
      const run = await app.request('/internal/hearken/cron', { headers: { Authorization: 'Bearer cron-secret-0123456789' } });
      expect(await run.json()).toMatchObject({ announced: 1 });
      expect(sent).toHaveLength(2);
      sent.length = 0;
      expect((await call('david', 'GET', `/v1/hearken/groups/${group.id}`)).body.question.id).toBe(scheduled.body.id);
      expect(sent).toHaveLength(0);
    });

    it('nudges people who haven’t answered once answers are waiting', async () => {
      const group = await familyGroup();
      const question = (await call('sarah', 'POST', `/v1/hearken/groups/${group.id}/questions`, asked)).body;
      await call('david', 'PUT', `/v1/hearken/groups/${group.id}/questions/${question.id}/answer`, { body: 'Yes', authorName: 'David' });
      sent.length = 0;
      clock = new Date('2026-10-21T16:00:00Z');
      const result = await service.runScheduled();
      expect(result.nudged).toBe(1);
      expect(sent.map(tokenOwner).sort()).toEqual(['lily', 'sarah']);
      expect(sent[0]!.payload.aps).toMatchObject({ alert: { title: '1 answer is waiting' } });
      sent.length = 0;
      await service.runScheduled();
      expect(sent).toHaveLength(0);
    });

    it('announces a question the first time someone looks after its time, if the job hasn’t yet', async () => {
      const group = await familyGroup();
      await call('sarah', 'POST', `/v1/hearken/groups/${group.id}/questions`, { ...asked, postAt: '2026-10-20T13:00:00Z' });
      clock = new Date('2026-10-20T14:00:00Z');
      await call('lily', 'GET', '/v1/hearken/groups');
      expect(sent.map(tokenOwner).sort()).toEqual(['david', 'lily']);
    });
  });

  describe('moving from CloudKit', () => {
    it('imports a group and lets each member claim their seat and posts', async () => {
      const imported = await call('sarah', 'POST', '/v1/hearken/groups/import', {
        clientId: 'group-ABC', name: 'Jensen Family', symbol: 'house.fill', planId: 'bofm-90', startDate: '2026-08-30',
        displayName: 'Sarah Jensen', initials: 'SJ', ownerLegacyId: '_sarah', progress,
        members: [
          { legacyId: '_sarah', displayName: 'Sarah Jensen', initials: 'SJ' },
          { legacyId: '_david', displayName: 'David Jensen', initials: 'DJ', progress: { ...progress, streak: 51 } },
        ],
        items: [
          { legacyId: 'item-1', legacyAuthorId: '_david', authorName: 'David Jensen', kind: 'highlight', chapterId: 'bofm.alma.34',
            startVerse: 32, endVerse: 32, text: 'For behold, this life is the time', note: 'Not someday.', createdAt: '2026-10-18T12:00:00Z' },
          { legacyId: 'item-2', legacyAuthorId: '_sarah', authorName: 'Sarah Jensen', kind: 'reflection', chapterId: 'bofm.alma.33',
            startVerse: 0, endVerse: 0, text: 'Alma 33', note: 'Zenos!', createdAt: '2026-10-17T12:00:00Z' },
        ],
        reactions: [{ legacyItemId: 'item-1', legacyUserId: '_sarah', kind: 'heart' }, { legacyItemId: 'item-2', legacyUserId: '_david', kind: 'insight' }],
      });
      expect(imported.status).toBe(201);
      const { group, migrationToken } = imported.body;
      expect(group.members).toEqual([
        expect.objectContaining({ userId: users.sarah, role: 'owner', pending: false }),
        expect.objectContaining({ userId: 'legacy:_david', pending: true, progress: expect.objectContaining({ streak: 51 }) }),
      ]);
      expect(group.items[0]).toMatchObject({ authorId: 'legacy:_david', reactions: [{ kind: 'heart', userId: users.sarah }] });

      // Importing again (a retry) returns the same group.
      const retry = await call('sarah', 'POST', '/v1/hearken/groups/import', {
        clientId: 'group-ABC', name: 'Jensen Family', symbol: 'house.fill', planId: 'bofm-90', startDate: '2026-08-30',
        displayName: 'Sarah Jensen', initials: 'SJ', ownerLegacyId: '_sarah', members: [], items: [], reactions: [],
      });
      expect(retry.body.group.id).toBe(group.id);

      const claimed = await call('david', 'POST', '/v1/hearken/groups/claim', {
        migrationToken, legacyUserId: '_david', displayName: 'David Jensen', initials: 'DJ',
      });
      expect(claimed.status).toBe(200);
      expect(claimed.body.members.map((member: { userId: string }) => member.userId)).toEqual([users.sarah, users.david]);
      expect(claimed.body.items[0]).toMatchObject({ authorId: users.david });
      expect(claimed.body.items[1].reactions).toEqual([{ kind: 'insight', userId: users.david }]);
      expect(claimed.body.members[1].progress).toMatchObject({ streak: 51 });
      expect((await call('lily', 'POST', '/v1/hearken/groups/claim', {
        migrationToken: 'not-a-real-token-at-all', legacyUserId: '_lily', displayName: 'Lily', initials: 'LJ',
      })).status).toBe(404);
    });
  });

  it('deletes everything about a person, handing their groups on', async () => {
    const group = await familyGroup();
    await call('sarah', 'POST', `/v1/hearken/groups/${group.id}/items`, {
      kind: 'reflection', chapterId: '', startVerse: 0, endVerse: 0, text: '', note: 'Mine', authorName: 'Sarah',
    });
    expect((await call('sarah', 'DELETE', '/v1/hearken/me')).status).toBe(204);
    const view = await call('david', 'GET', `/v1/hearken/groups/${group.id}`);
    expect(view.body).toMatchObject({ ownerId: users.david, items: [] });
    expect(view.body.members.map((member: { userId: string }) => member.userId)).toEqual([users.david, users.lily]);
    expect(await sql`select 1 from hk_push_tokens where user_id = ${users.sarah}`).toHaveLength(0);
  });
});

describe('Hearken study groups without a database', () => {
  it('answers 503 instead of failing', async () => {
    const app = createApp({
      config: readConfig({}),
      verifyToken: async () => ({ userId: users.sarah, isAnonymous: false }),
    });
    const response = await app.request('/v1/hearken/groups', { headers: { Authorization: 'Bearer x' } });
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe('STORAGE_NOT_CONFIGURED');
  });

  it('serves the invite page and the Hearken universal link', async () => {
    const app = createApp({ config: readConfig({ APPLE_APP_IDS: 'BH8R3BX5WF.com.stephenwarren.suffice,BH8R3BX5WF.com.stephenwarren.hearken' }) });
    const page = await app.request('/hearken/join/abcd2345');
    expect(await page.text()).toContain('ABCD2345');
    const evil = await app.request('/hearken/join/%3Cscript%3E');
    expect(await evil.text()).not.toContain('<script>');
    const aasa = await (await app.request('/.well-known/apple-app-site-association')).json();
    expect(aasa.applinks.details[1]).toEqual({
      appIDs: ['BH8R3BX5WF.com.stephenwarren.hearken'],
      components: [{ '/': '/hearken/join/*', comment: 'Hearken study group invites' }],
    });
  });
});
