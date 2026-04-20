'use client';

/**
 * Lightweight emoji picker. No library — a curated grid of ~60 common
 * avatar-style emojis plus a text input for anything outside the grid
 * (lets the OS emoji keyboard / input method pick anything at all).
 *
 * Usage is popover-style: parent controls open/close, positions relative
 * to the trigger. This component just renders the grid + input.
 */

import { useEffect, useRef, useState } from 'react';

export const CURATED_EMOJIS: string[] = [
  // Faces / expressions
  '😀', '😄', '🙂', '😎', '🥸', '🤓', '😇', '🥳', '🤩', '😴',
  // Animals
  '🦖', '🐱', '🐶', '🦊', '🐼', '🐨', '🦉', '🦋', '🐝', '🐙',
  '🦄', '🐯', '🐸', '🐵', '🦔', '🦦',
  // Plants / nature
  '🌻', '🌸', '🌷', '🌵', '🍄', '🌈', '☀️', '🌙', '⭐', '⚡',
  // Food
  '🍕', '🍔', '🍎', '🍓', '🍑', '🍩', '🍰', '☕', '🍵', '🧋',
  // Objects / moods
  '✨', '🔥', '💫', '💖', '🎀', '🎨', '🎧', '📚', '🎮', '🚀',
  '🧸', '🪴', '🌊', '🏔️',
];

export function EmojiPicker({
  current,
  onPick,
  onClear,
  onClose,
}: {
  current: string;
  onPick: (emoji: string) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const [custom, setCustom] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);

  // Close on outside click or Escape.
  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  function submitCustom(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = custom.trim().slice(0, 8);
    if (!trimmed) return;
    onPick(trimmed);
    setCustom('');
  }

  return (
    <div
      ref={containerRef}
      role="dialog"
      aria-label="choose an emoji"
      className="absolute left-1/2 top-full z-[60] mt-2 w-72 -translate-x-1/2 rounded-2xl border border-white/60 bg-white/90 p-3 shadow-xl backdrop-blur-md dark:border-white/10 dark:bg-neutral-900/90"
    >
      <div className="grid grid-cols-8 gap-1">
        {CURATED_EMOJIS.map((e) => {
          const selected = e === current;
          return (
            <button
              key={e}
              type="button"
              onClick={() => onPick(e)}
              className={`flex h-7 w-7 items-center justify-center rounded-lg text-base leading-none transition-colors hover:bg-neutral-900/10 dark:hover:bg-white/10 ${
                selected ? 'bg-neutral-900/10 ring-1 ring-neutral-900/30 dark:bg-white/10 dark:ring-white/30' : ''
              }`}
              aria-label={`pick ${e}`}
            >
              {e}
            </button>
          );
        })}
      </div>
      <form onSubmit={submitCustom} className="mt-2 flex items-center gap-2">
        <input
          type="text"
          value={custom}
          onChange={(ev) => setCustom(ev.target.value)}
          placeholder="or type any emoji…"
          maxLength={8}
          className="flex-1 rounded-lg border border-white/60 bg-white/80 px-2 py-1 text-sm outline-none focus:ring-2 focus:ring-neutral-900/10 dark:border-white/10 dark:bg-neutral-900/70 dark:focus:ring-white/20"
        />
        <button
          type="submit"
          disabled={!custom.trim()}
          className="rounded-full bg-neutral-900 px-3 py-1 text-xs text-white disabled:opacity-40 dark:bg-white dark:text-neutral-900"
        >
          set
        </button>
      </form>
      {current && (
        <button
          type="button"
          onClick={onClear}
          className="mt-2 w-full rounded-lg border border-white/60 bg-white/60 px-2 py-1 text-[11px] text-neutral-600 transition-colors hover:bg-white/80 dark:border-white/10 dark:bg-neutral-900/60 dark:text-neutral-400"
        >
          clear my emoji
        </button>
      )}
    </div>
  );
}

/**
 * Canonical fallback when a member has no emoji set. Renders the first
 * letter of their display name in a neutral bubble, or a generic face
 * if we don't even have a name yet.
 */
export function avatarFallback(name: string | null | undefined): string {
  const trimmed = (name ?? '').trim();
  if (!trimmed) return '🙂';
  // Grapheme-aware first char (handles multi-codepoint names gracefully).
  const first = Array.from(trimmed)[0] ?? '';
  return first.toUpperCase();
}
