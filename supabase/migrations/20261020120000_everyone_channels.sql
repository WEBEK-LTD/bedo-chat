-- Bedo Chat - channels for everyone in the academy (Phase 15.1, D-52).
--
-- The owner asked on 2026-10-10 that a channel made from the Admin Dashboard reaches every student, including students
-- who create their account later, without an admin adding anyone. Groups are not affected. A channel with this switch
-- on gets every active account as a subscriber; a new account joins it when it is created; and the site's minute call
-- adds anyone still missing (an account that was suspended and is active again, say). Someone who left the channel
-- or was removed from it is not added back. The switch is on by default for channels made in the Admin Dashboard and
-- an admin can turn it off per channel; students' own channels never have it.
alter table app.group_settings add column academy_wide boolean not null default false;
comment on column app.group_settings.academy_wide is
  'Channels only (D-52): every academy account is a subscriber, new accounts join on creation; leavers and removed people stay out.';

-- The channels already made from the Admin Dashboard (recorded as channel.created by an admin) become academy-wide;
-- the site's minute call then adds the subscribers, with the usual membership history.
update app.group_settings s
set academy_wide = true
from app.conversations c
where c.id = s.conversation_id
  and c.type = 'channel'
  and c.deleted_at is null
  and exists (
    select 1 from app.audit_log a
    where a.actor_type = 'admin' and a.action = 'channel.created' and a.target_type = 'conversation' and a.target_id = c.id::text
  );
