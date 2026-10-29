import type { Sql } from 'postgres';
import type { ApnsMessage, ApnsSender } from '../integrations/apns.js';
import type { TeamService } from './team.js';

/**
 * Hearth Studio's pushes, sent by the social cron: a hand-off post that's due (so a reminder
 * arrives even with the Mac that scheduled it switched off), a post that failed, and new
 * comments (one push for however many arrived since the last).
 */

const PLATFORM_NAMES: Record<string, string> = {
  instagram: 'Instagram', facebook: 'Facebook', tiktok: 'TikTok', youtube: 'YouTube', x: 'X', linkedin: 'LinkedIn', pinterest: 'Pinterest', snapchat: 'Snapchat',
};

export type StudioNotifier = ReturnType<typeof createStudioNotifier>;

export function createStudioNotifier(sql: Sql, team: TeamService, apns: ApnsSender | undefined) {
  async function send(teamId: string, kind: 'due' | 'comments' | 'failed', build: (topic: string) => Omit<ApnsMessage, 'token' | 'environment' | 'topic'>) {
    if (!apns) return 0;
    const devices = await team.devicesFor(teamId, kind);
    if (devices.length === 0) return 0;
    const messages = devices.map((device) => ({ ...build(device.topic), token: device.token, environment: device.environment, topic: device.topic }));
    const results = await apns(messages);
    await Promise.all(results.map((result, index) => (result === 'gone' ? team.forgetDevice(devices[index]!.token) : undefined)));
    return results.filter((result) => result === 'sent').length;
  }

  const text = (value: unknown, length = 120) => {
    const string = String(value ?? '').replace(/\s+/g, ' ').trim();
    return string.length > length ? `${string.slice(0, length - 1)}…` : string;
  };

  return {
    async run() {
      let sent = 0;
      for (const teamId of await team.teams()) {
        // Hand-off posts whose time has come.
        const due = await sql`
          update social_targets t set notified_at = now()
          from social_posts p
          where t.team_id = ${teamId} and t.post_id = p.id and t.delivery = 'handoff' and t.status = 'scheduled'
            and t.scheduled_for <= now() and t.notified_at is null
          returning t.id, t.platform, coalesce(t.text, p.text) as text, p.about`;
        for (const row of due) {
          sent += await send(teamId, 'due', () => ({
            payload: {
              aps: { alert: { title: `Time to post on ${PLATFORM_NAMES[String(row.platform)] ?? row.platform}`, body: text(row.text) || 'A post is ready for you' }, sound: 'default', 'thread-id': 'due' },
              target: String(row.id), kind: 'due',
            },
            collapseId: `due-${String(row.id).slice(0, 32)}`,
          }));
        }

        // Posts that didn't go out.
        const failed = await sql`
          update social_targets set notified_at = now()
          where team_id = ${teamId} and status = 'failed' and notified_at is null and delivery = 'api'
          returning id, platform, error`;
        for (const row of failed) {
          sent += await send(teamId, 'failed', () => ({
            payload: {
              aps: { alert: { title: `A post didn’t go out on ${PLATFORM_NAMES[String(row.platform)] ?? row.platform}`, body: text(row.error) || 'Open Hearth Studio to try again' }, sound: 'default', 'thread-id': 'failed' },
              target: String(row.id), kind: 'failed',
            },
          }));
        }

        // New comments, in one push.
        const comments = await sql`
          update social_comments set notified_at = now()
          where team_id = ${teamId} and notified_at is null and from_account = false and status = 'open'
          returning id, author, text`;
        if (comments.length > 0) {
          const first = comments[0]!;
          sent += await send(teamId, 'comments', () => ({
            payload: {
              aps: {
                alert: comments.length === 1
                  ? { title: `${text(first.author, 40) || 'Someone'} commented`, body: text(first.text) }
                  : { title: `${comments.length} new comments`, body: `${text(first.author, 40) || 'Someone'}: ${text(first.text, 90)}` },
                sound: 'default', 'thread-id': 'comments', badge: comments.length,
              },
              comment: String(first.id), kind: 'comments',
            },
            collapseId: 'comments',
          }));
        }
      }
      return sent;
    },
  };
}
