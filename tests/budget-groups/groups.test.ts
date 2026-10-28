import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { createApp } from '../../src/app.js';
import { readConfig } from '../../src/config.js';
import { BUDGET_LIMITS, createBudgetGroupsService } from '../../src/budget-groups/service.js';
import type { BudgetGroupsService } from '../../src/budget-groups/service.js';
import type { EffectiveEntitlement } from '../../src/services/subscriptions.js';

// Runs against a real Postgres: set BUDGET_TEST_DATABASE_URL (or HEARKEN_TEST_DATABASE_URL) to an
// empty scratch database. The migration is applied once; every test starts with empty tables.
const url = process.env.BUDGET_TEST_DATABASE_URL ?? process.env.HEARKEN_TEST_DATABASE_URL;

const users = {
  sarah: '00000000-0000-4000-8000-000000000001',
  david: '00000000-0000-4000-8000-000000000002',
  lily: '00000000-0000-4000-8000-000000000003',
  ben: '00000000-0000-4000-8000-000000000004',
  guest: '00000000-0000-4000-8000-000000000009',
};
type Who = keyof typeof users;

// Sarah has Suffice Plus and Ben has Hearth+; David and Lily have no plan.
const plans: Partial<Record<string, EffectiveEntitlement[]>> = {
  [users.sarah]: [{ id: 'suffice_plus', expiresAt: null, source: 'own' }],
  [users.ben]: [{ id: 'hearth_plus', expiresAt: null, source: 'own' }],
  [users.david]: [{ id: 'hearken_plus', expiresAt: null, source: 'own' }],
};

function testApp(budgetGroups?: BudgetGroupsService) {
  return createApp({
    config: readConfig({ ENFORCE_ENTITLEMENTS: 'true' }),
    verifyToken: async (token) => {
      if (token === 'anonymous') return { userId: users.guest, isAnonymous: true };
      const userId = users[token as Who];
      if (!userId) throw new Error('unknown test token');
      return { userId, isAnonymous: false };
    },
    entitlements: async (userId) => plans[userId] ?? [],
    ...(budgetGroups ? { budgetGroups } : {}),
  });
}

function caller(app: ReturnType<typeof createApp>) {
  return async (who: Who | 'anonymous', method: string, path: string, body?: unknown) => {
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
  };
}

const expense = (overrides: Record<string, unknown> = {}) => ({
  clientId: randomUUID(), payee: 'Cabin rental', amountCents: 45000, date: '2026-11-02', ...overrides,
});

