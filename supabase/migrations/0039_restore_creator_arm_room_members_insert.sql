-- ============================================================================
-- 0039_restore_creator_arm_room_members_insert.sql
--
-- Restores the room-creator bootstrap path removed in 0038.
--
-- 0038 dropped the creator arm on the grounds that kick_and_rotate (SECURITY
-- DEFINER) handles all post-creation membership inserts. That reasoning is
-- correct for rotations, but missed the initial-creation path:
--
--   createRoom() → wrapRoomKeyForAllMyDevices() → addRoomMember()
--
-- addRoomMember() is a direct client-side insert. For a brand-new room the
-- caller has no outstanding invite and is not yet a current-gen member, so
-- both arms of the 0038 policy fail. wrapRoomKeyForAllMyDevices catches the
-- error per-device and warns, returning without throwing. The status-page
-- check-6 (findOrCreateTestRoom) therefore "passes" with only an in-memory
-- roomKey, and check-7 (insertBlob) then fails RLS because there is no
-- room_members row for this user at generation 1.
--
-- FIX: add arm (c) — room creator may always insert their own membership.
-- This is safe because:
--   • kick_and_rotate is creator-only; no one else can evict the creator.
--   • A creator self-leaving (kick_and_rotate evictees=[self]) is intentional;
--     being able to re-add themselves is consistent with room ownership.
--   • Post-eviction re-insertion for non-creator users is still blocked by
--     the invite / current-gen-member requirement (arms a + b).
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
      -- (c) Room creator bootstrapping initial membership.
      --     kick_and_rotate is creator-only, so creators are never evicted by
      --     others; this arm does not reopen the post-eviction hole.
      or exists (
           select 1 from rooms r
           where r.id = room_members.room_id
             and r.created_by = auth.uid()
         )
    )
  );
