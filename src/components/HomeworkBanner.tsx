'use client';

/**
 * Therapy Homework banner.
 *
 * V2 port of V1's HomeworkBanner. Model: events of type `homework_set` carry
 * the homework text; the latest non-empty text is the active assignment,
 * empty text clears it.
 *
 * Read path: reduce the room event stream (useRoomProjection).
 * Write path: appendEvent({ type: 'homework_set', text, ts }).
 */

import { useState } from 'react';
import { displayName } from '@/lib/domain/displayName';
import { describeError } from '@/lib/domain/errors';
import { useRoom, useRoomProjection } from './RoomProvider';
import { SectionHeader } from './design/SectionHeader';

interface HomeworkState {
  text: string;
  ts: number;
  senderId: string;
}

/** Curated starter intentions. Picking one prefills the textarea so you can
 *  use it as-is, tweak it, or stack a personal note onto it. */
const INTENTION_STARTERS: { label: string; body: string }[] = [
  { label: 'A daily appreciation',  body: 'Each day this week, name one thing you appreciate about each other out loud.' },
  { label: 'A phone-free hour',     body: 'Spend one phone-free hour together this weekend — no devices in the room.' },
  { label: 'Soft startup',          body: 'Practise the "soft startup" on hard topics: lead with feeling, not blame.' },
  { label: '30-second hug',         body: 'Hold each other for 30 seconds without speaking, once a day.' },
  { label: '"What do you need?"',   body: 'Take turns asking, gently: "What do you need from me right now?"' },
  { label: 'Two-thing check-in',    body: 'Each evening, share one good thing and one hard thing from your day.' },
  { label: 'Repair, not rerun',     body: 'When a hard moment passes, name what helped instead of replaying what hurt.' },
  { label: 'Long talk slot',        body: 'Schedule one 20-minute uninterrupted talk this week — phones away, no agenda.' },
  { label: 'Pause before reacting', body: 'When something lands hard, take three breaths before you respond.' },
  { label: 'Small pride share',     body: 'Each share one thing you\u2019re privately proud of from this week.' },
];

export function HomeworkBanner() {
  const { appendEvent, myUserId, displayNames } = useRoom();
  const current = useRoomProjection<HomeworkState | null>(
    (state, rec) => {
      if (rec.event.type !== 'homework_set') return state;
      if (state && state.ts > rec.event.ts) return state;  // newer wins by ts
      return { text: rec.event.text, ts: rec.event.ts, senderId: rec.senderId };
    },
    null,
    [],
  );

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const active = current && current.text.trim().length > 0;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await appendEvent({ type: 'homework_set', text: draft, ts: Date.now() });
      setDraft('');
      setEditing(false);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    if (!confirm('Clear the current homework?')) return;
    setBusy(true);
    setError(null);
    try {
      await appendEvent({ type: 'homework_set', text: '', ts: Date.now() });
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-2xl border border-white/50 bg-amber-50/70 p-8 text-sm shadow-xl backdrop-blur-md transition-transform duration-200 ease-out hover:scale-[1.012] dark:border-white/10 dark:bg-amber-950/40">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <SectionHeader label="Intentions" emoji="🌱" />
          {active ? (
            <p className="mt-2 whitespace-pre-wrap break-words pl-1 font-display italic text-lg leading-snug text-amber-950 dark:text-amber-100">
              {current!.text}
            </p>
          ) : (
            <p className="mt-2 pl-1 text-sm leading-relaxed text-amber-800/70 dark:text-amber-200">
              No active homework. You&apos;re all caught up 🙌
            </p>
          )}
          {current && (
            <p className="mt-1 text-[10px] text-amber-800/60 dark:text-amber-200">
              last change by {displayName(current.senderId, displayNames, myUserId)}
              {' · '}
              {new Date(current.ts).toLocaleString()}
            </p>
          )}
        </div>
        <div className="flex flex-shrink-0 flex-col gap-1.5">
          {!editing && (
            <button
              onClick={() => {
                setDraft(current?.text ?? '');
                setEditing(true);
              }}
              className="rounded-full bg-amber-900 px-3 py-1.5 font-display italic text-xs text-white shadow-sm transition-all hover:scale-[1.04] active:scale-[1.02] disabled:opacity-50 dark:bg-amber-200 dark:text-amber-950"
            >
              {active ? 'Edit' : 'Set'}
            </button>
          )}
          {active && !editing && (
            <button
              onClick={() => void clear()}
              disabled={busy}
              className="rounded-full border border-amber-300 bg-white/60 px-3 py-1.5 font-display italic text-xs text-amber-900 transition-all hover:scale-[1.04] hover:bg-white/90 active:scale-[1.02] disabled:opacity-50 dark:border-amber-800 dark:bg-neutral-900/60 dark:text-amber-200"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {editing && (
        <div className="mt-4 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <label
              htmlFor="intention-starter"
              className="text-[11px] font-medium uppercase tracking-[0.18em] text-amber-700 dark:text-amber-300"
            >
              Starter
            </label>
            <select
              id="intention-starter"
              defaultValue=""
              onChange={(e) => {
                const idx = Number(e.target.value);
                if (Number.isNaN(idx)) return;
                const starter = INTENTION_STARTERS[idx];
                if (!starter) return;
                setDraft((prev) =>
                  prev.trim().length === 0 ? starter.body : prev + '\n\n' + starter.body,
                );
                e.target.value = '';
              }}
              disabled={busy}
              className="flex-1 rounded-xl border border-amber-200 bg-white/90 px-3 py-2 text-sm text-amber-900 outline-none focus:border-amber-300 focus:ring-2 focus:ring-amber-300/40 disabled:opacity-50 dark:border-amber-800 dark:bg-neutral-950 dark:text-amber-200"
            >
              <option value="">pick a starter intention…</option>
              {INTENTION_STARTERS.map((s, i) => (
                <option key={s.label} value={i}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={3}
            className="block w-full rounded-2xl border border-amber-200 bg-white/90 p-4 text-base leading-relaxed text-neutral-900 placeholder:italic placeholder:text-amber-300 outline-none transition-colors focus:border-amber-300 focus:ring-2 focus:ring-amber-300/40 dark:border-amber-800 dark:bg-neutral-950 dark:text-neutral-100"
            placeholder="…or write your own intention."
          />
          <div className="flex gap-2">
            <button
              onClick={() => void save()}
              disabled={busy || !draft.trim()}
              className="rounded-full bg-gradient-to-br from-amber-200 via-amber-300 to-amber-400 px-5 py-2 font-display italic text-sm text-amber-950 shadow-[0_8px_20px_-4px_rgba(217,119,6,0.5),inset_0_2px_3px_rgba(255,255,255,0.55),inset_0_-3px_6px_rgba(146,64,14,0.25)] ring-1 ring-amber-200/60 transition-all hover:scale-[1.04] active:scale-[1.06] disabled:opacity-50"
            >
              {busy ? 'saving…' : 'Save'}
            </button>
            <button
              onClick={() => {
                setEditing(false);
                setDraft('');
              }}
              disabled={busy}
              className="rounded-full border border-amber-200 bg-white/80 px-4 py-2 font-display italic text-sm text-amber-900 transition-all hover:scale-[1.04] hover:bg-white active:scale-[1.02] disabled:opacity-50 dark:border-amber-800 dark:bg-neutral-900/60 dark:text-amber-200"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
    </section>
  );
}
