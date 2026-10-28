import type { Sql, TransactionSql } from 'postgres';
import { ApiError } from '../errors.js';
import { isUniqueViolation, newInviteCode } from '../hearken/service.js';

/**
 * Suffice group budgets: a budget shared with people outside the household. Everything else in
 * Suffice stays in iCloud; a group keeps only what its members share: its name and plan, their
 * display names, shared expenses and settle-up payments (the settle-up math is the app's).
 *
 * Every read and write is scoped by the caller's membership; group ids from the client never grant
 * access on their own, and a group you aren't in looks the same as one that doesn't exist.
 */

export const BUDGET_LIMITS = {
  ownedGroupsPerUser: 20,
  membersPerGroup: 50,
  expensesPerGroup: 2000,
  settlementsPerGroup: 2000,
  expensesPerBatch: 500,
} as const;

export type BudgetRole = 'owner' | 'member';

export type BudgetMemberView = {
  userId: string;
  displayName: string;
  householdKey: string | null;
  role: BudgetRole;
  joinedAt: string;
};

export type BudgetExpenseView = {
  id: string;
  clientId: string;
  payee: string;
  amountCents: number;
  date: string;
  note: string | null;
  paidBy: string;
  createdAt: string;
};

export type BudgetSettlementView = {
  id: string;
  clientId: string;
  fromUserId: string;
  toUserId: string;
  amountCents: number;
  createdBy: string;
  createdAt: string;
};

export type BudgetGroupSummary = {
  id: string;
  name: string;
  planCents: number;
  startDate: string | null;
  endDate: string | null;
  ownerId: string;
  role: BudgetRole;
  memberCount: number;
  spentCents: number;
  myPaidCents: number;
  updatedAt: string;
};

export type BudgetGroupView = BudgetGroupSummary & {
  /** Only the owner sees the invite. */
  inviteCode: string | null;
  inviteURL: string | null;
  members: BudgetMemberView[];
  /** Newest date first. */
  expenses: BudgetExpenseView[];
  /** Newest first. */
  settlements: BudgetSettlementView[];
};

export type CreateBudgetGroupInput = {
  name: string;
  planCents: number;
  startDate?: string | null | undefined;
  endDate?: string | null | undefined;
  displayName: string;
  householdKey?: string | null | undefined;
};

export type UpdateBudgetGroupInput = {
  name?: string | undefined;
  planCents?: number | undefined;
  /** null clears the date; leaving it out keeps it. */
  startDate?: string | null | undefined;
  endDate?: string | null | undefined;
};

export type BudgetExpenseInput = {
  clientId: string;
  payee: string;
  amountCents: number;
  date: string;
  note?: string | null | undefined;
};

export type UpdateBudgetExpenseInput = {
  payee?: string | undefined;
  amountCents?: number | undefined;
  date?: string | undefined;
  note?: string | null | undefined;
};

export type BudgetSettlementInput = {
  clientId: string;
  fromUserId: string;
  toUserId: string;
  amountCents: number;
};

export type BudgetGroupsServiceOptions = {
  sql: Sql;
  publicBaseUrl: string;
};

type Db = Sql | TransactionSql;

type SummaryRow = {
  id: string; owner_id: string; name: string; plan_cents: number; start_date: string | null; end_date: string | null;
  invite_code: string; updated_at: Date; role: BudgetRole; member_count: number; spent_cents: string; my_paid_cents: string;
};
type MemberRow = { user_id: string; display_name: string; household_key: string | null; role: BudgetRole; joined_at: Date };
type ExpenseRow = {
  id: string; client_id: string; paid_by: string; payee: string; amount_cents: number; date: string; note: string | null; created_at: Date;
};
type SettlementRow = {
  id: string; client_id: string; created_by: string; from_user_id: string; to_user_id: string; amount_cents: number; created_at: Date;
};

const iso = (value: Date) => value.toISOString();
/** An empty note or household key means none. */
const orNull = (value: string | null | undefined) => (value === undefined ? undefined : value?.trim() ? value.trim() : null);

const notFound = () => new ApiError(404, 'GROUP_NOT_FOUND', 'That group no longer exists, or you are not in it');
const inviteNotFound = () => new ApiError(404, 'INVITE_NOT_FOUND', 'That invite code isn’t valid. Ask for a new one.');
const notOwner = (what: string) => new ApiError(403, 'NOT_GROUP_OWNER', `Only the group’s owner can ${what}`);

