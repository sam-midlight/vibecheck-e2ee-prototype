-- ============================================================================
-- 0024_one_active_call_per_room.sql
--
-- Enforce AT MOST ONE active call per room. Prevents the race where two
-- clients click "Start call" at the same moment and end up in separate
-- `calls` rows, each thinking they own the call. With this partial unique
-- index, the second `start_call` RPC fails the PK-side INSERT and the
-- client can fall back to joining the first winner.
--
-- Runbook for any existing duplicates in the wild: pick the most recently
-- started active call per room and keep it; end the rest. Ordering by
-- `started_at DESC` so a freshly-opened duplicate wins over a zombie.
-- ============================================================================

-- Clean up any existing duplicates so the unique-index creation succeeds.
with ranked as (
  select id,
         row_number() over (partition by room_id order by started_at desc) as rn
  from calls
  where ended_at is null
)
update calls
   set ended_at = now()
 where id in (select id from ranked where rn > 1);

-- Close the door.
create unique index if not exists calls_one_active_per_room
  on calls (room_id)
  where ended_at is null;

comment on index calls_one_active_per_room is
  'At most one active (ended_at IS NULL) call per room. Second concurrent '
  'start_call RPC fails on this constraint; the client should join the '
  'surviving row instead.';
