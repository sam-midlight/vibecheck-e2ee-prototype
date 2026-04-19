-- ============================================================================
-- 0042_megolm_counter_monotonic.sql
--
-- Closes the Megolm 200-message hard-cap bypass.
--
-- ROOT CAUSE: migration 0027's UPDATE policy on `megolm_sessions` is
--   `USING (sender_user_id = auth.uid())` with no WITH CHECK and no column
--   scope. The sender can therefore `UPDATE megolm_sessions SET
--   message_count = 0 WHERE session_id = <theirs>` at any time, which
--   defeats the BEFORE-INSERT cap trigger in 0029 (that trigger reads the
--   row's counter at blob-insert time). A patched/hostile client can send
--   indefinitely on one session_id — the exact threat 0029 exists to catch.
--
-- CONSEQUENCE: the "bounded compromise exposure" property rotation is meant
-- to provide (if a chain key at index N leaks, attacker's decryption window
-- is capped at the distance to the next rotation) is lost against a
-- misbehaving sender. Documented as a "defense-in-depth" guarantee in 0029
-- and in megolm.ts's MEGOLM_HARD_CAP comment, so the gap is a real regression.
--
-- FIX: a BEFORE UPDATE trigger enforcing counter monotonicity *for a given
-- session_id*. A legitimate session rotation always changes `session_id`
-- (fresh 32 random bytes from `createOutboundSession`), so the retry upsert
-- in `insertMegolmSession` (queries.ts) still resets the counter cleanly.
-- The only rejected shape is keep-same-session_id + lower message_count,
-- which is exactly the bypass.
--
-- The AFTER-INSERT increment trigger from 0029 only ever does
-- `message_count = message_count + 1`, so it satisfies this guard
-- unconditionally.
-- ============================================================================

create or replace function guard_megolm_session_counter()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.message_count < old.message_count
     and new.session_id is not distinct from old.session_id then
    raise exception
      'megolm message_count is monotonic for a given session_id (old=%, new=%)',
      old.message_count, new.message_count
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists megolm_sessions_counter_guard on megolm_sessions;
create trigger megolm_sessions_counter_guard
  before update on megolm_sessions
  for each row execute function guard_megolm_session_counter();
