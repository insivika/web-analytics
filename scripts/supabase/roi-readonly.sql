-- Read-only access for the Umami ROI report (run once in Supabase → SQL editor).
-- The role can read exactly three id columns through roi.user_map and nothing
-- else: no emails, names, onboarding data, or any other table.
--
-- Before running: replace CHANGE_ME with a long random password (e.g. from your
-- password manager). Don't commit the real password.

create role roi_reader with login password 'CHANGE_ME'
  nosuperuser nocreatedb nocreaterole noinherit noreplication;

-- Every transaction of this role is read-only, even if someone tries to write.
alter role roi_reader set default_transaction_read_only = on;
alter role roi_reader set statement_timeout = '30s';

create schema if not exists roi;
revoke all on schema roi from public;

-- The view runs with its owner's rights, so roi_reader needs no access to
-- public.profiles itself.
create or replace view roi.user_map as
  select user_id, firebase_user_id, stripe_customer_id
  from public.profiles;

revoke all on roi.user_map from public, anon, authenticated;
grant usage on schema roi to roi_reader;
grant select on roi.user_map to roi_reader;

-- Check (should return a count, and the second statement should fail):
--   set role roi_reader;
--   select count(*) from roi.user_map;
--   select email from public.profiles limit 1;   -- permission denied
--   reset role;
