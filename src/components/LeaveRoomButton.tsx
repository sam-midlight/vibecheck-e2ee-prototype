'use client';

/**
 * In-room "leave / delete" control. Renders differently based on whether
 * the caller is the sole remaining current-generation member:
 *   - sole member: red "Delete room" with the strong confirmation modal
 *   - multi member: amber "Leave room" with the softer confirmation modal
 * After success routes the user back to /rooms.
 *
 * Multi-member leave routes through `selfLeaveRoom` (bootstrap), which
 * wraps `kick_and_rotate` with `evicteeUserIds: [self]`. This rotates
 * the room key for the remaining members so their future messages stay
 * private from the leaver — matching the FS guarantees that `deleteRoom`
 * gives for the sole-member path.
 */

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { deleteRoom } from '@/lib/supabase/queries';
import { selfLeaveRoom } from '@/lib/bootstrap';
import { describeError } from '@/lib/domain/errors';
import { useRoom } from './RoomProvider';

export function LeaveRoomButton({
  roomId,
  userId,
  isSoleMember,
}: {
  roomId: string;
  userId: string;
  isSoleMember: boolean;
}) {
  const router = useRouter();
  const { room, myDevice } = useRoom();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      if (isSoleMember) {
        await deleteRoom(roomId);
      } else {
        if (!room || !myDevice) {
          throw new Error('room context not ready');
        }
        await selfLeaveRoom({
          roomId,
          userId,
          device: myDevice.deviceBundle,
          room,
        });
      }
      router.replace('/rooms');
    } catch (e) {
      setError(describeError(e));
      setBusy(false);
    }
  }

  const tone = isSoleMember ? 'red' : 'amber';
  const toneClasses =
    tone === 'red'
      ? {
          trigger:
            'border-red-300/60 bg-red-50/70 text-red-700 hover:bg-red-100/80 hover:text-red-900 dark:border-red-800/40 dark:bg-red-950/40 dark:text-red-300 dark:hover:bg-red-900/40',
          border: 'border-red-400/70 dark:border-red-700',
          bg: 'bg-red-50/80 dark:bg-red-950/60',
          title: 'text-red-900 dark:text-red-100',
          button: 'bg-red-700 hover:bg-red-800 text-white',
        }
      : {
          trigger:
            'border-amber-300/60 bg-amber-50/70 text-amber-800 hover:bg-amber-100/80 hover:text-amber-900 dark:border-amber-800/40 dark:bg-amber-950/40 dark:text-amber-300 dark:hover:bg-amber-900/40',
          border: 'border-amber-300/70 dark:border-amber-700',
          bg: 'bg-amber-50/80 dark:bg-amber-950/50',
          title: 'text-amber-900 dark:text-amber-100',
          button:
            'bg-amber-700 hover:bg-amber-800 text-white dark:bg-amber-200 dark:text-amber-950 dark:hover:bg-amber-100',
        };

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
        className={`rounded-full border px-3 py-1.5 text-xs shadow-sm backdrop-blur-md transition-all hover:shadow-md active:scale-[0.98] ${toneClasses.trigger}`}
      >
        {isSoleMember ? 'Delete room' : 'Leave room'}
      </button>

      {open && typeof document !== 'undefined' && createPortal(
        <div
          role="dialog"
          aria-modal="true"
          aria-label={isSoleMember ? 'Delete this room?' : 'Leave this room?'}
          className="fixed inset-0 z-[100] flex items-center justify-center bg-neutral-950/40 p-4 backdrop-blur-sm"
          onClick={(e) => {
            if (e.target === e.currentTarget && !busy) setOpen(false);
          }}
        >
          <div
            className={`w-full max-w-md rounded-2xl border-2 ${toneClasses.border} ${toneClasses.bg} p-5 text-sm shadow-2xl backdrop-blur-md`}
          >
            <h3 className={`text-base font-semibold ${toneClasses.title}`}>
              {isSoleMember ? 'Delete this room?' : 'Leave this room?'}
            </h3>
            <div className="mt-3 text-neutral-700 dark:text-neutral-300">
              {isSoleMember ? (
                <>
                  <p className="font-medium">
                    This will permanently delete this room and all encrypted
                    history. This cannot be undone.
                  </p>
                  <p className="mt-2">
                    Everyone&apos;s memberships, pending invites, and every
                    encrypted message in this room will be destroyed.
                  </p>
                </>
              ) : (
                <>
                  <p>
                    You&apos;ll stop receiving new messages and lose access to
                    everything encrypted for you in this room.
                  </p>
                  <p className="mt-2">
                    Your partner can re-invite you later. If they do,
                    you&apos;ll start fresh — you won&apos;t regain access to
                    past encrypted messages unless you still have old keys.
                  </p>
                </>
              )}
            </div>
            {error && (
              <p className="mt-3 rounded-lg border border-red-300/60 bg-red-50/70 p-2 text-xs text-red-800 dark:border-red-800/60 dark:bg-red-950/60 dark:text-red-200">
                {error}
              </p>
            )}
            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setOpen(false)}
                disabled={busy}
                className="rounded-full border border-white/60 bg-white/70 px-4 py-1.5 text-xs font-medium text-neutral-700 backdrop-blur-md transition-all hover:bg-white/90 hover:shadow-sm active:scale-[0.98] disabled:opacity-50 dark:border-white/10 dark:bg-neutral-900/60 dark:text-neutral-300"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void confirm()}
                disabled={busy}
                className={`rounded-full px-4 py-1.5 text-xs font-medium shadow-sm transition-all hover:shadow-md active:scale-[0.98] disabled:opacity-50 ${toneClasses.button}`}
              >
                {busy
                  ? 'working…'
                  : isSoleMember
                    ? 'Delete room forever'
                    : 'Leave room'}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
