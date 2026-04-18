-- ============================================================================
-- 0033_room_limit.sql — enforce 100-room-per-user cap on room_members.
--
-- A trigger fires on every INSERT into room_members. It counts how many
-- DISTINCT rooms the user is already in (excluding the room being joined,
-- so key rotations re-inserting into an existing room are always allowed).
-- If that count is >= 100, the insert is rejected.
--
-- The warning threshold (90) is enforced client-side only.
-- ============================================================================

create or replace function enforce_room_member_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
begin
  select count(distinct room_id) into v_count
    from room_members
   where user_id = NEW.user_id
     and room_id != NEW.room_id;

  if v_count >= 100 then
    raise exception 'room limit reached: a user may belong to at most 100 rooms'
      using errcode = 'check_violation';
  end if;

  return NEW;
end;
$$;

create trigger room_member_limit
  before insert on room_members
  for each row execute function enforce_room_member_limit();