describe.skipIf(!url)('Suffice group budgets', () => {
  const sql = postgres(url ?? 'postgres://unused', { onnotice: () => undefined, max: 4 });
  const service = createBudgetGroupsService({ sql, publicBaseUrl: 'https://api.hearthapps.com' });
  const call = caller(testApp(service));

  async function tripGroup() {
    const created = await call('sarah', 'POST', '/v1/budget-groups', {
      name: '  Tahoe Trip ', planCents: 200000, startDate: '2026-11-01', endDate: '2026-11-05', displayName: 'Sarah', householdKey: 'jensen',
    });
    expect(created.status).toBe(201);
    const code = created.body.inviteCode as string;
    for (const [who, displayName] of [['david', 'David'], ['lily', 'Lily']] as const) {
      expect((await call(who, 'POST', `/v1/budget-groups/invites/${code}/join`, { displayName })).status).toBe(200);
    }
    return created.body as { id: string; inviteCode: string; inviteURL: string };
  }

  const count = async (table: string, groupId: string) =>
    (await sql`select count(*)::int as count from ${sql(table)} where group_id = ${groupId}`)[0]!.count as number;

  beforeAll(async () => {
    const [exists] = await sql`select to_regclass('public.sf_budget_groups') as name`;
    if (!exists?.name) {
      // The migration has its own begin/commit, so it runs on one reserved connection.
      const reserved = await sql.reserve();
      try {
        await reserved.unsafe(readFileSync(
          new URL('../../supabase/migrations/20261028120000_suffice_budget_groups.sql', import.meta.url), 'utf8',
        ));
      } finally {
        reserved.release();
      }
    }
  });
  beforeEach(async () => {
    // Everything else belongs to a group and goes with it. (DELETE, not TRUNCATE, so the tests
    // also run as the API's own restricted role.)
    await sql`delete from sf_budget_groups`;
  });
  afterAll(async () => { await sql.end(); });

  describe('groups', () => {
    it('creates a group, lists it and shows the invite only to the owner', async () => {
      const group = await tripGroup();
      expect(group.inviteCode).toMatch(/^[A-Z2-9]{8}$/);
      expect(group.inviteURL).toBe(`https://api.hearthapps.com/suffice/join/${group.inviteCode}`);

      const owner = await call('sarah', 'GET', `/v1/budget-groups/${group.id}`);
      expect(owner.body).toMatchObject({
        name: 'Tahoe Trip', planCents: 200000, startDate: '2026-11-01', endDate: '2026-11-05', ownerId: users.sarah, role: 'owner',
        memberCount: 3, spentCents: 0, myPaidCents: 0, inviteCode: group.inviteCode, expenses: [], settlements: [],
      });
      expect(owner.body.members).toEqual([
        { userId: users.sarah, displayName: 'Sarah', householdKey: 'jensen', role: 'owner', joinedAt: expect.any(String) },
        { userId: users.david, displayName: 'David', householdKey: null, role: 'member', joinedAt: expect.any(String) },
        { userId: users.lily, displayName: 'Lily', householdKey: null, role: 'member', joinedAt: expect.any(String) },
      ]);

      const member = await call('david', 'GET', `/v1/budget-groups/${group.id}`);
      expect(member.body).toMatchObject({ role: 'member', inviteCode: null, inviteURL: null });

      await call('david', 'POST', `/v1/budget-groups/${group.id}/expenses`, expense({ amountCents: 30000 }));
      await call('lily', 'POST', `/v1/budget-groups/${group.id}/expenses`, expense({ amountCents: 1250, payee: 'Coffee' }));
      const list = await call('david', 'GET', '/v1/budget-groups');
      expect(list.status).toBe(200);
      expect(list.body.groups).toEqual([{
        id: group.id, name: 'Tahoe Trip', planCents: 200000, startDate: '2026-11-01', endDate: '2026-11-05', ownerId: users.sarah,
        role: 'member', memberCount: 3, spentCents: 31250, myPaidCents: 30000, updatedAt: expect.any(String),
      }]);
      expect((await call('ben', 'GET', '/v1/budget-groups')).body).toEqual({ groups: [] });
    });

    it('needs Suffice Plus or Hearth+ to create, but not to join or add expenses', async () => {
      const refused = await call('david', 'POST', '/v1/budget-groups', { name: 'Gift', planCents: 10000, displayName: 'David' });
      expect(refused.status).toBe(402);
      expect(refused.body.error).toMatchObject({ code: 'ENTITLEMENT_REQUIRED', message: expect.stringContaining('Suffice Plus or Hearth+') });

      const viaHearthPlus = await call('ben', 'POST', '/v1/budget-groups', { name: 'Gift for Mom', planCents: 10000, displayName: 'Ben' });
      expect(viaHearthPlus.status).toBe(201);
      expect(viaHearthPlus.body).toMatchObject({ startDate: null, endDate: null });

      const joined = await call('lily', 'POST', `/v1/budget-groups/invites/${viaHearthPlus.body.inviteCode}/join`, { displayName: 'Lily' });
      expect(joined.status).toBe(200);
      expect((await call('lily', 'POST', `/v1/budget-groups/${viaHearthPlus.body.id}/expenses`, expense())).status).toBe(201);
    });

    it('validates what it is sent', async () => {
      const bad = [
        { name: '', planCents: 100, displayName: 'Sarah' },
        { name: 'x'.repeat(61), planCents: 100, displayName: 'Sarah' },
        { name: 'Trip', planCents: -1, displayName: 'Sarah' },
        { name: 'Trip', planCents: 100_000_001, displayName: 'Sarah' },
        { name: 'Trip', planCents: 100, displayName: 'x'.repeat(41) },
        { name: 'Trip', planCents: 100, displayName: 'Sarah', startDate: '2026-11-05', endDate: '2026-11-01' },
        { name: 'Trip', planCents: 100, displayName: 'Sarah', startDate: '11/05/2026' },
        { name: 'Trip', planCents: 100, displayName: 'Sarah', householdKey: 'k'.repeat(129) },
        { name: 'Trip', planCents: 100, displayName: 'Sarah', bankAccount: '123' },
      ];
      for (const body of bad) {
        const response = await call('sarah', 'POST', '/v1/budget-groups', body);
        expect(response.status, JSON.stringify(body)).toBe(400);
        expect(response.body.error.code).toBe('INVALID_REQUEST');
      }
      const group = await tripGroup();
      // An end date before the stored start date.
      const patch = await call('sarah', 'PATCH', `/v1/budget-groups/${group.id}`, { endDate: '2026-10-01' });
      expect(patch.status).toBe(400);
      expect(patch.body.error.code).toBe('INVALID_REQUEST');
    });

    it('lets the owner rename, re-plan and clear dates', async () => {
      const group = await tripGroup();
      await sql`update sf_budget_groups set updated_at = updated_at - interval '1 minute'`;
      const before = (await call('sarah', 'GET', `/v1/budget-groups/${group.id}`)).body.updatedAt as string;
      const patched = await call('sarah', 'PATCH', `/v1/budget-groups/${group.id}`, { name: 'Tahoe 2026', planCents: 250000, endDate: null });
      expect(patched.status).toBe(200);
      expect(patched.body).toMatchObject({ name: 'Tahoe 2026', planCents: 250000, startDate: '2026-11-01', endDate: null });
      expect(patched.body.updatedAt > before).toBe(true);
    });

    it('answers 404 to people outside the group, and 403 to anonymous sessions', async () => {
      const group = await tripGroup();
      const expenseId = (await call('david', 'POST', `/v1/budget-groups/${group.id}/expenses`, expense())).body.id as string;
      const attempts: [string, string, unknown?][] = [
        ['GET', `/v1/budget-groups/${group.id}`],
        ['PATCH', `/v1/budget-groups/${group.id}`, { name: 'Mine' }],
        ['DELETE', `/v1/budget-groups/${group.id}`],
        ['POST', `/v1/budget-groups/${group.id}/leave`],
        ['POST', `/v1/budget-groups/${group.id}/invite-code`],
        ['DELETE', `/v1/budget-groups/${group.id}/members/${users.david}`],
        ['POST', `/v1/budget-groups/${group.id}/expenses`, expense()],
        ['POST', `/v1/budget-groups/${group.id}/expenses/batch`, { expenses: [expense()] }],
        ['PATCH', `/v1/budget-groups/${group.id}/expenses/${expenseId}`, { payee: 'Mine' }],
        ['DELETE', `/v1/budget-groups/${group.id}/expenses/${expenseId}`],
        ['POST', `/v1/budget-groups/${group.id}/settlements`, { clientId: randomUUID(), fromUserId: users.david, toUserId: users.sarah, amountCents: 1 }],
        ['GET', `/v1/budget-groups/${randomUUID()}`],
      ];
      for (const [method, path, body] of attempts) {
        const response = await call('ben', method, path, body);
        expect(response.status, `${method} ${path}`).toBe(404);
        expect(response.body.error.code).toBe('GROUP_NOT_FOUND');
      }
      expect((await call('anonymous', 'GET', '/v1/budget-groups')).body.error.code).toBe('REGISTERED_IDENTITY_REQUIRED');
      expect((await call('sarah', 'GET', '/v1/budget-groups/not-a-uuid')).status).toBe(400);
      expect(await count('sf_budget_expenses', group.id)).toBe(1);
    });

    it('keeps owner actions to the owner', async () => {
      const group = await tripGroup();
      const attempts: [string, string, unknown?][] = [
        ['PATCH', `/v1/budget-groups/${group.id}`, { name: 'Mine' }],
        ['DELETE', `/v1/budget-groups/${group.id}`],
        ['POST', `/v1/budget-groups/${group.id}/invite-code`],
        ['DELETE', `/v1/budget-groups/${group.id}/members/${users.lily}`],
      ];
      for (const [method, path, body] of attempts) {
        const response = await call('david', method, path, body);
        expect(response.status, `${method} ${path}`).toBe(403);
        expect(response.body.error.code).toBe('NOT_GROUP_OWNER');
      }
      expect((await call('sarah', 'GET', `/v1/budget-groups/${group.id}`)).body.memberCount).toBe(3);
    });

    it('erases the group and everything in it when the owner deletes it', async () => {
      const group = await tripGroup();
      await call('david', 'POST', `/v1/budget-groups/${group.id}/expenses`, expense());
      await call('sarah', 'POST', `/v1/budget-groups/${group.id}/settlements`, {
        clientId: randomUUID(), fromUserId: users.david, toUserId: users.sarah, amountCents: 100,
      });
      expect((await call('sarah', 'DELETE', `/v1/budget-groups/${group.id}`)).status).toBe(204);
      for (const table of ['sf_budget_members', 'sf_budget_expenses', 'sf_budget_settlements']) {
        expect(await count(table, group.id)).toBe(0);
      }
      expect(await sql`select 1 from sf_budget_groups where id = ${group.id}`).toHaveLength(0);
      expect((await call('david', 'GET', `/v1/budget-groups/${group.id}`)).status).toBe(404);
      expect((await call('ben', 'GET', `/v1/budget-groups/invites/${group.inviteCode}`)).status).toBe(404);
    });

    it(`caps owned groups at ${BUDGET_LIMITS.ownedGroupsPerUser}`, async () => {
      for (let index = 0; index < BUDGET_LIMITS.ownedGroupsPerUser; index += 1) {
        expect((await call('sarah', 'POST', '/v1/budget-groups', { name: `Group ${index}`, planCents: 0, displayName: 'Sarah' })).status).toBe(201);
      }
      const over = await call('sarah', 'POST', '/v1/budget-groups', { name: 'One more', planCents: 0, displayName: 'Sarah' });
      expect(over.status).toBe(409);
      expect(over.body.error.code).toBe('TOO_MANY_GROUPS');
      // Being a member elsewhere doesn't count.
      expect((await call('ben', 'POST', '/v1/budget-groups', { name: 'Ben’s', planCents: 0, displayName: 'Ben' })).status).toBe(201);
    });
  });

  describe('invites', () => {
    it('previews an invite, joins idempotently and updates the display name', async () => {
      const group = await tripGroup();
      const preview = await call('ben', 'GET', `/v1/budget-groups/invites/${group.inviteCode.toLowerCase()}`);
      expect(preview.status).toBe(200);
      expect(preview.body).toEqual({
        groupId: group.id, name: 'Tahoe Trip', planCents: 200000, startDate: '2026-11-01', endDate: '2026-11-05', ownerName: 'Sarah',
        memberNames: ['Sarah', 'David', 'Lily'], memberCount: 3, alreadyMember: false,
      });
      expect((await call('david', 'GET', `/v1/budget-groups/invites/${group.inviteCode}`)).body.alreadyMember).toBe(true);

      const again = await call('david', 'POST', `/v1/budget-groups/invites/${group.inviteCode}/join`, { displayName: 'Dave', householdKey: 'jensen' });
      expect(again.status).toBe(200);
      expect(again.body.memberCount).toBe(3);
      expect(again.body.members[1]).toMatchObject({ userId: users.david, displayName: 'Dave', householdKey: 'jensen', role: 'member' });
      // Leaving the key out keeps it; the owner joining their own group stays the owner.
      const kept = await call('david', 'POST', `/v1/budget-groups/invites/${group.inviteCode}/join`, { displayName: 'David' });
      expect(kept.body.members[1]).toMatchObject({ displayName: 'David', householdKey: 'jensen' });
      const owner = await call('sarah', 'POST', `/v1/budget-groups/invites/${group.inviteCode}/join`, { displayName: 'Sarah J' });
      expect(owner.body).toMatchObject({ role: 'owner', inviteCode: group.inviteCode });
    });

    it('rotates the invite code, and the old one stops working', async () => {
      const group = await tripGroup();
      const rotated = await call('sarah', 'POST', `/v1/budget-groups/${group.id}/invite-code`);
      expect(rotated.status).toBe(200);
      expect(rotated.body.inviteCode).not.toBe(group.inviteCode);
      expect(rotated.body.inviteURL).toBe(`https://api.hearthapps.com/suffice/join/${rotated.body.inviteCode}`);
      for (const [method, path] of [
        ['GET', `/v1/budget-groups/invites/${group.inviteCode}`],
        ['POST', `/v1/budget-groups/invites/${group.inviteCode}/join`],
      ] as const) {
        const old = await call('ben', method, path, method === 'POST' ? { displayName: 'Ben' } : undefined);
        expect(old.status).toBe(404);
        expect(old.body.error.code).toBe('INVITE_NOT_FOUND');
      }
      expect((await call('ben', 'POST', `/v1/budget-groups/invites/${rotated.body.inviteCode}/join`, { displayName: 'Ben' })).status).toBe(200);
      expect((await call('ben', 'GET', '/v1/budget-groups/invites/ABCD2345')).body.error.code).toBe('INVITE_NOT_FOUND');
      expect((await call('ben', 'GET', '/v1/budget-groups/invites/short')).status).toBe(400);
    });

    it(`caps a group at ${BUDGET_LIMITS.membersPerGroup} members`, async () => {
      const group = await tripGroup();
      const extra = Array.from({ length: BUDGET_LIMITS.membersPerGroup - 3 }, (_, index) => ({
        group_id: group.id, user_id: randomUUID(), role: 'member', display_name: `Friend ${index}`,
      }));
      await sql`insert into sf_budget_members ${sql(extra, 'group_id', 'user_id', 'role', 'display_name')}`;
      const full = await call('ben', 'POST', `/v1/budget-groups/invites/${group.inviteCode}/join`, { displayName: 'Ben' });
      expect(full.status).toBe(409);
      expect(full.body.error.code).toBe('GROUP_FULL');
      // Someone already in can still rejoin.
      expect((await call('lily', 'POST', `/v1/budget-groups/invites/${group.inviteCode}/join`, { displayName: 'Lily' })).status).toBe(200);
    });

    it('serves an invite page naming the group and saying where group budgets live', async () => {
      const group = await tripGroup();
      await call('sarah', 'PATCH', `/v1/budget-groups/${group.id}`, { name: '<b>Tahoe</b> & co' });
      const page = await testApp(service).request(`/suffice/join/${group.inviteCode.toLowerCase()}`);
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain("You're invited to a group budget in Suffice");
      expect(html).toContain('&lt;b&gt;Tahoe&lt;/b&gt; &amp; co');
      expect(html).toContain("Group budgets are stored on Hearth's servers");
      expect(html).toContain(group.inviteCode);
      const unknown = await (await testApp(service).request('/suffice/join/ABCD2345')).text();
      expect(unknown).not.toContain('<h2>');
    });
  });

  describe('leaving', () => {
    async function withActivity() {
      const group = await tripGroup();
      await call('david', 'POST', `/v1/budget-groups/${group.id}/expenses`, expense({ payee: 'Gas' }));
      await call('david', 'POST', `/v1/budget-groups/${group.id}/expenses`, expense({ payee: 'Snacks' }));
      await call('lily', 'POST', `/v1/budget-groups/${group.id}/expenses`, expense({ payee: 'Groceries' }));
      const settle = (who: Who, from: Who, to: Who) => call(who, 'POST', `/v1/budget-groups/${group.id}/settlements`, {
        clientId: randomUUID(), fromUserId: users[from], toUserId: users[to], amountCents: 500,
      });
      expect((await settle('sarah', 'david', 'sarah')).status).toBe(201);
      expect((await settle('lily', 'sarah', 'lily')).status).toBe(201);
      // Recorded by David, between two others: stays when he leaves.
      expect((await settle('david', 'lily', 'sarah')).status).toBe(201);
      return group;
    }

    it('removes the leaver’s expenses and the settlements to or from them', async () => {
      const group = await withActivity();
      expect((await call('david', 'POST', `/v1/budget-groups/${group.id}/leave`)).status).toBe(204);
      const view = (await call('sarah', 'GET', `/v1/budget-groups/${group.id}`)).body;
      expect(view.memberCount).toBe(2);
      expect(view.expenses.map((entry: { payee: string }) => entry.payee)).toEqual(['Groceries']);
      expect(view.spentCents).toBe(45000);
      expect(view.settlements.map((entry: { fromUserId: string }) => entry.fromUserId).sort()).toEqual([users.lily, users.sarah].sort());
      expect((await call('david', 'GET', `/v1/budget-groups/${group.id}`)).status).toBe(404);
    });

    it('does the same when the owner removes someone', async () => {
      const group = await withActivity();
      expect((await call('sarah', 'DELETE', `/v1/budget-groups/${group.id}/members/${users.david}`)).status).toBe(204);
      expect(await sql`select 1 from sf_budget_expenses where paid_by = ${users.david}`).toHaveLength(0);
      expect(await sql`
        select 1 from sf_budget_settlements where from_user_id = ${users.david} or to_user_id = ${users.david}`).toHaveLength(0);
      expect(await count('sf_budget_settlements', group.id)).toBe(2);
      const missing = await call('sarah', 'DELETE', `/v1/budget-groups/${group.id}/members/${users.ben}`);
      expect(missing.status).toBe(404);
      expect(missing.body.error.code).toBe('MEMBER_NOT_FOUND');
      // A member's own id leaves.
      expect((await call('lily', 'DELETE', `/v1/budget-groups/${group.id}/members/${users.lily}`)).status).toBe(204);
      expect((await call('sarah', 'GET', `/v1/budget-groups/${group.id}`)).body.memberCount).toBe(1);
    });

    it('doesn’t let the owner leave', async () => {
      const group = await tripGroup();
      for (const [method, path] of [
        ['POST', `/v1/budget-groups/${group.id}/leave`],
        ['DELETE', `/v1/budget-groups/${group.id}/members/${users.sarah}`],
      ] as const) {
        const response = await call('sarah', method, path);
        expect(response.status).toBe(409);
        expect(response.body.error.code).toBe('OWNER_CANNOT_LEAVE');
      }
    });

    it('deletes a person’s budget data with their account', async () => {
      const group = await withActivity();
      const davids = await call('david', 'POST', '/v1/budget-groups/invites/' + group.inviteCode + '/join', { displayName: 'David' });
      expect(davids.status).toBe(200);
      const own = await call('ben', 'POST', '/v1/budget-groups', { name: 'Ben’s', planCents: 0, displayName: 'Ben' });
      await call('lily', 'POST', `/v1/budget-groups/invites/${own.body.inviteCode}/join`, { displayName: 'Lily' });
      await call('lily', 'POST', `/v1/budget-groups/${own.body.id}/expenses`, expense());
      await call('ben', 'POST', `/v1/budget-groups/invites/${group.inviteCode}/join`, { displayName: 'Ben' });

      await service.purgeUser(users.ben);
      expect(await sql`select 1 from sf_budget_groups where id = ${own.body.id}`).toHaveLength(0);
      expect(await sql`select 1 from sf_budget_members where user_id = ${users.ben}`).toHaveLength(0);

      await service.purgeUser(users.david);
      expect(await sql`select 1 from sf_budget_members where user_id = ${users.david}`).toHaveLength(0);
      expect(await sql`select 1 from sf_budget_expenses where paid_by = ${users.david}`).toHaveLength(0);
      expect((await call('sarah', 'GET', `/v1/budget-groups/${group.id}`)).body.memberCount).toBe(2);
    });
  });

  describe('expenses', () => {
    it('adds an expense once per clientId', async () => {
      const group = await tripGroup();
      const body = expense({ note: '  Two nights ' });
      const first = await call('david', 'POST', `/v1/budget-groups/${group.id}/expenses`, body);
      expect(first.status).toBe(201);
      expect(first.body).toEqual({
        id: expect.any(String), clientId: body.clientId, payee: 'Cabin rental', amountCents: 45000, date: '2026-11-02',
        note: 'Two nights', paidBy: users.david, createdAt: expect.any(String),
      });
      const again = await call('david', 'POST', `/v1/budget-groups/${group.id}/expenses`, { ...body, amountCents: 1 });
      expect(again.status).toBe(200);
      expect(again.body).toEqual(first.body);
      // Another member's clientId is their own.
      const lily = await call('lily', 'POST', `/v1/budget-groups/${group.id}/expenses`, body);
      expect(lily.status).toBe(201);
      expect(lily.body.id).not.toBe(first.body.id);
      expect(await count('sf_budget_expenses', group.id)).toBe(2);
    });

    it('uploads a batch, idempotent per item, and lists expenses newest date first', async () => {
      const group = await tripGroup();
      const existing = expense({ date: '2026-11-03', payee: 'Ski passes' });
      const first = await call('sarah', 'POST', `/v1/budget-groups/${group.id}/expenses`, existing);
      const items = [expense({ date: '2026-11-01', payee: 'Gas' }), existing, expense({ date: '2026-11-04', payee: 'Dinner', note: '' })];
      const batch = await call('sarah', 'POST', `/v1/budget-groups/${group.id}/expenses/batch`, { expenses: [...items, items[0]] });
      expect(batch.status).toBe(200);
      expect(batch.body.expenses.map((entry: { payee: string }) => entry.payee)).toEqual(['Gas', 'Ski passes', 'Dinner']);
      expect(batch.body.expenses[1]).toEqual(first.body);
      expect(batch.body.expenses[2].note).toBeNull();
      const replay = await call('sarah', 'POST', `/v1/budget-groups/${group.id}/expenses/batch`, { expenses: items });
      expect(replay.body).toEqual(batch.body);
      const view = (await call('david', 'GET', `/v1/budget-groups/${group.id}`)).body;
      expect(view.expenses.map((entry: { payee: string }) => entry.payee)).toEqual(['Dinner', 'Ski passes', 'Gas']);
      expect(view.spentCents).toBe(135000);
      expect(view.myPaidCents).toBe(0);

      expect((await call('sarah', 'POST', `/v1/budget-groups/${group.id}/expenses/batch`, { expenses: [] })).status).toBe(400);
      const tooMany = Array.from({ length: BUDGET_LIMITS.expensesPerBatch + 1 }, () => expense());
      expect((await call('sarah', 'POST', `/v1/budget-groups/${group.id}/expenses/batch`, { expenses: tooMany })).status).toBe(400);
      for (const bad of [{ amountCents: 0 }, { amountCents: 100_000_001 }, { payee: ' ' }, { clientId: 'device-1' }, { note: 'x'.repeat(501) }, { date: '2026-13-01' }]) {
        expect((await call('sarah', 'POST', `/v1/budget-groups/${group.id}/expenses`, expense(bad))).status, JSON.stringify(bad)).toBe(400);
      }
    });

    it(`caps a group at ${BUDGET_LIMITS.expensesPerGroup} expenses`, async () => {
      const group = await tripGroup();
      const rows = Array.from({ length: BUDGET_LIMITS.expensesPerGroup - 1 }, () => ({
        group_id: group.id, client_id: randomUUID(), paid_by: users.lily, payee: 'Old', amount_cents: 1, date: '2026-10-01',
      }));
      await sql`insert into sf_budget_expenses ${sql(rows, 'group_id', 'client_id', 'paid_by', 'payee', 'amount_cents', 'date')}`;
      const batch = await call('david', 'POST', `/v1/budget-groups/${group.id}/expenses/batch`, { expenses: [expense(), expense()] });
      expect(batch.status).toBe(409);
      expect(batch.body.error.code).toBe('GROUP_EXPENSE_LIMIT');
      const last = expense();
      expect((await call('david', 'POST', `/v1/budget-groups/${group.id}/expenses`, last)).status).toBe(201);
      const over = await call('david', 'POST', `/v1/budget-groups/${group.id}/expenses`, expense());
      expect(over.status).toBe(409);
      expect(over.body.error.code).toBe('GROUP_EXPENSE_LIMIT');
      // A replay isn't a new expense.
      expect((await call('david', 'POST', `/v1/budget-groups/${group.id}/expenses`, last)).status).toBe(200);
    });

    it('lets only the author change an expense, and the author or owner delete it', async () => {
      const group = await tripGroup();
      const posted = (await call('david', 'POST', `/v1/budget-groups/${group.id}/expenses`, expense({ note: 'Deposit' }))).body;
      const path = `/v1/budget-groups/${group.id}/expenses/${posted.id}`;
      for (const who of ['sarah', 'lily'] as const) {
        const response = await call(who, 'PATCH', path, { amountCents: 1 });
        expect(response.status).toBe(403);
        expect(response.body.error.code).toBe('NOT_EXPENSE_AUTHOR');
      }
      await sql`update sf_budget_groups set updated_at = updated_at - interval '1 minute'`;
      const before = (await call('david', 'GET', `/v1/budget-groups/${group.id}`)).body.updatedAt as string;
      const patched = await call('david', 'PATCH', path, { payee: 'Cabin', amountCents: 50000, date: '2026-11-01', note: null });
      expect(patched.status).toBe(200);
      expect(patched.body).toMatchObject({ id: posted.id, clientId: posted.clientId, payee: 'Cabin', amountCents: 50000, date: '2026-11-01', note: null });
      expect((await call('david', 'GET', `/v1/budget-groups/${group.id}`)).body.updatedAt > before).toBe(true);

      const lilys = await call('lily', 'DELETE', path);
      expect(lilys.status).toBe(403);
      expect(lilys.body.error.code).toBe('NOT_EXPENSE_AUTHOR');
      expect((await call('sarah', 'DELETE', path)).status).toBe(204);
      expect((await call('david', 'DELETE', path)).body.error.code).toBe('EXPENSE_NOT_FOUND');
      const own = (await call('lily', 'POST', `/v1/budget-groups/${group.id}/expenses`, expense())).body;
      expect((await call('lily', 'DELETE', `/v1/budget-groups/${group.id}/expenses/${own.id}`)).status).toBe(204);
      expect(await count('sf_budget_expenses', group.id)).toBe(0);
    });
  });

  describe('settlements', () => {
    it('records payments between members, once per clientId', async () => {
      const group = await tripGroup();
      const body = { clientId: randomUUID(), fromUserId: users.david, toUserId: users.sarah, amountCents: 15000 };
      const first = await call('lily', 'POST', `/v1/budget-groups/${group.id}/settlements`, body);
      expect(first.status).toBe(201);
      expect(first.body).toEqual({ id: expect.any(String), ...body, createdBy: users.lily, createdAt: expect.any(String) });
      const again = await call('lily', 'POST', `/v1/budget-groups/${group.id}/settlements`, { ...body, amountCents: 1 });
      expect(again.status).toBe(200);
      expect(again.body).toEqual(first.body);
      expect((await call('sarah', 'GET', `/v1/budget-groups/${group.id}`)).body.settlements).toEqual([first.body]);
    });

    it('refuses settlements with someone outside the group or with yourself', async () => {
      const group = await tripGroup();
      for (const [from, to] of [[users.david, users.ben], [users.ben, users.sarah], [users.david, users.david]] as const) {
        const response = await call('sarah', 'POST', `/v1/budget-groups/${group.id}/settlements`, {
          clientId: randomUUID(), fromUserId: from, toUserId: to, amountCents: 100,
        });
        expect(response.status).toBe(400);
        expect(response.body.error.code).toBe('INVALID_REQUEST');
      }
      for (const amountCents of [0, 100_000_001]) {
        expect((await call('sarah', 'POST', `/v1/budget-groups/${group.id}/settlements`, {
          clientId: randomUUID(), fromUserId: users.david, toUserId: users.sarah, amountCents,
        })).status).toBe(400);
      }
      expect(await count('sf_budget_settlements', group.id)).toBe(0);
    });

    it('lets the creator or the owner delete a settlement', async () => {
      const group = await tripGroup();
      const record = async (who: Who) => (await call(who, 'POST', `/v1/budget-groups/${group.id}/settlements`, {
        clientId: randomUUID(), fromUserId: users.david, toUserId: users.lily, amountCents: 100,
      })).body as { id: string };
      const davids = await record('david');
      const denied = await call('lily', 'DELETE', `/v1/budget-groups/${group.id}/settlements/${davids.id}`);
      expect(denied.status).toBe(403);
      expect(denied.body.error.code).toBe('NOT_SETTLEMENT_CREATOR');
      expect((await call('sarah', 'DELETE', `/v1/budget-groups/${group.id}/settlements/${davids.id}`)).status).toBe(204);
      const lilys = await record('lily');
      expect((await call('lily', 'DELETE', `/v1/budget-groups/${group.id}/settlements/${lilys.id}`)).status).toBe(204);
      const gone = await call('lily', 'DELETE', `/v1/budget-groups/${group.id}/settlements/${lilys.id}`);
      expect(gone.body.error.code).toBe('SETTLEMENT_NOT_FOUND');
    });
  });
});

