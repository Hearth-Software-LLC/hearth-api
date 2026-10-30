-- Learning module, schema 2: everything Hearken's bundled Subjects and Scholar Path need, so
-- Hearken can stop bundling them and install them as Collections (scripts/import-hearken-subjects.ts,
-- docs/hearken-collections-mapping.md).
--
-- Adds item fields (subjectId, symbol, order, the Scholar Path's title, summary and rules version,
-- contentVersion, the capstone), lesson fields
-- (the Hearken unit, course and stage it came from), and the link, step and assessment blocks
-- (model.ts / hearken-blocks.ts). Existing fields, blocks and review steps are kept as they are,
-- so every saved body stays valid. Only the shape changes; the listing settings are untouched.
--
-- Run after the collections migrations; safe to run twice (it only bumps a schema-1 type).

begin;

update public.content_types
set definition = jsonb_set(jsonb_set(jsonb_set(definition,
      '{fields}', '[
        {"key":"subject","label":"Subject","type":"text","required":true},
        {"key":"summary","label":"Summary","type":"text","required":false},
        {"key":"subjectId","label":"Hearken subject ID","type":"text","required":false},
        {"key":"symbol","label":"SF Symbol","type":"text","required":false},
        {"key":"order","label":"Order in the Hearken subject list","type":"number","required":false},
        {"key":"pathTitle","label":"Scholar Path title","type":"text","required":false},
        {"key":"pathSummary","label":"Scholar Path summary","type":"longtext","required":false},
        {"key":"ruleVersion","label":"Scholar rules version","type":"number","required":false},
        {"key":"contentVersion","label":"Hearken content version","type":"number","required":false},
        {"key":"capstoneId","label":"Capstone ID","type":"text","required":false},
        {"key":"capstoneTitle","label":"Capstone title","type":"text","required":false},
        {"key":"capstoneSummary","label":"Capstone summary","type":"longtext","required":false},
        {"key":"capstoneRequirements","label":"Capstone requirements (one per line)","type":"longtext","required":false},
        {"key":"capstoneRubric","label":"Capstone rubric (one per line)","type":"longtext","required":false}
      ]'::jsonb),
      '{sections}', '{"label":"Lesson","fields":[
        {"key":"objective","label":"Objective","type":"text","required":false},
        {"key":"kind","label":"Kind (unit, module, course, stage)","type":"text","required":false},
        {"key":"number","label":"Number","type":"text","required":false},
        {"key":"range","label":"Range","type":"text","required":false},
        {"key":"objectives","label":"Objectives (one per line)","type":"longtext","required":false},
        {"key":"keyPoints","label":"Key points (one per line)","type":"longtext","required":false},
        {"key":"courseId","label":"Course ID","type":"text","required":false},
        {"key":"courseNumber","label":"Course number","type":"number","required":false},
        {"key":"courseTitle","label":"Course title","type":"text","required":false},
        {"key":"courseSummary","label":"Course summary","type":"longtext","required":false},
        {"key":"courseMilestone","label":"Course milestone","type":"text","required":false},
        {"key":"courseObjectives","label":"Course objectives (one per line)","type":"longtext","required":false},
        {"key":"stage","label":"Stage number","type":"number","required":false},
        {"key":"stageTitle","label":"Stage title","type":"text","required":false},
        {"key":"stageOutcome","label":"Stage outcome","type":"longtext","required":false},
        {"key":"stagePublished","label":"Stage published","type":"boolean","required":false}
      ]}'::jsonb),
      '{blocks}', '["text","scripture","callout","quiz","match","timeline","image","video","link","step","assessment"]'::jsonb),
    schema_version = 2,
    updated_at = now()
where slug = 'learning-module' and app_key = 'hearken' and schema_version = 1;

commit;
