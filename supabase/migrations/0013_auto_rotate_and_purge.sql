-- ============================================================================
-- 0013_auto_rotate_and_purge.sql
--
-- Two related forward-secrecy improvements:
--
--   (1) `rooms.last_rotated_at` — tracks when the current_generation was last
--       bumped. Clients use this to suggest (and eventually auto-trigger) a
--       periodic rotation so a long-lived stable group doesn't keep using the
--       same symmetric key forever.
--
--   (2) `kick_and_rotate` now deletes `room_members` rows at
--       `generation < new_gen - 1` in the same transaction. We keep the
--       previous generation as a safety margin for messages that were
--       encrypted-and-sent just before rotation; everything older is dropped,
--       so a later DB compromise cannot resurrect historical room keys for
--       users who already rotated past them.
-- ============================================================================

alter table rooms
  add column if not exists last_rotated_at timestamptz not null default now();

-- Initialize legacy rows so time-since-last-rotate is well-defined.
update rooms set last_rotated_at = created_at where last_rotated_at is null;

drop function if exists kick_and_rotate(uuid, uuid[], int, int, jsonb, text, text);

create or replace function kick_and_rotate(
  p_room_id uuid,
  p_evictees uuid[],
  p_old_gen int,
  p_new_gen int,
  p_wraps jsonb,
  p_name_ciphertext text,
  p_name_nonce text
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller uuid := auth.uid();
  v_creator uuid;
  v_current int;
  v_is_self_leave bool;
  v_wrap jsonb;
  v_wrap_user uuid;
  v_wrap_key text;
  v_wrap_sig text;
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

  v_is_self_leave := (p_evictees is not null)
                  and (cardinality(p_evictees) = 1)
                  and (p_evictees[1] = v_caller);

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

  if p_evictees is not null then
    delete from room_members
    where room_id = p_room_id
      and user_id = any(p_evictees)
      and user_id <> v_caller;
  end if;

  for v_wrap in select * from jsonb_array_elements(coalesce(p_wraps, '[]'::jsonb))
  loop
    v_wrap_user := (v_wrap->>'user_id')::uuid;
    v_wrap_key  := v_wrap->>'wrapped_room_key';
    v_wrap_sig  := v_wrap->>'wrap_signature';
    if v_wrap_user is null or v_wrap_key is null then
      raise exception 'malformed wrap entry' using errcode = 'check_violation';
    end if;
    insert into room_members (room_id, user_id, generation, wrapped_room_key,
                              signer_user_id, wrap_signature)
    values (p_room_id, v_wrap_user, p_new_gen, v_wrap_key,
            v_caller, v_wrap_sig);
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

  -- Forward-secrecy purge: drop rows older than the previous generation.
  -- Previous generation is retained as a safety margin for in-flight blobs.
  delete from room_members
  where room_id = p_room_id
    and generation < p_new_gen - 1;

  if v_is_self_leave then
    delete from room_members
    where room_id = p_room_id and user_id = v_caller;
  end if;
end;
$$;

revoke all on function kick_and_rotate(uuid, uuid[], int, int, jsonb, text, text) from public;
grant execute on function kick_and_rotate(uuid, uuid[], int, int, jsonb, text, text) to authenticated;
