import type { Sql } from 'postgres';

/**
 * Reports of objectionable content or people from the Hearth apps (POST /v1/reports), kept in
 * `content_reports` (supabase/migrations/20261020120000_content_reports.sql) for review. Reached
 * over the same direct Postgres connection as Hearken (DATABASE_URL).
 */

export const REPORT_APPS = ['bigtable', 'hearken'] as const;
export const REPORT_KINDS = ['recipe', 'profile', 'post', 'comment', 'answer', 'question', 'member'] as const;
export const REPORT_REASONS = ['spam', 'harassment', 'hate', 'sexual', 'violence', 'self_harm', 'other'] as const;
/** Reports one person can send in any 24 hours. */
export const REPORTS_PER_DAY = 20;

export type NewReport = {
  app: (typeof REPORT_APPS)[number];
  kind: (typeof REPORT_KINDS)[number];
  targetId: string;
  groupId: string | null;
  reason: (typeof REPORT_REASONS)[number];
  details: string | null;
};

export type ReportStore = {
  /** Saves the report and returns its id, or null when the reporter has hit the daily limit. */
  create: (reporterId: string, report: NewReport) => Promise<string | null>;
  /** Removes everything a person reported (account deletion). */
  removeByReporter: (reporterId: string) => Promise<void>;
};

export function createReportStore(sql: Sql): ReportStore {
  return {
    async create(reporterId, report) {
      // One statement, so the limit check and the insert see the same rows.
      const [row] = await sql<{ id: string }[]>`
        insert into content_reports (reporter_id, app, kind, target_id, group_id, reason, details)
        select ${reporterId}::uuid, ${report.app}, ${report.kind}, ${report.targetId}, ${report.groupId}::uuid,
               ${report.reason}, ${report.details}
        where (
          select count(*) from content_reports
          where reporter_id = ${reporterId}::uuid and created_at > now() - interval '1 day'
        ) < ${REPORTS_PER_DAY}::int
        returning id`;
      return row?.id ?? null;
    },
    async removeByReporter(reporterId) {
      await sql`delete from content_reports where reporter_id = ${reporterId}::uuid`;
    },
  };
}
