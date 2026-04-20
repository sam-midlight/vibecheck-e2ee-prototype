-- 0046_leave_call_auto_end.sql
--
-- Prototype log surfaced: "I was only one on call and when I left it didn't
-- end the call." leave_call (0023_calls.sql) only sets left_at, so a solo
-- leaver leaves an ended_at IS NULL row behind. Combined with the partial
-- unique index from 0024_one_active_call_per_room, that ghost row blocks
-- the next start_call for the room until manually ended.
--
-- Fix: extend leave_call to set calls.ended_at = now() when no other
-- members remain active. Self-contained — same authorization model as
-- before; just adds the auto-cleanup tail.

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

  -- If no active members remain, mark the call ended so a fresh start_call
  -- can claim the room (the partial unique index from 0024 needs a clear slot).
  if not exists (
    select 1 from call_members
    where call_id = p_call_id
      and left_at is null
  ) then
    update calls set ended_at = now()
     where id = p_call_id and ended_at is null;
  end if;
end;
$$;

revoke all on function leave_call(uuid, uuid) from public;
grant execute on function leave_call(uuid, uuid) to authenticated;
