-- Bedo Chat - test accounts (D-59).
--
-- The owner decided on 2026-10-28 to have many test accounts that behave exactly like students, for trying the apps:
-- ranges of phone numbers (for example +201000000000 to +201000000099) set by a Super Admin in the Admin Dashboard,
-- that sign in to the student app with ONE fixed 6-digit code instead of a WhatsApp code. Each number is its own,
-- independent account. It is separate from the store review account (D-56), which keeps its own number and code and
-- comes first.
--
-- Safety: off until a Super Admin turns it on; student sign-in only (never admin accounts or phone changes); never a
-- number on the academy phone list, and never the number of an existing account that was not created as a test
-- account (so a real student whose number falls in a range is never reachable with the code). Turning it off, or
-- removing a range, ends the sessions of those test accounts. The code is stored encrypted with
-- SETTINGS_ENCRYPTION_KEY so the Super Admin can read it again.
create table app.test_account_settings (
  id          boolean primary key default true check (id),
  enabled     boolean not null default false,
  code_enc    text check (code_enc is null or length(code_enc) <= 500),
  updated_by  uuid references app.admin_accounts (id),
  updated_at  timestamptz,
  constraint test_accounts_complete check (not enabled or code_enc is not null)
);
comment on table app.test_account_settings is
  'Test accounts (D-59): numbers in app.test_number_ranges sign in with one fixed code set by a Super Admin. Off by default. One row.';
insert into app.test_account_settings (id) values (true);
create trigger test_account_settings_no_delete before delete on app.test_account_settings
  for each row execute function app.forbid_mutation();
create trigger test_account_settings_no_truncate before truncate on app.test_account_settings
  for each statement execute function app.forbid_mutation();
grant select on app.test_account_settings to bedo_runtime;
grant update (enabled, code_enc, updated_by, updated_at) on app.test_account_settings to bedo_runtime;

-- A range: every number from first_phone to last_phone (same length, at most 1000 numbers).
create table app.test_number_ranges (
  id           uuid primary key default gen_random_uuid(),
  first_phone  text not null check (first_phone ~ '^\+[1-9][0-9]{6,14}$'),
  last_phone   text not null check (last_phone ~ '^\+[1-9][0-9]{6,14}$'),
  added_by     uuid references app.admin_accounts (id),
  added_at     timestamptz not null default now(),
  constraint test_number_range_order check (length(first_phone) = length(last_phone) and first_phone <= last_phone),
  constraint test_number_range_size check (substr(last_phone, 2)::numeric - substr(first_phone, 2)::numeric < 1000)
);
comment on table app.test_number_ranges is 'Test accounts (D-59): the ranges of numbers that are test accounts.';
create index test_number_ranges_first on app.test_number_ranges (first_phone);
grant select, insert, delete on app.test_number_ranges to bedo_runtime;

-- The accounts created as test accounts (only these, and new numbers, may use the code).
create table app.test_accounts (
  user_id     uuid primary key references app.users (id) on delete cascade,
  created_at  timestamptz not null default now()
);
comment on table app.test_accounts is 'Test accounts (D-59): accounts created by signing in with the test accounts code.';
grant select, insert on app.test_accounts to bedo_runtime;
