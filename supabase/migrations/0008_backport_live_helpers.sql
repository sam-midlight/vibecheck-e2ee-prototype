-- ============================================================================
-- 0008_backport_live_helpers.sql
--
-- Back-port of two migrations that were applied directly to the live DB but
-- never committed to the repo (see memory: project_live_db_drift.md). Bringing
-- them into the migration history so:
--   (1) fresh DBs (V2 port, local resets) get the helpers and the fixes that
--       build on them;
--   (2) later migrations can safely depend on `is_room_member_at`,
--       `my_room_ids`, and `room_current_generation`.
--
-- All statements are idempotent (`create or replace`, `drop policy if exists`)
-- so this is safe to re-apply against the live DB.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- From live: rooms_creator_can_read_own
--
-- Allow the room creator to SELECT their freshly-inserted row. Without this,
-- `INSERT ... RETURNING *` is blocked by RLS because the creator isn't yet in
-- `room_members` (chicken-and-egg). Merged with the recursion-break rewrite
-- below so the final policy is consistent.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- From live: fix_room_members_recursion
--
-- RLS policies that subquery `room_members` trigger their own RLS recursion.
-- Wrap the lookup in SECURITY DEFINER functions (RLS-bypassing, read-only,
-- parameterized) and reference them from policies.
-- ---------------------------------------------------------------------------

create or replace function is_room_member_at(
  _room_id uuid,
  _user_id uuid,
  _generation int default null
) returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from room_members
    where room_id = _room_id
      and user_id = _user_id
      and (_generation is null or generation = _generation)
  );
$$;

revoke all on function is_room_member_at(uuid, uuid, int) from public;
grant execute on function is_room_member_at(uuid, uuid, int) to authenticated;

create or replace function room_current_generation(_room_id uuid)
returns int
language sql
security definer
stable
set search_path = public
as $$
  select current_generation from rooms where id = _room_id;
$$;

revoke all on function room_current_generation(uuid) from public;
grant execute on function room_current_generation(uuid) to authenticated;

create or replace function my_room_ids() returns setof uuid
language sql
security definer
stable
set search_path = public
as $$
  select room_id from room_members where user_id = auth.uid();
$$;

revoke all on function my_room_ids() from public;
grant execute on function my_room_ids() to authenticated;

-- Rewrite recursive policies on room_members ---------------------------------

drop policy if exists room_members_read   on room_members;
drop policy if exists room_members_insert on room_members;
drop policy if exists room_members_delete on room_members;

create policy room_members_read on room_members
  for select to authenticated using (
    user_id = auth.uid()
    or room_id in (select my_room_ids())
  );

create policy room_members_insert on room_members
  for insert to authenticated with check (
    user_id = auth.uid()
    or is_room_member_at(room_id, auth.uid(), room_current_generation(room_id))
  );

create policy room_members_delete on room_members
  for delete to authenticated using (
    user_id = auth.uid()
    or is_room_member_at(room_id, auth.uid(), room_current_generation(room_id))
  );

-- Rewrite other policies that subquery room_members --------------------------

drop policy if exists rooms_member_read   on rooms;
drop policy if exists rooms_member_update on rooms;

create policy rooms_member_read on rooms
  for select to authenticated using (
    created_by = auth.uid()
    or id in (select my_room_ids())
  );

create policy rooms_member_update on rooms
  for update to authenticated using (
    is_room_member_at(id, auth.uid(), current_generation)
  );

drop policy if exists room_invites_read   on room_invites;
drop policy if exists room_invites_insert on room_invites;

create policy room_invites_read on room_invites
  for select to authenticated using (
    invited_user_id = auth.uid()
    or created_by = auth.uid()
    or is_room_member_at(room_id, auth.uid(), generation)
  );

create policy room_invites_insert on room_invites
  for insert to authenticated with check (
    created_by = auth.uid()
    and is_room_member_at(room_id, auth.uid(), generation)
  );

drop policy if exists blobs_member_read   on blobs;
drop policy if exists blobs_member_insert on blobs;

create policy blobs_member_read on blobs
  for select to authenticated using (
    room_id in (select my_room_ids())
  );

create policy blobs_member_insert on blobs
  for insert to authenticated with check (
    sender_id = auth.uid()
    and is_room_member_at(room_id, auth.uid(), generation)
  );

-- Re-apply the admin-only kick/insert narrowing from 0007. The recursion-break
-- above overwrote those narrowings; put them back so only the room creator
-- (not any current-gen member) can insert/delete rows for other users.
drop policy if exists room_members_delete on room_members;
create policy room_members_delete on room_members
  for delete to authenticated using (
    user_id = auth.uid()
    or exists (
      select 1 from rooms r
      where r.id = room_members.room_id
        and r.created_by = auth.uid()
    )
  );

drop policy if exists room_members_insert on room_members;
create policy room_members_insert on room_members
  for insert to authenticated with check (
    user_id = auth.uid()
    or exists (
      select 1 from rooms r
      where r.id = room_members.room_id
        and r.created_by = auth.uid()
    )
  );
