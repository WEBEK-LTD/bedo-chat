-- Bedo Chat - the store review account (D-56).
--
-- Google Play (and Apple) review the apps with sign-in details that must keep working and never expire; their reviewers
-- cannot receive a WhatsApp code. The owner decided on 2026-10-11 to allow ONE review account: one phone number whose
-- sign-in code is a fixed 6-digit code set by a Super Admin in the Admin Dashboard, instead of a code sent by WhatsApp.
-- It is off until a Super Admin turns it on, works only for that number and only for student sign-in (never for admin
-- accounts or phone changes), keeps every limit and lock of ordinary codes, and turning it off ends the account's
-- sessions. The code is stored encrypted with SETTINGS_ENCRYPTION_KEY so the Super Admin can read it again.
create table app.review_account_settings (
  id          boolean primary key default true check (id),
  enabled     boolean not null default false,
  phone       text check (phone is null or phone ~ '^\+[1-9][0-9]{6,14}$'),
  code_enc    text check (code_enc is null or length(code_enc) <= 500),
  updated_by  uuid references app.admin_accounts (id),
  updated_at  timestamptz,
  constraint review_account_complete check (not enabled or (phone is not null and code_enc is not null))
);
comment on table app.review_account_settings is
  'The store review account (D-56): one number signing in with a fixed code set by a Super Admin. Off by default. One row.';
insert into app.review_account_settings (id) values (true);
create trigger review_account_settings_no_delete before delete on app.review_account_settings
  for each row execute function app.forbid_mutation();
create trigger review_account_settings_no_truncate before truncate on app.review_account_settings
  for each statement execute function app.forbid_mutation();
grant select on app.review_account_settings to bedo_runtime;
grant update (enabled, phone, code_enc, updated_by, updated_at) on app.review_account_settings to bedo_runtime;
