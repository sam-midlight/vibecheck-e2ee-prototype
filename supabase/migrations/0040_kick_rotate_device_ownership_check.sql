-- ============================================================================
-- 0040_kick_rotate_device_ownership_check.sql
--
-- Closes a ghost-membership integrity gap in kick_and_rotate.
--
-- ROOT CAUSE: The RPC validated that p_signer_device_id is owned by the
-- caller but placed no ownership constraint on the (user_id, device_id)
-- pairs in the p_wraps array. A malicious room creator could call the RPC
-- with wrap entries where device_id belongs to an attacker-controlled
-- device while user_id names a victim user. This caused:
--
--   1. my_generations_for_room (user-based) to return the new generation
--      for the victim → victim passes the RLS generation arm and can
--      SELECT all new-gen room_members rows (other members' wrapped key
--      ciphertext) and all new blobs — post-effective-exclusion metadata
--      access they should not have.
--
--   2. A second room-key copy silently routed to the attacker's device
--      under the victim's user_id label in room_members, while the
--      victim's actual devices find no row and cannot decrypt anything.
--
--   3. The wrap_signature for the mismatched row is cryptographically
--      valid (signed by the creator's real device over the stated fields),
--      so client-side signature verification passes and gives the victim
--      no clear tamper signal — only a decryption failure when they try
--      to open the sealed box.
--
-- FIX: inside the wrap loop, verify that device_id exists in `devices`,
-- is owned by the stated user_id, and is not revoked before inserting.
-- ============================================================================

drop function if exists kick_and_rotate(uuid, uuid[], int, int, jsonb, uuid, text, text);

create or replace function kick_and_rotate(
  p_room_id          uuid,
  p_evictee_user_ids uuid[],
  p_old_gen          int,
  p_new_gen          int,
  p_wraps            jsonb,   -- [{user_id, device_id, wrapped_room_key, wrap_signature}]
  p_signer_device_id uuid,
  p_name_ciphertext  text,
  p_name_nonce       text
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller        uuid := auth.uid();
  v_creator       uuid;
  v_current       int;
  v_is_self_leave bool;
  v_wrap          jsonb;
  v_wrap_user     uuid;
  v_wrap_device   uuid;
  v_wrap_key      text;
  v_wrap_sig      text;
begin
  if v_caller is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  select created_by, current_generation
    into v_creator, v_current
    from rooms where id = p_room_id for update;

  if v_creator is null then
    raise exception 'room not found' using errcode = 'no_data_found';
  end if;

  if not exists (
    select 1 from devices
    where id = p_signer_device_id
      and user_id = v_caller
      and revoked_at_ms is null
  ) then
    raise exception 'signer_device_id must be an active device owned by the caller'
      using errcode = 'insufficient_privilege';
  end if;

  v_is_self_leave := (p_evictee_user_ids is not null)
                  and (cardinality(p_evictee_user_ids) = 1)
                  and (p_evictee_user_ids[1] = v_caller);

  if v_caller <> v_creator and not v_is_self_leave then
    raise exception 'only the room creator may kick other members'
      using errcode = 'insufficient_privilege';
  end if;

  if v_current is distinct from p_old_gen then
    raise exception 'stale generation (expected %, have %)', p_old_gen, v_current
      using errcode = 'serialization_failure';
  end if;

  if p_new_gen <> p_old_gen + 1 then
    raise exception 'new generation must be old + 1'
      using errcode = 'check_violation';
  end if;

  if p_evictee_user_ids is not null then
    delete from room_members
    where room_id = p_room_id
      and user_id = any(p_evictee_user_ids)
      and user_id <> v_caller;
  end if;

  for v_wrap in select * from jsonb_array_elements(coalesce(p_wraps, '[]'::jsonb))
  loop
    v_wrap_user   := (v_wrap->>'user_id')::uuid;
    v_wrap_device := (v_wrap->>'device_id')::uuid;
    v_wrap_key    := v_wrap->>'wrapped_room_key';
    v_wrap_sig    := v_wrap->>'wrap_signature';

    if v_wrap_user is null or v_wrap_device is null
       or v_wrap_key is null or v_wrap_sig is null then
      raise exception 'malformed wrap entry' using errcode = 'check_violation';
    end if;

    -- Verify the device belongs to the stated user and is not revoked.
    -- Prevents ghost-membership rows where user_id ≠ devices.user_id:
    -- such rows corrupt my_generations_for_room (which is user-keyed) and
    -- can silently route a room-key copy to an attacker-controlled device.
    if not exists (
      select 1 from devices
      where id            = v_wrap_device
        and user_id       = v_wrap_user
        and revoked_at_ms is null
    ) then
      raise exception
        'wrap entry: device % does not belong to user % or is revoked',
        v_wrap_device, v_wrap_user
        using errcode = 'check_violation';
    end if;

    insert into room_members (room_id, user_id, device_id, generation,
                              wrapped_room_key, signer_device_id, wrap_signature)
    values (p_room_id, v_wrap_user, v_wrap_device, p_new_gen,
            v_wrap_key, p_signer_device_id, v_wrap_sig);
  end loop;

  update rooms
     set current_generation = p_new_gen,
         name_ciphertext    = p_name_ciphertext,
         name_nonce         = p_name_nonce,
         last_rotated_at    = now()
   where id = p_room_id and current_generation = p_old_gen;

  if not found then
    raise exception 'concurrent generation update'
      using errcode = 'serialization_failure';
  end if;

  -- Forward-secrecy purge: retain current generation + 9 prior (10 total).
  delete from room_members
  where room_id = p_room_id
    and generation < p_new_gen - 9;

  -- Stale invite purge: invites from before the new generation wrap a
  -- superseded key; recipients must be re-invited.
  delete from room_invites
  where room_id = p_room_id
    and generation < p_new_gen;

  if v_is_self_leave then
    delete from room_members
    where room_id = p_room_id and user_id = v_caller;
  end if;
end;
$$;

revoke all on function kick_and_rotate(uuid, uuid[], int, int, jsonb, uuid, text, text) from public;
grant execute on function kick_and_rotate(uuid, uuid[], int, int, jsonb, uuid, text, text) to authenticated;
