-- ============================================================================
-- 0009_atomic_kick_and_rotate.sql
--
-- Fixes the kick-rotation flow on three axes that the audit flagged:
--
--   (1) Atomicity — replaces the client-orchestrated 6-step dance
--       (delete-evictee / fetch-keepers / rotate / re-wrap / bump-gen /
--       delete-last) with a single SECURITY DEFINER RPC. Partial failure
--       no longer leaves the room half-rotated.
--
--   (2) Tightens `room_members_read` to same-generation scope, so evicted
--       users cannot SELECT keepers' new-generation wraps from the rows
--       inserted during rotation, and so old-generation rows aren't
--       visible to holders of different generations.
--
--   (3) Removes `room_members` from the realtime publication — the client
--       never subscribes to it, and leaving it published leaked new-gen
--       inserts to any open subscription that happened to cover it.
--
-- Note: depends on helpers (is_room_member_at, my_room_ids) from
-- 0008_backport_live_helpers.sql.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Helper: generations the caller holds in a given room.
-- ---------------------------------------------------------------------------
create or replace function my_generations_for_room(_room_id uuid)
returns setof int
language sql
security definer
stable
set search_path = public
as $$
  select generation from room_members
  where room_id = _room_id and user_id = auth.uid();
$$;

revoke all on function my_generations_for_room(uuid) from public;
grant execute on function my_generations_for_room(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Tighten room_members_read: same-generation scope + own rows + admin.
--
-- Old policy let a viewer see every row for every generation of any room they
-- belonged to — meaning an evicted member who still had an old-gen row could
-- SELECT the NEW-generation wrapped keys during the rotation window. Not
-- decryptable without the viewer's private key, but it leaks metadata
-- (who-is-in, when rotation happened) and fails the principle of least
-- privilege.
-- ---------------------------------------------------------------------------
drop policy if exists room_members_read on room_members;
create policy room_members_read on room_members
  for select to authenticated using (
    user_id = auth.uid()
    or exists (
      select 1 from rooms r
      where r.id = room_members.room_id
        and r.created_by = auth.uid()
    )
    or generation in (select my_generations_for_room(room_members.room_id))
  );

-- ---------------------------------------------------------------------------
-- kick_and_rotate(room_id, evictees, old_gen, new_gen, wraps, name_ct, name_nonce)
--
-- Single transaction doing:
--   1. Authorize: caller is either (a) room creator (admin kick), or (b)
--      leaving themselves (evictees = [caller]).
--   2. Row-lock the `rooms` row and verify current_generation = old_gen
--      (rejects concurrent/duplicate rotations).
--   3. Delete non-self evictee rows across all generations.
--   4. Insert new-gen wrapped rows from the jsonb array.
--   5. Bump rooms.current_generation and set the new name ciphertext.
--   6. For self-leave: delete self last (we needed membership to bump gen).
--
-- p_wraps shape: [{"user_id":"<uuid>","wrapped_room_key":"<b64>"}, ...]
-- p_name_ct and p_name_nonce may be NULL (no name) or empty-string (clear name).
-- We pass them through verbatim. Callers preserve the existing behavior where
-- `null` means "no name set" and re-encrypted bytes replace prior values.
-- ---------------------------------------------------------------------------
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
begin
  if v_caller is null then
    raise exception 'authentication required'
      using errcode = 'insufficient_privilege';
  end if;

  -- Row-lock rooms so concurrent rotations serialize here.
  select created_by, current_generation
    into v_creator, v_current
    from rooms
    where id = p_room_id
    for update;

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
    raise exception 'new generation must be old + 1 (got old=%, new=%)', p_old_gen, p_new_gen
      using errcode = 'check_violation';
  end if;

  -- 1. Delete non-self evictees FIRST so their RLS view of new-gen rows
  --    and future blobs closes before anything new is written.
  if p_evictees is not null then
    delete from room_members
    where room_id = p_room_id
      and user_id = any(p_evictees)
      and user_id <> v_caller;
  end if;

  -- 2. Insert new-gen wraps.
  for v_wrap in select * from jsonb_array_elements(coalesce(p_wraps, '[]'::jsonb))
  loop
    v_wrap_user := (v_wrap->>'user_id')::uuid;
    v_wrap_key  := v_wrap->>'wrapped_room_key';
    if v_wrap_user is null or v_wrap_key is null then
      raise exception 'malformed wrap entry' using errcode = 'check_violation';
    end if;
    insert into room_members (room_id, user_id, generation, wrapped_room_key)
    values (p_room_id, v_wrap_user, p_new_gen, v_wrap_key);
  end loop;

  -- 3. Bump current_generation + update name atomically.
  update rooms
     set current_generation = p_new_gen,
         name_ciphertext    = p_name_ciphertext,
         name_nonce         = p_name_nonce
   where id = p_room_id
     and current_generation = p_old_gen;

  if not found then
    raise exception 'concurrent generation update'
      using errcode = 'serialization_failure';
  end if;

  -- 4. Self-leave: delete self last. RLS permits; we needed membership up to now.
  if v_is_self_leave then
    delete from room_members
    where room_id = p_room_id and user_id = v_caller;
  end if;
end;
$$;

revoke all on function kick_and_rotate(uuid, uuid[], int, int, jsonb, text, text) from public;
grant execute on function kick_and_rotate(uuid, uuid[], int, int, jsonb, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Drop room_members from the realtime publication. The client never
-- subscribes to it; leaving it in published is a metadata-leak surface.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'room_members'
    ) then
      execute 'alter publication supabase_realtime drop table room_members';
    end if;
  end if;
end $$;
