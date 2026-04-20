'use client';

/**
 * Horizontal strip of member pills shown at the top of a room. Each pill
 * renders the member's emoji avatar + first name so Vibe Sliders (and
 * anywhere else we show multiple members) have a legible key. Clicking
 * your own pill opens the emoji picker to change your avatar — emits a
 * `member_update` event to the encrypted ledger.
 */

import { useMemo, useState } from 'react';
import { displayName as fmtDisplayName } from '@/lib/domain/displayName';
import { uniqueMembers } from '@/lib/domain/members';
import { avatarFallback } from './EmojiPicker';
import { SelfProfileEditor } from './SelfProfileEditor';
import { useRoom } from './RoomProvider';

export function RoomRoster() {
  const { room, members, myUserId, displayNames, memberEmojis } = useRoom();
  const [editorOpen, setEditorOpen] = useState(false);

  const currentGen = useMemo(
    () =>
      room
        ? uniqueMembers(members, room.current_generation).map((m) => m.user_id)
        : [],
    [members, room],
  );

  if (!room || !myUserId || currentGen.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {currentGen.map((uid) => {
        const isMe = uid === myUserId;
        const nameFull = fmtDisplayName(uid, displayNames, myUserId, null);
        const first = firstName(nameFull);
        const emoji = memberEmojis[uid];
        if (isMe) {
          // Self pill opens the SelfProfileEditor popover (name + emoji in
          // one place). Love Tank shortcut now lives on tapping your
          // breathing mood orb above the Vibe Oracle banner.
          return (
            <div key={uid} className="relative">
              <button
                type="button"
                onClick={() => setEditorOpen((o) => !o)}
                aria-expanded={editorOpen}
                title="edit your name + emoji"
                aria-label="edit your name and emoji"
                className="flex items-center gap-1.5 rounded-full border border-neutral-900/20 bg-white/80 px-3 py-1 text-xs shadow-sm backdrop-blur-md transition-all hover:bg-white hover:shadow-md active:scale-[0.98] dark:border-white/20 dark:bg-neutral-900/80 dark:text-neutral-100 dark:hover:bg-neutral-900"
              >
                <span className="text-sm leading-none">
                  {emoji || (
                    <span className="flex h-4 w-4 items-center justify-center rounded-full bg-neutral-900/10 text-[9px] font-medium dark:bg-white/15">
                      {avatarFallback(first)}
                    </span>
                  )}
                </span>
                <span className="truncate font-medium">{first}</span>
                <span aria-hidden className="ml-0.5 text-[10px] opacity-60">✎</span>
              </button>
              {editorOpen && (
                <SelfProfileEditor
                  initialName={firstName(fmtDisplayName(uid, displayNames, myUserId, null))}
                  initialEmoji={emoji ?? ''}
                  onClose={() => setEditorOpen(false)}
                />
              )}
            </div>
          );
        }
        return (
          <div key={uid} className="relative">
            <span
              title={nameFull}
              aria-label={`${nameFull}${emoji ? ' ' + emoji : ''}`}
              className="flex items-center gap-1.5 rounded-full border border-white/60 bg-white/60 px-3 py-1 text-xs text-neutral-700 shadow-sm backdrop-blur-md dark:border-white/10 dark:bg-neutral-900/60 dark:text-neutral-300"
            >
              <span className="text-sm leading-none">
                {emoji || (
                  <span className="flex h-4 w-4 items-center justify-center rounded-full bg-neutral-900/10 text-[9px] font-medium dark:bg-white/15">
                    {avatarFallback(first)}
                  </span>
                )}
              </span>
              <span className="truncate font-medium">{first}</span>
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** First whitespace-separated token of a display name, trimmed. */
function firstName(full: string): string {
  const trimmed = full.trim();
  if (!trimmed) return '';
  const idx = trimmed.search(/\s/);
  return idx === -1 ? trimmed : trimmed.slice(0, idx);
}
