-- ============================================================================
-- 0047_lock_room_invariants.sql — Lock down mutation of rooms invariant columns
--
-- Background: rooms_member_update (0008:114) authorises by row but does not
-- restrict columns. Combined with kick_and_rotate's authorization via the
-- live `rooms.created_by` value (0040:54-88), any current-gen member could
--   UPDATE rooms SET created_by = auth.uid() WHERE id = <room>
-- and then call kick_and_rotate to evict the legitimate creator. Same
-- vector covered rooms_creator_delete (0004:7-9), since that policy also
-- reads created_by.
--
-- Approach: revoke broad UPDATE on rooms from authenticated, then re-grant
-- only the columns that user-side code legitimately writes:
--   - name_ciphertext, name_nonce  (renameRoom)
--   - parent_room_id               (findOrCreateTestRoom status-probe marker)
--
-- Invariant columns (id, kind, created_by, current_generation,
-- last_rotated_at, created_at) become RPC-only. SECURITY DEFINER functions
-- like kick_and_rotate execute as the table owner (postgres) and bypass
-- column-level GRANT restrictions, so they continue to update these columns
-- unimpeded.
--
-- The existing rooms_member_update RLS policy is also tightened to add an
-- explicit WITH CHECK clause (matches USING). Pure defence-in-depth: column
-- GRANTs already prevent created_by writes, but an explicit WITH CHECK
-- clarifies intent and protects against future columns where someone
-- forgets to update the GRANT list.
--
-- parent_room_id remains user-mutable. Impact: a malicious member could
-- UPDATE rooms SET parent_room_id = id to hide a room from peers' rooms-list
-- view (listRooms filters `parent_room_id !== id` as status-probe tag). The
-- room is still reachable by direct URL and subscriptions still fire, so
-- this is soft DoS, not data loss. Accepted for now; follow-up is to move
-- the status-probe self-reference into a SECURITY DEFINER helper so
-- parent_room_id can also be locked down.
-- ============================================================================

-- Step 1: revoke broad UPDATE, then grant only the user-mutable columns.
revoke update on rooms from authenticated;

grant update (name_ciphertext, name_nonce, parent_room_id)
  on rooms to authenticated;

-- Step 2: tighten rooms_member_update with an explicit WITH CHECK. Column
-- GRANTs already block writes to invariant columns; WITH CHECK protects
-- against future column additions where someone forgets to update the
-- GRANT list and accidentally opens a new vector.
drop policy if exists rooms_member_update on rooms;
create policy rooms_member_update on rooms
  for update to authenticated
  using      (is_room_member_at(id, auth.uid(), current_generation))
  with check (is_room_member_at(id, auth.uid(), current_generation));
