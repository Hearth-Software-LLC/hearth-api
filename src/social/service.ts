import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { ApiError } from '../errors.js';
import type { TokenSeal } from '../services/token-seal.js';
import { MetaError } from './meta.js';
import type { MetaClient, MetaTarget, PublishInput, PublishResult } from './meta.js';
import type { MetricRow, PostInput, SocialPlatformId, SocialStore, StoredConnection, StoredTarget, TargetInput } from './store.js';

/**
 * Hearth Ship's social pages: connecting Meta accounts, publishing (now, or when the cron
 * finds a post due), and syncing posts, comments and numbers back.
 *
 * Only Facebook and Instagram publish through an API. Every other platform's targets are
 * hand-off: Hearth Ship reminds you when one is due and you mark it posted.
 */

export const API_PLATFORMS = ['facebook', 'instagram'] as const;
export const isApiPlatform = (platform: string): platform is 'facebook' | 'instagram' => (API_PLATFORMS as readonly string[]).includes(platform);

export type SocialMedia = {
  /** A URL Hearth Ship PUTs the file to. */
  uploadUrl: (path: string) => Promise<{ url: string; token: string }>;
  /** A URL Meta can fetch the file from. */
  signedUrl: (path: string, seconds: number) => Promise<string>;
};

export type SocialServiceOptions = {
  store: SocialStore;
  seal: TokenSeal;
  /** Signs the login's state. */
  stateKey: Buffer;
  meta?: MetaClient | undefined;
  media?: SocialMedia | undefined;
  now?: () => number;
  log?: (record: Record<string, unknown>) => void;
};

const POSTS_EVERY_MS = 15 * 60_000;
const METRICS_EVERY_MS = 6 * 3_600_000;
/** An Instagram video still processing after this many tries (5 minutes apart) has failed. */
const MAX_ATTEMPTS = 14;

export type SocialService = ReturnType<typeof createSocialService>;

