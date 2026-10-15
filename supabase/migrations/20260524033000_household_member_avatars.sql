alter table public.household_members
  add column if not exists avatar_url text;

insert into storage.buckets (id, name, public)
values ('member-avatars', 'member-avatars', true)
on conflict (id) do nothing;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'Member avatars are publicly readable'
  ) then
    create policy "Member avatars are publicly readable"
      on storage.objects
      for select
      using (bucket_id = 'member-avatars');
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'Users can upload their household avatars'
  ) then
    create policy "Users can upload their household avatars"
      on storage.objects
      for insert
      to authenticated
      with check (
        bucket_id = 'member-avatars'
        and split_part(name, '/', 1) = auth.uid()::text
      );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'Users can update their household avatars'
  ) then
    create policy "Users can update their household avatars"
      on storage.objects
      for update
      to authenticated
      using (
        bucket_id = 'member-avatars'
        and split_part(name, '/', 1) = auth.uid()::text
      )
      with check (
        bucket_id = 'member-avatars'
        and split_part(name, '/', 1) = auth.uid()::text
      );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'Users can delete their household avatars'
  ) then
    create policy "Users can delete their household avatars"
      on storage.objects
      for delete
      to authenticated
      using (
        bucket_id = 'member-avatars'
        and split_part(name, '/', 1) = auth.uid()::text
      );
  end if;
end $$;
