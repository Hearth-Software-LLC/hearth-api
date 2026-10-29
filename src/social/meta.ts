import { createHmac } from 'node:crypto';

/**
 * Meta's Graph API for Hearth Ship's social pages: Facebook Pages and the Instagram accounts
 * linked to them. Everything goes out as the Page (a Page access token from a long-lived user
 * token, which doesn't expire), so the developer app can stay in development mode: people with
 * a role on the app can use every permission on their own Pages without App Review.
 *
 * Numbers are fetched metric by metric where Meta has been retiring metrics, so one that's gone
 * leaves a gap instead of failing the sync.
 */

export type MetaSettings = {
  appId: string;
  appSecret: string;
  /** e.g. "v24.0" */
  version: string;
  redirectUri: string;
  /** Facebook Login for Business configuration; when set it replaces the scope list. */
  loginConfigId?: string | undefined;
};

export const META_SCOPES = [
  'pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'pages_manage_engagement',
  'pages_read_user_content', 'read_insights', 'business_management',
  'instagram_basic', 'instagram_content_publish', 'instagram_manage_comments', 'instagram_manage_insights',
];

export type MetaPlatform = 'facebook' | 'instagram';

/** A Page or Instagram account the login can post as. */
export type MetaAccount = {
  platform: MetaPlatform;
  externalId: string;
  name: string;
  handle: string | null;
  avatarUrl: string | null;
  token: string;
};

export type MetaTarget = { platform: MetaPlatform; externalId: string; token: string };

export type PublishMedia = { url: string; kind: 'image' | 'video' };
export type PublishInput = {
  text: string;
  link: string | null;
  firstComment: string | null;
  format: 'feed' | 'reel' | 'story';
  media: PublishMedia[];
};

export type PublishResult =
  | { state: 'published'; remoteId: string; permalink: string | null; warning: string | null }
  | { state: 'processing'; containerId: string };

export type RemotePost = {
  remoteId: string;
  text: string;
  permalink: string | null;
  mediaUrl: string | null;
  publishedAt: string;
  likes: number | null;
  comments: number | null;
  shares: number | null;
};

export type RemoteComment = {
  remoteId: string;
  parentRemoteId: string | null;
  author: string;
  text: string;
  likes: number;
  at: string;
  fromAccount: boolean;
};

export type MetricName = 'followers' | 'reach' | 'impressions' | 'views' | 'likes' | 'comments' | 'shares' | 'saves' | 'clicks' | 'engagements';
export type DayMetric = { day: string; metric: MetricName; value: number };
export type PostMetric = { metric: MetricName; value: number };

export class MetaError extends Error {
  constructor(message: string, readonly code: number | null, readonly auth: boolean) {
    super(message);
    this.name = 'MetaError';
  }
}

export type MetaClient = ReturnType<typeof createMetaClient>;

