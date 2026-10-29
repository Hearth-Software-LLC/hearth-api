import type { Sql } from 'postgres';
import { ApiError } from '../errors.js';
import { isUniqueViolation } from '../hearken/service.js';

/**
 * The Library: the team's screenshots, chosen mockups, ad images, uploads and app icons, in the
 * private `library` bucket (supabase/migrations/20261029100100_studio_library.sql). Files are
 * named by their SHA-256, so one image is stored once however many times it's added.
 *
 * Clients sync with a cursor (`seq`): every change, a deletion too, moves an asset's seq on.
 */

export const LIBRARY_KINDS = ['screenshot', 'mockup', 'ad', 'upload', 'icon'] as const;
/** Kinds the Library keeps one version of (per app, device, appearance and page). */
const ONE_VERSION = new Set<string>(['screenshot', 'mockup']);
export type LibraryKind = typeof LIBRARY_KINDS[number];
export const LIBRARY_TYPES = {
  'image/webp': 'webp', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/heic': 'heic', 'video/mp4': 'mp4', 'video/quicktime': 'mov',
} as const;
export type LibraryContentType = keyof typeof LIBRARY_TYPES;
/** Supabase Free's per-file limit. */
export const MAX_FILE_BYTES = 50 * 1024 * 1024;

export type StudioStorage = {
  uploadUrl: (path: string) => Promise<{ url: string; token: string }>;
  signedUrl: (path: string, seconds: number) => Promise<string>;
  remove: (paths: string[]) => Promise<void>;
  /** Copies bytes in directly (app icons from GitHub). */
  put: (path: string, bytes: Uint8Array, contentType: string) => Promise<void>;
};

export type AssetView = {
  id: string;
  app: string;
  kind: LibraryKind;
  device: string | null;
  appearance: string | null;
  name: string;
  path: string;
  thumbPath: string | null;
  contentType: string;
  width: number | null;
  height: number | null;
  bytes: number;
  sha256: string;
  runId: string | null;
  position: number | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  deleted: boolean;
  seq: number;
};

const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : String(value));
const num = (value: unknown) => (value == null ? null : Number(value));

function asset(row: Record<string, unknown>): AssetView {
  return {
    id: String(row.id), app: String(row.app), kind: row.kind as LibraryKind, device: (row.device as string | null) ?? null,
    appearance: (row.appearance as string | null) ?? null, name: String(row.name), path: String(row.path),
    thumbPath: (row.thumb_path as string | null) ?? null, contentType: String(row.content_type),
    width: num(row.width), height: num(row.height), bytes: Number(row.bytes), sha256: String(row.sha256),
    runId: (row.run_id as string | null) ?? null, position: num(row.position), createdBy: String(row.created_by),
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), deleted: row.deleted_at != null, seq: Number(row.seq),
  };
}

export type LibraryService = ReturnType<typeof createLibraryService>;