describe('Suffice group budgets without a database', () => {
  it('answers 503 instead of failing', async () => {
    const app = createApp({ config: readConfig({}), verifyToken: async () => ({ userId: users.sarah, isAnonymous: false }) });
    const response = await app.request('/v1/budget-groups', { headers: { Authorization: 'Bearer x' } });
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe('STORAGE_NOT_CONFIGURED');
  });

  it('gates creating a group on Suffice Plus or Hearth+, never joining', async () => {
    const budgetGroups = {
      createGroup: vi.fn(async () => ({ id: 'group-1' })),
      join: vi.fn(async () => ({ id: 'group-1' })),
      addExpense: vi.fn(async () => ({ expense: { id: 'expense-1' }, created: true })),
    } as unknown as BudgetGroupsService;
    const call = caller(testApp(budgetGroups));
    const create = { name: 'Trip', planCents: 1000, displayName: 'Lily' };
    const refused = await call('lily', 'POST', '/v1/budget-groups', create);
    expect(refused.status).toBe(402);
    expect(refused.body.error.code).toBe('ENTITLEMENT_REQUIRED');
    expect(budgetGroups.createGroup).not.toHaveBeenCalled();
    expect((await call('sarah', 'POST', '/v1/budget-groups', create)).status).toBe(201);
    expect((await call('ben', 'POST', '/v1/budget-groups', create)).status).toBe(201);
    expect((await call('lily', 'POST', '/v1/budget-groups/invites/ABCD2345/join', { displayName: 'Lily' })).status).toBe(200);
    expect((await call('lily', 'POST', `/v1/budget-groups/${randomUUID()}/expenses`, expense())).status).toBe(201);
    // Writes need a JSON body; leave and invite-code don't carry one.
    const app = testApp(budgetGroups);
    const plain = await app.request('/v1/budget-groups', { method: 'POST', headers: { Authorization: 'Bearer sarah' }, body: 'x' });
    expect(plain.status).toBe(400);
  });

  it('serves the invite page and the Suffice universal link', async () => {
    const app = createApp({ config: readConfig({ APPLE_APP_IDS: 'BH8R3BX5WF.com.stephenwarren.suffice,BH8R3BX5WF.com.stephenwarren.hearken' }) });
    const page = await app.request('/suffice/join/abcd2345');
    const html = await page.text();
    expect(html).toContain('ABCD2345');
    expect(html).toContain("You're invited to a group budget in Suffice");
    expect(html).toContain("Group budgets are stored on Hearth's servers");
    expect(await (await app.request('/suffice/join/%3Cscript%3E')).text()).not.toContain('<script>');
    const aasa = await (await app.request('/.well-known/apple-app-site-association')).json();
    expect(aasa.applinks.details).toContainEqual({
      appIDs: ['BH8R3BX5WF.com.stephenwarren.suffice'],
      components: [{ '/': '/suffice/join/*', comment: 'Suffice group budget invites' }],
    });
  });

  it('is in the OpenAPI document', async () => {
    const document = await (await createApp({ config: readConfig({}) }).request('/openapi.json')).json();
    expect(Object.keys(document.paths).filter((path) => path.startsWith('/v1/budget-groups')).sort()).toEqual([
      '/v1/budget-groups',
      '/v1/budget-groups/invites/{code}',
      '/v1/budget-groups/invites/{code}/join',
      '/v1/budget-groups/{groupId}',
      '/v1/budget-groups/{groupId}/expenses',
      '/v1/budget-groups/{groupId}/expenses/batch',
      '/v1/budget-groups/{groupId}/expenses/{expenseId}',
      '/v1/budget-groups/{groupId}/invite-code',
      '/v1/budget-groups/{groupId}/leave',
      '/v1/budget-groups/{groupId}/members/{userId}',
      '/v1/budget-groups/{groupId}/settlements',
      '/v1/budget-groups/{groupId}/settlements/{settlementId}',
    ]);
    expect(document.paths['/v1/budget-groups'].post.security).toEqual([{ BearerAuth: [] }]);
  });
});