const today = () => new Date().toISOString().slice(0, 10);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function createMetaClient(settings: MetaSettings, fetcher: typeof fetch = fetch, wait: (ms: number) => Promise<unknown> = sleep) {
  const base = `https://graph.facebook.com/${settings.version}`;
  const proof = (token: string) => createHmac('sha256', settings.appSecret).update(token).digest('hex');

  async function graph<T = Record<string, unknown>>(method: 'GET' | 'POST', path: string, params: Record<string, string | number | boolean | undefined>, token?: string): Promise<T> {
    const values = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) if (value !== undefined) values.set(key, String(value));
    if (token) {
      values.set('access_token', token);
      values.set('appsecret_proof', proof(token));
    }
    const url = method === 'GET' ? `${base}/${path}?${values}` : `${base}/${path}`;
    let response: Response;
    try {
      response = await fetcher(url, {
        method,
        ...(method === 'POST' ? { body: values, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } } : {}),
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new MetaError('Meta could not be reached', null, false);
    }
    const body = await response.json().catch(() => null) as ({ error?: { message?: string; code?: number; error_subcode?: number; type?: string } } & T) | null;
    if (!response.ok || !body || body.error) {
      const error = body?.error;
      const code = error?.code ?? null;
      // 190: the token is invalid, expired or revoked; 102: the session is gone.
      const auth = code === 190 || code === 102;
      throw new MetaError((error?.message ?? `Meta answered ${response.status}`).slice(0, 400), code, auth);
    }
    return body;
  }

  /** Each metric on its own, keeping the ones Meta still answers. */
  async function tolerant<T>(names: string[], fetchOne: (name: string) => Promise<T[]>): Promise<T[]> {
    const results: T[] = [];
    for (const name of names) {
      try {
        results.push(...await fetchOne(name));
      } catch (error) {
        if (error instanceof MetaError && error.auth) throw error;
      }
    }
    return results;
  }

  const permalink = (value: unknown) => {
    if (typeof value !== 'string' || !value) return null;
    return value.startsWith('/') ? `https://www.facebook.com${value}` : value;
  };

  // MARK: Instagram publishing

  async function instagramContainer(target: MetaTarget, input: PublishInput): Promise<string> {
    const caption = input.text;
    const [first] = input.media;
    if (!first) throw new MetaError('Instagram posts need a photo or video', null, false);
    if (input.format === 'story') {
      const created = await graph<{ id: string }>('POST', `${target.externalId}/media`, {
        media_type: 'STORIES', ...(first.kind === 'video' ? { video_url: first.url } : { image_url: first.url }),
      }, target.token);
      return created.id;
    }
    if (input.media.length > 1) {
      const children: string[] = [];
      for (const item of input.media.slice(0, 10)) {
        const child = await graph<{ id: string }>('POST', `${target.externalId}/media`, {
          is_carousel_item: true,
          ...(item.kind === 'video' ? { media_type: 'VIDEO', video_url: item.url } : { image_url: item.url }),
        }, target.token);
        children.push(child.id);
      }
      for (const child of children) await waitForContainer(target, child, 60_000);
      const created = await graph<{ id: string }>('POST', `${target.externalId}/media`, {
        media_type: 'CAROUSEL', children: children.join(','), caption,
      }, target.token);
      return created.id;
    }
    const created = await graph<{ id: string }>('POST', `${target.externalId}/media`, first.kind === 'video'
      ? { media_type: 'REELS', video_url: first.url, caption, share_to_feed: true }
      : { image_url: first.url, caption }, target.token);
    return created.id;
  }

  /** FINISHED, ERROR (throws) or still IN_PROGRESS after `budgetMs`. */
  async function waitForContainer(target: MetaTarget, containerId: string, budgetMs: number): Promise<boolean> {
    const deadline = Date.now() + budgetMs;
    for (;;) {
      const status = await graph<{ status_code?: string; status?: string }>('GET', containerId, { fields: 'status_code,status' }, target.token);
      if (status.status_code === 'FINISHED' || status.status_code === 'PUBLISHED') return true;
      if (status.status_code === 'ERROR' || status.status_code === 'EXPIRED') {
        throw new MetaError(`Instagram couldn’t process the media${status.status ? ` (${status.status})` : ''}`, null, false);
      }
      if (Date.now() + 3000 > deadline) return false;
      await wait(3000);
    }
  }

  async function instagramFinish(target: MetaTarget, containerId: string, firstComment: string | null): Promise<PublishResult> {
    const published = await graph<{ id: string }>('POST', `${target.externalId}/media_publish`, { creation_id: containerId }, target.token);
    const details = await graph<{ permalink?: string }>('GET', published.id, { fields: 'permalink' }, target.token).catch(() => ({} as { permalink?: string }));
    const warning = firstComment ? await comment(target, published.id, firstComment) : null;
    return { state: 'published', remoteId: published.id, permalink: details.permalink ?? null, warning };
  }

  /** The first comment; a failure is a warning, not a failed post. */
  async function comment(target: MetaTarget, remoteId: string, text: string): Promise<string | null> {
    try {
      await graph('POST', `${remoteId}/comments`, { message: text }, target.token);
      return null;
    } catch (error) {
      return `Posted, but the first comment failed: ${error instanceof Error ? error.message : 'unknown error'}`.slice(0, 500);
    }
  }

  // MARK: Facebook publishing

  async function facebookPublish(target: MetaTarget, input: PublishInput): Promise<PublishResult> {
    const page = target.externalId;
    let remoteId: string;
    const video = input.media.find((item) => item.kind === 'video');
    if (video) {
      const created = await graph<{ id: string }>('POST', `${page}/videos`, { file_url: video.url, description: input.text }, target.token);
      remoteId = created.id;
    } else if (input.media.length === 1) {
      const created = await graph<{ id: string; post_id?: string }>('POST', `${page}/photos`, { url: input.media[0]!.url, message: input.text }, target.token);
      remoteId = created.post_id ?? created.id;
    } else if (input.media.length > 1) {
      const ids: string[] = [];
      for (const item of input.media.slice(0, 10)) {
        const photo = await graph<{ id: string }>('POST', `${page}/photos`, { url: item.url, published: false }, target.token);
        ids.push(photo.id);
      }
      const created = await graph<{ id: string }>('POST', `${page}/feed`, {
        message: input.text, attached_media: JSON.stringify(ids.map((id) => ({ media_fbid: id }))),
      }, target.token);
      remoteId = created.id;
    } else {
      const created = await graph<{ id: string }>('POST', `${page}/feed`, { message: input.text, link: input.link ?? undefined }, target.token);
      remoteId = created.id;
    }
    const details = await graph<{ permalink_url?: string }>('GET', remoteId, { fields: 'permalink_url' }, target.token).catch(() => ({} as { permalink_url?: string }));
    const warning = input.firstComment ? await comment(target, remoteId, input.firstComment) : null;
    return { state: 'published', remoteId, permalink: permalink(details.permalink_url), warning };
  }

  return {
    authorizeUrl(state: string): string {
      const query = new URLSearchParams({
        client_id: settings.appId, redirect_uri: settings.redirectUri, state, response_type: 'code',
        ...(settings.loginConfigId ? { config_id: settings.loginConfigId } : { scope: META_SCOPES.join(',') }),
      });
      return `https://www.facebook.com/${settings.version}/dialog/oauth?${query}`;
    },

    /** The code from the login redirect, as a long-lived user token. */
    async exchangeCode(code: string): Promise<string> {
      const short = await graph<{ access_token: string }>('GET', 'oauth/access_token', {
        client_id: settings.appId, client_secret: settings.appSecret, redirect_uri: settings.redirectUri, code,
      });
      const long = await graph<{ access_token: string }>('GET', 'oauth/access_token', {
        grant_type: 'fb_exchange_token', client_id: settings.appId, client_secret: settings.appSecret, fb_exchange_token: short.access_token,
      });
      return long.access_token;
    },

    /** Every Page the login manages, and the Instagram account linked to each. */
    async accounts(userToken: string): Promise<MetaAccount[]> {
      type Page = {
        id: string; name: string; access_token?: string; picture?: { data?: { url?: string } };
        instagram_business_account?: { id: string; username?: string; name?: string; profile_picture_url?: string };
      };
      const fields = 'id,name,access_token,picture{url},instagram_business_account{id,username,name,profile_picture_url}';
      const pages = new Map<string, Page>();
      const found = await graph<{ data?: Page[] }>('GET', 'me/accounts', { fields, limit: 100 }, userToken);
      for (const page of found.data ?? []) pages.set(page.id, page);

      // Facebook Login for Business grants Pages one by one; the token's granular scopes name them,
      // including Pages a portfolio owns that me/accounts leaves out.
      if (pages.size === 0) {
        type Debug = { data?: { granular_scopes?: { scope: string; target_ids?: string[] }[] } };
        const debug = await graph<Debug>('GET', 'debug_token', {
          input_token: userToken, access_token: `${settings.appId}|${settings.appSecret}`,
        }).catch(() => ({} as Debug));
        const ids = new Set((debug.data?.granular_scopes ?? [])
          .filter((entry) => entry.scope.startsWith('pages_'))
          .flatMap((entry) => entry.target_ids ?? []));
        for (const id of ids) {
          const page = await graph<Page>('GET', id, { fields }, userToken).catch(() => undefined);
          if (page) pages.set(page.id, page);
        }
      }

      // A Page a business portfolio owns isn't always in me/accounts (the person reaches it through
      // the portfolio, not a role of their own). Look through the portfolios too.
      if (pages.size === 0) {
        type Business = { id: string; owned_pages?: { data?: { id: string }[] }; client_pages?: { data?: { id: string }[] } };
        const businesses = await graph<{ data?: Business[] }>('GET', 'me/businesses', {
          fields: 'id,owned_pages.limit(50){id},client_pages.limit(50){id}', limit: 25,
        }, userToken).catch((error) => { if (error instanceof MetaError && error.auth) throw error; return { data: [] as Business[] }; });
        const ids = new Set((businesses.data ?? []).flatMap((business) => [
          ...(business.owned_pages?.data ?? []), ...(business.client_pages?.data ?? []),
        ].map((page) => page.id)));
        for (const id of ids) {
          const page = await graph<Page>('GET', id, { fields }, userToken).catch(() => undefined);
          if (page) pages.set(page.id, page);
        }
      }

      const accounts: MetaAccount[] = [];
      for (const page of pages.values()) {
        if (!page.access_token) continue;
        accounts.push({ platform: 'facebook', externalId: page.id, name: page.name, handle: null, avatarUrl: page.picture?.data?.url ?? null, token: page.access_token });
        const ig = page.instagram_business_account;
        if (ig) {
          accounts.push({
            platform: 'instagram', externalId: ig.id, name: ig.name || ig.username || page.name,
            handle: ig.username ?? null, avatarUrl: ig.profile_picture_url ?? null, token: page.access_token,
          });
        }
      }
      return accounts;
    },

    /** The permissions the login granted (for explaining an empty login). */
    async grantedPermissions(userToken: string): Promise<string[]> {
      const list = await graph<{ data?: { permission: string; status: string }[] }>('GET', 'me/permissions', {}, userToken).catch(() => ({ data: [] }));
      return (list.data ?? []).filter((entry) => entry.status === 'granted').map((entry) => entry.permission);
    },

    /** Posts now. Instagram video that's still processing after `waitMs` comes back as processing. */
    async publish(target: MetaTarget, input: PublishInput, waitMs = 20_000): Promise<PublishResult> {
      if (target.platform === 'facebook') return facebookPublish(target, input);
      const containerId = await instagramContainer(target, input);
      if (!await waitForContainer(target, containerId, waitMs)) return { state: 'processing', containerId };
      return instagramFinish(target, containerId, input.firstComment);
    },

    /** Carries on with an Instagram container that was processing. */
    async resume(target: MetaTarget, containerId: string, firstComment: string | null, waitMs = 5_000): Promise<PublishResult> {
      if (!await waitForContainer(target, containerId, waitMs)) return { state: 'processing', containerId };
      return instagramFinish(target, containerId, firstComment);
    },

    async recentPosts(target: MetaTarget, limit = 25): Promise<RemotePost[]> {
      if (target.platform === 'instagram') {
        type Media = { id: string; caption?: string; media_type?: string; media_url?: string; thumbnail_url?: string; permalink?: string; timestamp: string; like_count?: number; comments_count?: number };
        const media = await graph<{ data?: Media[] }>('GET', `${target.externalId}/media`, {
          fields: 'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count', limit,
        }, target.token);
        return (media.data ?? []).map((item) => ({
          remoteId: item.id, text: item.caption ?? '', permalink: item.permalink ?? null,
          mediaUrl: (item.media_type === 'VIDEO' ? item.thumbnail_url : item.media_url) ?? item.thumbnail_url ?? null,
          publishedAt: new Date(item.timestamp).toISOString(), likes: item.like_count ?? null, comments: item.comments_count ?? null, shares: null,
        }));
      }
      type Post = { id: string; message?: string; created_time: string; permalink_url?: string; full_picture?: string; shares?: { count?: number }; reactions?: { summary?: { total_count?: number } }; comments?: { summary?: { total_count?: number } } };
      const posts = await graph<{ data?: Post[] }>('GET', `${target.externalId}/published_posts`, {
        fields: 'id,message,created_time,permalink_url,full_picture,shares,reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0)', limit,
      }, target.token);
      return (posts.data ?? []).map((item) => ({
        remoteId: item.id, text: item.message ?? '', permalink: permalink(item.permalink_url), mediaUrl: item.full_picture ?? null,
        publishedAt: new Date(item.created_time).toISOString(), likes: item.reactions?.summary?.total_count ?? null,
        comments: item.comments?.summary?.total_count ?? null, shares: item.shares?.count ?? 0,
      }));
    },

    async comments(target: MetaTarget, remotePostId: string, handle: string | null): Promise<RemoteComment[]> {
      const found: RemoteComment[] = [];
      if (target.platform === 'instagram') {
        type Comment = { id: string; text?: string; username?: string; timestamp: string; like_count?: number; replies?: { data?: Comment[] } };
        const list = await graph<{ data?: Comment[] }>('GET', `${remotePostId}/comments`, {
          fields: 'id,text,username,timestamp,like_count,replies{id,text,username,timestamp,like_count}', limit: 50,
        }, target.token);
        const add = (item: Comment, parent: string | null) => found.push({
          remoteId: item.id, parentRemoteId: parent, author: item.username ?? '', text: item.text ?? '', likes: item.like_count ?? 0,
          at: new Date(item.timestamp).toISOString(), fromAccount: !!handle && item.username === handle,
        });
        for (const item of list.data ?? []) {
          add(item, null);
          for (const reply of item.replies?.data ?? []) add(reply, item.id);
        }
        return found;
      }
      type Comment = { id: string; message?: string; from?: { id?: string; name?: string }; created_time: string; like_count?: number; comments?: { data?: Comment[] } };
      const list = await graph<{ data?: Comment[] }>('GET', `${remotePostId}/comments`, {
        fields: 'id,message,from{id,name},created_time,like_count,comments.limit(25){id,message,from{id,name},created_time,like_count}', limit: 50,
      }, target.token);
      const add = (item: Comment, parent: string | null) => found.push({
        remoteId: item.id, parentRemoteId: parent, author: item.from?.name ?? '', text: item.message ?? '', likes: item.like_count ?? 0,
        at: new Date(item.created_time).toISOString(), fromAccount: item.from?.id === target.externalId,
      });
      for (const item of list.data ?? []) {
        add(item, null);
        for (const reply of item.comments?.data ?? []) add(reply, item.id);
      }
      return found;
    },

    async reply(target: MetaTarget, commentRemoteId: string, text: string): Promise<string> {
      const edge = target.platform === 'instagram' ? 'replies' : 'comments';
      const created = await graph<{ id: string }>('POST', `${commentRemoteId}/${edge}`, { message: text }, target.token);
      return created.id;
    },

    async hide(target: MetaTarget, commentRemoteId: string, hidden: boolean): Promise<void> {
      await graph('POST', commentRemoteId, target.platform === 'instagram' ? { hide: hidden } : { is_hidden: hidden }, target.token);
    },

    /** Followers today, and daily reach (and engagement for Pages) for the last four weeks. */
    async accountMetrics(target: MetaTarget, days = 28): Promise<DayMetric[]> {
      const rows: DayMetric[] = [];
      const fields = await graph<{ followers_count?: number }>('GET', target.externalId, { fields: 'followers_count' }, target.token)
        .catch((error) => { if (error instanceof MetaError && error.auth) throw error; return {} as { followers_count?: number }; });
      if (typeof fields.followers_count === 'number') rows.push({ day: today(), metric: 'followers', value: fields.followers_count });
      const until = Math.floor(Date.now() / 1000);
      const since = until - Math.min(days, 29) * 86_400;
      const names: Record<string, MetricName> = target.platform === 'instagram'
        ? { reach: 'reach' }
        : { page_impressions_unique: 'reach', page_post_engagements: 'engagements', page_views_total: 'views' };
      rows.push(...await tolerant(Object.keys(names), async (name) => {
        type Insight = { data?: { name: string; values?: { value?: number; end_time?: string }[] }[] };
        const insight = await graph<Insight>('GET', `${target.externalId}/insights`, { metric: name, period: 'day', since, until }, target.token);
        return (insight.data?.[0]?.values ?? []).flatMap((point) => {
          if (typeof point.value !== 'number' || !point.end_time) return [];
          // end_time is the end of the day it counts (midnight Pacific); step back into that day.
          const day = new Date(new Date(point.end_time).getTime() - 12 * 3_600_000).toISOString().slice(0, 10);
          return [{ day, metric: names[name]!, value: point.value }];
        });
      }));
      return rows;
    },

    /** A post's lifetime totals that Meta still reports. */
    async postMetrics(target: MetaTarget, remotePostId: string): Promise<PostMetric[]> {
      const names: Record<string, MetricName> = target.platform === 'instagram'
        ? { reach: 'reach', views: 'views', likes: 'likes', comments: 'comments', shares: 'shares', saved: 'saves' }
        : { post_impressions_unique: 'reach', post_clicks: 'clicks' };
      type Insight = { data?: { name: string; values?: { value?: number }[]; total_value?: { value?: number } }[] };
      const read = (insight: Insight) => (insight.data ?? []).flatMap((entry) => {
        const value = entry.total_value?.value ?? entry.values?.[0]?.value;
        const metric = names[entry.name];
        return typeof value === 'number' && metric ? [{ metric, value }] : [];
      });
      try {
        return read(await graph<Insight>('GET', `${remotePostId}/insights`, { metric: Object.keys(names).join(',') }, target.token));
      } catch (error) {
        if (error instanceof MetaError && error.auth) throw error;
      }
      return tolerant(Object.keys(names), async (name) => read(await graph<Insight>('GET', `${remotePostId}/insights`, { metric: name }, target.token)));
    },
  };
}
