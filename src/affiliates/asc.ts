import { gunzipSync } from 'node:zlib';
import { importPKCS8, SignJWT } from 'jose';
import type { Sql } from 'postgres';
import type { LinkService, StatMetric } from './links.js';

/**
 * App Store Connect's Analytics Reports API: campaign page views, downloads and proceeds by ct=
 * token, imported daily into campaign_stats_daily.
 *
 * Once per app, an ONGOING report request is made (it needs a key with the Admin role); Apple
 * then makes daily report instances, each split into gzipped tab-separated segments. Apple's
 * figures are totals for the token, never people, and below a privacy threshold they're left out.
 * Column names vary a little between reports, so rows are read by header.
 */

export type AscCredentials = { keyId: string; issuerId: string; privateKey: string };
export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const API = 'https://api.appstoreconnect.apple.com';

/** The detailed reports that carry the Campaign column. */
export const CAMPAIGN_REPORTS = [
  'App Store Discovery and Engagement Detailed',
  'App Downloads Detailed',
  'App Store Purchases Detailed',
] as const;

export function createAscClient(credentials: AscCredentials, fetcher: Fetch = fetch) {
  let token: { value: string; expires: number } | undefined;

  async function bearer() {
    if (token && token.expires > Date.now() + 60_000) return token.value;
    const key = await importPKCS8(credentials.privateKey.replace(/\\n/g, '\n'), 'ES256');
    const expires = Date.now() + 15 * 60_000;
    const value = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: credentials.keyId, typ: 'JWT' })
      .setIssuer(credentials.issuerId).setIssuedAt().setExpirationTime(Math.floor(expires / 1000)).setAudience('appstoreconnect-v1')
      .sign(key);
    token = { value, expires };
    return value;
  }

  async function call<T = { data: unknown }>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetcher(path.startsWith('http') ? path : `${API}${path}`, {
      ...init, headers: { authorization: `Bearer ${await bearer()}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
    });
    if (!response.ok) {
      // Apple's first error detail, when there is one (never the token or the request body).
      const detail = await response.json().then((body: { errors?: { detail?: string; title?: string }[] }) => body.errors?.[0]?.detail ?? body.errors?.[0]?.title, () => undefined);
      const where = path.replace(API, '').split('?')[0];
      throw new Error(`App Store Connect ${init.method ?? 'GET'} ${where} answered ${response.status}${detail ? `: ${detail}` : ''}`);
    }
    return (await response.json()) as T;
  }

  type Item = { id: string; attributes?: Record<string, unknown> };
  type Page = { data: Item[]; links?: { next?: string } };
  async function all(path: string) {
    const items: Item[] = [];
    let next: string | undefined = path;
    while (next) {
      const page: Page = await call<Page>(next);
      items.push(...page.data);
      next = page.links?.next;
    }
    return items;
  }

  return {
    /** Any GET, for other features that read App Store Connect (Studio's Monetization tab). */
    get: <T = { data: unknown }>(path: string) => call<T>(path),
    all,
    async requestReports(appStoreId: string) {
      const created = await call<{ data: { id: string } }>('/v1/analyticsReportRequests', {
        method: 'POST',
        body: JSON.stringify({ data: { type: 'analyticsReportRequests', attributes: { accessType: 'ONGOING' },
          relationships: { app: { data: { type: 'apps', id: appStoreId } } } } }),
      });
      return created.data.id;
    },
    reports: (requestId: string) => all(`/v1/analyticsReportRequests/${requestId}/reports?limit=200`),
    instances: (reportId: string) => all(`/v1/analyticsReports/${reportId}/instances?filter[granularity]=DAILY&limit=200`),
    segments: (instanceId: string) => all(`/v1/analyticsReportInstances/${instanceId}/segments`),
    async download(url: string) {
      // Segment URLs are pre-signed: no token.
      const response = await fetcher(url);
      if (!response.ok) throw new Error(`An App Store Connect report segment answered ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      return (bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes).toString('utf8');
    },
  };
}

export type AscClient = ReturnType<typeof createAscClient>;

