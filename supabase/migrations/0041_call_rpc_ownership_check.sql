-- ============================================================================
-- 0041_call_rpc_ownership_check.sql
--
-- Closes the ghost call-member hole in start_call + rotate_call_key.
--
-- ROOT CAUSE: Both RPCs accepted arbitrary (target_user_id, target_device_id)
-- tuples in p_envelopes and seated them in call_members via ON CONFLICT
-- without verifying that:
--   (a) device_id belongs to target_user_id (same class of bug 0040 fixed
--       for kick_and_rotate);
--   (b) target_user_id is a current-generation member of the call's room.
--
-- CONSEQUENCE: A malicious rotator (any current-gen call participant, by
-- the client-side rotator-election scheme) could include an attacker-
-- controlled device owned by a non-room-member in p_envelopes. The RPC
-- seats them in call_members. The livekit-token edge function gates JWT
-- minting on (caller owns unrevoked device + call_members row exists);
-- the attacker's user satisfies both, receives a valid LiveKit JWT, and
-- joins the SFU. They decrypt media via the CallKey sealed to their own
-- x25519 pub in call_key_envelopes.
--
-- FIX: inside each envelope loop, verify ownership + current-gen
-- room-member status before INSERT. Defense-in-depth helper
-- `is_current_gen_member_of_call` is exposed for the livekit-token edge
-- function so the JWT-mint gate can independently verify room membership
-- — catches any legacy call_members row (pre-0041) or race that seated a
-- now-non-member.
--
-- Rotation-during-kick note: if a target user is evicted between
-- envelope construction and RPC execution, the room-member check fails
-- and the RPC aborts. The client should rebuild envelopes from fresh
-- state and retry. DO NOT swallow this exception — that would re-open
-- the hole for any kicked-then-re-added race.
-- ============================================================================

drop function if exists start_call(uuid, uuid, uuid, jsonb);

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

    -- Ownership: device belongs to stated user and is not revoked.
    if not exists (
      select 1 from devices
      where id = v_target_device
        and user_id = v_target_user
        and revoked_at_ms is null
    ) then
      raise exception
        'envelope: device % does not belong to user % or is revoked',
        v_target_device, v_target_user
        using errcode = 'check_violation';
    end if;

    -- Room-membership: target must be current-gen member of this call's room.
    if not is_room_member_at(p_room_id, v_target_user, room_current_generation(p_room_id)) then
      raise exception
        'envelope: user % is not a current-gen member of room %',
        v_target_user, p_room_id
        using errcode = 'insufficient_privilege';
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

drop function if exists rotate_call_key(uuid, uuid, int, int, jsonb);

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
  v_room_id uuid;
  v_current_gen int;
  v_ended timestamptz;
  v_env jsonb;
  v_target_device uuid;
  v_target_user uuid;
  v_ciphertext text;
  v_signature text;
begin
  v_caller := assert_caller_owns_device(p_signer_device_id);

  -- Row-lock the call so concurrent rotators serialize here. Also fetches
  -- room_id so the envelope loop can verify each target is a current-gen
  -- member of THIS call's room.
  select room_id, current_generation, ended_at
    into v_room_id, v_current_gen, v_ended
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

    -- Ownership: device belongs to stated user and is not revoked.
    if not exists (
      select 1 from devices
      where id = v_target_device
        and user_id = v_target_user
        and revoked_at_ms is null
    ) then
      raise exception
        'envelope: device % does not belong to user % or is revoked',
        v_target_device, v_target_user
        using errcode = 'check_violation';
    end if;

    -- Room-membership: target must be current-gen member of this call's room.
    -- If a target was kicked from the room between envelope-build and RPC
    -- execution, this aborts the whole RPC; client must rebuild and retry.
    if not is_room_member_at(v_room_id, v_target_user, room_current_generation(v_room_id)) then
      raise exception
        'envelope: user % is not a current-gen member of room %',
        v_target_user, v_room_id
        using errcode = 'insufficient_privilege';
    end if;

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
-- Helper for the livekit-token edge function: verifies the caller is a
-- current-generation member of the call's room. Defense-in-depth on top of
-- the RPC ownership checks above — catches any legacy call_members row
-- (pre-0041) or cross-RPC race that seated a now-non-member.
-- ---------------------------------------------------------------------------
create or replace function is_current_gen_member_of_call(
  p_call_id uuid,
  p_user_id uuid
) returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from calls c
    join rooms r on r.id = c.room_id
    join room_members rm
      on rm.room_id = c.room_id
     and rm.user_id = p_user_id
     and rm.generation = r.current_generation
    where c.id = p_call_id
  );
$$;

revoke all on function is_current_gen_member_of_call(uuid, uuid) from public;
grant execute on function is_current_gen_member_of_call(uuid, uuid) to authenticated;
