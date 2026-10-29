import type { Sql } from 'postgres';
import { ApiError } from '../errors.js';
import { isUniqueViolation, newInviteCode } from '../hearken/service.js';

/**
 * Hearth Studio's team: Hearth Software's members and what each can do. Every Studio route
 * (social, Library, campaigns, designs, plans) works for the caller's team, never for a person.
 *
 * The accounts in STUDIO_OWNER_IDS are the team's owners; they're added the first time the API
 * sees one of them, so there's nothing to set up by hand.
 */

export type Permission = 'post' | 'plans' | 'accounts' | 'owner';

export type Member = {
  teamId: string;
  teamName: string;
  userId: string;
  role: 'owner' | 'member';
  canPost: boolean;
  canPlans: boolean;
  canAccounts: boolean;
  displayName: string | null;
  /** The profile photo's path in the library bucket. */
  avatarPath: string | null;
  notifyDue: boolean;
  notifyComments: boolean;
  notifyFailed: boolean;
  addedAt: string;
};

export function can(member: Member, permission: Permission): boolean {
  if (member.role === 'owner') return true;
  if (permission === 'owner') return false;
  return permission === 'post' ? member.canPost : permission === 'plans' ? member.canPlans : member.canAccounts;
}

const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : String(value));

function member(row: Record<string, unknown>): Member {
  return {
    teamId: String(row.team_id), teamName: String(row.team_name ?? ''), userId: String(row.user_id),
    role: row.role as Member['role'], canPost: row.can_post === true, canPlans: row.can_plans === true, canAccounts: row.can_accounts === true,
    displayName: (row.display_name as string | null) ?? null,
    avatarPath: (row.avatar_path as string | null) ?? null,
    notifyDue: row.notify_due !== false, notifyComments: row.notify_comments !== false, notifyFailed: row.notify_failed !== false,
    addedAt: iso(row.added_at),
  };
}

export type Device = { token: string; userId: string; topic: string; environment: 'sandbox' | 'production' };

export type TeamService = ReturnType<typeof createTeamService>;

