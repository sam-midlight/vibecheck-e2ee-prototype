-- ============================================================================
-- 0007_pair_cap_and_admin_delete.sql — pair size cap + admin-only kick
--
-- Two product rules being enforced at the DB level:
--
--   1. Rooms with `kind = 'pair'` are strictly 2 people. You cannot invite a
--      3rd person, and you cannot add a 3rd member row. Enforced by BEFORE
--      INSERT triggers on `room_members` and `room_invites` that count the
--      distinct user_ids across both tables for the given room.
--
--   2. Only the room creator may forcibly remove *other* members' rows from
--      `room_members`. Everyone can still delete their OWN rows (a "leave
--      the room" gesture). The old policy let any current-gen member delete
--      anyone's row, which was too loose — non-admins could kick each other
--      out. The existing `rooms_creator_delete` policy already handles
--      whole-room teardown by the creator; this narrows the per-row delete
--      path to match.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Pair-room member cap (2 distinct user_ids, counted across members + invites).
--
-- Same trigger function fires on either table; we branch on TG_TABLE_NAME so
-- the "is this the first row for this user?" check uses the right column.
-- Non-pair rooms short-circuit and allow the insert without counting.
-- ---------------------------------------------------------------------------
create or replace function enforce_pair_room_cap()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  room_kind text;
  distinct_users int;
  incoming_user uuid;
  is_existing bool;
begin
  select kind into room_kind from rooms where id = new.room_id;
  if room_kind is distinct from 'pair' then
    return new;
  end if;

  if tg_table_name = 'room_members' then
    incoming_user := new.user_id;
  elsif tg_table_name = 'room_invites' then
    incoming_user := new.invited_user_id;
  else
    return new;
  end if;

  -- If this user is already represented in members or invites, they don't
  -- add a new distinct user — allow (this covers rotation re-inserts and
  -- invite-acceptance paths).
  select
    exists (select 1 from room_members where room_id = new.room_id and user_id = incoming_user)
    or exists (select 1 from room_invites where room_id = new.room_id and invited_user_id = incoming_user)
    into is_existing;
  if is_existing then
    return new;
  end if;

  select count(distinct u) into distinct_users from (
    select user_id as u from room_members where room_id = new.room_id
    union
    select invited_user_id as u from room_invites where room_id = new.room_id
  ) t;

  if distinct_users >= 2 then
    raise exception 'pair rooms are limited to 2 people (room_id=%)', new.room_id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists pair_member_cap on room_members;
create trigger pair_member_cap
  before insert on room_members
  for each row execute function enforce_pair_room_cap();

drop trigger if exists pair_invite_cap on room_invites;
create trigger pair_invite_cap
  before insert on room_invites
  for each row execute function enforce_pair_room_cap();

-- ---------------------------------------------------------------------------
-- Tighten room_members DELETE: self OR room creator.
--
-- Old policy (from 0001_init.sql) allowed any current-gen member to delete
-- anyone's row. That meant a non-admin could kick others out, which doesn't
-- match the product model where only the room creator is admin.
--
-- New rules:
--   - Anyone may delete their own row (leave the room at any generation).
--   - The room creator may delete any row in their room (kick during
--     rotation, or full cleanup).
-- The rotateRoomKey + re-add flow still works because the creator-admin
-- is the one calling it; non-admins never orchestrate a rotation themselves.
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- Also tighten room_members INSERT: self OR room creator.
--
-- The old policy let any current-gen member add rows for any user, which
-- could be abused to sneak someone into a room without going through the
-- invite path. With the new admin model, only the creator (during rotation)
-- adds rows for other users. Self-insert during invite acceptance still
-- works because the invitee has auth.uid() = user_id.
-- ---------------------------------------------------------------------------
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
