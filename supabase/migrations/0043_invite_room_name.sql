-- 0043_invite_room_name.sql
--
-- Travel the current room name along with each invite so joiners see the
-- real name immediately on accept. The creator's rooms.name_ciphertext
-- column path depends on either (a) the creator having successfully
-- written the column under a key the joiner can decrypt, or (b) the
-- creator's `room_rename` event being retrievable inside the joiner's
-- current-generation event stream. Both fail in plausible scenarios
-- (RLS hiccups, generation skew, bootstrap races), leaving the joiner
-- staring at the default "Room {id8}" placeholder.
--
-- With these columns, the room-owner copies whatever they have on the
-- rooms row at invite-send time into the invite row. On accept, the
-- joiner already has to decrypt the wrapped_room_key to join — they can
-- use that same key on these columns in the same transaction and cache
-- the decrypted name locally.
--
-- Both columns are nullable: legacy invites (pre-migration) + invites to
-- rooms that never had a custom name skip them harmlessly. No new RLS
-- policies needed — these columns inherit the existing row-level policy
-- on room_invites (visible to the invited user + the sender).

alter table room_invites
  add column if not exists room_name_ciphertext text,
  add column if not exists room_name_nonce      text;
