import type { Sql } from 'postgres';
import type { MetaPlatform, MetricName } from './meta.js';

/**
 * The social_* tables (supabase/migrations/20261029000000_social_pages.sql). Every query is
 * scoped by the owner; the cron's queries across owners are named as such.
 */

export const SOCIAL_PLATFORMS = ['instagram', 'facebook', 'tiktok', 'youtube', 'x', 'linkedin', 'pinterest', 'snapchat'] as const;
export type SocialPlatformId = typeof SOCIAL_PLATFORMS[number];
export type TargetStatus = 'draft' | 'scheduled' | 'publishing' | 'processing' | 'published' | 'failed';
export type TargetFormat = 'feed' | 'reel' | 'story';
export type MediaItem = { path: string; kind: 'image' | 'video'; width?: number | undefined; height?: number | undefined };

export type ConnectionView = {
  id: string;
  platform: MetaPlatform;
  externalId: string;
  name: string;
  handle: string | null;
  avatarUrl: string | null;
  app: string | null;
  status: 'active' | 'needs_reconnect';
  lastError: string | null;
  postsSyncedAt: string | null;
  metricsSyncedAt: string | null;
  createdAt: string;
};
export type StoredConnection = ConnectionView & { ownerId: string; tokenSealed: string };

export type TargetView = {
  id: string;
  postId: string | null;
  app: string;
  platform: SocialPlatformId;
  connectionId: string | null;
  delivery: 'api' | 'handoff';
  format: TargetFormat;
  text: string | null;
  status: TargetStatus;
  scheduledFor: string | null;
  attempts: number;
  containerId: string | null;
  remoteId: string | null;
  permalink: string | null;
  publishedAt: string | null;
  error: string | null;
  previewText: string | null;
  previewMediaUrl: string | null;
  likeCount: number | null;
  commentCount: number | null;
  shareCount: number | null;
  updatedAt: string;
};
export type StoredTarget = TargetView & { ownerId: string };

export type PostView = {
  id: string;
  app: string;
  about: string | null;
  text: string;
  link: string | null;
  firstComment: string | null;
  media: MediaItem[];
  draft: boolean;
  scheduledFor: string | null;
  createdAt: string;
  updatedAt: string;
  targets: TargetView[];
};

export type CommentView = {
  id: string;
  connectionId: string;
  app: string;
  platform: MetaPlatform;
  remoteId: string;
  remotePostId: string;
  parentRemoteId: string | null;
  author: string;
  text: string;
  likeCount: number;
  fromAccount: boolean;
  status: 'open' | 'done' | 'hidden';
  commentedAt: string;
};

export type MetricRow = { platform: string; postKey: string; day: string; metric: MetricName; value: number; source: 'api' | 'import' };

export type PostInput = {
  app: string;
  about: string | null;
  text: string;
  link: string | null;
  firstComment: string | null;
  media: MediaItem[];
  draft: boolean;
  scheduledFor: string | null;
};
export type TargetInput = {
  platform: SocialPlatformId;
  connectionId: string | null;
  delivery: 'api' | 'handoff';
  format: TargetFormat;
  text: string | null;
  status: TargetStatus;
  scheduledFor: string | null;
};

export type RemotePostUpsert = {
  remoteId: string;
  text: string;
  permalink: string | null;
  mediaUrl: string | null;
  publishedAt: string;
  likes: number | null;
  comments: number | null;
  shares: number | null;
};

type Row = Record<string, unknown>;
const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : value == null ? null : String(value));
const num = (value: unknown) => (value == null ? null : Number(value));

function connection(row: Row): StoredConnection {
  return {
    id: String(row.id), ownerId: String(row.owner_id), platform: row.platform as MetaPlatform, externalId: String(row.external_id),
    name: String(row.name), handle: (row.handle as string | null) ?? null, avatarUrl: (row.avatar_url as string | null) ?? null,
    app: (row.app as string | null) ?? null, status: row.status as ConnectionView['status'], lastError: (row.last_error as string | null) ?? null,
    postsSyncedAt: iso(row.posts_synced_at), metricsSyncedAt: iso(row.metrics_synced_at), createdAt: iso(row.created_at)!,
    tokenSealed: String(row.token_sealed),
  };
}

export function publicConnection(stored: StoredConnection): ConnectionView {
  const { ownerId: _owner, tokenSealed: _token, ...view } = stored;
  return view;
}

