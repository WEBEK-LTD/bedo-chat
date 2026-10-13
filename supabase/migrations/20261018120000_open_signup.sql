-- Bedo Chat - who can create an account (D-47).
--
-- The owner decided on 2026-10-10 that any student with a WhatsApp number can create an account by signing in, without
-- being added to the academy phone list first. A Super Admin can switch back to "only numbers on the academy phone list"
-- in the Admin Dashboard at any time. In both modes the number of an account deleted by an admin (D-14, D-24) cannot
-- create a new account, and the one-time-code limits stay as they are.
create table app.access_settings (
  id           boolean primary key default true check (id),
  signup_mode  text not null default 'open' check (signup_mode in ('open', 'academy_list')),
  updated_by   uuid references app.admin_accounts (id),
  updated_at   timestamptz
);
comment on table app.access_settings is
  'Who can create an account (D-47): anyone with a WhatsApp number (open) or only numbers on the academy phone list. One row.';
insert into app.access_settings (id) values (true);
create trigger access_settings_no_delete before delete on app.access_settings
  for each row execute function app.forbid_mutation();
create trigger access_settings_no_truncate before truncate on app.access_settings
  for each statement execute function app.forbid_mutation();
grant select on app.access_settings to bedo_runtime;
grant update (signup_mode, updated_by, updated_at) on app.access_settings to bedo_runtime;
