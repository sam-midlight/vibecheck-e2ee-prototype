-- ============================================================================
-- 0032_rooms_members_realtime.sql — publish `rooms` on realtime
--
-- Previously `rooms` was excluded from `supabase_realtime`; clients picked
-- up metadata changes (current_generation, name) via a 10-second poll. That
-- window caused a correctness bug in Megolm:
--
--   1. User 2 accepts invite → kick_and_rotate bumps rooms.current_generation
--      N → N+1 and inserts room_members rows at N+1.
--   2. User A's client still has roomKey at gen N in state (poll hasn't fired).
--   3. User A sends: `ensureFreshSession` sees the existing outbound Megolm
--      session at gen N and reuses it.
--   4. That session was distributed BEFORE User 2 joined, so User 2 has no
--      megolm_session_shares row for it and can't decrypt User A's messages.
--   5. Only way out was a manual rotation.
--
-- Adding `rooms` to the realtime publication lets clients react to rotation
-- within ms, so `ensureFreshSession` on the next send sees the new generation
-- and distributes a fresh session to the full post-join member set.
--
-- NOTE: migration 0009 deliberately dropped `room_members` from this
-- publication to close a metadata-leak surface; that decision stands. Every
-- membership change flows through `kick_and_rotate`, which always UPDATEs
-- `rooms.current_generation` in the same transaction, so subscribing to the
-- `rooms` UPDATE event is sufficient signal — the client then re-fetches
-- `room_members` + its own wrapped_room_key row on its own.
-- ============================================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    -- Idempotent: swallow duplicate_object so re-running the migration on
    -- an already-configured DB is safe.
    BEGIN
      EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE rooms';
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
  END IF;
END $$;
