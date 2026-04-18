-- ============================================================================
-- 0038_tighten_room_members_insert_policy.sql
--
-- Closes the post-eviction self-re-insertion hole.
--
-- BEFORE (0008): room_members_insert allowed `user_id = auth.uid()` with no
--   other constraint — any authenticated user could INSERT a row for themselves
--   in any room at any generation, including after being kicked. The rotator
--   (rotateOneRoomAsAdmin) builds its re-wrap list from raw room_members rows,
--   so a re-inserted user would receive the next generation's key.
--
-- FIX: self-insert now requires one of two conditions:
--   (a) The device has an outstanding (non-expired) invite for this room — the
--       standard "accept invite" path.
--   (b) The caller is already a current-generation member of this room — covers
--       co-device self-wrap (wrapRoomKeyForAllMyDevices) and sibling-device
--       key-forwarding (respondToKeyForwardRequests). No generation constraint
--       on the inserted row in this arm so historical gen key-forwards work.
--
-- The room-creator arm is intentionally dropped: kick_and_rotate is SECURITY
-- DEFINER and bypasses RLS, so no direct-insert path in the codebase requires
-- it. Removing it closes the surface entirely.
-- ============================================================================

drop policy if exists room_members_insert on room_members;

create policy room_members_insert on room_members
  for insert to authenticated with check (
    user_id = auth.uid()
    and (
      -- (a) Accepting an invite: device must have a valid outstanding invite.
      exists (
        select 1 from room_invites i
        where i.room_id           = room_members.room_id
          and i.invited_device_id = room_members.device_id
          and (
            i.expires_at_ms is null
            or i.expires_at_ms > (extract(epoch from now()) * 1000)::bigint
          )
      )
      -- (b) Already a current-gen member (co-device wrap or key-forward).
      --     Uses the security-definer helper to avoid recursive RLS.
      or is_room_member_at(
           room_members.room_id,
           auth.uid(),
           room_current_generation(room_members.room_id)
         )
    )
  );
