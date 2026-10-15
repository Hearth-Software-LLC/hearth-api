-- Replace household member age with date of birth.

alter table public.household_members
  add column if not exists date_of_birth date;

update public.household_members
set date_of_birth = make_date(extract(year from current_date)::int - age, 1, 1)
where date_of_birth is null
  and age is not null
  and age between 0 and 120;

alter table public.household_members
  drop column if exists age;
