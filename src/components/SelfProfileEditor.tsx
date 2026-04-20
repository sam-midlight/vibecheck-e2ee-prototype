'use client';

/**
 * SelfProfileEditor — stub during the vibecheck2 merge.
 *
 * Final version lets the user edit their display name + emoji avatar,
 * writing a signed `display_name_set` / `emoji_set` pair of events into
 * the room ledger. Until that's wired through RoomProvider.appendEvent
 * in the composed shell, a minimal read-only popover keeps RoomRoster's
 * self-pill layout stable.
 */
export function SelfProfileEditor({
  initialName,
  initialEmoji,
  onClose,
}: {
  initialName: string;
  initialEmoji: string;
  onClose: () => void;
}) {
  return (
    <div
      role="dialog"
      aria-label="your profile"
      className="absolute left-1/2 top-full z-50 mt-2 w-56 -translate-x-1/2 rounded-2xl border border-white/60 bg-white/95 p-3 text-xs shadow-xl backdrop-blur-md dark:border-white/10 dark:bg-neutral-900/95"
    >
      <p className="font-display italic text-sm">
        {initialEmoji ? `${initialEmoji} ` : ''}
        {initialName}
      </p>
      <p className="mt-1.5 leading-relaxed text-neutral-500">
        Name + emoji editing lands in the next wave.
      </p>
      <button
        type="button"
        onClick={onClose}
        className="mt-2 rounded-full border border-neutral-200 bg-white/80 px-3 py-1 text-[11px] text-neutral-700 dark:border-neutral-700 dark:bg-neutral-900/60 dark:text-neutral-200"
      >
        close
      </button>
    </div>
  );
}