/** A check constraint failed: here, only an end date before the start date gets this far. */
function isCheckViolation(error: unknown) {
  return (error as { code?: string | undefined })?.code === '23514';
}
const badDates = () => new ApiError(400, 'INVALID_REQUEST', 'The end date can’t be before the start date');

const expenseView = (row: ExpenseRow): BudgetExpenseView => ({
  id: row.id, clientId: row.client_id, payee: row.payee, amountCents: row.amount_cents, date: row.date, note: row.note,
  paidBy: row.paid_by, createdAt: iso(row.created_at),
});
const settlementView = (row: SettlementRow): BudgetSettlementView => ({
  id: row.id, clientId: row.client_id, fromUserId: row.from_user_id, toUserId: row.to_user_id, amountCents: row.amount_cents,
  createdBy: row.created_by, createdAt: iso(row.created_at),
});

export function createBudgetGroupsService(options: BudgetGroupsServiceOptions) {
  const { sql } = options;
  const inviteURL = (code: string) => new URL(`/suffice/join/${code}`, options.publicBaseUrl).toString();

  // MARK: Access

  async function membership(db: Db, groupId: string, userId: string) {
    const [row] = await db<{ role: BudgetRole; owner_id: string }[]>`
      select m.role, g.owner_id
      from sf_budget_members m join sf_budget_groups g on g.id = m.group_id
      where m.group_id = ${groupId} and m.user_id = ${userId}`;
    if (!row) throw notFound();
    return row;
  }

  /** Holds the group's row until the transaction ends, so limits are checked against settled counts. */
  async function lockGroup(tx: TransactionSql, groupId: string) {
    await tx`select id from sf_budget_groups where id = ${groupId} for update`;
  }

  const touch = (db: Db, groupId: string) => db`update sf_budget_groups set updated_at = now() where id = ${groupId}`;

  // MARK: Views

  async function summaryRows(db: Db, me: string, groupId?: string) {
    return db<SummaryRow[]>`
      select g.id, g.owner_id, g.name, g.plan_cents, g.start_date::text as start_date, g.end_date::text as end_date,
             g.invite_code, g.updated_at, m.role,
             (select count(*)::int from sf_budget_members where group_id = g.id) as member_count,
             (select coalesce(sum(amount_cents), 0)::bigint from sf_budget_expenses where group_id = g.id) as spent_cents,
             (select coalesce(sum(amount_cents), 0)::bigint from sf_budget_expenses where group_id = g.id and paid_by = ${me})
               as my_paid_cents
      from sf_budget_groups g join sf_budget_members m on m.group_id = g.id and m.user_id = ${me}
      ${groupId ? db`where g.id = ${groupId}` : db``}
      order by g.updated_at desc, g.id`;
  }

  const summary = (row: SummaryRow): BudgetGroupSummary => ({
    id: row.id, name: row.name, planCents: row.plan_cents, startDate: row.start_date, endDate: row.end_date, ownerId: row.owner_id,
    role: row.role, memberCount: row.member_count, spentCents: Number(row.spent_cents), myPaidCents: Number(row.my_paid_cents),
    updatedAt: iso(row.updated_at),
  });

  async function view(db: Db, me: string, groupId: string): Promise<BudgetGroupView> {
    const [row] = await summaryRows(db, me, groupId);
    if (!row) throw notFound();
    const [members, expenses, settlements] = await Promise.all([
      db<MemberRow[]>`
        select user_id, display_name, household_key, role, joined_at from sf_budget_members
        where group_id = ${groupId} order by joined_at, user_id`,
      db<ExpenseRow[]>`
        select id, client_id, paid_by, payee, amount_cents, date::text as date, note, created_at from sf_budget_expenses
        where group_id = ${groupId} order by date desc, created_at desc, id`,
      db<SettlementRow[]>`
        select id, client_id, created_by, from_user_id, to_user_id, amount_cents, created_at from sf_budget_settlements
        where group_id = ${groupId} order by created_at desc, id`,
    ]);
    const isOwner = row.role === 'owner';
    return {
      ...summary(row),
      inviteCode: isOwner ? row.invite_code : null,
      inviteURL: isOwner ? inviteURL(row.invite_code) : null,
      members: members.map((member) => ({
        userId: member.user_id, displayName: member.display_name, householdKey: member.household_key, role: member.role,
        joinedAt: iso(member.joined_at),
      })),
      expenses: expenses.map(expenseView),
      settlements: settlements.map(settlementView),
    };
  }

  // MARK: Groups

  async function listGroups(me: string) {
    return (await summaryRows(sql, me)).map(summary);
  }

  async function getGroup(me: string, groupId: string) {
    return view(sql, me, groupId);
  }

  async function createGroup(me: string, input: CreateBudgetGroupInput) {
    try {
      return await sql.begin(async (tx) => {
        // One create at a time per owner, so the limit holds.
        await tx`select pg_advisory_xact_lock(hashtext(${`sf_budget_owner:${me}`}))`;
        const [owned] = await tx<{ count: number }[]>`select count(*)::int as count from sf_budget_groups where owner_id = ${me}`;
        if ((owned?.count ?? 0) >= BUDGET_LIMITS.ownedGroupsPerUser) {
          throw new ApiError(409, 'TOO_MANY_GROUPS', `You can own up to ${BUDGET_LIMITS.ownedGroupsPerUser} group budgets`);
        }
        let id: string | undefined;
        for (let attempt = 0; attempt < 5 && !id; attempt += 1) {
          try {
            const [created] = await tx.savepoint((savepoint) => savepoint<{ id: string }[]>`
              insert into sf_budget_groups (owner_id, name, plan_cents, start_date, end_date, invite_code)
              values (${me}, ${input.name}, ${input.planCents}, ${input.startDate ?? null}, ${input.endDate ?? null}, ${newInviteCode()})
              returning id`);
            id = created!.id;
          } catch (error) {
            if (!isUniqueViolation(error, 'sf_budget_groups_invite_code_key')) throw error;
          }
        }
        if (!id) throw new ApiError(503, 'STORAGE_UNAVAILABLE', 'Could not create the group; try again');
        await tx`
          insert into sf_budget_members (group_id, user_id, role, display_name, household_key)
          values (${id}, ${me}, 'owner', ${input.displayName}, ${orNull(input.householdKey) ?? null})`;
        return view(tx, me, id);
      });
    } catch (error) {
      if (isCheckViolation(error)) throw badDates();
      throw error;
    }
  }

  async function updateGroup(me: string, groupId: string, patch: UpdateBudgetGroupInput) {
    const member = await membership(sql, groupId, me);
    if (member.role !== 'owner') throw notOwner('change the group');
    try {
      await sql`
        update sf_budget_groups set
          name = coalesce(${patch.name ?? null}, name),
          plan_cents = coalesce(${patch.planCents ?? null}::int, plan_cents),
          start_date = case when ${patch.startDate !== undefined} then ${patch.startDate ?? null}::date else start_date end,
          end_date = case when ${patch.endDate !== undefined} then ${patch.endDate ?? null}::date else end_date end,
          updated_at = now()
        where id = ${groupId}`;
    } catch (error) {
      if (isCheckViolation(error)) throw badDates();
      throw error;
    }
    return view(sql, me, groupId);
  }

  /** Erases the group and everything in it, for everyone. */
  async function deleteGroup(me: string, groupId: string) {
    const member = await membership(sql, groupId, me);
    if (member.role !== 'owner') throw notOwner('delete the group');
    await sql`delete from sf_budget_groups where id = ${groupId}`;
  }

  async function rotateInvite(me: string, groupId: string) {
    const member = await membership(sql, groupId, me);
    if (member.role !== 'owner') throw notOwner('reset the invite');
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = newInviteCode();
      try {
        await sql`update sf_budget_groups set invite_code = ${code}, updated_at = now() where id = ${groupId}`;
        return { inviteCode: code, inviteURL: inviteURL(code) };
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
      }
    }
    throw new ApiError(503, 'STORAGE_UNAVAILABLE', 'Could not reset the invite; try again');
  }

  // MARK: Invites and membership

  async function previewInvite(me: string, code: string) {
    const [row] = await sql<{
      id: string; name: string; plan_cents: number; start_date: string | null; end_date: string | null; owner_name: string | null;
      member_names: string[]; already_member: boolean;
    }[]>`
      select g.id, g.name, g.plan_cents, g.start_date::text as start_date, g.end_date::text as end_date,
             (select display_name from sf_budget_members where group_id = g.id and user_id = g.owner_id) as owner_name,
             array(select display_name from sf_budget_members where group_id = g.id order by joined_at, user_id) as member_names,
             exists (select 1 from sf_budget_members where group_id = g.id and user_id = ${me}) as already_member
      from sf_budget_groups g where g.invite_code = ${code.toUpperCase()}`;
    if (!row) throw inviteNotFound();
    return {
      groupId: row.id, name: row.name, planCents: row.plan_cents, startDate: row.start_date, endDate: row.end_date,
      ownerName: row.owner_name ?? '', memberNames: row.member_names, memberCount: row.member_names.length,
      alreadyMember: row.already_member,
    };
  }

  /** For the invite page: the group's name, or null when the code doesn't (or no longer) work. */
  async function inviteGroupName(code: string) {
    const [row] = await sql<{ name: string }[]>`select name from sf_budget_groups where invite_code = ${code.toUpperCase()}`;
    return row?.name ?? null;
  }

  /** Joins with an invite code. Joining again just updates your display name (and household key, when given). */
  async function join(me: string, code: string, input: { displayName: string; householdKey?: string | null | undefined }) {
    const groupId = await sql.begin(async (tx) => {
      const [group] = await tx<{ id: string }[]>`
        select id from sf_budget_groups where invite_code = ${code.toUpperCase()} for update`;
      if (!group) throw inviteNotFound();
      const householdKey = orNull(input.householdKey);
      const [existing] = await tx`select 1 from sf_budget_members where group_id = ${group.id} and user_id = ${me}`;
      if (existing) {
        await tx`
          update sf_budget_members set
            display_name = ${input.displayName},
            household_key = case when ${householdKey !== undefined} then ${householdKey ?? null} else household_key end
          where group_id = ${group.id} and user_id = ${me}`;
      } else {
        const [count] = await tx<{ count: number }[]>`
          select count(*)::int as count from sf_budget_members where group_id = ${group.id}`;
        if ((count?.count ?? 0) >= BUDGET_LIMITS.membersPerGroup) {
          throw new ApiError(409, 'GROUP_FULL', `This group already has ${BUDGET_LIMITS.membersPerGroup} members`);
        }
        await tx`
          insert into sf_budget_members (group_id, user_id, role, display_name, household_key)
          values (${group.id}, ${me}, 'member', ${input.displayName}, ${householdKey ?? null})`;
      }
      await touch(tx, group.id);
      return group.id;
    });
    return view(sql, me, groupId);
  }

  /**
   * Removes a member. Their expenses and every settlement to or from them go with them (the
   * foreign keys in the migration cascade from the membership).
   */
  async function depart(db: Db, groupId: string, userId: string) {
    await db`delete from sf_budget_members where group_id = ${groupId} and user_id = ${userId}`;
    await touch(db, groupId);
  }

  async function leave(me: string, groupId: string) {
    const member = await membership(sql, groupId, me);
    if (member.role === 'owner') {
      throw new ApiError(409, 'OWNER_CANNOT_LEAVE', 'The owner can’t leave the group; delete it instead');
    }
    await sql.begin((tx) => depart(tx, groupId, me));
  }

  /** Removes someone (owner), or leaves when it's your own id. */
  async function removeMember(me: string, groupId: string, userId: string) {
    if (userId === me) return leave(me, groupId);
    const member = await membership(sql, groupId, me);
    if (member.role !== 'owner') throw notOwner('remove people');
    await sql.begin(async (tx) => {
      const [target] = await tx`select 1 from sf_budget_members where group_id = ${groupId} and user_id = ${userId}`;
      if (!target) throw new ApiError(404, 'MEMBER_NOT_FOUND', 'That person is not in this group');
      await depart(tx, groupId, userId);
    });
  }

  // MARK: Expenses

  /**
   * Adds the caller's expenses, skipping any whose clientId they already added to this group.
   * Returns every expense asked for (one per clientId, in the order given) and how many are new.
   */
  async function insertExpenses(me: string, groupId: string, inputs: BudgetExpenseInput[]) {
    const unique = [...new Map(inputs.map((input) => [input.clientId.toLowerCase(), input])).values()];
    const clientIds = unique.map((input) => input.clientId.toLowerCase());
    return sql.begin(async (tx) => {
      await membership(tx, groupId, me);
      await lockGroup(tx, groupId);
      const existing = await tx<{ client_id: string }[]>`
        select client_id from sf_budget_expenses
        where group_id = ${groupId} and paid_by = ${me} and client_id = any(${clientIds}::uuid[])`;
      const known = new Set(existing.map((row) => row.client_id));
      const fresh = unique.filter((input) => !known.has(input.clientId.toLowerCase()));
      if (fresh.length > 0) {
        const [count] = await tx<{ count: number }[]>`
          select count(*)::int as count from sf_budget_expenses where group_id = ${groupId}`;
        if ((count?.count ?? 0) + fresh.length > BUDGET_LIMITS.expensesPerGroup) {
          throw new ApiError(409, 'GROUP_EXPENSE_LIMIT', `A group can hold up to ${BUDGET_LIMITS.expensesPerGroup} expenses`);
        }
        const rows = fresh.map((input) => ({
          group_id: groupId, client_id: input.clientId.toLowerCase(), paid_by: me, payee: input.payee,
          amount_cents: input.amountCents, date: input.date, note: orNull(input.note) ?? null,
        }));
        await tx`
          insert into sf_budget_expenses ${tx(rows, 'group_id', 'client_id', 'paid_by', 'payee', 'amount_cents', 'date', 'note')}
          on conflict (group_id, paid_by, client_id) do nothing`;
        await touch(tx, groupId);
      }
      const saved = await tx<ExpenseRow[]>`
        select id, client_id, paid_by, payee, amount_cents, date::text as date, note, created_at from sf_budget_expenses
        where group_id = ${groupId} and paid_by = ${me} and client_id = any(${clientIds}::uuid[])`;
      const byClientId = new Map(saved.map((row) => [row.client_id, row]));
      return {
        expenses: clientIds.map((clientId) => expenseView(byClientId.get(clientId)!)),
        created: fresh.length,
      };
    });
  }

  /** Adds an expense paid by the caller. `created` is false when this clientId was already added. */
  async function addExpense(me: string, groupId: string, input: BudgetExpenseInput) {
    const result = await insertExpenses(me, groupId, [input]);
    return { expense: result.expenses[0]!, created: result.created > 0 };
  }

  async function addExpenses(me: string, groupId: string, inputs: BudgetExpenseInput[]) {
    return (await insertExpenses(me, groupId, inputs)).expenses;
  }

  async function expenseAuthor(groupId: string, expenseId: string) {
    const [row] = await sql<{ paid_by: string }[]>`
      select paid_by from sf_budget_expenses where id = ${expenseId} and group_id = ${groupId}`;
    if (!row) throw new ApiError(404, 'EXPENSE_NOT_FOUND', 'That expense no longer exists');
    return row.paid_by;
  }

  async function updateExpense(me: string, groupId: string, expenseId: string, patch: UpdateBudgetExpenseInput) {
    await membership(sql, groupId, me);
    if (await expenseAuthor(groupId, expenseId) !== me) {
      throw new ApiError(403, 'NOT_EXPENSE_AUTHOR', 'Only the person who added an expense can change it');
    }
    const note = orNull(patch.note);
    const [row] = await sql.begin(async (tx) => {
      const updated = await tx<ExpenseRow[]>`
        update sf_budget_expenses set
          payee = coalesce(${patch.payee ?? null}, payee),
          amount_cents = coalesce(${patch.amountCents ?? null}::int, amount_cents),
          date = coalesce(${patch.date ?? null}::date, date),
          note = case when ${note !== undefined} then ${note ?? null} else note end,
          updated_at = now()
        where id = ${expenseId} and group_id = ${groupId}
        returning id, client_id, paid_by, payee, amount_cents, date::text as date, note, created_at`;
      await touch(tx, groupId);
      return updated;
    });
    if (!row) throw new ApiError(404, 'EXPENSE_NOT_FOUND', 'That expense no longer exists');
    return expenseView(row);
  }

  async function deleteExpense(me: string, groupId: string, expenseId: string) {
    const member = await membership(sql, groupId, me);
    if (await expenseAuthor(groupId, expenseId) !== me && member.role !== 'owner') {
      throw new ApiError(403, 'NOT_EXPENSE_AUTHOR', 'Only the person who added an expense, or the owner, can delete it');
    }
    await sql.begin(async (tx) => {
      await tx`delete from sf_budget_expenses where id = ${expenseId} and group_id = ${groupId}`;
      await touch(tx, groupId);
    });
  }

  // MARK: Settlements

  /** Records a payment between two members. Recording the same clientId again returns the first one (`created` false). */
  async function addSettlement(me: string, groupId: string, input: BudgetSettlementInput) {
    const fromUserId = input.fromUserId.toLowerCase();
    const toUserId = input.toUserId.toLowerCase();
    const clientId = input.clientId.toLowerCase();
    if (fromUserId === toUserId) throw new ApiError(400, 'INVALID_REQUEST', 'A settlement is between two different people');
    return sql.begin(async (tx) => {
      await membership(tx, groupId, me);
      await lockGroup(tx, groupId);
      const select = () => tx<SettlementRow[]>`
        select id, client_id, created_by, from_user_id, to_user_id, amount_cents, created_at from sf_budget_settlements
        where group_id = ${groupId} and created_by = ${me} and client_id = ${clientId}`;
      const [existing] = await select();
      if (existing) return { settlement: settlementView(existing), created: false };
      const [members] = await tx<{ count: number }[]>`
        select count(*)::int as count from sf_budget_members
        where group_id = ${groupId} and user_id = any(${[fromUserId, toUserId]}::uuid[])`;
      if ((members?.count ?? 0) !== 2) throw new ApiError(400, 'INVALID_REQUEST', 'Both people must be in the group');
      const [count] = await tx<{ count: number }[]>`
        select count(*)::int as count from sf_budget_settlements where group_id = ${groupId}`;
      if ((count?.count ?? 0) >= BUDGET_LIMITS.settlementsPerGroup) {
        throw new ApiError(409, 'GROUP_SETTLEMENT_LIMIT', `A group can hold up to ${BUDGET_LIMITS.settlementsPerGroup} settlements`);
      }
      await tx`
        insert into sf_budget_settlements (group_id, client_id, created_by, from_user_id, to_user_id, amount_cents)
        values (${groupId}, ${clientId}, ${me}, ${fromUserId}, ${toUserId}, ${input.amountCents})`;
      await touch(tx, groupId);
      const [created] = await select();
      return { settlement: settlementView(created!), created: true };
    });
  }

  async function deleteSettlement(me: string, groupId: string, settlementId: string) {
    const member = await membership(sql, groupId, me);
    const [row] = await sql<{ created_by: string }[]>`
      select created_by from sf_budget_settlements where id = ${settlementId} and group_id = ${groupId}`;
    if (!row) throw new ApiError(404, 'SETTLEMENT_NOT_FOUND', 'That settlement no longer exists');
    if (row.created_by !== me && member.role !== 'owner') {
      throw new ApiError(403, 'NOT_SETTLEMENT_CREATOR', 'Only the person who recorded a payment, or the owner, can delete it');
    }
    await sql.begin(async (tx) => {
      await tx`delete from sf_budget_settlements where id = ${settlementId} and group_id = ${groupId}`;
      await touch(tx, groupId);
    });
  }

  // MARK: Account deletion

  /**
   * For deleting the whole Hearth account (DELETE /v1/me): the groups the person owns are erased
   * for everyone; in other groups their membership goes, taking their expenses and every
   * settlement to or from them.
   */
  async function purgeUser(userId: string) {
    await sql.begin(async (tx) => {
      await tx`delete from sf_budget_groups where owner_id = ${userId}`;
      const left = await tx<{ group_id: string }[]>`
        delete from sf_budget_members where user_id = ${userId} returning group_id`;
      for (const { group_id } of left) await touch(tx, group_id);
    });
  }

  return {
    listGroups, getGroup, createGroup, updateGroup, deleteGroup, rotateInvite, previewInvite, inviteGroupName, join, leave,
    removeMember, addExpense, addExpenses, updateExpense, deleteExpense, addSettlement, deleteSettlement, purgeUser,
  };
}

export type BudgetGroupsService = ReturnType<typeof createBudgetGroupsService>;
