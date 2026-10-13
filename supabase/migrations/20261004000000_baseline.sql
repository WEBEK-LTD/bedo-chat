-- Bedo Chat - Phase 1 database baseline
--
-- Applied by the @bedo/db migration runner (packages/db), which records every migration with a
-- SHA-256 checksum in app_meta.schema_migrations. Never edit a migration that has been applied
-- anywhere; add a new one instead. The runner refuses to continue if an applied file changes.
--
-- Feature tables (users, sessions, conversations, messages, ...) are added by the phase that
-- builds the feature, as listed in the Phase 0 blueprint.

-- Extensions live in their own schema, matching Supabase's convention.
create schema if not exists extensions;
create extension if not exists citext with schema extensions;   -- case-insensitive usernames
create extension if not exists pg_trgm with schema extensions;  -- partial-match search on names and files
create extension if not exists pgcrypto with schema extensions; -- gen_random_uuid(), digest()

-- All application tables live in "app". Clients never connect to the database directly
-- (D-08): only the NestJS API and worker do, so no browser-facing role gets any access.
create schema if not exists app;
revoke all on schema app from public;

do $$
declare
  client_role text;
begin
  -- On Supabase, make sure the Data API roles can never read the application schema.
  foreach client_role in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = client_role) then
      execute format('revoke all on schema app from %I', client_role);
      execute format('revoke all on all tables in schema app from %I', client_role);
      execute format('alter default privileges in schema app revoke all on tables from %I', client_role);
      execute format('alter default privileges in schema app revoke all on sequences from %I', client_role);
      execute format('alter default privileges in schema app revoke all on functions from %I', client_role);
    end if;
  end loop;
end
$$;

-- Keeps updated_at current on any table that attaches this trigger.
create or replace function app.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Rejects UPDATE, DELETE and TRUNCATE on append-only tables.
create or replace function app.forbid_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'table %.% is append-only', tg_table_schema, tg_table_name
    using errcode = 'insufficient_privilege';
end;
$$;

-- Append-only record of admin and security actions (blueprint: Security, Admin dashboard).
create table app.audit_log (
  id           bigint generated always as identity primary key,
  occurred_at  timestamptz not null default now(),
  actor_type   text        not null check (actor_type in ('user', 'admin', 'system')),
  actor_id     uuid,
  action       text        not null check (length(action) between 1 and 100),
  target_type  text        check (target_type is null or length(target_type) between 1 and 100),
  target_id    text        check (target_id is null or length(target_id) between 1 and 200),
  ip           inet,
  user_agent   text        check (user_agent is null or length(user_agent) <= 1000),
  metadata     jsonb       not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  constraint audit_log_actor_id_required check (actor_type = 'system' or actor_id is not null)
);

comment on table app.audit_log is 'Append-only log of admin and security actions. Rows can never be updated or deleted.';

create index audit_log_occurred_at_idx on app.audit_log (occurred_at desc);
create index audit_log_actor_idx on app.audit_log (actor_type, actor_id, occurred_at desc);
create index audit_log_target_idx on app.audit_log (target_type, target_id, occurred_at desc);

create trigger audit_log_no_update_delete
  before update or delete on app.audit_log
  for each row execute function app.forbid_mutation();

create trigger audit_log_no_truncate
  before truncate on app.audit_log
  for each statement execute function app.forbid_mutation();

-- Runtime role. The API and worker connect as a login role that is a member of bedo_runtime, never
-- as the table owner: only the owner can disable triggers or alter tables, so the append-only rule
-- above cannot be bypassed from application code. Migrations run as the owner (e.g. "postgres").
-- Each later migration grants bedo_runtime exactly the privileges its tables need; there are
-- deliberately no default privileges.
--
-- Create the login role once per environment (password from your secret store, never in git):
--   create role bedo_api login password '...' in role bedo_runtime;
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'bedo_runtime') then
    create role bedo_runtime nologin;
  end if;
exception
  -- Roles are cluster-wide: another database on the same server may have created it concurrently.
  when duplicate_object then null;
end
$$;

grant usage on schema app to bedo_runtime;
-- Extension types and functions (citext columns, pg_trgm operators) used by later tables.
grant usage on schema extensions to bedo_runtime;
grant select, insert on app.audit_log to bedo_runtime;
