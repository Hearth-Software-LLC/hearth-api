import type { Sql } from 'postgres';
import { ApiError } from '../errors.js';

/**
 * Ad campaigns and Store Studio designs: JSON documents the apps own the shape of (Hearth
 * Studio's Campaign and StoreDesign types). The server keeps them per team and app, with a
 * version: saving over a version someone else has replaced answers 409 with the current one.
 */

export type CampaignView = { app: string; slug: string; name: string; document: Record<string, unknown>; version: number; updatedBy: string; updatedAt: string; deleted: boolean; seq: number };
export type DesignView = { app: string; document: Record<string, unknown>; version: number; updatedBy: string; updatedAt: string; seq: number };

const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : String(value));

const campaign = (row: Record<string, unknown>): CampaignView => ({
  app: String(row.app), slug: String(row.slug), name: String(row.name), document: row.document as Record<string, unknown>,
  version: Number(row.version), updatedBy: String(row.updated_by), updatedAt: iso(row.updated_at), deleted: row.deleted_at != null, seq: Number(row.seq),
});
const design = (row: Record<string, unknown>): DesignView => ({
  app: String(row.app), document: row.document as Record<string, unknown>, version: Number(row.version),
  updatedBy: String(row.updated_by), updatedAt: iso(row.updated_at), seq: Number(row.seq),
});

export class VersionConflict<T> extends ApiError {
  constructor(readonly current: T) {
    super(409, 'VERSION_CONFLICT', 'Someone else saved this since you opened it');
  }
}

export type DocumentsService = ReturnType<typeof createDocumentsService>;

export function createDocumentsService(sql: Sql) {
  return {
    async campaigns(team: string, since: number, app?: string) {
      const rows = await sql`
        select * from marketing_campaigns
        where team_id = ${team} and seq > ${since} and (${since} > 0 or deleted_at is null)
          and (${app ?? null}::text is null or app = ${app ?? null})
        order by seq limit 1000`;
      const items = rows.map(campaign);
      return { campaigns: items, cursor: items.at(-1)?.seq ?? since };
    },

    async campaign(team: string, app: string, slug: string) {
      const [row] = await sql`select * from marketing_campaigns where team_id = ${team} and app = ${app} and slug = ${slug} and deleted_at is null`;
      return row ? campaign(row) : undefined;
    },

    /** Creates (baseVersion 0) or replaces (baseVersion = the version it was based on). */
    async saveCampaign(team: string, user: string, app: string, slug: string, input: { name: string; document: Record<string, unknown>; baseVersion: number }) {
      return sql.begin(async (tx) => {
        const [current] = await tx`select * from marketing_campaigns where team_id = ${team} and app = ${app} and slug = ${slug} for update`;
        const live = current && current.deleted_at == null;
        if (live && Number(current.version) !== input.baseVersion) throw new VersionConflict(campaign(current));
        if (!live && input.baseVersion !== 0 && current) throw new VersionConflict(campaign(current));
        const version = live ? Number(current.version) + 1 : 1;
        const [row] = await tx`
          insert into marketing_campaigns (team_id, app, slug, name, document, version, updated_by)
          values (${team}, ${app}, ${slug}, ${input.name}, ${tx.json(input.document as never)}, ${version}, ${user})
          on conflict (team_id, app, slug) do update set name = excluded.name, document = excluded.document, version = excluded.version,
            updated_by = excluded.updated_by, updated_at = now(), seq = nextval('studio_change_seq'), deleted_at = null
          returning *`;
        return campaign(row!);
      }) as Promise<CampaignView>;
    },

    async deleteCampaign(team: string, app: string, slug: string) {
      const rows = await sql`
        update marketing_campaigns set deleted_at = now(), updated_at = now(), seq = nextval('studio_change_seq')
        where team_id = ${team} and app = ${app} and slug = ${slug} and deleted_at is null returning slug`;
      if (rows.length === 0) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Campaign not found');
    },

    async designs(team: string, since: number) {
      const rows = await sql`select * from store_designs where team_id = ${team} and seq > ${since} order by seq`;
      const items = rows.map(design);
      return { designs: items, cursor: items.at(-1)?.seq ?? since };
    },

    async design(team: string, app: string) {
      const [row] = await sql`select * from store_designs where team_id = ${team} and app = ${app}`;
      return row ? design(row) : undefined;
    },

    async saveDesign(team: string, user: string, app: string, input: { document: Record<string, unknown>; baseVersion: number }) {
      return sql.begin(async (tx) => {
        const [current] = await tx`select * from store_designs where team_id = ${team} and app = ${app} for update`;
        if (current && Number(current.version) !== input.baseVersion) throw new VersionConflict(design(current));
        if (!current && input.baseVersion !== 0) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Design not found');
        const version = current ? Number(current.version) + 1 : 1;
        const [row] = await tx`
          insert into store_designs (team_id, app, document, version, updated_by)
          values (${team}, ${app}, ${tx.json(input.document as never)}, ${version}, ${user})
          on conflict (team_id, app) do update set document = excluded.document, version = excluded.version,
            updated_by = excluded.updated_by, updated_at = now(), seq = nextval('studio_change_seq')
          returning *`;
        return design(row!);
      }) as Promise<DesignView>;
    },
  };
}
