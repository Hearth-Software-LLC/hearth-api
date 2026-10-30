import type { Sql } from 'postgres';
import { ApiError } from '../errors.js';
import { isUniqueViolation } from '../hearken/service.js';
import { VersionConflict } from '../studio/documents.js';
import {
  BLOCK_LIBRARY, bodySchema, buildBundle, definitionSchema, diffBodies, emptyBody, mediaIds, runChecks, slugify,
} from './model.js';
import type { Body, CatalogEntry, Check, MediaFile, MediaInfo, TypeDefinition } from './model.js';

/**
 * Hearth Content's storage: content types, items and their versions, reviews, comments, media,
 * releases and each app's catalog (supabase/migrations/20261030120000_hearth_content.sql).
 *
 * Publishing writes an immutable bundle to the public bucket, then moves the item's entry in its
 * app's catalog in one transaction. Rolling back points the catalog at an earlier bundle.
 */

export type ContentStorage = {
  /** Writes a file to the public `hearth-content` bucket. */
  put: (path: string, bytes: Uint8Array, contentType: string) => Promise<void>;
  /** A signed link the browser PUTs an upload to. */
  uploadUrl: (path: string) => Promise<{ url: string; token: string }>;
  /** The file's public CDN URL. */
  publicUrl: (path: string) => string;
};

export const MEDIA_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' } as const;
export type MediaType = keyof typeof MEDIA_TYPES;

export type VersionState = 'draft' | 'in_review' | 'changes_requested' | 'approved' | 'published';
export type ContentTypeView = {
  id: string; slug: string; app: string | null; name: string; description: string; schemaVersion: number;
  definition: TypeDefinition; updatedAt: string;
};
export type EntrySummary = {
  id: string; app: string; typeId: string; typeSlug: string; typeName: string; slug: string; title: string;
  ownerId: string; ownerName: string | null; latestVersion: number; liveVersion: number | null;
  state: VersionState; scheduledFor: string | null; createdAt: string; updatedAt: string;
};
export type ReviewView = { step: string; state: 'pending' | 'approved' | 'changes_requested'; reviewerId: string | null; reviewerName: string | null; note: string | null; decidedAt: string | null };
export type VersionView = { version: number; body: Body; state: VersionState; revision: number; schemaVersion: number; updatedAt: string; updatedBy: string; updatedByName: string | null };

const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : String(value));
const isoOrNull = (value: unknown) => (value == null ? null : iso(value));

const typeView = (row: Record<string, unknown>): ContentTypeView => ({
  id: String(row.id), slug: String(row.slug), app: (row.app_key as string | null) ?? null, name: String(row.name),
  description: String(row.description), schemaVersion: Number(row.schema_version),
  definition: definitionSchema.parse(row.definition), updatedAt: iso(row.updated_at),
});

const summary = (row: Record<string, unknown>): EntrySummary => ({
  id: String(row.id), app: String(row.app_key), typeId: String(row.type_id), typeSlug: String(row.type_slug), typeName: String(row.type_name),
  slug: String(row.slug), title: String(row.title), ownerId: String(row.owner_id), ownerName: (row.owner_name as string | null) ?? null,
  latestVersion: Number(row.latest_version), liveVersion: row.live_version == null ? null : Number(row.live_version),
  state: row.state as VersionState, scheduledFor: isoOrNull(row.scheduled_for), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
});

export type ContentService = ReturnType<typeof createContentService>;

