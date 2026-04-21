'use client';

/**
 * <ReactionBar /> — glass chips showing aggregated emoji reactions for a
 * given event target, plus a "+ smile" trigger that opens a picker with
 * a curated set of quick reactions. Emits `add_reaction` / `remove_reaction`
 * events into the encrypted ledger.
 *
 * Click on an existing chip toggles your own reaction for that emoji.
 * Picker selection also toggles — tapping an emoji you already reacted
 * with removes it. Optimistic updates flow through RoomProvider.appendEvent.
 *
 * `tone` lets the caller subtly tint chips to match the surrounding UI
 * ("dark" for dark message bubbles, "light" otherwise).
 */

import { useEffect, useRef, useState } from 'react';
import { useRoomCore, useRoomEvents } from './RoomProvider';

const QUICK_REACTIONS: string[] = ['❤️', '👍', '🫂', '👀', '😂', '😮'];

export function ReactionBar({ targetId }: { targetId: string }) {
  const { reactionsByTarget } = useRoomEvents();
  const { myUserId, appendEvent } = useRoomCore();
  const summaries = reactionsByTarget[targetId] ?? [];
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const pickerAnchorRef = useRef<HTMLDivElement>(null);

  if (!myUserId) return null;

  async function toggle(emoji: string) {
    if (busy) return;
    const mine = summaries.find((s) => s.emoji === emoji)?.userIds.includes(
      myUserId!,
    );
    setBusy(true);
    try {
      await appendEvent({
        type: mine ? 'remove_reaction' : 'add_reaction',
        targetId,
        emoji,
        ts: Date.now(),
      });
    } finally {
      setBusy(false);
      setPickerOpen(false);
    }
  }

  // Single neutral glass look that contrasts on any bubble color — solid
  // enough to pop on a dark message bubble, soft enough to fade on a light
  // panel.
  const chipBase =
    'border-neutral-300/60 bg-white/85 text-neutral-800 hover:bg-white dark:border-white/10 dark:bg-neutral-900/80 dark:text-neutral-100 dark:hover:bg-neutral-900';
  const chipMine = 'ring-1 ring-neutral-900/30 dark:ring-white/30';
  const triggerStyle =
    'border-neutral-300/60 bg-white/70 text-neutral-500 hover:bg-white/90 dark:border-white/10 dark:bg-neutral-900/70 dark:text-neutral-400 dark:hover:bg-neutral-900/90';

  return (
    <div className="mt-1 flex flex-wrap items-center gap-1" ref={pickerAnchorRef}>
      {summaries.map((s) => {
        const mine = s.userIds.includes(myUserId);
        return (
          <button
            key={s.emoji}
            type="button"
            onClick={() => void toggle(s.emoji)}
            disabled={busy}
            aria-label={`${s.emoji} ${s.userIds.length} — ${
              mine ? 'click to remove your reaction' : 'click to react'
            }`}
            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] backdrop-blur-md transition-all active:scale-[0.97] disabled:opacity-60 ${chipBase} ${
              mine ? chipMine : ''
            }`}
          >
            <span className="text-[12px] leading-none">{s.emoji}</span>
            <span className="tabular-nums">{s.userIds.length}</span>
          </button>
        );
      })}
      <div className="relative">
        <button
          type="button"
          onClick={() => setPickerOpen((o) => !o)}
          aria-label="add reaction"
          title="add reaction"
          className={`flex h-[22px] w-[22px] items-center justify-center rounded-full border text-[11px] opacity-60 backdrop-blur-md transition-all hover:opacity-100 active:scale-[0.97] ${triggerStyle}`}
        >
          <SmileIcon />
        </button>
        {pickerOpen && (
          <ReactionPicker
            onPick={(emoji) => void toggle(emoji)}
            onClose={() => setPickerOpen(false)}
            busy={busy}
          />
        )}
      </div>
    </div>
  );
}

function ReactionPicker({
  onPick,
  onClose,
  busy,
}: {
  onPick: (emoji: string) => void;
  onClose: () => void;
  busy: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="pick a reaction"
      className="absolute bottom-full left-0 z-30 mb-1 flex gap-0.5 rounded-full border border-white/60 bg-white/90 p-1 shadow-xl backdrop-blur-md dark:border-white/10 dark:bg-neutral-900/90"
    >
      {QUICK_REACTIONS.map((e) => (
        <button
          key={e}
          type="button"
          disabled={busy}
          onClick={() => onPick(e)}
          className="flex h-7 w-7 items-center justify-center rounded-full text-base leading-none transition-all hover:bg-neutral-900/10 active:scale-[0.95] disabled:opacity-50 dark:hover:bg-white/10"
          aria-label={`react with ${e}`}
        >
          {e}
        </button>
      ))}
    </div>
  );
}

function SmileIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden
      className="h-3 w-3"
    >
      <circle cx="8" cy="8" r="6" />
      <path d="M5.5 9.5s.75 1.5 2.5 1.5 2.5-1.5 2.5-1.5" strokeLinecap="round" />
      <circle cx="6" cy="6.5" r=".6" fill="currentColor" stroke="none" />
      <circle cx="10" cy="6.5" r=".6" fill="currentColor" stroke="none" />
    </svg>
  );
}
