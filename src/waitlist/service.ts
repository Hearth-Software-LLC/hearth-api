import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Sql } from 'postgres';
import type { Resend } from '../email/resend.js';
import { ApiError } from '../errors.js';
import { isBot } from '../affiliates/links.js';

/**
 * The beta funnel: the launch waitlist (sign up on hearthapps.com, confirm by email, hear once at
 * launch), each beta app's page details ("what's new this week", its TestFlight link), and taps on
 * the beta pages' TestFlight buttons. Emails go through Resend: a confirmation per sign-up, and
 * one broadcast per app at launch to that app's segment of confirmed people.
 */

export type BetaApp = { key: string; name: string; testflightUrl: string; whatsNew: string[]; updatedAt: string | null };
type Counts = { confirmed: number; pending: number; new: number; testflightTaps: number; pageTaps: number };

const EMAIL = /^[^\s@<>()[\]\\,;:"]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const CONFIRM_DAYS = 7;
/** A second sign-up within this window doesn't send another confirmation. */
const RESEND_AFTER_MS = 10 * 60_000;

export function normalizeEmail(value: string) {
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !EMAIL.test(email)) throw new ApiError(400, 'INVALID_REQUEST', 'That doesn’t look like an email address');
  return email;
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const iso = (value: unknown) => (value == null ? null : value instanceof Date ? value.toISOString() : String(value));
const listOf = (names: string[]) => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

/** A signed, expiring confirmation token: base64url(JSON) "." base64url(HMAC). */
export function signToken(key: Buffer, payload: { id: string; exp: number }) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${createHmac('sha256', key).update(body).digest('base64url')}`;
}

export function readToken(key: Buffer, token: string, now: number): { id: string } | undefined {
  const [body, signature] = token.split('.');
  if (!body || !signature) return undefined;
  const expected = createHmac('sha256', key).update(body).digest();
  const given = Buffer.from(signature, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { id?: unknown; exp?: unknown };
    if (typeof payload.id !== 'string' || typeof payload.exp !== 'number' || payload.exp * 1000 < now) return undefined;
    return { id: payload.id };
  } catch {
    return undefined;
  }
}

function frame(inner: string) {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f5f2ec">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f2ec;padding:32px 16px">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:18px;padding:32px;font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',Arial,sans-serif;color:#1c1c1e">
${inner}
</table>
<p style="font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',Arial,sans-serif;font-size:12px;color:#8a8a8e;margin:16px 0 0">Hearth Software LLC · hearthapps.com</p>
</td></tr></table></body></html>`;
}

const button = (href: string, label: string) =>
  `<a href="${escapeHtml(href)}" style="display:inline-block;background:#1c1c1e;color:#ffffff;text-decoration:none;font-weight:600;font-size:16px;padding:14px 26px;border-radius:999px">${escapeHtml(label)}</a>`;

export function confirmationEmail(names: string[], link: string) {
  const apps = listOf(names);
  const subject = `Confirm: hear when ${apps} launches`;
  const html = frame(`<tr><td>
<h1 style="font-size:24px;line-height:1.2;margin:0 0 12px">One tap to confirm</h1>
<p style="font-size:16px;line-height:1.5;margin:0 0 24px">You asked to hear when ${escapeHtml(apps)} comes to the App Store. Confirm, and we’ll email you once on launch day. Nothing else.</p>
<p style="margin:0 0 24px">${button(link, 'Confirm my email')}</p>
<p style="font-size:14px;line-height:1.5;color:#6c6c70;margin:0">The link works for ${CONFIRM_DAYS} days. If this wasn’t you, ignore this email and you won’t hear from us.</p>
</td></tr>`);
  const text = `You asked to hear when ${apps} comes to the App Store. Confirm, and we'll email you once on launch day. Nothing else.\n\nConfirm: ${link}\n\nThe link works for ${CONFIRM_DAYS} days. If this wasn't you, ignore this email.\n\nHearth Software LLC · hearthapps.com`;
  return { subject, html, text };
}

