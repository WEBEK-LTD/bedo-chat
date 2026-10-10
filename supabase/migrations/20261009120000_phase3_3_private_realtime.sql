-- Bedo Chat - D-36: private realtime channels (Supabase Realtime Authorization).
--
-- Each signed-in device receives realtime signals on its own channel. The API gives the device a short-lived token
-- (a JWT signed with the project's JWT secret, role "authenticated") whose claim "bedo_topic" names that one channel.
-- This policy is the only permission on realtime.messages for devices: a device may RECEIVE broadcasts on the channel
-- its token names, and nothing else. There is no insert policy, so no device can send (or fake) a signal; there is no
-- presence policy, so devices cannot see who else listens. The API sends with the service key, which bypasses
-- policies. With "Allow public access" turned off in the Realtime settings, every channel needs such a token.
--
-- How Supabase checks it: when a device joins a channel, Realtime sets realtime.topic (the channel), the device's JWT
-- claims and its role, then checks whether a broadcast row for that channel would be visible under these policies.
--
-- realtime.messages exists only on Supabase; on any other Postgres (local development, tests) nothing is created.

do $private_realtime$
begin
  if to_regclass('realtime.messages') is null or to_regprocedure('realtime.topic()') is null then
    raise notice 'realtime.messages not found (not a Supabase database): no realtime policy created';
    return;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    raise exception 'Stopped: the role "authenticated" does not exist';
  end if;

  execute 'drop policy if exists bedo_device_receives_own_channel on realtime.messages';
  execute $policy$
    create policy bedo_device_receives_own_channel on realtime.messages
      as permissive
      for select
      to authenticated
      using (
        realtime.messages.extension = 'broadcast'
        and realtime.messages.topic = (select realtime.topic())
        and (select realtime.topic()) = (
          select nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'bedo_topic'
        )
      )
  $policy$;
end
$private_realtime$;
