-- 0045_blobs_push_trigger.sql
--
-- When a new blob lands, dispatch a generic web-push to every member of
-- the room EXCEPT the sender. Uses pg_net to async-post to the
-- `send-push` edge function — returns immediately so the INSERT isn't
-- blocked.
--
-- Config (URL + shared secret) lives in a regular table, NOT in
-- `current_setting('app.*')`, because Supabase-managed projects don't
-- grant superuser / ALTER DATABASE rights to run
-- `alter database ... set app.xxx`. Instead, create this table once and
-- populate it per-environment:
--
--   create schema if not exists internal;
--   create table if not exists internal.push_config (
--     key   text primary key,
--     value text not null
--   );
--   insert into internal.push_config (key, value) values
--     ('send_push_url',
--      'https://<project-ref>.supabase.co/functions/v1/send-push'),
--     ('send_push_secret', '<same value as SEND_PUSH_SECRET on the edge fn>');
--
-- The function below is SECURITY DEFINER so it executes with the function
-- owner's privileges (typically postgres, which has USAGE on every schema
-- + SELECT on every table). If either config key is missing, the trigger
-- is a harmless no-op — local/dev environments stay usable without push
-- setup.

create extension if not exists pg_net;

-- Defensive grants: ensure the function owner can reach internal.push_config
-- even if the schema was created with restrictive defaults.
do $$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'internal') then
    execute 'grant usage on schema internal to postgres';
    if exists (
      select 1
      from information_schema.tables
      where table_schema = 'internal' and table_name = 'push_config'
    ) then
      execute 'grant select on internal.push_config to postgres';
    end if;
  end if;
end $$;

create or replace function public.notify_new_blob()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_url    text;
  v_secret text;
begin
  -- Skip silently if the internal schema / table isn't set up yet.
  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'internal' and table_name = 'push_config'
  ) then
    return new;
  end if;

  select value into v_url
    from internal.push_config
    where key = 'send_push_url';
  select value into v_secret
    from internal.push_config
    where key = 'send_push_secret';

  if v_url is null or length(v_url) = 0 then
    return new;
  end if;

  perform net.http_post(
    url := v_url,
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-edge-secret', coalesce(v_secret, '')
    ),
    body := jsonb_build_object(
      'room_id', new.room_id,
      'sender_id', new.sender_id,
      'blob_id', new.id
    )
  );
  return new;
end;
$$;

drop trigger if exists blobs_notify_push on blobs;

create trigger blobs_notify_push
  after insert on blobs
  for each row
  execute function public.notify_new_blob();
