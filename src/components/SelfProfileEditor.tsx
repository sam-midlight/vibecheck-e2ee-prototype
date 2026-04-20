'use client';

/**
 * SelfProfileEditor — small popover that opens from your top-banner pill.
 * Lets you change two things in one place:
 *
 *   • Your display name (saves locally + emits `display_name_set` so your
 *     partner sees the new name in the room ledger)
 *   • Your room emoji (emits `member_update`)
 *
 * The popover anchors to its parent (RoomRoster wraps it in a relative
 * div). Closes on outside click, Escape, or a save with no changes.
 */

import { useEffect, useRef, useState } from 'react';
import { describeError } from '@/lib/domain/errors';
import { saveMyDisplayName } from '@/lib/domain/myDisplayName';
import { CURATED_EMOJIS } from './EmojiPicker';
import { useRoom } from './RoomProvider';

export function SelfProfileEditor({
  initialName,
  initialEmoji,
  onClose,
}: {
  initialName: string;
  initialEmoji: string;
  onClose: () => void;
}) {
  const { appendEvent } = useRoom();
  const [name, setName] = useState(initialName);
  const [emoji, setEmoji] = useState(initialEmoji);
  const [custom, setCustom] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Outside-click + Escape dismissal.
  useEffect(() => {
    function onPointer(e: PointerEvent) {
      const el = containerRef.current;
      if (el && !el.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  // Autofocus the name field on open so you can just start typing.
  useEffect(() => {
    queueMicrotask(() => inputRef.current?.select());
  }, []);

  async function save(e?: React.FormEvent) {
    if (e) e.preventDefault();
    const trimmedName = name.trim().slice(0, 60);
    const trimmedEmoji = emoji.trim().slice(0, 8);
    const nameChanged = trimmedName !== initialName;
    const emojiChanged = trimmedEmoji !== initialEmoji;
    if (!nameChanged && !emojiChanged) {
      onClose();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const now = Date.now();
      if (nameChanged) {
        saveMyDisplayName(trimmedName);
        await appendEvent({ type: 'display_name_set', name: trimmedName, ts: now });
      }
      if (emojiChanged) {
        await appendEvent({ type: 'member_update', emoji: trimmedEmoji, ts: now });
      }
      onClose();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  function pickEmoji(next: string) {
    setEmoji(next);
  }

  function applyCustom(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = custom.trim().slice(0, 8);
    if (!trimmed) return;
    setEmoji(trimmed);
    setCustom('');
  }

  return (
    <div
      ref={containerRef}
      role="dialog"
      aria-label="edit your profile"
      className="absolute left-0 top-full z-[60] mt-2 w-80 rounded-2xl border border-white/60 bg-white/95 p-4 shadow-2xl backdrop-blur-md dark:border-white/10 dark:bg-neutral-900/95"
    >
      <form onSubmit={save} className="space-y-3">
        <div>
          <label
            htmlFor="self-profile-name"
            className="block text-[10px] font-medium uppercase tracking-[0.18em] text-neutral-500"
          >
            Your name
          </label>
          <input
            ref={inputRef}
            id="self-profile-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value.slice(0, 60))}
            placeholder="how should they see you?"
            maxLength={60}
            disabled={busy}
            className="mt-1.5 block w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-neutral-900/15 dark:border-neutral-700 dark:bg-neutral-950"
          />
        </div>

        <div>
          <span className="block text-[10px] font-medium uppercase tracking-[0.18em] text-neutral-500">
            Your emoji
          </span>
          <div className="mt-1.5 grid grid-cols-10 gap-1">
            {CURATED_EMOJIS.map((e) => {
              const selected = e === emoji;
              return (
                <button
                  key={e}
                  type="button"
                  onClick={() => pickEmoji(e)}
                  className={`flex h-7 w-7 items-center justify-center rounded-lg text-base leading-none transition-colors hover:bg-neutral-900/10 dark:hover:bg-white/10 ${
                    selected
                      ? 'bg-neutral-900/10 ring-1 ring-neutral-900/30 dark:bg-white/10 dark:ring-white/30'
                      : ''
                  }`}
                  aria-label={`pick ${e}`}
                  aria-pressed={selected}
                >
                  {e}
                </button>
              );
            })}
          </div>
          <div className="mt-2 flex items-center gap-2">
            <input
              type="text"
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              placeholder="or type any emoji…"
              maxLength={8}
              className="flex-1 rounded-lg border border-neutral-200 bg-white px-2 py-1 text-sm outline-none focus:ring-2 focus:ring-neutral-900/15 dark:border-neutral-700 dark:bg-neutral-950"
            />
            <button
              type="button"
              onClick={applyCustom}
              disabled={!custom.trim()}
              className="rounded-full border border-neutral-300 px-3 py-1 text-[11px] text-neutral-700 transition-colors hover:bg-neutral-100 disabled:opacity-40 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
            >
              use
            </button>
            {emoji && (
              <button
                type="button"
                onClick={() => setEmoji('')}
                className="rounded-full border border-neutral-300 px-3 py-1 text-[11px] text-neutral-500 transition-colors hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
              >
                clear
              </button>
            )}
          </div>
        </div>

        {error && <p className="text-xs text-red-600">{error}</p>}

        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-full border border-neutral-300 px-3 py-1.5 text-xs text-neutral-700 transition-colors hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            cancel
          </button>
          <button
            type="submit"
            disabled={busy || !name.trim()}
            className="rounded-full bg-neutral-900 px-4 py-1.5 text-xs font-semibold text-white shadow-sm transition-all hover:shadow-md disabled:opacity-50 dark:bg-white dark:text-neutral-900"
          >
            {busy ? 'saving…' : 'save'}
          </button>
        </div>
      </form>
    </div>
  );
}
