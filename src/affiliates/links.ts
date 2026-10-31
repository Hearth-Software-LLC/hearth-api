import type { Sql } from 'postgres';
import { ApiError } from '../errors.js';
import { isUniqueViolation } from '../hearken/service.js';

/**
 * Campaign links: an App Store link with a ct= token, maybe behind a short link. For reporting
 * only (App Store Connect's totals for the token, and short-link taps); they never create money owed.
 */

export const STAT_METRICS = ['page_views', 'downloads', 'redownloads', 'proceeds_cents', 'paying_users'] as const;
export type StatMetric = (typeof STAT_METRICS)[number];
export type Totals = Record<StatMetric, number> & { taps: number };

export type LinkDestination = 'app_store' | 'beta';

export type LinkView = {
  id: string; app: string; name: string; ct: string;
  /** Null for a beta link (it goes to hearthapps.com/beta/<app>, not the App Store). */
  appStoreId: string | null; slug: string | null;
  destination: LinkDestination; postId: string | null;
  affiliateId: string | null; affiliateName: string | null;
  /** Where the link goes (the App Store, or the app's beta page), and the short form when there is one. */
  url: string; shortUrl: string | null;
  totals: Totals;
  createdAt: string;
};

const zero = (): Totals => ({ taps: 0, page_views: 0, downloads: 0, redownloads: 0, proceeds_cents: 0, paying_users: 0 });
const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : String(value));

/** Crawlers and link previews: they don't count as taps. */
const BOT = /bot|crawl|spider|preview|facebookexternalhit|slackbot|discord|whatsapp|telegram|twitter|linkedin|embedly|curl|wget|python|go-http/i;
export const isBot = (userAgent: string | undefined) => !userAgent || BOT.test(userAgent);

export function appStoreUrl(appStoreId: string, ct: string, providerId: string | undefined) {
  const query = new URLSearchParams();
  if (providerId) query.set('pt', providerId);
  query.set('ct', ct);
  query.set('mt', '8');
  return `https://apps.apple.com/app/id${appStoreId}?${query.toString()}`;
}