function target(row: Row): StoredTarget {
  return {
    id: String(row.id), ownerId: String(row.owner_id), postId: (row.post_id as string | null) ?? null, app: String(row.app),
    platform: row.platform as SocialPlatformId, connectionId: (row.connection_id as string | null) ?? null,
    delivery: row.delivery as TargetView['delivery'], format: row.format as TargetFormat, text: (row.text as string | null) ?? null,
    status: row.status as TargetStatus, scheduledFor: iso(row.scheduled_for), attempts: Number(row.attempts ?? 0),
    containerId: (row.container_id as string | null) ?? null, remoteId: (row.remote_id as string | null) ?? null,
    permalink: (row.permalink as string | null) ?? null, publishedAt: iso(row.published_at), error: (row.error as string | null) ?? null,
    previewText: (row.preview_text as string | null) ?? null, previewMediaUrl: (row.preview_media_url as string | null) ?? null,
    likeCount: num(row.like_count), commentCount: num(row.comment_count), shareCount: num(row.share_count), updatedAt: iso(row.updated_at)!,
  };
}

export function publicTarget(stored: StoredTarget): TargetView {
  const { ownerId: _owner, ...view } = stored;
  return view;
}

function comment(row: Row): CommentView & { ownerId: string } {
  return {
    id: String(row.id), ownerId: String(row.owner_id), connectionId: String(row.connection_id), app: String(row.app),
    platform: row.platform as MetaPlatform, remoteId: String(row.remote_id), remotePostId: String(row.remote_post_id),
    parentRemoteId: (row.parent_remote_id as string | null) ?? null, author: String(row.author), text: String(row.text),
    likeCount: Number(row.like_count ?? 0), fromAccount: row.from_account === true, status: row.status as CommentView['status'],
    commentedAt: iso(row.commented_at)!,
  };
}

export type SocialStore = ReturnType<typeof createSocialStore>;