export function createTeamService(sql: Sql, options: { ownerIds: string[]; now?: () => number }) {
  const now = options.now ?? Date.now;
  let ownersEnsured: Promise<void> | undefined;

  /** The owners in the environment are owners of the Hearth team, once per process. */
  function ensureOwners() {
    ownersEnsured ??= (async () => {
      if (options.ownerIds.length === 0) return;
      const [team] = await sql`select id from studio_teams where slug = 'hearth'`;
      if (!team) return;
      for (const userId of options.ownerIds) {
        await sql`
          insert into studio_members (team_id, user_id, role, can_post, can_plans, can_accounts)
          values (${team.id}, ${userId}, 'owner', true, true, true)
          on conflict (team_id, user_id) do update set role = 'owner'`;
      }
    })().catch((error) => { ownersEnsured = undefined; throw error; });
    return ownersEnsured;
  }

  const select = sql`
    select m.*, t.name as team_name from studio_members m join studio_teams t on t.id = m.team_id`;

  return {
    async memberOf(userId: string): Promise<Member | undefined> {
      await ensureOwners();
      const [row] = await sql`${select} where m.user_id = ${userId} order by m.added_at limit 1`;
      return row ? member(row) : undefined;
    },

    async members(teamId: string): Promise<Member[]> {
      const rows = await sql`${select} where m.team_id = ${teamId} order by m.role desc, m.added_at`;
      return rows.map(member);
    },

    /** Sets (or clears) a member's profile photo; returns the path it replaced. */
    async setAvatar(teamId: string, userId: string, path: string | null) {
      const [row] = await sql`
        update studio_members m set avatar_path = ${path}
        from (select avatar_path as previous from studio_members where team_id = ${teamId} and user_id = ${userId}) old
        where m.team_id = ${teamId} and m.user_id = ${userId}
        returning old.previous`;
      if (!row) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Member not found');
      return (row.previous as string | null) ?? null;
    },

    async team(teamId: string) {
      const [row] = await sql`select id, slug, name, keep_runs from studio_teams where id = ${teamId}`;
      return row ? { id: String(row.id), slug: String(row.slug), name: String(row.name), keepRuns: Number(row.keep_runs) } : undefined;
    },

    async updateMember(teamId: string, userId: string, patch: { canPost?: boolean; canPlans?: boolean; canAccounts?: boolean; displayName?: string | null }) {
      const [row] = await sql`
        update studio_members set
          can_post = coalesce(${patch.canPost ?? null}, can_post),
          can_plans = coalesce(${patch.canPlans ?? null}, can_plans),
          can_accounts = coalesce(${patch.canAccounts ?? null}, can_accounts),
          display_name = case when ${patch.displayName !== undefined} then ${patch.displayName ?? null} else display_name end
        where team_id = ${teamId} and user_id = ${userId}
        returning *`;
      if (!row) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Member not found');
      return (await this.members(teamId)).find((entry) => entry.userId === userId)!;
    },

    async removeMember(teamId: string, userId: string) {
      const [target] = await sql`select role from studio_members where team_id = ${teamId} and user_id = ${userId}`;
      if (!target) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Member not found');
      if (target.role === 'owner') throw new ApiError(409, 'OWNER', 'An owner can’t be removed here');
      await sql.begin(async (tx) => {
        await tx`delete from studio_devices where team_id = ${teamId} and user_id = ${userId}`;
        await tx`delete from studio_members where team_id = ${teamId} and user_id = ${userId}`;
      });
    },

    async setNotifications(teamId: string, userId: string, prefs: { due?: boolean; comments?: boolean; failed?: boolean }) {
      await sql`
        update studio_members set
          notify_due = coalesce(${prefs.due ?? null}, notify_due),
          notify_comments = coalesce(${prefs.comments ?? null}, notify_comments),
          notify_failed = coalesce(${prefs.failed ?? null}, notify_failed)
        where team_id = ${teamId} and user_id = ${userId}`;
    },

    async createInvite(teamId: string, by: string, permissions: { canPost: boolean; canPlans: boolean; canAccounts: boolean }) {
      const expiresAt = new Date(now() + 7 * 86_400_000);
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const code = newInviteCode();
        try {
          await sql`
            insert into studio_invites (code, team_id, can_post, can_plans, can_accounts, created_by, expires_at)
            values (${code}, ${teamId}, ${permissions.canPost}, ${permissions.canPlans}, ${permissions.canAccounts}, ${by}, ${expiresAt})`;
          return { code, expiresAt: expiresAt.toISOString() };
        } catch (error) {
          if (!isUniqueViolation(error)) throw error;
        }
      }
      throw new ApiError(503, 'STORAGE_UNAVAILABLE', 'Couldn’t make an invite code');
    },

    async join(code: string, userId: string, displayName: string | null) {
      return sql.begin(async (tx) => {
        const [invite] = await tx`
          select * from studio_invites where code = ${code.toUpperCase()} and used_at is null and expires_at > ${new Date(now())} for update`;
        if (!invite) throw new ApiError(404, 'INVITE_NOT_FOUND', 'That invite is used, expired or doesn’t exist. Ask for a new one.');
        await tx`
          insert into studio_members (team_id, user_id, role, can_post, can_plans, can_accounts, display_name, added_by)
          values (${invite.team_id}, ${userId}, 'member', ${invite.can_post}, ${invite.can_plans}, ${invite.can_accounts}, ${displayName}, ${invite.created_by})
          on conflict (team_id, user_id) do update set
            can_post = studio_members.can_post or excluded.can_post,
            can_plans = studio_members.can_plans or excluded.can_plans,
            can_accounts = studio_members.can_accounts or excluded.can_accounts`;
        await tx`update studio_invites set used_by = ${userId}, used_at = now() where code = ${invite.code}`;
        return String(invite.team_id);
      }) as Promise<string>;
    },

    // MARK: Devices

    async registerDevice(teamId: string, userId: string, device: { token: string; topic: string; environment: 'sandbox' | 'production' }) {
      await sql`
        insert into studio_devices (token, team_id, user_id, topic, environment)
        values (${device.token}, ${teamId}, ${userId}, ${device.topic}, ${device.environment})
        on conflict (token) do update set team_id = excluded.team_id, user_id = excluded.user_id,
          topic = excluded.topic, environment = excluded.environment, updated_at = now()`;
    },

    async removeDevice(userId: string, token: string) {
      await sql`delete from studio_devices where token = ${token} and user_id = ${userId}`;
    },

    async forgetDevice(token: string) {
      await sql`delete from studio_devices where token = ${token}`;
    },

    /** Devices of the members who want this kind of notification. */
    async devicesFor(teamId: string, kind: 'due' | 'comments' | 'failed'): Promise<Device[]> {
      const rows = await sql`
        select d.token, d.user_id, d.topic, d.environment from studio_devices d
        join studio_members m on m.team_id = d.team_id and m.user_id = d.user_id
        where d.team_id = ${teamId}
          and case ${kind} when 'due' then m.notify_due when 'comments' then m.notify_comments else m.notify_failed end`;
      return rows.map((row) => ({ token: String(row.token), userId: String(row.user_id), topic: String(row.topic), environment: row.environment as Device['environment'] }));
    },

    async teams(): Promise<string[]> {
      const rows = await sql`select id from studio_teams`;
      return rows.map((row) => String(row.id));
    },
  };
}
