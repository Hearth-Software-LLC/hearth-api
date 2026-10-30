-- Apply AFTER deploying the hearth-api with Collections (and after 20261031090000_content_collections.sql).
--
-- Makes learning modules Collections, counted in lessons. hearth-api builds from before Collections
-- read type definitions with a strict schema and would answer 500 for this one, so don't apply it
-- while an older build is live, and undo it (remove the `listing` key) before rolling the API back:
--
--   update public.content_types set definition = definition - 'listing' where slug = 'learning-module';

begin;
set local lock_timeout = '5s';

update public.content_types
set definition = definition || '{"listing":{"downloadable":true,"unit":{"one":"lesson","many":"lessons"},"countFrom":"sections"}}'::jsonb
where slug = 'learning-module' and not (definition ? 'listing');

commit;