export function createSocialStore(sql: Sql) {
  async function postsWithTargets(rows: Row[]): Promise<PostView[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((row) => String(row.id));
    const targets = await sql`select * from social_targets where post_id = any(${ids}::uuid[]) order by created_at, platform`;
    const byPost = new Map<string, TargetView[]>();
    for (const row of targets) {
      const view = publicTarget(target(row));
      byPost.set(view.postId!, [...(byPost.get(view.postId!) ?? []), view]);
    }
    return rows.map((row) => ({
      id: String(row.id), app: String(row.app), about: (row.about as string | null) ?? null, text: String(row.text), link: (row.link as string | null) ?? null,
      firstComment: (row.first_comment as string | null) ?? null, media: (row.media as MediaItem[] | null) ?? [],
      draft: row.draft === true, scheduledFor: iso(row.scheduled_for), createdAt: iso(row.created_at)!, updatedAt: iso(row.updated_at)!,
      targets: byPost.get(String(row.id)) ?? [],
    }));
  }

  return {
    // MARK: Connections

    async connections(owner: string): Promise<StoredConnection[]> {
      const rows = await sql`select * from social_connections where owner_id = ${owner} order by app nulls last, platform, name`;
      return rows.map(connection);
    },

    async connection(owner: string, id: string): Promise<StoredConnection | undefined> {
      const [row] = await sql`select * from social_connections where owner_id = ${owner} and id = ${id}`;
      return row ? connection(row) : undefined;
    },

    /** Saves an account from a login; an account seen before keeps its app. */
    async saveConnection(owner: string, input: { platform: MetaPlatform; externalId: string; name: string; handle: string | null; avatarUrl: string | null; app: string | null; tokenSealed: string }) {
      const [row] = await sql`
        insert into social_connections (owner_id, platform, external_id, name, handle, avatar_url, app, token_sealed)
        values (${owner}, ${input.platform}, ${input.externalId}, ${input.name.slice(0, 200)}, ${input.handle}, ${input.avatarUrl}, ${input.app}, ${input.tokenSealed})
        on conflict (owner_id, platform, external_id) do update set
          name = excluded.name, handle = excluded.handle, avatar_url = excluded.avatar_url,
          app = coalesce(social_connections.app, excluded.app), token_sealed = excluded.token_sealed,
          status = 'active', last_error = null, updated_at = now()
        returning *`;
      return connection(row!);
    },

    async setConnectionApp(owner: string, id: string, app: string | null) {
      const [row] = await sql`update social_connections set app = ${app}, updated_at = now() where owner_id = ${owner} and id = ${id} returning *`;
      return row ? connection(row) : undefined;
    },

    async markConnection(id: string, patch: { status?: 'active' | 'needs_reconnect'; lastError?: string | null; postsSyncedAt?: Date; metricsSyncedAt?: Date }) {
      await sql`
        update social_connections set
          status = coalesce(${patch.status ?? null}, status),
          last_error = case when ${patch.lastError !== undefined} then ${patch.lastError?.slice(0, 500) ?? null} else last_error end,
          posts_synced_at = coalesce(${patch.postsSyncedAt ?? null}, posts_synced_at),
          metrics_synced_at = coalesce(${patch.metricsSyncedAt ?? null}, metrics_synced_at),
          updated_at = now()
        where id = ${id}`;
    },

    async removeConnection(owner: string, id: string) {
      const rows = await sql`delete from social_connections where owner_id = ${owner} and id = ${id} returning id`;
      return rows.length > 0;
    },

    /** Cron: active connections with an app, across owners. */
    async activeConnections(): Promise<StoredConnection[]> {
      const rows = await sql`select * from social_connections where status = 'active' and app is not null order by posts_synced_at nulls first`;
      return rows.map(connection);
    },

    // MARK: Posts

    async posts(owner: string, app: string): Promise<PostView[]> {
      const rows = await sql`select * from social_posts where owner_id = ${owner} and app = ${app} order by coalesce(scheduled_for, updated_at) desc limit 300`;
      return postsWithTargets(rows);
    },

    async post(owner: string, id: string): Promise<PostView | undefined> {
      const rows = await sql`select * from social_posts where owner_id = ${owner} and id = ${id}`;
      return (await postsWithTargets(rows))[0];
    },

    async createPost(owner: string, input: PostInput, targets: TargetInput[]): Promise<string> {
      return sql.begin(async (tx) => {
        const [row] = await tx`
          insert into social_posts (owner_id, app, about, text, link, first_comment, media, draft, scheduled_for)
          values (${owner}, ${input.app}, ${input.about}, ${input.text}, ${input.link}, ${input.firstComment}, ${tx.json(input.media)}, ${input.draft}, ${input.scheduledFor})
          returning id`;
        const id = String(row!.id);
        for (const item of targets) {
          await tx`
            insert into social_targets (owner_id, post_id, app, platform, connection_id, delivery, format, text, status, scheduled_for)
            values (${owner}, ${id}, ${input.app}, ${item.platform}, ${item.connectionId}, ${item.delivery}, ${item.format}, ${item.text}, ${item.status}, ${item.scheduledFor})`;
        }
        return id;
      }) as Promise<string>;
    },

    /** Replaces the post and its unpublished targets; published ones stay as they are. */
    async updatePost(owner: string, id: string, input: PostInput, targets: TargetInput[]) {
      await sql.begin(async (tx) => {
        await tx`
          update social_posts set about = ${input.about}, text = ${input.text}, link = ${input.link}, first_comment = ${input.firstComment},
            media = ${tx.json(input.media)}, draft = ${input.draft}, scheduled_for = ${input.scheduledFor}, updated_at = now()
          where owner_id = ${owner} and id = ${id}`;
        const kept = await tx`select platform, connection_id from social_targets where post_id = ${id} and status in ('published', 'publishing', 'processing')`;
        await tx`delete from social_targets where post_id = ${id} and status not in ('published', 'publishing', 'processing')`;
        const keptKeys = new Set(kept.map((row) => `${row.platform}/${row.connection_id ?? ''}`));
        for (const item of targets) {
          if (keptKeys.has(`${item.platform}/${item.connectionId ?? ''}`)) continue;
          await tx`
            insert into social_targets (owner_id, post_id, app, platform, connection_id, delivery, format, text, status, scheduled_for)
            values (${owner}, ${id}, ${input.app}, ${item.platform}, ${item.connectionId}, ${item.delivery}, ${item.format}, ${item.text}, ${item.status}, ${item.scheduledFor})`;
        }
      });
    },

    async removePost(owner: string, id: string) {
      const rows = await sql`delete from social_posts where owner_id = ${owner} and id = ${id} returning id`;
      return rows.length > 0;
    },

    // MARK: Targets

    async target(owner: string, id: string): Promise<StoredTarget | undefined> {
      const [row] = await sql`select * from social_targets where owner_id = ${owner} and id = ${id}`;
      return row ? target(row) : undefined;
    },

    /** Moves a target to publishing unless something else already has (returns false then). */
    async claim(id: string, from: TargetStatus[]): Promise<boolean> {
      const rows = await sql`
        update social_targets set status = 'publishing', attempts = attempts + 1, updated_at = now()
        where id = ${id} and status = any(${from}::text[]) returning id`;
      return rows.length > 0;
    },

    async updateTarget(id: string, patch: Partial<Pick<TargetView, 'status' | 'containerId' | 'remoteId' | 'permalink' | 'publishedAt' | 'error' | 'scheduledFor'>>) {
      const has = (key: keyof typeof patch) => Object.prototype.hasOwnProperty.call(patch, key);
      await sql`
        update social_targets set
          status = coalesce(${patch.status ?? null}, status),
          container_id = case when ${has('containerId')} then ${patch.containerId ?? null} else container_id end,
          remote_id = case when ${has('remoteId')} then ${patch.remoteId ?? null} else remote_id end,
          permalink = case when ${has('permalink')} then ${patch.permalink ?? null} else permalink end,
          published_at = case when ${has('publishedAt')} then ${patch.publishedAt ?? null}::timestamptz else published_at end,
          error = case when ${has('error')} then ${patch.error?.slice(0, 500) ?? null} else error end,
          scheduled_for = case when ${has('scheduledFor')} then ${patch.scheduledFor ?? null}::timestamptz else scheduled_for end,
          updated_at = now()
        where id = ${id}`;
    },

    /** Cron: API targets due now (scheduled and processing), and ones stuck publishing for 10 minutes. */
    async dueTargets(limit = 20, owner?: string): Promise<StoredTarget[]> {
      const rows = await sql`
        select * from social_targets
        where delivery = 'api' and (${owner ?? null}::uuid is null or owner_id = ${owner ?? null}::uuid) and (
          (status = 'scheduled' and scheduled_for <= now())
          or status = 'processing'
          or (status = 'publishing' and updated_at < now() - interval '10 minutes'))
        order by scheduled_for nulls first limit ${limit}`;
      return rows.map(target);
    },

    /** Posts found on an account (or in an import) are kept by their remote id. */
    async upsertRemotePosts(owner: string, app: string, platform: SocialPlatformId, connectionId: string | null, delivery: 'api' | 'handoff', posts: RemotePostUpsert[]) {
      for (const item of posts) {
        await sql`
          insert into social_targets (owner_id, app, platform, connection_id, delivery, status, remote_id, permalink, published_at,
            preview_text, preview_media_url, like_count, comment_count, share_count)
          values (${owner}, ${app}, ${platform}, ${connectionId}, ${delivery}, 'published', ${item.remoteId}, ${item.permalink}, ${item.publishedAt},
            ${item.text.slice(0, 5000)}, ${item.mediaUrl?.slice(0, 4000) ?? null}, ${item.likes}, ${item.comments}, ${item.shares})
          on conflict (owner_id, app, platform, remote_id) where remote_id is not null do update set
            permalink = coalesce(excluded.permalink, social_targets.permalink),
            preview_text = excluded.preview_text,
            preview_media_url = coalesce(excluded.preview_media_url, social_targets.preview_media_url),
            like_count = coalesce(excluded.like_count, social_targets.like_count),
            comment_count = coalesce(excluded.comment_count, social_targets.comment_count),
            share_count = coalesce(excluded.share_count, social_targets.share_count),
            updated_at = now()`;
      }
    },

    /** Published posts on the app's accounts that weren't made in Hearth Ship. */
    async foundPosts(owner: string, app: string, limit = 200): Promise<TargetView[]> {
      const rows = await sql`
        select * from social_targets where owner_id = ${owner} and app = ${app} and post_id is null
        order by published_at desc nulls last limit ${limit}`;
      return rows.map((row) => publicTarget(target(row)));
    },

    /** Every published post of the app (made here or found), newest first. */
    async publishedTargets(owner: string, app: string, since: string): Promise<TargetView[]> {
      const rows = await sql`
        select * from social_targets where owner_id = ${owner} and app = ${app} and status = 'published' and published_at >= ${since}
        order by published_at desc limit 500`;
      return rows.map((row) => publicTarget(target(row)));
    },

    /** A connection's posts from the last `days` days, for comments and numbers. */
    async recentRemoteIds(connectionId: string, days: number, limit = 25): Promise<string[]> {
      const rows = await sql`
        select remote_id from social_targets where connection_id = ${connectionId} and status = 'published' and remote_id is not null
          and published_at >= now() - make_interval(days => ${days})
        order by published_at desc limit ${limit}`;
      return rows.map((row) => String(row.remote_id));
    },

    // MARK: Comments

    async comments(owner: string, app: string, status: CommentView['status'] | 'all', limit = 200): Promise<CommentView[]> {
      const rows = await sql`
        select * from social_comments where owner_id = ${owner} and app = ${app}
          and (${status} = 'all' or status = ${status})
        order by commented_at desc limit ${limit}`;
      return rows.map((row) => { const { ownerId: _owner, ...view } = comment(row); return view; });
    },

    async comment(owner: string, id: string) {
      const [row] = await sql`select * from social_comments where owner_id = ${owner} and id = ${id}`;
      return row ? comment(row) : undefined;
    },

    /** New comments come in open; ones from the account itself come in done. Known ones keep their status. */
    async upsertComments(owner: string, connection: StoredConnection, remotePostId: string, items: { remoteId: string; parentRemoteId: string | null; author: string; text: string; likes: number; at: string; fromAccount: boolean }[]) {
      let added = 0;
      for (const item of items) {
        const rows = await sql`
          insert into social_comments (owner_id, connection_id, app, platform, remote_id, remote_post_id, parent_remote_id, author, text, like_count, from_account, status, commented_at)
          values (${owner}, ${connection.id}, ${connection.app ?? ''}, ${connection.platform}, ${item.remoteId}, ${remotePostId}, ${item.parentRemoteId},
            ${item.author.slice(0, 200)}, ${item.text.slice(0, 5000)}, ${item.likes}, ${item.fromAccount}, ${item.fromAccount ? 'done' : 'open'}, ${item.at})
          on conflict (connection_id, remote_id) do update set text = excluded.text, like_count = excluded.like_count
          returning (xmax = 0) as inserted`;
        if (rows[0]?.inserted) added += 1;
      }
      return added;
    },

    async setCommentStatus(owner: string, id: string, status: CommentView['status']) {
      const rows = await sql`update social_comments set status = ${status} where owner_id = ${owner} and id = ${id} returning id`;
      return rows.length > 0;
    },

    /** Marks earlier open comments in the thread done after a reply. */
    async closeThread(owner: string, connectionId: string, rootRemoteId: string) {
      await sql`
        update social_comments set status = 'done'
        where owner_id = ${owner} and connection_id = ${connectionId} and status = 'open'
          and (remote_id = ${rootRemoteId} or parent_remote_id = ${rootRemoteId})`;
    },

    // MARK: Metrics

    async saveMetrics(owner: string, app: string, rows: MetricRow[]) {
      for (const row of rows) {
        await sql`
          insert into social_metrics (owner_id, app, platform, post_key, day, metric, value, source)
          values (${owner}, ${app}, ${row.platform}, ${row.postKey}, ${row.day}, ${row.metric}, ${row.value}, ${row.source})
          on conflict (owner_id, app, platform, post_key, day, metric) do update set
            value = excluded.value, source = excluded.source, updated_at = now()`;
      }
    },

    async metrics(owner: string, app: string, since: string): Promise<MetricRow[]> {
      const rows = await sql`
        select platform, post_key, day, metric, value, source from social_metrics
        where owner_id = ${owner} and app = ${app} and (post_key <> '' or day >= ${since}::date)
        order by day`;
      return rows.map((row) => ({
        platform: String(row.platform), postKey: String(row.post_key), day: iso(row.day)!.slice(0, 10),
        metric: row.metric as MetricName, value: Number(row.value), source: row.source as MetricRow['source'],
      }));
    },

    /** Everything of one owner (account deletion). */
    async removeOwner(owner: string) {
      await sql.begin(async (tx) => {
        await tx`delete from social_metrics where owner_id = ${owner}`;
        await tx`delete from social_comments where owner_id = ${owner}`;
        await tx`delete from social_targets where owner_id = ${owner}`;
        await tx`delete from social_posts where owner_id = ${owner}`;
        await tx`delete from social_connections where owner_id = ${owner}`;
      });
    },
  };
}
