-- 0003_room_name.sql
--
-- Add an optional end-to-end-encrypted display name to each room.
--
-- The name ciphertext is sealed with the current-generation room key (same
-- cipher as blobs: XChaCha20-Poly1305). Whenever the room key rotates, the
-- client re-encrypts the name under the new key so current members can still
-- read it. Both columns are nullable — null means "no name set; show the
-- short ID instead".
--
-- No new RLS policies needed: the existing rooms_member_update policy
-- already lets any current-generation member update the row.

alter table rooms
  add column if not exists name_ciphertext text,
  add column if not exists name_nonce      text;
