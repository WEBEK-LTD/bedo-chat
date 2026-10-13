-- Bedo Chat - Phase 9: security hardening (D-43).
--
-- From the Phase 9 security review (docs/SECURITY-REVIEW-PHASE-9.md): a member an admin removed from a group or
-- channel cannot come back on their own (by invite link, join request or joining a public channel) until an admin
-- adds them again. The rest of the review is fixed in the API (no data changes).

create table app.chat_bans (
  conversation_id  uuid not null references app.conversations (id),
  user_id          uuid not null references app.users (id),
  banned_by        uuid not null references app.users (id),
  banned_at        timestamptz not null default now(),
  primary key (conversation_id, user_id)
);
comment on table app.chat_bans is
  'People an admin removed from a group or channel (Phase 9). Removed by an admin adding them again; the membership history keeps both.';

-- Insert on removal; delete when an admin adds the person again.
grant select, insert, delete on app.chat_bans to bedo_runtime;