export function createLibraryService(sql: Sql, options: { storage?: StudioStorage | undefined; limitBytes: number }) {
  const storage = () => {
    if (!options.storage) throw new ApiError(503, 'STORAGE_NOT_CONFIGURED', 'Library storage is not configured');
    return options.storage;
  };
  const soft = Math.floor(options.limitBytes * 0.9);

  async function usedBytes(team: string): Promise<number> {
    const [row] = await sql`
      select coalesce(sum(bytes), 0)::bigint as used from (
        select distinct on (path) path, bytes from library_assets where team_id = ${team} and deleted_at is null
      ) as files`;
    return Number(row?.used ?? 0);
  }

  /** Asset ids and paths still used by a post, campaign or design, which retention keeps. */
  async function referenced(team: string, candidates: AssetView[]): Promise<Set<string>> {
    const keep = new Set<string>();
    if (candidates.length === 0) return keep;
    const [posts, campaigns, designs] = await Promise.all([
      sql`select media::text as text from social_posts where team_id = ${team}`,
      sql`select document::text as text from marketing_campaigns where team_id = ${team} and deleted_at is null`,
      sql`select document::text as text from store_designs where team_id = ${team}`,
    ]);
    const haystack = [...posts, ...campaigns, ...designs].map((row) => String(row.text)).join('\n');
    for (const item of candidates) if (haystack.includes(item.id) || haystack.includes(item.path)) keep.add(item.id);
    return keep;
  }

  /** Deletes stored files no live asset points to and no post, campaign or design mentions. */
  async function removeUnused(team: string, paths: string[]) {
    if (paths.length === 0 || !options.storage) return;
    const live = await sql`
      select path, thumb_path from library_assets where team_id = ${team} and deleted_at is null
        and (path = any(${paths}::text[]) or thumb_path = any(${paths}::text[]))`;
    const still = new Set(live.flatMap((row) => [row.path, row.thumb_path]).filter(Boolean).map(String));
    const [posts, campaigns, designs] = await Promise.all([
      sql`select media::text as text from social_posts where team_id = ${team}`,
      sql`select document::text as text from marketing_campaigns where team_id = ${team} and deleted_at is null`,
      sql`select document::text as text from store_designs where team_id = ${team}`,
    ]);
    const haystack = [...posts, ...campaigns, ...designs].map((row) => String(row.text)).join('\n');
    const gone = paths.filter((path) => !still.has(path) && !haystack.includes(path));
    if (gone.length) await options.storage.remove(gone).catch(() => undefined);
  }

  async function deleteAssets(team: string, items: AssetView[]) {
    if (items.length === 0) return;
    const ids = items.map((item) => item.id);
    await sql`
      update library_assets set deleted_at = now(), updated_at = now(), seq = nextval('studio_change_seq')
      where team_id = ${team} and id = any(${ids}::uuid[]) and deleted_at is null`;
    // A file other live assets still point to stays.
    const paths = [...new Set(items.flatMap((item) => [item.path, item.thumbPath]).filter((p): p is string => !!p))];
    const live = await sql`
      select path, thumb_path from library_assets where team_id = ${team} and deleted_at is null
        and (path = any(${paths}::text[]) or thumb_path = any(${paths}::text[]))`;
    const still = new Set(live.flatMap((row) => [row.path, row.thumb_path]).filter(Boolean).map(String));
    const gone = paths.filter((path) => !still.has(path));
    if (gone.length && options.storage) await options.storage.remove(gone).catch(() => undefined);
  }

  return {
    limitBytes: options.limitBytes,
    usedBytes,

    /** Where to PUT a file; `exists` when this exact file is already in the team's Library. */
    async startUpload(team: string, input: { app: string; kind: LibraryKind; sha256: string; bytes: number; contentType: LibraryContentType; thumbnail?: boolean | undefined }) {
      if (input.bytes > MAX_FILE_BYTES) throw new ApiError(422, 'FILE_TOO_LARGE', 'Files can be up to 50 MB on the current storage plan');
      const ext = input.thumbnail ? 'thumb.webp' : LIBRARY_TYPES[input.contentType];
      const path = `${team}/${input.app}/${input.kind}/${input.sha256}.${ext}`;
      const [existing] = await sql`
        select id from library_assets where team_id = ${team} and (path = ${path} or thumb_path = ${path}) and deleted_at is null limit 1`;
      if (existing) return { path, exists: true as const, uploadUrl: null, token: null };
      if (!input.thumbnail && await usedBytes(team) + input.bytes > soft) {
        throw new ApiError(409, 'STORAGE_FULL', 'The Library is nearly full on the current storage plan. Remove old items, or move to a bigger plan.');
      }
      const upload = await storage().uploadUrl(path);
      return { path, exists: false as const, uploadUrl: upload.url, token: upload.token };
    },

    async createAsset(team: string, user: string, input: {
      app: string; kind: LibraryKind; name: string; path: string; thumbPath?: string | null | undefined; contentType: LibraryContentType;
      width?: number | null | undefined; height?: number | null | undefined; bytes: number; sha256: string;
      device?: string | null | undefined; appearance?: string | null | undefined; runId?: string | null | undefined; position?: number | null | undefined;
    }): Promise<AssetView> {
      const prefix = `${team}/${input.app}/${input.kind}/${input.sha256}.`;
      if (!input.path.startsWith(prefix) || (input.thumbPath && !input.thumbPath.startsWith(prefix))) {
        throw new ApiError(422, 'INVALID_PATH', 'Start the upload with POST /v1/library/uploads');
      }
      if (input.runId) {
        const [run] = await sql`select id from library_runs where id = ${input.runId} and team_id = ${team}`;
        if (!run) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Run not found');
      }
      const values = {
        device: input.device ?? null, appearance: input.appearance ?? null, thumbPath: input.thumbPath ?? null,
        width: input.width ?? null, height: input.height ?? null, runId: input.runId ?? null, position: input.position ?? null,
      };
      // Screenshots and mockups: one version per app, device, appearance and page. A new one
      // replaces it in place (same id), and the old files go unless something still uses them.
      if (ONE_VERSION.has(input.kind)) {
        // Two uploads of a new page at once: the second becomes a replace.
        const attempt = () => sql.begin(async (tx) => {
          const [current] = await tx`
            select * from library_assets
            where team_id = ${team} and app = ${input.app} and kind = ${input.kind} and deleted_at is null
              and coalesce(device, '') = ${values.device ?? ''} and coalesce(appearance, '') = ${values.appearance ?? ''}
              and name = ${input.name}
            for update`;
          if (current) {
            const [updated] = await tx`
              update library_assets set path = ${input.path}, thumb_path = ${values.thumbPath}, content_type = ${input.contentType},
                width = ${values.width}, height = ${values.height}, bytes = ${input.bytes}, sha256 = ${input.sha256},
                run_id = coalesce(${values.runId}, run_id), position = coalesce(${values.position}, position),
                updated_at = now(), seq = nextval('studio_change_seq')
              where id = ${current.id}
              returning *`;
            return { row: updated!, replaced: asset(current) };
          }
          const [inserted] = await tx`
            insert into library_assets (team_id, app, kind, device, appearance, name, path, thumb_path, content_type, width, height, bytes, sha256, run_id, position, created_by)
            values (${team}, ${input.app}, ${input.kind}, ${values.device}, ${values.appearance}, ${input.name}, ${input.path},
              ${values.thumbPath}, ${input.contentType}, ${values.width}, ${values.height}, ${input.bytes}, ${input.sha256},
              ${values.runId}, ${values.position}, ${user})
            returning *`;
          return { row: inserted!, replaced: undefined };
        }) as Promise<{ row: Record<string, unknown>; replaced: AssetView | undefined }>;
        const { row, replaced } = await attempt().catch((error: unknown) => {
          if (isUniqueViolation(error)) return attempt();
          throw error;
        });
        if (replaced) {
          const old = [replaced.path, replaced.thumbPath].filter((p): p is string => !!p && p !== row.path && p !== row.thumb_path);
          await removeUnused(team, old);
        }
        return asset(row);
      }
      const rows = await sql`
        insert into library_assets (team_id, app, kind, device, appearance, name, path, thumb_path, content_type, width, height, bytes, sha256, run_id, position, created_by)
        values (${team}, ${input.app}, ${input.kind}, ${values.device}, ${values.appearance}, ${input.name}, ${input.path},
          ${values.thumbPath}, ${input.contentType}, ${values.width}, ${values.height}, ${input.bytes}, ${input.sha256},
          ${values.runId}, ${values.position}, ${user})
        returning *`;
      return asset(rows[0]!);
    },

    async rename(team: string, id: string, patch: { name?: string | undefined; app?: string | undefined }) {
      const rows = await sql`
        update library_assets set name = coalesce(${patch.name ?? null}, name), app = coalesce(${patch.app ?? null}, app),
          updated_at = now(), seq = nextval('studio_change_seq')
        where team_id = ${team} and id = ${id} and deleted_at is null returning *`;
      if (!rows[0]) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Library item not found');
      return asset(rows[0]);
    },

    /** Changes after `since` (0: everything live), oldest first, `limit` at a time. */
    async changes(team: string, since: number, filters: { app?: string | undefined; kind?: LibraryKind | undefined }, limit = 500) {
      const rows = await sql`
        select * from library_assets
        where team_id = ${team} and seq > ${since}
          and (${since} > 0 or deleted_at is null)
          and (${filters.app ?? null}::text is null or app = ${filters.app ?? null})
          and (${filters.kind ?? null}::text is null or kind = ${filters.kind ?? null})
        order by seq limit ${limit + 1}`;
      const items = rows.slice(0, limit).map(asset);
      return { assets: items, cursor: items.at(-1)?.seq ?? since, more: rows.length > limit };
    },

    async get(team: string, id: string) {
      const [row] = await sql`select * from library_assets where team_id = ${team} and id = ${id} and deleted_at is null`;
      return row ? asset(row) : undefined;
    },

    /** Where to PUT a team member's profile photo (at most 5 MB, an image). */
    async startAvatarUpload(team: string, userId: string, input: { sha256: string; bytes: number; contentType: LibraryContentType }) {
      if (!input.contentType.startsWith('image/')) throw new ApiError(422, 'NOT_AN_IMAGE', 'A profile photo has to be an image');
      if (input.bytes > 5 * 1024 * 1024) throw new ApiError(422, 'FILE_TOO_LARGE', 'Profile photos can be up to 5 MB');
      const path = `${team}/avatars/${userId}/${input.sha256}.${LIBRARY_TYPES[input.contentType]}`;
      const upload = await storage().uploadUrl(path);
      return { path, uploadUrl: upload.url, token: upload.token };
    },

    /** A signed link to a profile photo (a week). */
    async avatarUrl(path: string) {
      return storage().signedUrl(path, 7 * 86_400);
    },

    /** Removes a profile photo that's been replaced. */
    async removeAvatar(path: string) {
      await options.storage?.remove([path]).catch(() => undefined);
    },

    async url(team: string, id: string, thumbnail: boolean) {
      const item = await this.get(team, id);
      if (!item) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Library item not found');
      const path = thumbnail && item.thumbPath ? item.thumbPath : item.path;
      return { url: await storage().signedUrl(path, 3600), expiresIn: 3600 };
    },

    async remove(team: string, id: string) {
      const item = await this.get(team, id);
      if (!item) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Library item not found');
      await deleteAssets(team, [item]);
    },

    // MARK: Screenshot runs

    async startRun(team: string, user: string, input: { app: string; device: string; appearance: string; source?: string | null | undefined }) {
      const [row] = await sql`
        insert into library_runs (team_id, app, device, appearance, source, created_by)
        values (${team}, ${input.app}, ${input.device}, ${input.appearance}, ${input.source ?? null}, ${user}) returning id`;
      return { id: String(row!.id) };
    },

    /** Marks the run done and deletes screenshots of older runs past the team's keep count. */
    async completeRun(team: string, runId: string) {
      const [run] = await sql`
        update library_runs set completed_at = now() where id = ${runId} and team_id = ${team}
        returning app, device, appearance`;
      if (!run) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Run not found');
      const [teamRow] = await sql`select keep_runs from studio_teams where id = ${team}`;
      const keep = Number(teamRow?.keep_runs ?? 2);
      const old = await sql`
        select id from library_runs
        where team_id = ${team} and app = ${run.app} and device = ${run.device} and appearance = ${run.appearance} and completed_at is not null
        order by completed_at desc offset ${keep}`;
      const oldIds = old.map((row) => String(row.id));
      if (oldIds.length === 0) return { removed: 0 };
      const candidates = (await sql`
        select * from library_assets where team_id = ${team} and run_id = any(${oldIds}::uuid[]) and deleted_at is null`).map(asset);
      const keepIds = await referenced(team, candidates);
      const doomed = candidates.filter((item) => !keepIds.has(item.id));
      await deleteAssets(team, doomed);
      return { removed: doomed.length };
    },

    async usage(team: string) {
      const [counts] = await sql`select count(*)::int as items from library_assets where team_id = ${team} and deleted_at is null`;
      return { usedBytes: await usedBytes(team), limitBytes: options.limitBytes, items: Number(counts?.items ?? 0) };
    },

    /** An app icon from GitHub, stored once by its hash. */
    async ensureIcon(team: string, app: string, bytes: Uint8Array, sha256: string, contentType: 'image/png' | 'image/jpeg' | 'image/webp') {
      const [existing] = await sql`
        select * from library_assets where team_id = ${team} and app = ${app} and kind = 'icon' and sha256 = ${sha256} and deleted_at is null limit 1`;
      if (existing) return asset(existing);
      const path = `${team}/${app}/icon/${sha256}.${LIBRARY_TYPES[contentType]}`;
      await storage().put(path, bytes, contentType);
      const older = (await sql`select * from library_assets where team_id = ${team} and app = ${app} and kind = 'icon' and deleted_at is null`).map(asset);
      await deleteAssets(team, older);
      const rows = await sql`
        insert into library_assets (team_id, app, kind, name, path, content_type, bytes, sha256, created_by)
        values (${team}, ${app}, 'icon', ${`${app} icon`}, ${path}, ${contentType}, ${bytes.byteLength}, ${sha256}, ${team})
        returning *`;
      return asset(rows[0]!);
    },
  };
}
