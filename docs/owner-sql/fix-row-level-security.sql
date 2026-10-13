-- Bedo Chat: turns off Supabase's automatic row level security on Bedo Chat's own tables. Run as postgres in the
-- Supabase SQL Editor. Safe to run again at any time; it changes nothing else.
--
-- Why: newer Supabase projects switch row level security on for every new table. Bedo Chat's tables (schemas app,
-- audit and app_meta) have no policies, because no Supabase API role can reach them at all; with row level security
-- on and no policy, the site's own database login (bedo_api) can no longer read or write them, and every request
-- fails ("new row violates row-level security policy for table ...").
--
-- It first checks that the anon, authenticated and public roles still have no access to those schemas (so turning row
-- level security off exposes nothing), then turns it off on every Bedo Chat table where it is on, and shows the result.
-- realtime.messages is not touched: its row level security and the device policy stay as they are.
do $fix_rls$
declare
  item   record;
  fixed  integer := 0;
begin
  if current_user <> 'postgres' then
    raise exception 'Stopped: run this as postgres, not %', current_user;
  end if;
  for item in
    select r.rolname, s.schema_name
    from (values ('anon'), ('authenticated'), ('public')) as r (rolname)
    cross join (values ('app'), ('audit'), ('app_meta')) as s (schema_name)
    where exists (select 1 from pg_namespace where nspname = s.schema_name)
      and (r.rolname = 'public' or exists (select 1 from pg_roles where rolname = r.rolname))
  loop
    if (item.rolname = 'public' and exists (
          select 1 from pg_namespace n, aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a
          where n.nspname = item.schema_name and a.grantee = 0 and a.privilege_type = 'USAGE'))
       or (item.rolname <> 'public' and has_schema_privilege(item.rolname, item.schema_name, 'usage')) then
      raise exception 'Stopped: the role % can use the schema %, so row level security was left on (nothing was changed)', item.rolname, item.schema_name;
    end if;
  end loop;

  for item in
    select n.nspname, c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('app', 'audit', 'app_meta')
      and c.relkind in ('r', 'p')
      and (c.relrowsecurity or c.relforcerowsecurity)
    order by 1, 2
  loop
    execute format('alter table %I.%I no force row level security', item.nspname, item.relname);
    execute format('alter table %I.%I disable row level security', item.nspname, item.relname);
    fixed := fixed + 1;
  end loop;
  raise notice 'Row level security turned off on % Bedo Chat tables', fixed;
end
$fix_rls$;

select 'Bedo Chat tables with row level security on (should be none)' as "check",
       case when not exists (
         select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname in ('app', 'audit', 'app_meta') and c.relkind in ('r', 'p') and c.relrowsecurity)
       then 'ok'
       else 'NOT OK: ' || (select string_agg(n.nspname || '.' || c.relname, ', ') from pg_class c join pg_namespace n on n.oid = c.relnamespace
                           where n.nspname in ('app', 'audit', 'app_meta') and c.relkind in ('r', 'p') and c.relrowsecurity) end as result
union all
select 'row level security on realtime.messages (should stay on)',
       case when to_regclass('realtime.messages') is null then 'not in this database'
            when (select relrowsecurity from pg_class where oid = to_regclass('realtime.messages')) then 'ok' else 'NOT OK' end;
