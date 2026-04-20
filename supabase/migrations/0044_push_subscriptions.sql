-- 0044_push_subscriptions.sql
--
-- Web-push endpoint registry. Each device that grants notification
-- permission stores its Push API subscription (endpoint + p256dh +
-- auth). The send-push edge function reads this table when a new blob
-- arrives and dispatches a generic "something new in your room" ping to
-- every member except the sender.
--
-- Zero content leaves the client: the push payload is always a generic
-- title + roomId (used to route the click), never the encrypted blob.
--
-- RLS: only the subscription owner can read/insert/delete their own
-- rows. The edge function runs as service_role and bypasses RLS.

create table if not exists push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  endpoint    text not null unique,
  p256dh      text not null,
  auth        text not null,
  device_name text,
  created_at  timestamptz not null default now(),
  last_used   timestamptz
);

create index if not exists push_subscriptions_user_idx on push_subscriptions(user_id);

alter table push_subscriptions enable row level security;

create policy push_subscriptions_self_select on push_subscriptions
  for select to authenticated using (user_id = auth.uid());

create policy push_subscriptions_self_insert on push_subscriptions
  for insert to authenticated with check (user_id = auth.uid());

create policy push_subscriptions_self_delete on push_subscriptions
  for delete to authenticated using (user_id = auth.uid());
