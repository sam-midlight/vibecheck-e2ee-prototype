-- ============================================================================
-- 0023_calls.sql — E2EE video call schema + RPCs.
--
-- Introduces the call-scoped analogue of the room-key machinery. A "call" is
-- an ephemeral subset of a room's members meeting over a LiveKit SFU with
-- SFrame-level E2EE. Frame keys are 32-byte symmetric keys (CallKey) wrapped
-- per-device via crypto_box_seal to each participant's X25519 pub — exactly
-- the same primitive used for room keys in `room_members.wrapped_room_key`.
--
-- Three tables:
--   calls                — one row per call, tracks current_generation
--   call_members         — one row per (call, device); heartbeats via last_seen_at
--   call_key_envelopes   — per-(call, generation, target_device) sealed CallKey
--
-- Six RPCs:
--   start_call           — initiator opens a call with gen=1 envelopes
--   join_call            — new participant announces presence
--   leave_call           — graceful leave (marks left_at)
--   rotate_call_key      — elected rotator bumps generation and re-wraps
--   heartbeat_call       — keepalive; drives the 30s reconnection-grace window
--   end_call             — any member ends the call
--
-- Race resolution: rotate_call_key enforces p_new_gen = current_gen + 1.
-- Concurrent rotators hit a serialization failure and the loser reads the
-- new gen via the `calls` postgres-changes subscription. No leader lease.
--
-- See `docs/video-call-design.md` for the full design.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. calls — one row per call session.
-- ---------------------------------------------------------------------------
create table calls (
  id                    uuid primary key,            -- client-supplied UUIDv7 (signature-bound)
  room_id               uuid not null references rooms(id) on delete cascade,
  initiator_user_id     uuid not null references auth.users(id),
  initiator_device_id   uuid not null references devices(id),
  started_at            timestamptz not null default now(),
  ended_at              timestamptz,                 -- null = active
  current_generation    int  not null default 1
);

create index calls_room_active_idx on calls (room_id) where ended_at is null;

comment on table calls is
  'E2EE video call sessions scoped to a room. current_generation bumps on every membership change.';
comment on column calls.id is
  'Client-supplied UUIDv7. Caller pre-generates so the initiator can sign envelopes before server insert.';

alter table calls enable row level security;

create policy calls_room_member_read on calls
  for select to authenticated using (
    room_id in (select my_room_ids())
  );

-- No direct client INSERT/UPDATE/DELETE — all mutations flow through RPCs.
-- (Default: RLS denies by omission.)

-- ---------------------------------------------------------------------------
-- 2. call_members — one row per (call, device) participation.
-- ---------------------------------------------------------------------------
create table call_members (
  call_id       uuid not null references calls(id) on delete cascade,
  device_id     uuid not null references devices(id),
  user_id       uuid not null references auth.users(id),
  joined_at     timestamptz not null default now(),
  left_at       timestamptz,                          -- null = still in the call
  last_seen_at  timestamptz not null default now(),   -- heartbeat; drives §6.5 grace
  primary key (call_id, device_id)
);

create index call_members_active_idx on call_members (call_id) where left_at is null;
create index call_members_user_idx on call_members (user_id);

comment on table call_members is
  'Per-device membership of a call. left_at nullable (null = in-call). last_seen_at drives 30s reconnection grace.';

alter table call_members enable row level security;

-- Room members can see who is in calls in their rooms (needed for rotator
-- election which needs to enumerate active participants).
create policy call_members_room_member_read on call_members
  for select to authenticated using (
    call_id in (select id from calls where room_id in (select my_room_ids()))
  );

-- ---------------------------------------------------------------------------
-- 3. call_key_envelopes — sealed CallKey per (call, generation, target_device).
-- ---------------------------------------------------------------------------
create table call_key_envelopes (
  call_id           uuid not null references calls(id) on delete cascade,
  generation        int  not null,
  target_device_id  uuid not null references devices(id),
  sender_device_id  uuid not null references devices(id),
  ciphertext        text not null,   -- b64: crypto_box_seal(CallKey, target.x25519_pub)
  signature         text not null,   -- b64: ed25519_sign(call_id || gen || target_device_id || ciphertext)
  created_at        timestamptz not null default now(),
  primary key (call_id, generation, target_device_id)
);