export function createContentService(sql: Sql, options: { storage?: ContentStorage | undefined; now?: () => number } = {}) {
  const now = options.now ?? Date.now;
  const storage = () => {
    if (!options.storage) throw new ApiError(503, 'STORAGE_NOT_CONFIGURED', 'Content storage is not configured');
    return options.storage;
  };
  let hearthTeam: string | undefined;

  async function audit(db: Sql, teamId: string, actor: string, action: string, target: string, detail: Record<string, unknown> = {}) {
    await db`insert into content_audit_log (team_id, actor_id, action, target, detail) values (${teamId}, ${actor}, ${action}, ${target}, ${db.json(detail as never)})`;
  }

  const entrySelect = (db: Sql) => db`
    select e.*, t.slug as type_slug, t.name as type_name, m.display_name as owner_name, v.state,
      (select min(r.scheduled_for) from content_releases r where r.entry_id = e.id and r.state = 'scheduled') as scheduled_for
    from content_entries e
    join content_types t on t.id = e.type_id
    join content_versions v on v.entry_id = e.id and v.version = e.latest_version
    left join studio_members m on m.team_id = e.team_id and m.user_id = e.owner_id`;

  async function entryRow(db: Sql, teamId: string, id: string) {
    const [row] = await db`${entrySelect(db)} where e.team_id = ${teamId} and e.id = ${id} and e.deleted_at is null`;
    if (!row) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'That item doesn’t exist');
    return row;
  }

  async function typeRow(db: Sql, teamId: string, id: string) {
    const [row] = await db`select * from content_types where team_id = ${teamId} and id = ${id}`;
    if (!row) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'That content type doesn’t exist');
    return typeView(row);
  }

  async function versionRow(db: Sql, entryId: string, version: number): Promise<VersionView> {
    const [row] = await db`
      select v.*, m.display_name as updated_by_name from content_versions v
      join content_entries e on e.id = v.entry_id
      left join studio_members m on m.team_id = e.team_id and m.user_id = v.updated_by
      where v.entry_id = ${entryId} and v.version = ${version}`;
    if (!row) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'That version doesn’t exist');
    return {
      version: Number(row.version), body: bodySchema.parse(row.body), state: row.state as VersionState, revision: Number(row.revision),
      schemaVersion: Number(row.schema_version), updatedAt: iso(row.updated_at), updatedBy: String(row.updated_by),
      updatedByName: (row.updated_by_name as string | null) ?? null,
    };
  }

  async function reviewsFor(db: Sql, entryId: string, version: number): Promise<ReviewView[]> {
    const rows = await db`
      select r.*, m.display_name as reviewer_name from content_reviews r
      join content_entries e on e.id = r.entry_id
      left join studio_members m on m.team_id = e.team_id and m.user_id = r.reviewer_id
      where r.entry_id = ${entryId} and r.version = ${version}`;
    return rows.map((row) => ({
      step: String(row.step), state: row.state as ReviewView['state'], reviewerId: (row.reviewer_id as string | null) ?? null,
      reviewerName: (row.reviewer_name as string | null) ?? null, note: (row.note as string | null) ?? null, decidedAt: isoOrNull(row.decided_at),
    }));
  }

  async function mediaMap(db: Sql, teamId: string, ids: string[]) {
    if (ids.length === 0) return new Map<string, Record<string, unknown>>();
    const rows = await db`select * from content_media where team_id = ${teamId} and id = any(${ids}::uuid[])`;
    return new Map(rows.map((row) => [String(row.id), row as Record<string, unknown>]));
  }

  async function checksFor(db: Sql, teamId: string, entry: Record<string, unknown>, version: VersionView, type: ContentTypeView): Promise<Check[]> {
    const media = await mediaMap(db, teamId, mediaIds(version.body));
    const info = new Map<string, MediaInfo>([...media].map(([id, row]) => [id, { id, uploaded: row.uploaded === true, alt: String(row.alt ?? '') }]));
    const reviews = await reviewsFor(db, String(entry.id), version.version);
    return runChecks({
      appKey: String(entry.app_key), definition: type.definition, body: version.body, media: info,
      approvals: type.definition.reviewSteps.map((step) => ({ step, approved: reviews.some((review) => review.step === step && review.state === 'approved') })),
    });
  }

  /** Writes the bundle and moves the catalog. `scheduled`: the release row a schedule made. */
  async function doPublish(teamId: string, actor: string, entryId: string, version: number, override: boolean, scheduled?: string) {
    const entry = await entryRow(sql, teamId, entryId);
    const type = await typeRow(sql, teamId, String(entry.type_id));
    const ver = await versionRow(sql, entryId, version);
    const media = await mediaMap(sql, teamId, mediaIds(ver.body));
    const files = new Map<string, MediaFile>([...media].map(([id, row]) => [id, {
      id, url: storage().publicUrl(String(row.path)), width: row.width == null ? null : Number(row.width),
      height: row.height == null ? null : Number(row.height), alt: String(row.alt ?? ''),
    }]));
    const publishedAt = new Date(now()).toISOString();
    const bundle = buildBundle({
      entryId, app: String(entry.app_key), typeSlug: type.slug, slug: String(entry.slug), title: String(entry.title),
      version, schemaVersion: ver.schemaVersion, publishedAt, body: ver.body, media: files,
    });
    await storage().put(bundle.path, bundle.bytes, 'application/json');
    const catalogEntry: CatalogEntry = {
      id: entryId, type: type.slug, slug: String(entry.slug), title: String(entry.title), version, schemaVersion: ver.schemaVersion,
      hash: bundle.hash, url: storage().publicUrl(bundle.path), bytes: bundle.bytes.length, publishedAt,
    };
    return sql.begin(async (tx) => {
      if (scheduled) {
        const [release] = await tx`select id from content_releases where id = ${scheduled} and state = 'scheduled' for update`;
        if (!release) return undefined;
      }
      const catalogVersion = await placeInCatalog(tx as unknown as Sql, teamId, String(entry.app_key), catalogEntry);
      await tx`update content_versions set state = 'published', published_at = now() where entry_id = ${entryId} and version = ${version}`;
      const [release] = scheduled
        ? await tx`
            update content_releases set state = 'done', bundle_path = ${bundle.path}, hash = ${bundle.hash}, bytes = ${bundle.bytes.length},
              catalog_version = ${catalogVersion}, created_at = now()
            where id = ${scheduled} returning id`
        : await tx`
            insert into content_releases (team_id, app_key, entry_id, version, action, bundle_path, hash, bytes, catalog_version, override, published_by)
            values (${teamId}, ${entry.app_key}, ${entryId}, ${version}, 'publish', ${bundle.path}, ${bundle.hash}, ${bundle.bytes.length}, ${catalogVersion}, ${override}, ${actor})
            returning id`;
      await tx`update content_entries set live_version = ${version}, live_release_id = ${release!.id}, updated_at = now() where id = ${entryId}`;
      await audit(tx as unknown as Sql, teamId, actor, override ? 'publish_override' : 'publish', entryId, { version, bundle: bundle.path, catalogVersion });
      return { releaseId: String(release!.id), catalogVersion, bundle: bundle.path, hash: bundle.hash, bytes: bundle.bytes.length, url: catalogEntry.url };
    });
  }

  /** Puts (or with null, takes out) an item's entry in an app's catalog; returns the new catalog version. */
  async function placeInCatalog(tx: Sql, teamId: string, app: string, entry: CatalogEntry | null, removeId?: string) {
    await tx`insert into content_catalogs (team_id, app_key) values (${teamId}, ${app}) on conflict do nothing`;
    const [catalog] = await tx`select version, entries from content_catalogs where team_id = ${teamId} and app_key = ${app} for update`;
    const id = entry?.id ?? removeId;
    const entries = ((catalog!.entries as CatalogEntry[]) ?? []).filter((existing) => existing.id !== id);
    if (entry) entries.push(entry);
    entries.sort((a, b) => a.type.localeCompare(b.type) || a.slug.localeCompare(b.slug));
    const version = Number(catalog!.version) + 1;
    await tx`update content_catalogs set version = ${version}, entries = ${tx.json(entries as never)}, updated_at = now() where team_id = ${teamId} and app_key = ${app}`;
    return version;
  }

  return {
    async teamId(): Promise<string> {
      if (hearthTeam) return hearthTeam;
      const [row] = await sql`select id from studio_teams where slug = 'hearth'`;
      if (!row) throw new ApiError(503, 'STORAGE_NOT_CONFIGURED', 'The Hearth Software team is missing');
      hearthTeam = String(row.id);
      return hearthTeam;
    },

    // MARK: Types

    async types(teamId: string): Promise<ContentTypeView[]> {
      const rows = await sql`select * from content_types where team_id = ${teamId} order by app_key nulls first, name`;
      return rows.map(typeView);
    },

    type: (teamId: string, id: string) => typeRow(sql, teamId, id),

    async createType(teamId: string, actor: string, input: { slug: string; app: string | null; name: string; description: string; definition: TypeDefinition }) {
      checkBlocks(input.app, input.definition);
      try {
        const [row] = await sql`
          insert into content_types (team_id, slug, app_key, name, description, definition)
          values (${teamId}, ${input.slug}, ${input.app}, ${input.name}, ${input.description}, ${sql.json(input.definition as never)})
          returning *`;
        await audit(sql, teamId, actor, 'type_create', String(row!.id), { slug: input.slug });
        return typeView(row!);
      } catch (error) {
        if (isUniqueViolation(error)) throw new ApiError(409, 'SLUG_TAKEN', 'A content type already uses that slug');
        throw error;
      }
    },

    /** Saves a type; a changed shape (fields, sections, blocks) is a new schema version. */
    async updateType(teamId: string, actor: string, id: string, input: { name?: string; description?: string; definition?: TypeDefinition }) {
      const current = await typeRow(sql, teamId, id);
      const definition = input.definition ?? current.definition;
      checkBlocks(current.app, definition);
      const shape = (value: TypeDefinition) => JSON.stringify({ fields: value.fields, sections: value.sections, blocks: value.blocks });
      const bump = shape(definition) !== shape(current.definition);
      const [row] = await sql`
        update content_types set name = ${input.name ?? current.name}, description = ${input.description ?? current.description},
          definition = ${sql.json(definition as never)}, schema_version = schema_version + ${bump ? 1 : 0}, updated_at = now()
        where id = ${id} and team_id = ${teamId} returning *`;
      await audit(sql, teamId, actor, 'type_update', id, { schemaVersion: Number(row!.schema_version), bumped: bump });
      return typeView(row!);
    },

    // MARK: Items

    async entries(teamId: string, filter: { app?: string; typeId?: string } = {}): Promise<EntrySummary[]> {
      const rows = await sql`
        ${entrySelect(sql)} where e.team_id = ${teamId} and e.deleted_at is null
          ${filter.app ? sql`and e.app_key = ${filter.app}` : sql``}
          ${filter.typeId ? sql`and e.type_id = ${filter.typeId}` : sql``}
        order by e.updated_at desc`;
      return rows.map(summary);
    },

    async entry(teamId: string, id: string) {
      const row = await entryRow(sql, teamId, id);
      const type = await typeRow(sql, teamId, String(row.type_id));
      const version = await versionRow(sql, id, Number(row.latest_version));
      return { entry: summary(row), type, version, reviews: await reviewsFor(sql, id, version.version) };
    },

    async createEntry(teamId: string, actor: string, input: { app: string; typeId: string; title: string; slug?: string | undefined }) {
      const type = await typeRow(sql, teamId, input.typeId);
      if (type.app !== null && type.app !== input.app) throw new ApiError(422, 'TYPE_NOT_FOR_APP', `${type.name} is only for ${type.app}`);
      if (type.app === null && input.app !== 'shared') throw new ApiError(422, 'SHARED_TYPE', `${type.name} is shared content: make it under Shared`);
      const slug = input.slug ?? slugify(input.title);
      try {
        const id = await sql.begin(async (tx) => {
          const [row] = await tx`
            insert into content_entries (team_id, app_key, type_id, slug, title, owner_id)
            values (${teamId}, ${input.app}, ${input.typeId}, ${slug}, ${input.title}, ${actor}) returning id`;
          await tx`
            insert into content_versions (entry_id, version, body, schema_version, created_by, updated_by)
            values (${row!.id}, 1, ${tx.json(emptyBody(type.definition) as never)}, ${type.schemaVersion}, ${actor}, ${actor})`;
          return String(row!.id);
        }) as string;
        await audit(sql, teamId, actor, 'create', id, { app: input.app, type: type.slug });
        return this.entry(teamId, id);
      } catch (error) {
        if (isUniqueViolation(error)) throw new ApiError(409, 'SLUG_TAKEN', 'Another item in this app already uses that slug');
        throw error;
      }
    },

    /**
     * Saves the draft. Editing a published version starts the next one; editing one in review sends
     * it back to draft (its approvals no longer apply) and cancels a schedule.
     */
    async saveDraft(teamId: string, actor: string, id: string, input: { title?: string | undefined; body: Body; revision: number }) {
      const row = await entryRow(sql, teamId, id);
      const type = await typeRow(sql, teamId, String(row.type_id));
      const latest = await versionRow(sql, id, Number(row.latest_version));
      if (latest.revision !== input.revision) throw new VersionConflict(await this.entry(teamId, id));
      const disallowed = [...new Set([...(input.body.sections ?? []).flatMap((section) => section.blocks), ...(input.body.blocks ?? [])]
        .map((block) => block.type).filter((kind) => !type.definition.blocks.includes(kind)))];
      if (disallowed.length) throw new ApiError(422, 'BLOCK_NOT_ALLOWED', `${type.name} doesn’t use ${disallowed.map((kind) => BLOCK_LIBRARY[kind].label).join(', ')} blocks`);
      await sql.begin(async (tx) => {
        if (latest.state === 'published') {
          const next = latest.version + 1;
          await tx`
            insert into content_versions (entry_id, version, body, schema_version, created_by, updated_by)
            values (${id}, ${next}, ${tx.json(input.body as never)}, ${type.schemaVersion}, ${actor}, ${actor})`;
          await tx`update content_entries set latest_version = ${next} where id = ${id}`;
        } else {
          if (latest.state !== 'draft') {
            await tx`delete from content_reviews where entry_id = ${id} and version = ${latest.version}`;
            await tx`update content_releases set state = 'canceled' where entry_id = ${id} and version = ${latest.version} and state = 'scheduled'`;
          }
          await tx`
            update content_versions set body = ${tx.json(input.body as never)}, schema_version = ${type.schemaVersion}, state = 'draft',
              revision = revision + 1, updated_by = ${actor}, updated_at = now(), submitted_at = null
            where entry_id = ${id} and version = ${latest.version}`;
        }
        await tx`update content_entries set title = ${input.title ?? String(row.title)}, updated_at = now() where id = ${id}`;
      });
      return this.entry(teamId, id);
    },

    async remove(teamId: string, actor: string, id: string) {
      const row = await entryRow(sql, teamId, id);
      if (row.live_version != null) throw new ApiError(409, 'PUBLISHED', 'Unpublish it first: apps are using it');
      await sql`update content_entries set deleted_at = now() where id = ${id}`;
      await sql`update content_releases set state = 'canceled' where entry_id = ${id} and state = 'scheduled'`;
      await audit(sql, teamId, actor, 'delete', id);
    },

    // MARK: Review

    /** Sends the draft to review; a type without review steps is approved at once. */
    async submit(teamId: string, actor: string, id: string) {
      const row = await entryRow(sql, teamId, id);
      const type = await typeRow(sql, teamId, String(row.type_id));
      const version = Number(row.latest_version);
      const latest = await versionRow(sql, id, version);
      if (latest.state === 'published') throw new ApiError(409, 'NOTHING_TO_REVIEW', 'There are no changes since it was published');
      if (latest.state === 'in_review' || latest.state === 'approved') throw new ApiError(409, 'ALREADY_SUBMITTED', 'It’s already in review');
      const steps = type.definition.reviewSteps;
      await sql.begin(async (tx) => {
        await tx`delete from content_reviews where entry_id = ${id} and version = ${version}`;
        for (const step of steps) await tx`insert into content_reviews (entry_id, version, step) values (${id}, ${version}, ${step})`;
        await tx`
          update content_versions set state = ${steps.length ? 'in_review' : 'approved'}, submitted_at = now()
          where entry_id = ${id} and version = ${version}`;
        await tx`update content_entries set updated_at = now() where id = ${id}`;
      });
      await audit(sql, teamId, actor, 'submit', id, { version });
      return this.entry(teamId, id);
    },

    async decide(teamId: string, actor: string, id: string, input: { step: string; decision: 'approve' | 'changes'; note?: string | undefined }) {
      const row = await entryRow(sql, teamId, id);
      const version = Number(row.latest_version);
      const latest = await versionRow(sql, id, version);
      if (latest.state !== 'in_review' && latest.state !== 'approved' && latest.state !== 'changes_requested') {
        throw new ApiError(409, 'NOT_IN_REVIEW', 'It isn’t waiting for review');
      }
      const [review] = await sql`
        update content_reviews set state = ${input.decision === 'approve' ? 'approved' : 'changes_requested'}, reviewer_id = ${actor},
          note = ${input.note ?? null}, decided_at = now()
        where entry_id = ${id} and version = ${version} and step = ${input.step} returning id`;
      if (!review) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'That review step isn’t part of this item');
      const reviews = await reviewsFor(sql, id, version);
      const state: VersionState = reviews.some((entry) => entry.state === 'changes_requested') ? 'changes_requested'
        : reviews.every((entry) => entry.state === 'approved') ? 'approved' : 'in_review';
      await sql`update content_versions set state = ${state} where entry_id = ${id} and version = ${version}`;
      await sql`update content_entries set updated_at = now() where id = ${id}`;
      await audit(sql, teamId, actor, input.decision === 'approve' ? 'approve' : 'request_changes', id, { version, step: input.step });
      return this.entry(teamId, id);
    },

    async comments(teamId: string, id: string) {
      await entryRow(sql, teamId, id);
      const rows = await sql`
        select c.*, m.display_name as author_name from content_comments c
        left join studio_members m on m.team_id = ${teamId} and m.user_id = c.author_id
        where c.entry_id = ${id} order by c.created_at`;
      return rows.map((row) => ({
        id: String(row.id), version: Number(row.version), blockId: (row.block_id as string | null) ?? null, authorId: String(row.author_id),
        authorName: (row.author_name as string | null) ?? null, body: String(row.body), resolved: row.resolved === true, createdAt: iso(row.created_at),
      }));
    },

    async addComment(teamId: string, actor: string, id: string, input: { body: string; blockId?: string | null | undefined }) {
      const row = await entryRow(sql, teamId, id);
      await sql`
        insert into content_comments (entry_id, version, block_id, author_id, body)
        values (${id}, ${row.latest_version}, ${input.blockId ?? null}, ${actor}, ${input.body})`;
      return this.comments(teamId, id);
    },

    async resolveComment(teamId: string, commentId: string, resolved: boolean) {
      const [row] = await sql`
        update content_comments c set resolved = ${resolved} from content_entries e
        where c.id = ${commentId} and e.id = c.entry_id and e.team_id = ${teamId} returning c.entry_id`;
      if (!row) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'That comment doesn’t exist');
      return String(row.entry_id);
    },

    /** The pre-publish checks on the latest version. */
    async checks(teamId: string, id: string) {
      const row = await entryRow(sql, teamId, id);
      const type = await typeRow(sql, teamId, String(row.type_id));
      return checksFor(sql, teamId, row, await versionRow(sql, id, Number(row.latest_version)), type);
    },

    /** What the latest version changes from the live one. */
    async diff(teamId: string, id: string) {
      const row = await entryRow(sql, teamId, id);
      const latest = await versionRow(sql, id, Number(row.latest_version));
      const live = row.live_version != null && Number(row.live_version) !== latest.version ? await versionRow(sql, id, Number(row.live_version)) : null;
      if (row.live_version != null && Number(row.live_version) === latest.version) return { from: latest.version, to: latest.version, ...diffBodies(latest.body, latest.body) };
      return { from: live?.version ?? null, to: latest.version, ...diffBodies(live?.body ?? null, latest.body) };
    },

    // MARK: Media

    async startUpload(teamId: string, actor: string, input: { app: string; sha256: string; bytes: number; contentType: MediaType; width?: number | undefined; height?: number | undefined }) {
      const path = `${input.app === 'shared' ? 'shared' : `apps/${input.app}`}/media/${input.sha256}.${MEDIA_TYPES[input.contentType]}`;
      const [existing] = await sql`select * from content_media where path = ${path}`;
      if (existing?.uploaded === true) return { id: String(existing.id), url: storage().publicUrl(path), upload: null };
      const [row] = existing ? [existing] : await sql`
        insert into content_media (team_id, app_key, path, content_type, sha256, bytes, width, height, created_by)
        values (${teamId}, ${input.app}, ${path}, ${input.contentType}, ${input.sha256}, ${input.bytes}, ${input.width ?? null}, ${input.height ?? null}, ${actor})
        returning *`;
      return { id: String(row!.id), url: storage().publicUrl(path), upload: await storage().uploadUrl(path) };
    },

    async commitUpload(teamId: string, id: string) {
      const [row] = await sql`update content_media set uploaded = true where id = ${id} and team_id = ${teamId} returning *`;
      if (!row) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'That upload doesn’t exist');
      return this.mediaView(row);
    },

    mediaView(row: Record<string, unknown>) {
      return {
        id: String(row.id), app: String(row.app_key), url: storage().publicUrl(String(row.path)), contentType: String(row.content_type),
        bytes: Number(row.bytes), width: row.width == null ? null : Number(row.width), height: row.height == null ? null : Number(row.height),
        alt: String(row.alt), uploaded: row.uploaded === true, createdAt: iso(row.created_at),
      };
    },

    async media(teamId: string, app: string) {
      const rows = await sql`select * from content_media where team_id = ${teamId} and app_key = ${app} and uploaded order by created_at desc limit 500`;
      return rows.map((row) => this.mediaView(row));
    },

    async mediaApp(teamId: string, id: string) {
      const [row] = await sql`select app_key from content_media where id = ${id} and team_id = ${teamId}`;
      if (!row) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'That image doesn’t exist');
      return String(row.app_key);
    },

    async setAlt(teamId: string, id: string, alt: string) {
      const [row] = await sql`update content_media set alt = ${alt} where id = ${id} and team_id = ${teamId} returning *`;
      if (!row) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'That image doesn’t exist');
      return this.mediaView(row);
    },

    // MARK: Publishing

    /**
     * Publishes the latest version now, or schedules it (`at`). Checks must pass; missing
     * approvals stop a publisher, while an owner may override them (logged on the release).
     */
    async publish(teamId: string, actor: string, id: string, input: { override: boolean; canOverride: boolean; at?: Date | undefined }) {
      const row = await entryRow(sql, teamId, id);
      const type = await typeRow(sql, teamId, String(row.type_id));
      const version = await versionRow(sql, id, Number(row.latest_version));
      if (version.state === 'published') throw new ApiError(409, 'ALREADY_LIVE', 'This version is already live');
      if (input.override && !input.canOverride) throw new ApiError(403, 'PERMISSION_REQUIRED', 'Only an owner can publish without the approvals');
      const checks = await checksFor(sql, teamId, row, version, type);
      const failing = checks.filter((check) => check.state === 'fail' && !(check.id === 'approvals' && input.override));
      if (failing.length) throw new ApiError(422, 'CHECKS_FAILED', `Fix these first: ${failing.map((check) => check.label + (check.detail ? ` (${check.detail})` : '')).join('; ')}`);
      const override = input.override && checks.some((check) => check.id === 'approvals' && check.state === 'fail');
      if (input.at && input.at.getTime() > now() + 60_000) {
        await sql`update content_releases set state = 'canceled' where entry_id = ${id} and state = 'scheduled'`;
        const [release] = await sql`
          insert into content_releases (team_id, app_key, entry_id, version, action, override, state, scheduled_for, published_by)
          values (${teamId}, ${row.app_key}, ${id}, ${version.version}, 'publish', ${override}, 'scheduled', ${input.at}, ${actor}) returning id`;
        await audit(sql, teamId, actor, 'schedule', id, { version: version.version, at: input.at.toISOString() });
        return { scheduled: true, releaseId: String(release!.id), scheduledFor: input.at.toISOString() };
      }
      const result = await doPublish(teamId, actor, id, version.version, override);
      return { scheduled: false, ...result };
    },

    /** Publishes schedules that are due; returns how many went live. */
    async runDue(): Promise<number> {
      const due = await sql`
        select id, team_id, entry_id, version, override, published_by from content_releases
        where state = 'scheduled' and scheduled_for <= ${new Date(now())} order by scheduled_for limit 20`;
      let published = 0;
      for (const release of due) {
        try {
          const done = await doPublish(String(release.team_id), String(release.published_by), String(release.entry_id), Number(release.version), release.override === true, String(release.id));
          if (done) published += 1;
        } catch (error) {
          console.warn('scheduled publish failed', String(release.id), error instanceof Error ? error.message : error);
          await sql`update content_releases set state = 'canceled' where id = ${release.id}`;
        }
      }
      return published;
    },

    async cancelScheduled(teamId: string, actor: string, releaseId: string) {
      const [row] = await sql`
        update content_releases set state = 'canceled' where id = ${releaseId} and team_id = ${teamId} and state = 'scheduled' returning entry_id`;
      if (!row) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Nothing is scheduled there');
      await audit(sql, teamId, actor, 'unschedule', String(row.entry_id), { releaseId });
    },

    /** Points the app's catalog back at an earlier release's bundle. Nothing is uploaded. */
    async rollback(teamId: string, actor: string, id: string, releaseId: string) {
      const row = await entryRow(sql, teamId, id);
      const [target] = await sql`
        select * from content_releases where id = ${releaseId} and entry_id = ${id} and state = 'done' and bundle_path is not null`;
      if (!target) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'That release can’t be rolled back to');
      const type = await typeRow(sql, teamId, String(row.type_id));
      const ver = await versionRow(sql, id, Number(target.version));
      const entry: CatalogEntry = {
        id, type: type.slug, slug: String(row.slug), title: String(row.title), version: Number(target.version), schemaVersion: ver.schemaVersion,
        hash: String(target.hash), url: storage().publicUrl(String(target.bundle_path)), bytes: Number(target.bytes), publishedAt: iso(target.created_at),
      };
      return sql.begin(async (tx) => {
        const catalogVersion = await placeInCatalog(tx as unknown as Sql, teamId, String(row.app_key), entry);
        const [release] = await tx`
          insert into content_releases (team_id, app_key, entry_id, version, action, bundle_path, hash, bytes, catalog_version, published_by)
          values (${teamId}, ${row.app_key}, ${id}, ${target.version}, 'rollback', ${target.bundle_path}, ${target.hash}, ${target.bytes}, ${catalogVersion}, ${actor})
          returning id`;
        await tx`update content_entries set live_version = ${target.version}, live_release_id = ${release!.id}, updated_at = now() where id = ${id}`;
        await audit(tx as unknown as Sql, teamId, actor, 'rollback', id, { toVersion: Number(target.version), releaseId });
        return { releaseId: String(release!.id), catalogVersion, version: Number(target.version) };
      });
    },

    async unpublish(teamId: string, actor: string, id: string) {
      const row = await entryRow(sql, teamId, id);
      if (row.live_version == null) throw new ApiError(409, 'NOT_LIVE', 'It isn’t published');
      return sql.begin(async (tx) => {
        const catalogVersion = await placeInCatalog(tx as unknown as Sql, teamId, String(row.app_key), null, id);
        await tx`
          insert into content_releases (team_id, app_key, entry_id, version, action, catalog_version, published_by)
          values (${teamId}, ${row.app_key}, ${id}, ${row.live_version}, 'unpublish', ${catalogVersion}, ${actor})`;
        await tx`update content_entries set live_version = null, live_release_id = null, updated_at = now() where id = ${id}`;
        await audit(tx as unknown as Sql, teamId, actor, 'unpublish', id);
        return { catalogVersion };
      });
    },

    async releases(teamId: string, filter: { app?: string | undefined; entryId?: string | undefined } = {}) {
      const rows = await sql`
        select r.*, e.title, e.live_release_id, m.display_name as actor_name from content_releases r
        join content_entries e on e.id = r.entry_id
        left join studio_members m on m.team_id = r.team_id and m.user_id = r.published_by
        where r.team_id = ${teamId} and r.state <> 'canceled'
          ${filter.app ? sql`and r.app_key = ${filter.app}` : sql``}
          ${filter.entryId ? sql`and r.entry_id = ${filter.entryId}` : sql``}
        order by coalesce(r.scheduled_for, r.created_at) desc limit 200`;
      return rows.map((row) => ({
        id: String(row.id), app: String(row.app_key), entryId: String(row.entry_id), title: String(row.title), version: Number(row.version),
        action: String(row.action), state: String(row.state), hash: (row.hash as string | null) ?? null, bytes: row.bytes == null ? null : Number(row.bytes),
        bundleUrl: row.bundle_path ? storage().publicUrl(String(row.bundle_path)) : null, catalogVersion: row.catalog_version == null ? null : Number(row.catalog_version),
        override: row.override === true, live: String(row.live_release_id ?? '') === String(row.id),
        scheduledFor: isoOrNull(row.scheduled_for), by: String(row.published_by), byName: (row.actor_name as string | null) ?? null, at: iso(row.created_at),
      }));
    },

    async catalogs(teamId: string) {
      const rows = await sql`select * from content_catalogs where team_id = ${teamId} order by app_key`;
      return rows.map((row) => ({
        app: String(row.app_key), version: Number(row.version), minAppVersion: String(row.min_app_version),
        items: (row.entries as CatalogEntry[]).length, updatedAt: iso(row.updated_at),
      }));
    },

    async setMinAppVersion(teamId: string, actor: string, app: string, minAppVersion: string) {
      await sql`
        insert into content_catalogs (team_id, app_key, min_app_version) values (${teamId}, ${app}, ${minAppVersion})
        on conflict (team_id, app_key) do update set min_app_version = excluded.min_app_version, version = content_catalogs.version + 1, updated_at = now()`;
      await audit(sql, teamId, actor, 'min_app_version', app, { minAppVersion });
    },

    /** The public catalog an app reads: its own items plus every shared one. */
    async catalog(app: string) {
      await this.runDue().catch(() => 0);
      const teamId = await this.teamId();
      const rows = await sql`select * from content_catalogs where team_id = ${teamId} and app_key in (${app}, 'shared')`;
      const own = rows.find((row) => row.app_key === app);
      const shared = app === 'shared' ? undefined : rows.find((row) => row.app_key === 'shared');
      const entries = [...((own?.entries as CatalogEntry[] | undefined) ?? []), ...((shared?.entries as CatalogEntry[] | undefined) ?? [])];
      const updated = [own?.updated_at, shared?.updated_at].filter(Boolean).map((value) => new Date(value as Date).getTime());
      return {
        app,
        version: Number(own?.version ?? 0),
        sharedVersion: Number(shared?.version ?? 0),
        minAppVersion: String(own?.min_app_version ?? '1.0'),
        updatedAt: updated.length ? new Date(Math.max(...updated)).toISOString() : null,
        entries,
      };
    },
  };
}

/** A type may only use blocks that exist for its app (scripture and timeline are Hearken's). */
function checkBlocks(app: string | null, definition: TypeDefinition) {
  const wrong = definition.blocks.filter((kind) => {
    const only = BLOCK_LIBRARY[kind].app;
    return only !== undefined && only !== app;
  });
  if (wrong.length) throw new ApiError(422, 'BLOCK_NOT_FOR_APP', `${wrong.map((kind) => BLOCK_LIBRARY[kind].label).join(', ')} blocks are only for ${BLOCK_LIBRARY[wrong[0]!].app}`);
}