export function launchEmail(name: string, appStoreUrl: string) {
  const subject = `${name} is on the App Store`;
  const html = frame(`<tr><td>
<h1 style="font-size:24px;line-height:1.2;margin:0 0 12px">${escapeHtml(name)} is here</h1>
<p style="font-size:16px;line-height:1.5;margin:0 0 24px">You asked us to tell you when ${escapeHtml(name)} launched. It’s on the App Store now.</p>
<p style="margin:0 0 24px">${button(appStoreUrl, `Get ${name}`)}</p>
<p style="font-size:14px;line-height:1.5;color:#6c6c70;margin:0">Thanks for waiting with us. This is the one launch email we promised for ${escapeHtml(name)}.</p>
<p style="font-size:12px;line-height:1.5;color:#8a8a8e;margin:16px 0 0"><a href="{{{RESEND_UNSUBSCRIBE_URL}}}" style="color:#8a8a8e">Unsubscribe</a></p>
</td></tr>`);
  return { subject, html };
}

export type WaitlistService = ReturnType<typeof createWaitlistService>;

export function createWaitlistService(sql: Sql, options: {
  resend?: Resend | undefined;
  tokenKey: Buffer;
  /** Where the confirm link points (this API). */
  apiBase: string;
  /** The website (beta pages, thanks and confirmed pages). */
  siteBase: string;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const api = options.apiBase.replace(/\/+$/, '');
  const site = options.siteBase.replace(/\/+$/, '');
  const email = () => {
    if (!options.resend) throw new ApiError(503, 'EMAIL_NOT_CONFIGURED', 'Email isn’t set up (RESEND_API_KEY, RESEND_FROM)');
    return options.resend;
  };

  const view = (row: Record<string, unknown>): BetaApp => ({
    key: String(row.app), name: String(row.name), testflightUrl: String(row.testflight_url),
    whatsNew: Array.isArray(row.whats_new) ? (row.whats_new as unknown[]).map(String) : [],
    updatedAt: iso(row.updated_at),
  });

  async function betaApps(): Promise<BetaApp[]> {
    const rows = await sql`select * from beta_apps where launched_at is null order by app`;
    return rows.map(view);
  }

  async function names(apps: string[]) {
    const rows = await sql`select app, name from beta_apps where app = any(${apps})`;
    const byKey = new Map(rows.map((row) => [String(row.app), String(row.name)]));
    return apps.map((app) => byKey.get(app) ?? app);
  }

  /** Each app's Resend segment ("Waitlist · Sated"), made the first time it's needed. */
  async function segments(apps: string[]) {
    const ids: string[] = [];
    for (const row of await sql`select app, name, resend_segment_id from beta_apps where app = any(${apps})`) {
      let id = row.resend_segment_id as string | null;
      if (!id) {
        id = await email().segment(`Waitlist · ${String(row.name)}`);
        await sql`update beta_apps set resend_segment_id = ${id} where app = ${row.app}`;
      }
      ids.push(id);
    }
    return ids;
  }

  async function sendConfirmation(id: string, to: string, apps: string[]) {
    const exp = Math.floor(now() / 1000) + CONFIRM_DAYS * 86_400;
    const link = `${api}/v1/waitlist/confirm?t=${encodeURIComponent(signToken(options.tokenKey, { id, exp }))}`;
    const message = confirmationEmail(await names(apps), link);
    await email().send({ to, ...message });
    await sql`update waitlist set confirm_sent_at = ${new Date(now())} where id = ${id}`;
  }

  return {
    betaApps,

    async betaApp(app: string) {
      const [row] = await sql`select * from beta_apps where app = ${app} and launched_at is null`;
      if (!row) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'No beta page for that app');
      return view(row);
    },

    async setWhatsNew(app: string, lines: string[], by: string) {
      const clean = lines.map((line) => line.trim()).filter(Boolean);
      const [row] = await sql`
        update beta_apps set whats_new = ${sql.json(clean)}, updated_by = ${by}, updated_at = ${new Date(now())}
        where app = ${app} and launched_at is null returning *`;
      if (!row) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'No beta page for that app');
      return view(row);
    },

    /**
     * A sign-up from the website. Says nothing about whether the address was already there.
     * A confirmed person who adds an app is added to its segment without another email.
     */
    async join(input: { email: string; apps: string[]; via?: string | undefined; page?: string | undefined }) {
      const address = normalizeEmail(input.email);
      const wanted = [...new Set(input.apps)];
      const known = new Set((await sql`select app from beta_apps where app = any(${wanted}) and launched_at is null`).map((row) => String(row.app)));
      if (wanted.length === 0 || wanted.some((app) => !known.has(app))) throw new ApiError(400, 'INVALID_REQUEST', 'Pick one of the apps in beta');
      const via = input.via && /^[a-z0-9-]{2,60}$/.test(input.via) ? input.via : null;
      const page = input.page ? input.page.slice(0, 200) : null;
      const [before] = await sql`select apps from waitlist where email = ${address}`;
      const [row] = await sql`
        insert into waitlist (email, apps, via, page) values (${address}, ${wanted}, ${via}, ${page})
        on conflict (email) do update set
          apps = (select array_agg(distinct a order by a) from unnest(waitlist.apps || excluded.apps) a),
          unsubscribed_at = null
        returning id, apps, confirmed_at, confirm_sent_at, bounced_at`;
      const id = String(row!.id);
      const apps = (row!.apps as string[]) ?? wanted;
      if (row!.bounced_at) return { ok: true as const };
      if (row!.confirmed_at) {
        const added = wanted.filter((app) => !((before?.apps as string[] | undefined) ?? []).includes(app));
        if (added.length && options.resend) await email().addToSegments(address, await segments(added));
        return { ok: true as const };
      }
      const sentAt = row!.confirm_sent_at instanceof Date ? row!.confirm_sent_at.getTime() : null;
      if (sentAt === null || now() - sentAt > RESEND_AFTER_MS) await sendConfirmation(id, address, apps);
      return { ok: true as const };
    },

    /** The confirm link: the apps confirmed, or undefined for a bad or expired link. */
    async confirm(token: string) {
      const payload = readToken(options.tokenKey, token, now());
      if (!payload || !/^[0-9a-f-]{36}$/.test(payload.id)) return undefined;
      const [row] = await sql`
        update waitlist set confirmed_at = coalesce(confirmed_at, ${new Date(now())})
        where id = ${payload.id} returning email, apps, resend_contact_id`;
      if (!row) return undefined;
      const apps = row.apps as string[];
      const added = await email().addToSegments(String(row.email), await segments(apps));
      if (added.id && !row.resend_contact_id) await sql`update waitlist set resend_contact_id = ${added.id} where id = ${payload.id}`;
      return { apps };
    },

    /** A beta page's TestFlight button: counts the tap, then says where TestFlight is. */
    async testflight(app: string, via: string | undefined, userAgent: string | undefined) {
      const [beta] = await sql`select testflight_url from beta_apps where app = ${app}`;
      if (!beta) return undefined;
      if (!isBot(userAgent)) {
        const [link] = via && /^[a-z0-9-]{2,60}$/.test(via)
          ? await sql`select id from campaign_links where slug = ${via} and app = ${app} and deleted_at is null`
          : [];
        const day = new Date(now()).toISOString().slice(0, 10);
        await sql`
          insert into testflight_taps_daily (app, link_id, day, taps) values (${app}, ${link?.id ?? null}, ${day}, 1)
          on conflict (app, coalesce(link_id, '00000000-0000-0000-0000-000000000000'::uuid), day)
          do update set taps = testflight_taps_daily.taps + 1`;
      }
      return String(beta.testflight_url);
    },

    /** Hearth Connect's Beta card: sign-ups and taps per app. */
    async summary(days: number) {
      const since = new Date(now() - days * 86_400_000);
      const sinceDay = since.toISOString().slice(0, 10);
      const apps = await betaApps();
      const list = [];
      const totals: Counts = { confirmed: 0, pending: 0, new: 0, testflightTaps: 0, pageTaps: 0 };
      for (const app of apps) {
        const [people] = await sql`
          select
            count(*) filter (where confirmed_at is not null) as confirmed,
            count(*) filter (where confirmed_at is null) as pending,
            count(*) filter (where confirmed_at >= ${since}) as recent
          from waitlist where ${app.key} = any(apps) and unsubscribed_at is null and bounced_at is null`;
        const [testflight] = await sql`select coalesce(sum(taps), 0) as taps from testflight_taps_daily where app = ${app.key} and day >= ${sinceDay}`;
        const [page] = await sql`
          select coalesce(sum(t.taps), 0) as taps from link_taps_daily t join campaign_links l on l.id = t.link_id
          where l.app = ${app.key} and l.destination = 'beta' and t.day >= ${sinceDay}`;
        const counts: Counts = {
          confirmed: Number(people!.confirmed), pending: Number(people!.pending), new: Number(people!.recent),
          testflightTaps: Number(testflight!.taps), pageTaps: Number(page!.taps),
        };
        for (const key of Object.keys(totals) as (keyof Counts)[]) totals[key] += counts[key];
        list.push({
          app: app.key, name: app.name,
          waitlist: { confirmed: counts.confirmed, pending: counts.pending, new: counts.new },
          testflightTaps: counts.testflightTaps, pageTaps: counts.pageTaps,
        });
      }
      return { days, apps: list, totals };
    },

    /** The launch email for an app: a preview, or (send) a broadcast to everyone confirmed for it. */
    async launch(input: { app: string; appStoreUrl: string; send: boolean; by: string }) {
      const [beta] = await sql`select name from beta_apps where app = ${input.app}`;
      if (!beta) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'No beta page for that app');
      if (!/^https:\/\/apps\.apple\.com\//.test(input.appStoreUrl)) throw new ApiError(400, 'INVALID_REQUEST', 'Use the app’s apps.apple.com link');
      const [count] = await sql`
        select count(*) as n from waitlist
        where ${input.app} = any(apps) and confirmed_at is not null and unsubscribed_at is null and bounced_at is null`;
      const recipients = Number(count!.n);
      const message = launchEmail(String(beta.name), input.appStoreUrl);
      if (!input.send) return { ...message, recipients };
      const [already] = await sql`select 1 from waitlist_broadcasts where app = ${input.app}`;
      if (already) throw new ApiError(409, 'ALREADY_SENT', `The launch email for ${String(beta.name)} has already gone out`);
      if (recipients === 0) throw new ApiError(400, 'INVALID_REQUEST', 'Nobody has confirmed for this app yet');
      const [segmentId] = await segments([input.app]);
      const sent = await email().broadcast({ segmentId: segmentId!, name: `${String(beta.name)} launch`, ...message });
      await sql`
        insert into waitlist_broadcasts (app, resend_broadcast_id, recipients, app_store_url, sent_by)
        values (${input.app}, ${sent.id}, ${recipients}, ${input.appStoreUrl}, ${input.by})`;
      return { broadcastId: sent.id, recipients };
    },

    /** Someone asked to be taken off: the row and the Resend contact go. */
    async remove(address: string) {
      const normalized = normalizeEmail(address);
      await sql`delete from waitlist where email = ${normalized}`;
      if (options.resend) await options.resend.removeContact(normalized);
    },

    /** Resend's webhook: bounces, complaints and unsubscribes stop further email. */
    async webhook(event: { type?: unknown; data?: Record<string, unknown> }) {
      const data = event.data ?? {};
      const to = Array.isArray(data.to) ? data.to.map(String) : typeof data.email === 'string' ? [data.email] : [];
      const addresses = to.map((value) => value.trim().toLowerCase()).filter(Boolean);
      if (!addresses.length) return { handled: false };
      const at = new Date(now());
      switch (event.type) {
        case 'email.bounced':
          await sql`update waitlist set bounced_at = ${at} where email = any(${addresses})`;
          return { handled: true };
        case 'email.complained':
        case 'contact.deleted':
          await sql`update waitlist set unsubscribed_at = ${at} where email = any(${addresses})`;
          return { handled: true };
        case 'contact.updated':
          if (data.unsubscribed === true) {
            await sql`update waitlist set unsubscribed_at = ${at} where email = any(${addresses})`;
            return { handled: true };
          }
          return { handled: false };
        default:
          return { handled: false };
      }
    },

    confirmedPage: (apps: string[] | undefined) =>
      apps ? `${site}/beta/confirmed?apps=${apps.map(encodeURIComponent).join(',')}` : `${site}/beta/confirmed?status=expired`,
    thanksPage: (apps: string[] | undefined) =>
      apps ? `${site}/beta/thanks?apps=${apps.map(encodeURIComponent).join(',')}` : `${site}/beta/thanks?status=invalid`,
  };
}
