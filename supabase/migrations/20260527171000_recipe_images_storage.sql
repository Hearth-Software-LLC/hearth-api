insert into storage.buckets (id, name, public)
values ('recipe-images', 'recipe-images', true)
on conflict (id) do nothing;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'Recipe images are publicly readable'
  ) then
    create policy "Recipe images are publicly readable"
      on storage.objects
      for select
      using (bucket_id = 'recipe-images');
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'Users can upload their recipe images'
  ) then
    create policy "Users can upload their recipe images"
      on storage.objects
      for insert
      to authenticated
      with check (
        bucket_id = 'recipe-images'
        and split_part(name, '/', 1) = auth.uid()::text
      );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'Users can update their recipe images'
  ) then
    create policy "Users can update their recipe images"
      on storage.objects
      for update
      to authenticated
      using (
        bucket_id = 'recipe-images'
        and split_part(name, '/', 1) = auth.uid()::text
      )
      with check (
        bucket_id = 'recipe-images'
        and split_part(name, '/', 1) = auth.uid()::text
      );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'Users can delete their recipe images'
  ) then
    create policy "Users can delete their recipe images"
      on storage.objects
      for delete
      to authenticated
      using (
        bucket_id = 'recipe-images'
        and split_part(name, '/', 1) = auth.uid()::text
      );
  end if;
end $$;