comment on table call_key_envelopes is
  'Per-device sealed CallKey wraps. Same primitive as room_members.wrapped_room_key but call-scoped.';
comment on column call_key_envelopes.signature is
  'ed25519 signature by sender_device over (call_id || generation || target_device_id || ciphertext). '
  'Client verifies on read; server only checks sender_device belongs to caller at insert time.';

alter table call_key_envelopes enable row level security;

-- Only the owner of the target device can read the envelope addressed to it.
-- Sender_device is public because a peer may need to verify who signed.
create policy call_key_envelopes_target_read on call_key_envelopes
  for select to authenticated using (
    target_device_id in (select id from devices where user_id = auth.uid())
  );

-- ---------------------------------------------------------------------------
-- 4. Helpers.
-- ---------------------------------------------------------------------------

-- Is this device an active call member (joined, not yet left)?
create or replace function is_active_call_member(
  _call_id uuid,
  _device_id uuid
) returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from call_members
    where call_id = _call_id
      and device_id = _device_id
      and left_at is null
  );
$$;

revoke all on function is_active_call_member(uuid, uuid) from public;
grant execute on function is_active_call_member(uuid, uuid) to authenticated;

-- Assert caller owns the named device and it's not revoked. Returns user_id.
-- Used by every RPC to bind caller identity to a specific device.
create or replace function assert_caller_owns_device(_device_id uuid)
returns uuid
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_user_id uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;
  select user_id into v_user_id
    from devices
    where id = _device_id
      and user_id = auth.uid()
      and revoked_at_ms is null;
  if v_user_id is null then
    raise exception 'device % is not an active device owned by the caller', _device_id
      using errcode = 'insufficient_privilege';
  end if;
  return v_user_id;
end;
$$;

