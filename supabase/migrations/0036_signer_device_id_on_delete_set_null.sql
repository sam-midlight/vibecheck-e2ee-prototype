-- ============================================================================
-- 0036_signer_device_id_on_delete_set_null.sql
--
-- Fix: nuke_identity (and any ad-hoc device deletion) raises FK violation
-- 23503 when room_members rows for OTHER users still carry
-- signer_device_id pointing at a device belonging to the user being nuked.
--
-- Scenario: Alice is the room creator. She signs wrap rows for Bob's devices
-- during rotation (signer_device_id = Alice's device, user_id = Bob).
-- When Alice nukes, nuke_identity deletes room_members WHERE user_id = Alice —
-- but Bob's rows survive and still reference Alice's device as signer.
-- The subsequent DELETE FROM devices WHERE user_id = Alice then hits the FK.
--
-- Fix: change signer_device_id to ON DELETE SET NULL. A NULL signer means the
-- signing device's record is gone and the wrap cannot be reverified. The
-- client's verifyAndUnwrapMyRoomKey already rejects any row where the signer
-- pub cannot be resolved, so a NULL signer_device_id is treated identically
-- to a missing signer pub — the row is rejected.
--
-- room_members.device_id (the recipient) already has ON DELETE CASCADE and
-- is unaffected by this change.
-- ============================================================================

ALTER TABLE room_members
  DROP CONSTRAINT IF EXISTS room_members_signer_device_id_fkey;

ALTER TABLE room_members
  ADD CONSTRAINT room_members_signer_device_id_fkey
    FOREIGN KEY (signer_device_id)
    REFERENCES devices(id)
    ON DELETE SET NULL;
