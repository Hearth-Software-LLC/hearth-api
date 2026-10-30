-- Apply AFTER deploying the hearth-api with the ingredients and steps blocks (src/content/recipe-blocks.ts),
-- and after 20261031110000_learning_module_v2.sql.
--
-- Collections for Sated, Suffice and BigTable: four app-specific, downloadable content types for the
-- Hearth Software team.
--   sated     article            Article collection   sections "Article", counted in articles
--   suffice   article            Article collection   sections "Article", counted in articles
--   suffice   learning-module    Learning module      sections "Lesson", counted in lessons
--   bigtable  recipe-collection  Recipe collection    sections "Recipe", counted in recipes
-- Review steps: help-article's ("Copy edit"), with a "Fact check" first for Sated and Suffice.
--
-- A slug was unique per team; Suffice's learning-module and the two apps' "article" types need it
-- unique per team and app instead (a shared type, app_key null, counts as its own app).
--
-- hearth-api builds without the ingredients and steps blocks read type definitions with a strict
-- schema and would answer 500 for the recipe type, so don't apply this while an older build is live.
-- To undo before rolling the API back:
--
--   delete from public.content_types where app_key = 'bigtable' and slug = 'recipe-collection';
--
-- (only possible while no item uses it; the other three types use blocks older builds know).
--
-- Safe to run twice: each type is only added when its app has no type with that slug.

begin;
set local lock_timeout = '5s';

alter table public.content_types drop constraint if exists content_types_team_id_slug_key;
create unique index if not exists content_types_team_app_slug
  on public.content_types (team_id, coalesce(app_key, ''), slug);

insert into public.content_types (team_id, slug, app_key, name, description, definition)
select t.id, v.slug, v.app_key, v.name, v.description, v.definition::jsonb
from public.studio_teams t, (values
  ('article', 'sated', 'Article collection', 'Articles people download in Sated: one or more, each a stack of blocks.',
   '{"fields":[{"key":"summary","label":"Summary","type":"longtext","required":false}],"sections":{"label":"Article","fields":[{"key":"dek","label":"Dek (a one-line standfirst)","type":"text","required":false},{"key":"readMinutes","label":"Minutes to read","type":"number","required":false}]},"blocks":["text","callout","image","video","quiz"],"reviewSteps":["Fact check","Copy edit"],"listing":{"downloadable":true,"unit":{"one":"article","many":"articles"},"countFrom":"sections"}}'),
  ('article', 'suffice', 'Article collection', 'Articles people download in Suffice: one or more, each a stack of blocks.',
   '{"fields":[{"key":"summary","label":"Summary","type":"longtext","required":false}],"sections":{"label":"Article","fields":[{"key":"dek","label":"Dek (a one-line standfirst)","type":"text","required":false},{"key":"readMinutes","label":"Minutes to read","type":"number","required":false}]},"blocks":["text","callout","image","video","quiz"],"reviewSteps":["Fact check","Copy edit"],"listing":{"downloadable":true,"unit":{"one":"article","many":"articles"},"countFrom":"sections"}}'),
  ('learning-module', 'suffice', 'Learning module', 'A money topic made of ordered lessons, each a stack of blocks.',
   '{"fields":[{"key":"subject","label":"Subject","type":"text","required":true},{"key":"summary","label":"Summary","type":"longtext","required":false}],"sections":{"label":"Lesson","fields":[{"key":"objective","label":"Objective","type":"text","required":false}]},"blocks":["text","callout","quiz","match","timeline","image","video"],"reviewSteps":["Fact check","Copy edit"],"listing":{"downloadable":true,"unit":{"one":"lesson","many":"lessons"},"countFrom":"sections"}}'),
  ('recipe-collection', 'bigtable', 'Recipe collection', 'Recipes people add to their BigTable kitchen: each one its ingredients, steps and a photo.',
   '{"fields":[{"key":"summary","label":"Summary","type":"longtext","required":false}],"sections":{"label":"Recipe","fields":[{"key":"description","label":"Description","type":"longtext","required":false},{"key":"image","label":"Photo","type":"image","required":true},{"key":"servings","label":"Servings","type":"number","required":true},{"key":"prepMinutes","label":"Prep minutes","type":"number","required":false},{"key":"cookMinutes","label":"Cook minutes","type":"number","required":false},{"key":"difficulty","label":"Difficulty (easy, medium or hard)","type":"text","required":false},{"key":"tags","label":"Tags (comma separated)","type":"text","required":false}]},"blocks":["ingredients","steps","text","callout","image"],"reviewSteps":["Copy edit"],"listing":{"downloadable":true,"unit":{"one":"recipe","many":"recipes"},"countFrom":"sections"}}')
) as v(slug, app_key, name, description, definition)
where t.slug = 'hearth'
  and not exists (
    select 1 from public.content_types c where c.team_id = t.id and c.slug = v.slug and c.app_key = v.app_key
  );

commit;