export function slugify(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

export type LinkService = ReturnType<typeof createLinkService>;

/** An app's beta page, crediting a short link when it has one. */
export function betaPageUrl(siteBase: string, app: string, slug: string | null) {
  const url = `${siteBase.replace(/\/+$/, '')}/beta/${app}`;
  return slug ? `${url}?via=${encodeURIComponent(slug)}` : url;
}

export function createLinkService(sql: Sql, options: { providerId?: string | undefined; shortBase: string; siteBase?: string; now?: () => number }) {
  const now = options.now ?? Date.now;
  const base = options.shortBase.replace(/\/+$/, '');
  const site = options.siteBase ?? 'https://hearthapps.com';
  const target = (row: Record<string, unknown>) =>
    row.destination === 'beta'
      ? betaPageUrl(site, String(row.app), (row.slug as string | null) ?? null)
      : appStoreUrl(String(row.app_store_id), String(row.ct), options.providerId);

  async function views(team: string, filter: { id?: string; app?: string; affiliateId?: string; destination?: LinkDestination | 'all'; days: number }): Promise<LinkView[]> {
    const since = new Date(now() - filter.days * 86_400_000).toISOString().slice(0, 10);
    const rows = await sql`
      select l.*, a.name as affiliate_name,
        coalesce((select sum(t.taps) from link_taps_daily t where t.link_id = l.id and t.day >= ${since}), 0) as taps,
        coalesce((select jsonb_object_agg(s.metric, s.total) from (
          select metric, sum(value) as total from campaign_stats_daily c
          where c.team_id = l.team_id and c.app = l.app and c.ct = l.ct and c.day >= ${since} group by metric) s), '{}') as stats
      from campaign_links l left join affiliates a on a.id = l.affiliate_id
      where l.team_id = ${team} and l.deleted_at is null
        and (${filter.id ?? null}::uuid is null or l.id = ${filter.id ?? null})
        and (${filter.app ?? null}::text is null or l.app = ${filter.app ?? null})
        and (${filter.affiliateId ?? null}::uuid is null or l.affiliate_id = ${filter.affiliateId ?? null})
        and (${filter.destination ?? 'all'} = 'all' or l.destination = ${filter.destination ?? 'all'})
      order by l.created_at desc`;
    return rows.map((row) => {
      const totals = zero();
      totals.taps = Number(row.taps);
      for (const [metric, value] of Object.entries((row.stats as Record<string, unknown>) ?? {})) {
        if ((STAT_METRICS as readonly string[]).includes(metric)) totals[metric as StatMetric] = Number(value);
      }
      return {
        id: String(row.id), app: String(row.app), name: String(row.name), ct: String(row.ct),
        appStoreId: row.app_store_id == null ? null : String(row.app_store_id),
        slug: (row.slug as string | null) ?? null,
        destination: row.destination === 'beta' ? 'beta' as const : 'app_store' as const,
        postId: (row.post_id as string | null) ?? null,
        affiliateId: (row.affiliate_id as string | null) ?? null,
        affiliateName: (row.affiliate_name as string | null) ?? null,
        url: target(row),
        shortUrl: row.slug ? `${base}/${String(row.slug)}` : null,
        totals, createdAt: iso(row.created_at),
      };
    });
  }

  async function one(team: string, id: string, days = 30) {
    const [found] = await views(team, { id, days });
    if (!found) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Link not found');
    return found;
  }

  return {
    /**
     * Links with their numbers. App Store links only unless `destination` says otherwise: app
     * builds from before beta links read `appStoreId` as always present.
     */
    list: (team: string, filter: { app?: string; affiliateId?: string; destination?: LinkDestination | 'all'; days?: number } = {}) => {
      const query: { app?: string; affiliateId?: string; destination: LinkDestination | 'all'; days: number } = {
        days: filter.days ?? 30, destination: filter.destination ?? 'app_store',
      };
      if (filter.app) query.app = filter.app;
      if (filter.affiliateId) query.affiliateId = filter.affiliateId;
      return views(team, query);
    },
    get: one,

    async create(team: string, by: string, input: {
      app: string; name: string; appStoreId?: string | undefined; ct?: string | undefined; slug?: string | null | undefined;
      affiliateId?: string | null | undefined; destination?: LinkDestination | undefined; postId?: string | null | undefined;
    }) {
      const destination = input.destination ?? 'app_store';
      if (destination === 'app_store' && !input.appStoreId) throw new ApiError(400, 'INVALID_REQUEST', 'An App Store link needs the app’s App Store id');
      if (destination === 'beta') {
        const [beta] = await sql`select 1 from beta_apps where app = ${input.app} and launched_at is null`;
        if (!beta) throw new ApiError(400, 'INVALID_REQUEST', `${input.app} has no beta page`);
        // A beta link always has a short form: it's how a post's taps and sign-ups are counted.
        if (input.slug === null) throw new ApiError(400, 'INVALID_REQUEST', 'A beta link needs a short link');
      }
      const ct = (input.ct ?? slugify(input.name).slice(0, 40)) || 'link';
      if (!/^[A-Za-z0-9._-]{1,40}$/.test(ct)) throw new ApiError(400, 'INVALID_REQUEST', 'A campaign token is up to 40 letters, digits, . _ or -');
      const slug = input.slug === undefined ? `${input.app}-${slugify(input.name)}`.slice(0, 60) : input.slug;
      if (slug !== null && !/^[a-z0-9-]{2,60}$/.test(slug)) throw new ApiError(400, 'INVALID_REQUEST', 'A short link is 2–60 lowercase letters, digits or -');
      if (input.affiliateId) {
        const [affiliate] = await sql`select 1 from affiliates where id = ${input.affiliateId} and team_id = ${team}`;
        if (!affiliate) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Affiliate not found');
      }
      try {
        const [row] = await sql`
          insert into campaign_links (team_id, app, name, ct, app_store_id, slug, affiliate_id, created_by, destination, post_id)
          values (${team}, ${input.app}, ${input.name}, ${ct}, ${destination === 'beta' ? null : input.appStoreId!}, ${slug},
            ${input.affiliateId ?? null}, ${by}, ${destination}, ${input.postId ?? null})
          returning id`;
        return one(team, String(row!.id));
      } catch (error) {
        if (isUniqueViolation(error)) throw new ApiError(409, 'LINK_TAKEN', 'That campaign token or short link is already used');
        throw error;
      }
    },

    async update(team: string, id: string, patch: { name?: string | undefined; affiliateId?: string | null | undefined; slug?: string | null | undefined }) {
      const current = await one(team, id);
      if (patch.slug !== undefined && patch.slug !== null && !/^[a-z0-9-]{2,60}$/.test(patch.slug)) {
        throw new ApiError(400, 'INVALID_REQUEST', 'A short link is 2–60 lowercase letters, digits or -');
      }
      try {
        await sql`
          update campaign_links set
            name = ${patch.name ?? current.name},
            affiliate_id = ${patch.affiliateId !== undefined ? patch.affiliateId : current.affiliateId},
            slug = ${patch.slug !== undefined ? patch.slug : current.slug}
          where id = ${id} and team_id = ${team}`;
      } catch (error) {
        if (isUniqueViolation(error)) throw new ApiError(409, 'LINK_TAKEN', 'That short link is already used');
        throw error;
      }
      return one(team, id);
    },

    /** Stops the short link working; App Store Connect keeps reporting the token. */
    async remove(team: string, id: string) {
      const [row] = await sql`
        update campaign_links set deleted_at = now(), slug = null where id = ${id} and team_id = ${team} and deleted_at is null returning id`;
      if (!row) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Link not found');
    },

    /** A link's numbers day by day. */
    async daily(team: string, id: string, days = 30) {
      const link = await one(team, id, days);
      const since = new Date(now() - days * 86_400_000).toISOString().slice(0, 10);
      const taps = await sql`select day, taps from link_taps_daily where link_id = ${id} and day >= ${since}`;
      const stats = await sql`
        select day, metric, value from campaign_stats_daily where team_id = ${team} and app = ${link.app} and ct = ${link.ct} and day >= ${since}`;
      const byDay = new Map<string, Totals>();
      const at = (value: unknown) => {
        const key = value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
        if (!byDay.has(key)) byDay.set(key, zero());
        return byDay.get(key)!;
      };
      for (const row of taps) at(row.day).taps = Number(row.taps);
      for (const row of stats) at(row.day)[row.metric as StatMetric] = Number(row.value);
      return { link, days: [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, totals]) => ({ date, ...totals })) };
    },

    /** An app's campaign totals by token (App Store Connect › Analytics, in Hearth Studio). */
    async appStore(team: string, app: string, days = 30) {
      const since = new Date(now() - days * 86_400_000).toISOString().slice(0, 10);
      const rows = await sql`
        select s.ct, s.metric, sum(s.value) as total, max(s.day) as latest,
          (select l.name from campaign_links l where l.team_id = s.team_id and l.app = s.app and l.ct = s.ct and l.deleted_at is null limit 1) as name
        from campaign_stats_daily s
        where s.team_id = ${team} and s.app = ${app} and s.day >= ${since}
        group by s.team_id, s.app, s.ct, s.metric`;
      const campaigns = new Map<string, { ct: string; name: string | null; totals: Totals }>();
      let latest: string | null = null;
      for (const row of rows) {
        const ct = String(row.ct);
        if (!campaigns.has(ct)) campaigns.set(ct, { ct, name: (row.name as string | null) ?? null, totals: zero() });
        campaigns.get(ct)!.totals[row.metric as StatMetric] = Number(row.total);
        const day = row.latest instanceof Date ? row.latest.toISOString().slice(0, 10) : String(row.latest);
        if (!latest || day > latest) latest = day;
      }
      const list = [...campaigns.values()].sort((a, b) => b.totals.downloads - a.totals.downloads);
      const total = zero();
      for (const entry of list) for (const metric of STAT_METRICS) total[metric] += entry.totals[metric];
      return { app, days, updatedThrough: latest, totals: total, campaigns: list };
    },

    /** GET /go/<slug>: where to send the tap, counting it unless it's a crawler. */
    async follow(slug: string, userAgent: string | undefined) {
      const [row] = await sql`select id, app, destination, app_store_id, ct, slug from campaign_links where slug = ${slug} and deleted_at is null`;
      if (!row) return undefined;
      if (!isBot(userAgent)) {
        const day = new Date(now()).toISOString().slice(0, 10);
        await sql`
          insert into link_taps_daily (link_id, day, taps) values (${row.id}, ${day}, 1)
          on conflict (link_id, day) do update set taps = link_taps_daily.taps + 1`;
      }
      return target(row);
    },

    /** What App Store Connect imports into: an app's daily totals for a token. */
    async recordStats(team: string, app: string, rows: { ct: string; day: string; metric: StatMetric; value: number }[]) {
      for (const row of rows) {
        await sql`
          insert into campaign_stats_daily (team_id, app, ct, day, metric, value)
          values (${team}, ${app}, ${row.ct}, ${row.day}, ${row.metric}, ${row.value})
          on conflict (team_id, app, ct, day, metric) do update set value = excluded.value`;
      }
    },

    /** The apps (key and App Store id) that have links, for the import. */
    async storeApps(team: string) {
      const rows = await sql`select distinct app, app_store_id from campaign_links where team_id = ${team} and app_store_id is not null`;
      return rows.map((row) => ({ app: String(row.app), appStoreId: String(row.app_store_id) }));
    },
  };
}
