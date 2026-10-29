-- Hearth Studio: an Admin role. Admins can do everything but manage the team (invite, remove,
-- change roles and permissions); only they and owners publish paywalls and edit store products.
alter table studio_members drop constraint if exists studio_members_role_check;
alter table studio_members add constraint studio_members_role_check check (role in ('owner', 'admin', 'member'));
