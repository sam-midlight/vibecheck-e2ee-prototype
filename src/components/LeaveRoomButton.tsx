'use client';

/**
 * LeaveRoomButton — stub during the vibecheck2 merge.
 *
 * Final version calls `kick_and_rotate` with the caller as the leaver
 * (same RPC that powers creator-side kicks). Until that's wired up
 * through the composed shell, this is a visual placeholder that keeps
 * the RoomTabs menu layout honest.
 */
export function LeaveRoomButton({
  roomId: _roomId,
  userId: _userId,
  isSoleMember: _isSoleMember,
}: {
  roomId: string;
  userId: string;
  isSoleMember: boolean;
}) {
  return (
    <button type="button" disabled title="leave flow lands in the next wave">
      Leave room (coming soon)
    </button>
  );
}