revoke all on function assert_caller_owns_device(uuid) from public;
grant execute on function assert_caller_owns_device(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. start_call(p_call_id, p_room_id, p_signer_device_id, p_envelopes)
--
-- Called by the initiator. Creates the call, inserts call_members rows for
-- every envelope target (so every target device has a seat the moment the
-- call exists), and inserts all gen=1 envelopes atomically.
--
-- p_envelopes shape: [
--   { target_device_id, target_user_id, ciphertext, signature }, ...
-- ]
-- The initiator's own envelope is included (self-wrap).
-- ---------------------------------------------------------------------------
create or replace function start_call(
  p_call_id uuid,
  p_room_id uuid,
  p_signer_device_id uuid,
  p_envelopes jsonb
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller uuid := auth.uid();
  v_env jsonb;
  v_target_device uuid;
  v_target_user uuid;
  v_ciphertext text;
  v_signature text;
begin
  perform assert_caller_owns_device(p_signer_device_id);

  if not is_room_member_at(p_room_id, v_caller, room_current_generation(p_room_id)) then
    raise exception 'caller is not a current member of room %', p_room_id
      using errcode = 'insufficient_privilege';
  end if;

  insert into calls (id, room_id, initiator_user_id, initiator_device_id)
  values (p_call_id, p_room_id, v_caller, p_signer_device_id);

  for v_env in select * from jsonb_array_elements(coalesce(p_envelopes, '[]'::jsonb))
  loop
    v_target_device := (v_env->>'target_device_id')::uuid;
    v_target_user   := (v_env->>'target_user_id')::uuid;
    v_ciphertext    := v_env->>'ciphertext';
    v_signature     := v_env->>'signature';
    if v_target_device is null or v_target_user is null
       or v_ciphertext is null or v_signature is null then
      raise exception 'malformed envelope' using errcode = 'check_violation';
    end if;

    insert into call_members (call_id, device_id, user_id)
    values (p_call_id, v_target_device, v_target_user)
    on conflict (call_id, device_id) do nothing;

    insert into call_key_envelopes
      (call_id, generation, target_device_id, sender_device_id, ciphertext, signature)
    values
      (p_call_id, 1, v_target_device, p_signer_device_id, v_ciphertext, v_signature);
  end loop;
end;
$$;

revoke all on function start_call(uuid, uuid, uuid, jsonb) from public;
grant execute on function start_call(uuid, uuid, uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. join_call(p_call_id, p_device_id)
--
-- New participant announces presence. Inserts call_members row; does NOT
-- create an envelope (the rotator is responsible for wrapping). Returns the
-- current generation so the client knows to wait for gen+1 rotation.
-- ---------------------------------------------------------------------------
create or replace function join_call(
  p_call_id uuid,
  p_device_id uuid
) returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller uuid;
  v_room uuid;
  v_current_gen int;
  v_ended timestamptz;
begin
  v_caller := assert_caller_owns_device(p_device_id);

  select room_id, current_generation, ended_at
    into v_room, v_current_gen, v_ended
    from calls where id = p_call_id;

  if v_room is null then
    raise exception 'call not found' using errcode = 'no_data_found';
  end if;
  if v_ended is not null then
    raise exception 'call has ended' using errcode = 'object_not_in_prerequisite_state';
  end if;
  if not is_room_member_at(v_room, v_caller, room_current_generation(v_room)) then
    raise exception 'caller is not a current member of the call''s room'
      using errcode = 'insufficient_privilege';
  end if;

  insert into call_members (call_id, device_id, user_id)
  values (p_call_id, p_device_id, v_caller)
  on conflict (call_id, device_id) do update
    set left_at = null,
        last_seen_at = now();

  return v_current_gen;
end;
$$;

revoke all on function join_call(uuid, uuid) from public;
grant execute on function join_call(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. leave_call(p_call_id, p_device_id)
--
-- Graceful leave. Marks left_at for the caller's device. Does NOT bump
-- generation — the elected rotator handles that via rotate_call_key.
-- ---------------------------------------------------------------------------
create or replace function leave_call(
  p_call_id uuid,
  p_device_id uuid
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform assert_caller_owns_device(p_device_id);

  update call_members
     set left_at = now()
   where call_id = p_call_id
     and device_id = p_device_id
     and left_at is null;
end;
$$;

revoke all on function leave_call(uuid, uuid) from public;
grant execute on function leave_call(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 8. rotate_call_key(p_call_id, p_signer_device_id, p_old_gen, p_new_gen,
--                    p_envelopes)
--
-- Elected rotator bumps the generation and replaces envelopes for the new
-- gen. p_new_gen must equal p_old_gen + 1; concurrent rotators lose the
-- generation check and the loser simply re-reads state.
--
-- p_envelopes must cover every active call member (including the rotator).
-- Members omitted from the envelope set cannot decrypt post-rotation — this
-- is the leave / revoke eviction mechanism.
-- ---------------------------------------------------------------------------
create or replace function rotate_call_key(
  p_call_id uuid,
  p_signer_device_id uuid,
  p_old_gen int,
  p_new_gen int,
  p_envelopes jsonb
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller uuid;
  v_current_gen int;
  v_ended timestamptz;
  v_env jsonb;
  v_target_device uuid;
  v_target_user uuid;
  v_ciphertext text;
  v_signature text;
begin
  v_caller := assert_caller_owns_device(p_signer_device_id);

  -- Row-lock the call so concurrent rotators serialize here.
  select current_generation, ended_at
    into v_current_gen, v_ended
    from calls where id = p_call_id for update;

  if v_current_gen is null then
    raise exception 'call not found' using errcode = 'no_data_found';
  end if;
  if v_ended is not null then
    raise exception 'call has ended' using errcode = 'object_not_in_prerequisite_state';
  end if;
  if not is_active_call_member(p_call_id, p_signer_device_id) then
    raise exception 'rotator device is not an active call member'
      using errcode = 'insufficient_privilege';
  end if;
  if v_current_gen is distinct from p_old_gen then
    raise exception 'stale generation (expected %, have %)', p_old_gen, v_current_gen
      using errcode = 'serialization_failure';
  end if;
  if p_new_gen <> p_old_gen + 1 then
    raise exception 'new generation must be old + 1 (got old=%, new=%)', p_old_gen, p_new_gen
      using errcode = 'check_violation';
  end if;

  for v_env in select * from jsonb_array_elements(coalesce(p_envelopes, '[]'::jsonb))
  loop
    v_target_device := (v_env->>'target_device_id')::uuid;
    v_target_user   := (v_env->>'target_user_id')::uuid;
    v_ciphertext    := v_env->>'ciphertext';
    v_signature     := v_env->>'signature';
    if v_target_device is null or v_target_user is null
       or v_ciphertext is null or v_signature is null then
      raise exception 'malformed envelope' using errcode = 'check_violation';
    end if;

    -- Target must be a current call member (joined, not left). Omitting an
    -- evictee from the envelope set is how revoke/leave actually evicts.
    insert into call_members (call_id, device_id, user_id)
    values (p_call_id, v_target_device, v_target_user)
    on conflict (call_id, device_id) do update
      set left_at = null,
          last_seen_at = now();

    insert into call_key_envelopes
      (call_id, generation, target_device_id, sender_device_id, ciphertext, signature)
    values
      (p_call_id, p_new_gen, v_target_device, p_signer_device_id, v_ciphertext, v_signature);
  end loop;

  update calls
     set current_generation = p_new_gen
   where id = p_call_id
     and current_generation = p_old_gen;

  if not found then
    raise exception 'concurrent generation update'
      using errcode = 'serialization_failure';
  end if;
end;
$$;

revoke all on function rotate_call_key(uuid, uuid, int, int, jsonb) from public;
grant execute on function rotate_call_key(uuid, uuid, int, int, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 9. heartbeat_call(p_call_id, p_device_id)
--
-- Keepalive. Clients call every ~10s. Rotator election (client-side) treats
-- a member as "gone" once last_seen_at is >30s stale AND realtime presence
-- is down — the 30s grace window from §6.5.
-- ---------------------------------------------------------------------------
create or replace function heartbeat_call(
  p_call_id uuid,
  p_device_id uuid
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform assert_caller_owns_device(p_device_id);

  update call_members
     set last_seen_at = now()
   where call_id = p_call_id
     and device_id = p_device_id
     and left_at is null;
end;
$$;

revoke all on function heartbeat_call(uuid, uuid) from public;
grant execute on function heartbeat_call(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 10. end_call(p_call_id)
--
-- Any active call member can end the call. Marks ended_at; ON DELETE
-- CASCADE on envelopes fires when rows are eventually purged. For MVP we
-- retain the calls row for history (see port-to-v2 retention note).
-- ---------------------------------------------------------------------------
create or replace function end_call(p_call_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller uuid := auth.uid();
begin
  if v_caller is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  if not exists (
    select 1 from call_members
    where call_id = p_call_id
      and user_id = v_caller
      and left_at is null
  ) then
    raise exception 'caller is not an active call member'
      using errcode = 'insufficient_privilege';
  end if;

  update calls set ended_at = now()
   where id = p_call_id and ended_at is null;

  update call_members set left_at = now()
   where call_id = p_call_id and left_at is null;
end;
$$;

revoke all on function end_call(uuid) from public;
grant execute on function end_call(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 11. Realtime publication.
--
-- `calls` is published so clients subscribed to a room see INSERTs
-- (call_started), UPDATEs on current_generation (key_rotated), and UPDATEs
-- on ended_at (call_ended). RLS scopes visibility to room members.
--
-- call_members and call_key_envelopes are NOT published — they're too
-- chatty per rotation. Clients fetch envelopes lazily on the generation-
-- bump signal from the calls row.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'calls'
    ) then
      execute 'alter publication supabase_realtime add table calls';
    end if;
  end if;
end $$;
