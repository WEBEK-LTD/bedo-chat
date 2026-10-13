-- Bedo Chat - site monitoring inside the Admin Dashboard (Phase 14.5).
--
-- The owner asked for monitoring without any outside service. Every minute the site's scheduled function (the one that
-- sends scheduled messages) calls the site through its public address; each call that gets through records a check here
-- (database time, and every few minutes the file storage). A gap between checks means the site could not be reached;
-- it becomes an incident when the checks come back, and Super Admins are told on WhatsApp. Checks are kept 30 days.
create table app.site_checks (
  id            bigint generated always as identity primary key,
  checked_at    timestamptz not null default now(),
  -- heartbeat: the minute check; manual: "Check now" in the dashboard.
  kind          text not null check (kind in ('heartbeat', 'manual')),
  ok            boolean not null,
  database_ms   real check (database_ms is null or database_ms >= 0),
  storage_ms    real check (storage_ms is null or storage_ms >= 0),
  storage_ok    boolean,
  server_region text check (server_region is null or server_region ~ '^[a-z0-9-]{1,32}$'),
  detail        text check (detail is null or length(detail) <= 300)
);
create index site_checks_checked_at_idx on app.site_checks (checked_at);
comment on table app.site_checks is
  'Site monitoring (Phase 14.5): one row per minute check that reached the site, and per manual check. Kept 30 days.';

create table app.site_incidents (
  id                 bigint generated always as identity primary key,
  -- outage: the site was not reached; storage: file storage failed; whatsapp: one-time codes were not delivered;
  -- database_slow: database steps far slower than usual.
  kind               text not null check (kind in ('outage', 'storage', 'whatsapp', 'database_slow')),
  started_at         timestamptz not null,
  ended_at           timestamptz,
  detail             text check (detail is null or length(detail) <= 300),
  alerted_at         timestamptz,
  recovery_alerted_at timestamptz,
  constraint site_incidents_order check (ended_at is null or ended_at >= started_at)
);
create index site_incidents_started_idx on app.site_incidents (started_at desc);
create unique index site_incidents_one_open on app.site_incidents (kind) where ended_at is null;
comment on table app.site_incidents is 'Site monitoring (Phase 14.5): problems found by the checks, with when Super Admins were told.';

create table app.monitoring_settings (
  id               boolean primary key default true check (id),
  whatsapp_alerts  boolean not null default true,
  updated_by       uuid references app.admin_accounts (id),
  updated_at       timestamptz
);
comment on table app.monitoring_settings is 'Site monitoring (Phase 14.5): whether Super Admins get WhatsApp alerts. One row.';
insert into app.monitoring_settings (id) values (true);
create trigger monitoring_settings_no_delete before delete on app.monitoring_settings
  for each row execute function app.forbid_mutation();
create trigger monitoring_settings_no_truncate before truncate on app.monitoring_settings
  for each statement execute function app.forbid_mutation();

grant select, insert, delete on app.site_checks to bedo_runtime;
grant select, insert on app.site_incidents to bedo_runtime;
grant update (ended_at, detail, alerted_at, recovery_alerted_at) on app.site_incidents to bedo_runtime;
grant delete on app.site_incidents to bedo_runtime;
grant select on app.monitoring_settings to bedo_runtime;
grant update (whatsapp_alerts, updated_by, updated_at) on app.monitoring_settings to bedo_runtime;