export function createSocialService(options: SocialServiceOptions) {
  const { store, seal } = options;
  const now = options.now ?? Date.now;
  const log = options.log ?? ((record) => { if (process.env.NODE_ENV !== 'test') console.info(JSON.stringify(record)); });

  function requireMeta(): MetaClient {
    if (!options.meta) throw new ApiError(503, 'PROVIDER_NOT_CONFIGURED', 'Facebook and Instagram aren’t set up on hearth-api (META_APP_ID, META_APP_SECRET)');
    return options.meta;
  }

  function requireMedia(): SocialMedia {
    if (!options.media) throw new ApiError(503, 'STORAGE_NOT_CONFIGURED', 'Post media storage is not configured');
    return options.media;
  }

  const tokenOf = (connection: StoredConnection) => seal.open(connection.tokenSealed, connection.ownerId, `${connection.platform}:${connection.externalId}`);
  const metaTarget = (connection: StoredConnection): MetaTarget => ({ platform: connection.platform, externalId: connection.externalId, token: tokenOf(connection) });

  // MARK: Login state

  function signState(payload: Record<string, unknown>): string {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const mac = createHmac('sha256', options.stateKey).update(`meta-login:${body}`).digest('base64url');
    return `${body}.${mac}`;
  }

  function readState(state: string): { owner: string; app: string | null } {
    const [body, mac] = state.split('.');
    if (!body || !mac) throw new ApiError(400, 'INVALID_STATE', 'The sign-in link is invalid');
    const expected = createHmac('sha256', options.stateKey).update(`meta-login:${body}`).digest();
    const given = Buffer.from(mac, 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new ApiError(400, 'INVALID_STATE', 'The sign-in link is invalid');
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { o?: string; a?: string | null; e?: number };
    if (!payload.o || !payload.e || payload.e < now()) throw new ApiError(400, 'INVALID_STATE', 'The sign-in link has expired; start again');
    return { owner: payload.o, app: payload.a ?? null };
  }

  // MARK: Publishing

  async function publishInput(target: StoredTarget): Promise<PublishInput> {
    const post = target.postId ? await store.post(target.ownerId, target.postId) : undefined;
    if (!post) throw new MetaError('The post is gone', null, false);
    const media = requireMedia();
    return {
      text: target.text ?? post.text,
      link: target.platform === 'facebook' ? post.link : null,
      firstComment: target.format === 'story' ? null : post.firstComment,
      format: target.format,
      // A day: Instagram may fetch a video's file a while after the container is made.
      media: await Promise.all(post.media.map(async (item) => ({ url: await media.signedUrl(item.path, 86_400), kind: item.kind }))),
    };
  }

  /** Publishes (or carries on publishing) one API target. Safe to call twice: only one call claims it. */
  async function publishTarget(target: StoredTarget, waitMs: number): Promise<void> {
    const from = target.status === 'processing' ? ['processing'] as const
      : target.status === 'publishing' ? ['publishing'] as const
      : ['scheduled', 'failed', 'draft'] as const;
    if (!await store.claim(target.id, [...from])) return;
    const connection = target.connectionId ? await store.connection(target.ownerId, target.connectionId) : undefined;
    if (!connection) {
      await store.updateTarget(target.id, { status: 'failed', error: 'The account was disconnected. Connect it again in Accounts.' });
      return;
    }
    let result: PublishResult;
    try {
      const meta = requireMeta();
      const account = metaTarget(connection);
      if (target.containerId) {
        const post = target.postId ? await store.post(target.ownerId, target.postId) : undefined;
        result = await meta.resume(account, target.containerId, target.format === 'story' ? null : post?.firstComment ?? null);
      } else {
        result = await meta.publish(account, await publishInput(target), waitMs);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Publishing failed';
      if (error instanceof MetaError && error.auth) {
        await store.markConnection(connection.id, { status: 'needs_reconnect', lastError: message });
      }
      log({ route: 'social.publish', platform: target.platform, failed: true, code: error instanceof MetaError ? error.code : null });
      await store.updateTarget(target.id, { status: 'failed', error: message, containerId: null });
      return;
    }
    if (result.state === 'processing') {
      const tooLong = target.attempts + 1 >= MAX_ATTEMPTS;
      await store.updateTarget(target.id, tooLong
        ? { status: 'failed', error: 'Instagram took too long to process the video. Try again.', containerId: null }
        : { status: 'processing', containerId: result.containerId });
      return;
    }
    await store.updateTarget(target.id, {
      status: 'published', remoteId: result.remoteId, permalink: result.permalink,
      publishedAt: new Date(now()).toISOString(), error: result.warning, containerId: null,
    });
    log({ route: 'social.publish', platform: target.platform, published: true });
  }

  /** Every API target that's due, until `deadline`. */
  async function runDue(deadline: number, owner?: string) {
    let count = 0;
    for (const target of await store.dueTargets(20, owner)) {
      if (now() > deadline) break;
      await publishTarget(target, Math.max(0, Math.min(15_000, deadline - now() - 5_000)));
      count += 1;
    }
    return count;
  }

  // MARK: Syncing

  async function syncConnection(connection: StoredConnection, force: boolean) {
    if (!connection.app || connection.status !== 'active') return { posts: 0, comments: 0 };
    const meta = requireMeta();
    const app = connection.app;
    const owner = connection.ownerId;
    const due = (at: string | null, every: number) => force || !at || now() - Date.parse(at) >= every;
    let posts = 0;
    let comments = 0;
    try {
      const account = metaTarget(connection);
      const day = new Date(now()).toISOString().slice(0, 10);
      if (due(connection.postsSyncedAt, POSTS_EVERY_MS)) {
        const recent = await meta.recentPosts(account);
        await store.upsertRemotePosts(owner, app, connection.platform, connection.id, 'api', recent);
        posts = recent.length;
        const counts: MetricRow[] = recent.flatMap((post) => ([
          ['likes', post.likes], ['comments', post.comments], ['shares', post.shares],
        ] as const).flatMap(([metric, value]) => (value == null ? [] : [{ platform: connection.platform, postKey: post.remoteId, day, metric, value, source: 'api' as const }])));
        await store.saveMetrics(owner, app, counts);
        for (const remoteId of await store.recentRemoteIds(connection.id, 14)) {
          comments += await store.upsertComments(owner, connection, remoteId, await meta.comments(account, remoteId, connection.handle));
        }
        await store.markConnection(connection.id, { postsSyncedAt: new Date(now()), lastError: null });
      }
      if (due(connection.metricsSyncedAt, METRICS_EVERY_MS)) {
        const rows: MetricRow[] = (await meta.accountMetrics(account)).map((row) => ({ ...row, platform: connection.platform, postKey: '', source: 'api' }));
        for (const remoteId of await store.recentRemoteIds(connection.id, 30)) {
          rows.push(...(await meta.postMetrics(account, remoteId)).map((row) => ({ ...row, platform: connection.platform, postKey: remoteId, day, source: 'api' as const })));
        }
        await store.saveMetrics(owner, app, rows);
        await store.markConnection(connection.id, { metricsSyncedAt: new Date(now()) });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Sync failed';
      await store.markConnection(connection.id, error instanceof MetaError && error.auth
        ? { status: 'needs_reconnect', lastError: message }
        : { lastError: message });
      log({ route: 'social.sync', platform: connection.platform, failed: true });
    }
    return { posts, comments };
  }

  return {
    metaConfigured: () => options.meta !== undefined,

    startMetaLogin(owner: string, app: string | null): string {
      const state = signState({ o: owner, a: app, e: now() + 15 * 60_000, n: randomBytes(9).toString('base64url') });
      return requireMeta().authorizeUrl(state);
    },

    /** The login's redirect: saves every Page and Instagram account it can post as. */
    async finishMetaLogin(code: string, state: string) {
      const { owner, app } = readState(state);
      const meta = requireMeta();
      const userToken = await meta.exchangeCode(code);
      const accounts = await meta.accounts(userToken);
      const pages = accounts.filter((account) => account.platform === 'facebook');
      // One Page (and its Instagram) is clearly the app's; more than one, you pick in Accounts.
      const assign = app && pages.length === 1 ? app : null;
      for (const account of accounts) {
        await store.saveConnection(owner, {
          platform: account.platform, externalId: account.externalId, name: account.name, handle: account.handle, avatarUrl: account.avatarUrl,
          app: assign, tokenSealed: seal.seal(account.token, owner, `${account.platform}:${account.externalId}`),
        });
      }
      return { owner, count: accounts.length };
    },

    async uploadUrl(owner: string, extension: string) {
      const path = `${owner}/${new Date(now()).toISOString().slice(0, 10)}/${randomBytes(12).toString('hex')}.${extension}`;
      const upload = await requireMedia().uploadUrl(path);
      return { path, uploadUrl: upload.url, token: upload.token };
    },

    async previewUrl(path: string) {
      return options.media ? options.media.signedUrl(path, 3600).catch(() => null) : null;
    },

    /** The targets a post's request asks for, checked against the owner's connections. */
    async resolveTargets(owner: string, app: string, draft: boolean, scheduledFor: string | null,
      requested: { platform: SocialPlatformId; connectionId?: string | null | undefined; format?: TargetInput['format'] | undefined; text?: string | null | undefined }[]): Promise<TargetInput[]> {
      const connections = await store.connections(owner);
      const status: TargetInput['status'] = draft ? 'draft' : 'scheduled';
      return requested.map((item) => {
        if (isApiPlatform(item.platform) && item.connectionId) {
          const connection = connections.find((entry) => entry.id === item.connectionId);
          if (!connection || connection.platform !== item.platform || connection.app !== app) {
            throw new ApiError(422, 'INVALID_TARGET', `That ${item.platform} account isn’t connected to this app`);
          }
          return { platform: item.platform, connectionId: connection.id, delivery: 'api', format: item.format ?? 'feed', text: item.text ?? null, status, scheduledFor };
        }
        return { platform: item.platform, connectionId: null, delivery: 'handoff', format: item.format ?? 'feed', text: item.text ?? null, status, scheduledFor };
      });
    },

    /**
     * Publishes a post's API targets that are due now (Post now, or a schedule in the past),
     * waiting up to `waitMs` for each. Hand-off targets stay scheduled for you to post.
     */
    async publishPostNow(owner: string, postId: string, waitMs = 20_000) {
      const post = await store.post(owner, postId);
      if (!post) return;
      for (const target of post.targets) {
        if (target.delivery !== 'api' || target.status !== 'scheduled') continue;
        if (target.scheduledFor && Date.parse(target.scheduledFor) > now()) continue;
        const stored = await store.target(owner, target.id);
        if (stored) await publishTarget(stored, waitMs);
      }
    },

    async retryTarget(owner: string, targetId: string) {
      const target = await store.target(owner, targetId);
      if (!target) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Post not found');
      if (target.delivery !== 'api') throw new ApiError(422, 'HANDOFF_TARGET', 'Post this one yourself, then mark it posted');
      if (target.status === 'published') return;
      await publishTarget(target, 20_000);
    },

    async markPosted(owner: string, targetId: string, permalink: string | null, publishedAt: string | null) {
      const target = await store.target(owner, targetId);
      if (!target) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Post not found');
      if (target.delivery !== 'handoff') throw new ApiError(422, 'API_TARGET', 'This one posts itself');
      await store.updateTarget(target.id, {
        status: 'published', permalink, publishedAt: publishedAt ?? new Date(now()).toISOString(), error: null,
        // The link is how its numbers are matched up later (imports).
        remoteId: permalink ?? `handoff:${target.id}`,
      });
    },

    async markNotPosted(owner: string, targetId: string) {
      const target = await store.target(owner, targetId);
      if (!target || target.delivery !== 'handoff') throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Post not found');
      await store.updateTarget(target.id, { status: 'scheduled', permalink: null, publishedAt: null, remoteId: null });
    },

    async reply(owner: string, commentId: string, text: string) {
      const comment = await store.comment(owner, commentId);
      if (!comment) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Comment not found');
      const connection = await store.connection(owner, comment.connectionId);
      if (!connection) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Comment not found');
      // Replies go on the top-level comment (Instagram and Pages keep one level of replies).
      const root = comment.parentRemoteId ?? comment.remoteId;
      try {
        const remoteId = await requireMeta().reply(metaTarget(connection), root, text);
        await store.upsertComments(owner, connection, comment.remotePostId, [{
          remoteId, parentRemoteId: root, author: connection.handle ?? connection.name, text, likes: 0, at: new Date(now()).toISOString(), fromAccount: true,
        }]);
        await store.closeThread(owner, connection.id, root);
      } catch (error) {
        if (error instanceof MetaError) {
          if (error.auth) await store.markConnection(connection.id, { status: 'needs_reconnect', lastError: error.message });
          throw new ApiError(502, 'UPSTREAM_FAILED', `${connection.platform === 'instagram' ? 'Instagram' : 'Facebook'} didn’t take the reply: ${error.message}`);
        }
        throw error;
      }
    },

    async hide(owner: string, commentId: string, hidden: boolean) {
      const comment = await store.comment(owner, commentId);
      const connection = comment ? await store.connection(owner, comment.connectionId) : undefined;
      if (!comment || !connection) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Comment not found');
      try {
        await requireMeta().hide(metaTarget(connection), comment.remoteId, hidden);
      } catch (error) {
        if (error instanceof MetaError) throw new ApiError(502, 'UPSTREAM_FAILED', `Couldn’t ${hidden ? 'hide' : 'unhide'} it: ${error.message}`);
        throw error;
      }
      await store.setCommentStatus(owner, commentId, hidden ? 'hidden' : 'open');
    },

    /** Hearth Ship's Refresh: due posts, then every connection of the app, now. */
    async syncNow(owner: string, app: string | null) {
      const deadline = now() + 45_000;
      const published = await runDue(deadline, owner);
      let posts = 0;
      let comments = 0;
      for (const connection of await store.connections(owner)) {
        if (now() > deadline) break;
        if (app && connection.app !== app) continue;
        const result = await syncConnection(connection, true);
        posts += result.posts;
        comments += result.comments;
      }
      return { published, posts, comments };
    },

    /** Every 5 minutes: due posts first, then whichever connections are due a sync. */
    async cron() {
      const deadline = now() + 50_000;
      const published = await runDue(deadline);
      let synced = 0;
      if (options.meta) {
        for (const connection of await store.activeConnections()) {
          if (now() > deadline) break;
          await syncConnection(connection, false);
          synced += 1;
        }
      }
      return { published, synced };
    },
  };
}
