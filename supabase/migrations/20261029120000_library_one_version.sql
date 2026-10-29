-- The Library keeps one version of each screenshot and mockup: one per app, device, appearance
-- (which includes the orientation, e.g. "light-landscape") and page. A new capture replaces it
-- in place (same id, so posts and campaigns that use it get the new image); the old file is
-- removed unless a post still uses it. Uploads, ads and icons are unaffected.

begin;

-- Any duplicates already there: keep the newest of each.
update public.library_assets a
set deleted_at = now(), updated_at = now(), seq = nextval('public.studio_change_seq')
where a.deleted_at is null
  and a.kind in ('screenshot', 'mockup')
  and exists (
    select 1 from public.library_assets b
    where b.deleted_at is null and b.id <> a.id
      and b.team_id = a.team_id and b.app = a.app and b.kind = a.kind
      and coalesce(b.device, '') = coalesce(a.device, '')
      and coalesce(b.appearance, '') = coalesce(a.appearance, '')
      and b.name = a.name
      and (b.updated_at, b.id) > (a.updated_at, a.id)
  );

drop index if exists public.library_assets_one_per_run;

create unique index library_assets_one_version on public.library_assets
  (team_id, app, kind, coalesce(device, ''), coalesce(appearance, ''), name)
  where deleted_at is null and kind in ('screenshot', 'mockup');

commit;