/** A report's rows as campaign totals (by token, day and metric), summed. */
export function parseCampaignReport(tsv: string) {
  const lines = tsv.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) return [];
  const header = lines[0]!.split('\t').map((name) => name.trim().toLowerCase());
  const column = (...names: string[]) => header.findIndex((name) => names.includes(name));
  const date = column('date'), campaign = column('campaign'), counts = column('counts', 'count');
  const event = column('event'), downloadType = column('download type');
  const proceeds = column('proceeds in usd'), payingUsers = column('paying users', 'unique devices');
  if (date < 0 || campaign < 0) return [];
  const sums = new Map<string, { ct: string; day: string; metric: StatMetric; value: number }>();
  const add = (ct: string, day: string, metric: StatMetric, value: number) => {
    if (!Number.isFinite(value) || value === 0) return;
    const key = `${ct}\u0000${day}\u0000${metric}`;
    const entry = sums.get(key);
    if (entry) entry.value += value; else sums.set(key, { ct, day, metric, value });
  };
  for (const line of lines.slice(1)) {
    const cells = line.split('\t');
    const ct = cells[campaign]?.trim() ?? '';
    const day = cells[date]?.trim().slice(0, 10) ?? '';
    if (!/^[A-Za-z0-9._-]{1,40}$/.test(ct) || !/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    const count = counts >= 0 ? Number(cells[counts]) : NaN;
    if (event >= 0) {
      const name = (cells[event] ?? '').toLowerCase();
      if (name.includes('page view')) add(ct, day, 'page_views', count);
    }
    if (downloadType >= 0) {
      const type = (cells[downloadType] ?? '').toLowerCase();
      if (type.includes('redownload')) add(ct, day, 'redownloads', count);
      else if (type.includes('download')) add(ct, day, 'downloads', count);
    }
    if (proceeds >= 0) add(ct, day, 'proceeds_cents', Math.round(Number(cells[proceeds]) * 100));
    if (payingUsers >= 0 && proceeds >= 0) add(ct, day, 'paying_users', Number(cells[payingUsers]));
  }
  return [...sums.values()];
}

/**
 * The daily import: makes each app's report request the first time, then reads every report
 * instance newer than the last import. Report instances are complete days, so re-reading one
 * just writes the same totals.
 */
export async function importCampaignStats(sql: Sql, client: AscClient, links: LinkService, team: string) {
  const summary: { app: string; days: number; error?: string }[] = [];
  for (const { app, appStoreId } of await links.storeApps(team)) {
    try {
      let [request] = await sql`select * from asc_report_requests where app_store_id = ${appStoreId}`;
      if (!request) {
        const id = await client.requestReports(appStoreId);
        [request] = await sql`
          insert into asc_report_requests (app_store_id, request_id) values (${appStoreId}, ${id})
          on conflict (app_store_id) do update set request_id = excluded.request_id returning *`;
      }
      const after = request!.imported_through instanceof Date ? request!.imported_through.toISOString().slice(0, 10) : null;
      let latest = after;
      const days = new Set<string>();
      for (const report of await client.reports(String(request!.request_id))) {
        if (!(CAMPAIGN_REPORTS as readonly string[]).includes(String(report.attributes?.name ?? ''))) continue;
        for (const instance of await client.instances(report.id)) {
          const processed = String(instance.attributes?.processingDate ?? '');
          if (after && processed <= after) continue;
          for (const segment of await client.segments(instance.id)) {
            const url = segment.attributes?.url;
            if (typeof url !== 'string') continue;
            const rows = parseCampaignReport(await client.download(url));
            await links.recordStats(team, app, rows);
            for (const row of rows) days.add(row.day);
          }
          if (!latest || processed > latest) latest = processed;
        }
      }
      if (latest && latest !== after) await sql`update asc_report_requests set imported_through = ${latest} where app_store_id = ${appStoreId}`;
      summary.push({ app, days: days.size });
    } catch (error) {
      summary.push({ app, days: 0, error: error instanceof Error ? error.message : 'failed' });
    }
  }
  return summary;
}
