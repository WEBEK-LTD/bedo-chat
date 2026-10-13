-- Bedo Chat - Phase 3.3 (D-36): one Netlify site, no separate API host, no Redis.
--
-- The API now runs inside the website's server functions, which keep no state between requests. What Redis
-- held moves here, all short-lived and owned by the runtime role:
--   app.ephemeral        pending sign-ins (2-Step, admin), authenticator setup secrets (encrypted), photo uploads
--   app.rate_counters    fixed-window attempt counters (sign-in, setup tokens, messaging limits, ...)
--   app.rate_events      sliding-window events for the one-time-code limits (per number, per address)
--   app.presence_devices which signed-in devices are online right now (heartbeat every 25 s, 60 s each, P-18)
--   app.maintenance_runs when the hourly housekeeping last ran (it runs from ordinary requests)
-- Expired rows are ignored by every read and removed by the hourly housekeeping. Nothing here is audit
-- history; the audit tables are unchanged.

create table app.ephemeral (
  key        text primary key check (length(key) between 1 and 300),
  value      text not null check (length(value) <= 16384),
  expires_at timestamptz not null
);
create index ephemeral_expires_idx on app.ephemeral (expires_at);
comment on table app.ephemeral is
  'Short-lived server state with an expiry (D-36): pending sign-ins, setup secrets (encrypted), upload tickets. Never audit history.';

create table app.rate_counters (
  key        text primary key check (length(key) between 1 and 300),
  count      integer not null check (count >= 0),
  expires_at timestamptz not null
);
create index rate_counters_expires_idx on app.rate_counters (expires_at);
comment on table app.rate_counters is 'Fixed-window rate-limit counters (D-36). A row past expires_at counts as zero.';

create table app.rate_events (
  bucket text not null check (length(bucket) between 1 and 300),
  at     timestamptz not null
);
create index rate_events_bucket_at_idx on app.rate_events (bucket, at);
comment on table app.rate_events is 'Sliding-window events for the one-time-code limits (D-36), one row per code sent.';

create table app.presence_devices (
  user_id    uuid not null references app.users (id),
  session_id uuid not null,
  expires_at timestamptz not null,
  primary key (user_id, session_id)
);
create index presence_devices_expires_idx on app.presence_devices (expires_at);
comment on table app.presence_devices is
  'Signed-in devices that sent a heartbeat in the last 60 seconds (P-18, D-36). A user is online while one is unexpired.';

create table app.maintenance_runs (
  name        text primary key check (length(name) between 1 and 100),
  last_run_at timestamptz not null
);
comment on table app.maintenance_runs is 'When each hourly housekeeping task last ran (D-36).';

grant select, insert, update, delete on app.ephemeral, app.rate_counters, app.rate_events, app.presence_devices to bedo_runtime;
grant select, insert, update on app.maintenance_runs to bedo_runtime;
