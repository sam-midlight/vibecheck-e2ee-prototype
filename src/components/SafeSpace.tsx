'use client';

/**
 * Safe Space + Time-Out.
 *
 * Safe Space: one member posts sensitive content with a 4-digit OTP. The
 * other member must enter the OTP to unlock (reveal) the content. Both
 * members then acknowledge, then both resolve. Latest-ts-per-user wins for
 * each phase.
 *
 * Time-Out: any member may start a room-wide clinical lockout (default 20
 * min). While active, posting and unlocking are disabled for everyone.
 * Either member may end it early.
 *
 * Caveat (matches V1): the OTP sits next to the content in the decrypted
 * blob. Every room member can technically read both; the gate is UX-only.
 * Acceptable for a two-partner app.
 */

import { useEffect, useMemo, useState } from 'react';
import { displayName } from '@/lib/domain/displayName';
import { describeError } from '@/lib/domain/errors';
import { useMemberMoods } from '@/lib/domain/memberMood';
import { HelpIcon } from './HelpIcon';
import { useRoom, useRoomProjection } from './RoomProvider';

const DEFAULT_TIMEOUT_SECONDS = 20 * 60;

/** Curated prompt starters shown in the post form. Picking one prefills the
 *  textarea; the user then types their own reflection below the prompt. */
const TEMPLATES: { label: string; body: string }[] = [
  {
    label: 'Something I\u2019ve been carrying…',
    body: 'Something I\u2019ve been carrying lately that I haven\u2019t said out loud:\n\n',
  },
  {
    label: 'What I needed this week…',
    body: 'What I really needed this week that I didn\u2019t ask for:\n\n',
  },
  {
    label: 'A moment I felt disconnected…',
    body: 'A moment this week when I felt disconnected from us, and what was going on for me:\n\n',
  },
  {
    label: 'Something I\u2019m afraid to say…',
    body: 'Something I\u2019m a bit scared to say, but I want you to know:\n\n',
  },
  {
    label: 'Something I appreciate but haven\u2019t said…',
    body: 'Something about you / us I\u2019ve been grateful for but haven\u2019t named:\n\n',
  },
  {
    label: 'A pattern I\u2019m noticing…',
    body: 'A pattern between us I\u2019ve been noticing (no blame — just observing):\n\n',
  },
];

interface Entry {
  entryId: string;
  authorId: string;
  content: string;
  otp: string;
  createdTs: number;
  unlockedTs: number;
  unlockedBy?: string;
  acks: Record<string, number>;
  readyToTalks: Record<string, number>;   // non-author signals they've processed
  resolutions: Record<string, number>;
}

interface TimeOutState {
  activeUntilTs: number;
  startedBy?: string;
  startedTs: number;
  endTs: number;
}

interface State {
  entries: Record<string, Entry>;
  timeOut: TimeOutState;
}

export function SafeSpace({
  autoOpenPostForm = false,
}: {
  /** When true, the post form is open as soon as the component mounts.
   *  Used by the safe-space route's ?compose=1 query so an orb-action
   *  long-press can drop the user straight into composing. Optional —
   *  existing callers (the home dashboard wrapper) opt out by default. */
  autoOpenPostForm?: boolean;
} = {}) {
  const { myUserId, members, room, displayNames } = useRoom();

  const state = useRoomProjection<State>((acc, rec) => {
    const ev = rec.event;
    const uid = rec.senderId;
    switch (ev.type) {
      case 'icebreaker_post': {
        if (acc.entries[ev.entryId]) return acc;
        return {
          ...acc,
          entries: {
            ...acc.entries,
            [ev.entryId]: {
              entryId: ev.entryId,
              authorId: uid,
              content: ev.content,
              otp: ev.otp,
              createdTs: ev.ts,
              unlockedTs: 0,
              acks: {},
              readyToTalks: {},
              resolutions: {},
            },
          },
        };
      }
      case 'icebreaker_unlock': {
        const e = acc.entries[ev.entryId];
        if (!e) return acc;
        if (e.unlockedTs) return acc;
        if (ev.otp !== e.otp) return acc;
        if (uid === e.authorId) return acc;
        return {
          ...acc,
          entries: {
            ...acc.entries,
            [ev.entryId]: { ...e, unlockedTs: ev.ts, unlockedBy: uid },
          },
        };
      }
      case 'icebreaker_ready_to_talk': {
        const e = acc.entries[ev.entryId];
        if (!e) return acc;
        if (uid === e.authorId) return acc;      // only the receiving partner
        const prior = e.readyToTalks[uid] ?? 0;
        if (prior >= ev.ts) return acc;
        return {
          ...acc,
          entries: {
            ...acc.entries,
            [ev.entryId]: {
              ...e,
              readyToTalks: { ...e.readyToTalks, [uid]: ev.ts },
            },
          },
        };
      }
      case 'icebreaker_ack': {
        // Legacy event kept for backwards compatibility with any rows
        // written by an earlier build. New UI emits `icebreaker_ready_to_talk`
        // instead. The reducer still records acks so existing data projects.
        const e = acc.entries[ev.entryId];
        if (!e) return acc;
        const prior = e.acks[uid] ?? 0;
        if (prior >= ev.ts) return acc;
        return {
          ...acc,
          entries: {
            ...acc.entries,
            [ev.entryId]: { ...e, acks: { ...e.acks, [uid]: ev.ts } },
          },
        };
      }
      case 'icebreaker_resolve': {
        const e = acc.entries[ev.entryId];
        if (!e) return acc;
        const prior = e.resolutions[uid] ?? 0;
        if (prior >= ev.ts) return acc;
        return {
          ...acc,
          entries: {
            ...acc.entries,
            [ev.entryId]: {
              ...e,
              resolutions: { ...e.resolutions, [uid]: ev.ts },
            },
          },
        };
      }
      case 'time_out_start': {
        const activeUntil = ev.ts + ev.durationSeconds * 1000;
        // Latest start wins (strictly newer).
        if (ev.ts <= acc.timeOut.startedTs) return acc;
        return {
          ...acc,
          timeOut: {
            activeUntilTs: activeUntil,
            startedBy: uid,
            startedTs: ev.ts,
            endTs: acc.timeOut.endTs,
          },
        };
      }
      case 'time_out_end': {
        if (ev.ts <= acc.timeOut.endTs) return acc;
        return {
          ...acc,
          timeOut: { ...acc.timeOut, endTs: ev.ts },
        };
      }
      default:
        return acc;
    }
  }, {
    entries: {},
    timeOut: { activeUntilTs: 0, startedTs: 0, endTs: 0 },
  });

  const currentMemberIds = useMemo(
    () =>
      room
        ? members
            .filter((m) => m.generation === room.current_generation)
            .map((m) => m.user_id)
        : [],
    [members, room],
  );

  // Map each member's userId → vibe hue, so EntryCard can paint the ghost
  // bubble's glowing border in the author's current vibe colour. Computed
  // once here and passed down so we don't re-project moods per card.
  const moods = useMemberMoods();
  const hueByUid = useMemo<Record<string, number>>(() => {
    const out: Record<string, number> = {};
    for (const m of moods) out[m.uid] = m.hue;
    return out;
  }, [moods]);

  // Ticking "now" for timeout countdown.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const h = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(h);
  }, []);

  const timeOutActive =
    state.timeOut.activeUntilTs > now &&
    state.timeOut.endTs < state.timeOut.startedTs;

  const { active, resolved } = useMemo(() => {
    const a: Entry[] = [];
    const r: Entry[] = [];
    for (const e of Object.values(state.entries)) {
      const allResolved =
        currentMemberIds.length > 0 &&
        currentMemberIds.every((uid) => e.resolutions[uid]);
      if (allResolved) r.push(e);
      else a.push(e);
    }
    a.sort((x, y) => y.createdTs - x.createdTs);
    r.sort((x, y) => latestResolveTs(y) - latestResolveTs(x));
    return { active: a, resolved: r };
  }, [state.entries, currentMemberIds]);

  const [posting, setPosting] = useState(autoOpenPostForm);

  if (!myUserId) return null;

  return (
    // Transparent surface so the cosmic mosaic + starfield show through —
    // the safe-space card lives inside a "room within a room" canvas, not
    // a standalone widget. Subtle slate outline keeps content grouped
    // without the warm amber lantern feel.
    <section className="rounded-2xl border border-slate-300/15 bg-transparent p-6 text-sm shadow-xl backdrop-blur-sm">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.1em] text-slate-300">
          <span>Safe space 🛡️</span>
          <HelpIcon
            label="Safe space"
            text="For conversations too heavy for regular chat. Post behind a 4-digit code, share the code out loud when you're both ready, unlock it, and mark it resolved together. Either of you can call a 20-minute time-out to pause."
          />
        </div>
        <TimeOutControls
          timeOut={state.timeOut}
          timeOutActive={timeOutActive}
          now={now}
        />
      </div>

      {timeOutActive && (
        <div className="mt-2 rounded border border-amber-400 bg-amber-100 p-2 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-900 dark:text-amber-100">
          <strong>Time-out active</strong> — Safe Space is paused until{' '}
          {new Date(state.timeOut.activeUntilTs).toLocaleTimeString()}.
          {state.timeOut.startedBy && (
            <>
              {' '}
              (called by{' '}
              {displayName(state.timeOut.startedBy, displayNames, myUserId)})
            </>
          )}
        </div>
      )}

      {!posting && !timeOutActive && (
        <button
          onClick={() => setPosting(true)}
          className="mt-3 rounded-full bg-slate-100/95 px-4 py-1.5 text-xs font-semibold text-slate-900 shadow-sm transition-all hover:bg-white hover:shadow-md active:scale-[0.98]"
        >
          + new entry
        </button>
      )}

      {posting && (
        <PostForm onDone={() => setPosting(false)} />
      )}

      {active.length === 0 && !posting && (
        <p className="mt-3 text-sm leading-relaxed text-slate-300/85">
          The safe space is quiet right now — open whenever you need it.
        </p>
      )}

      <ul className="mt-2 space-y-2">
        {active.map((e) => (
          <EntryCard
            key={e.entryId}
            entry={e}
            myUserId={myUserId}
            memberIds={currentMemberIds}
            timeOutActive={timeOutActive}
            displayNames={displayNames}
            authorHue={hueByUid[e.authorId] ?? 270}
          />
        ))}
      </ul>

      {resolved.length > 0 && (
        <details className="mt-4">
          <summary className="cursor-pointer text-[11px] font-medium uppercase tracking-[0.1em] text-slate-300/85 hover:text-slate-100">
            Resolved ({resolved.length})
          </summary>
          <ul className="mt-2 space-y-2">
            {resolved.map((e) => (
              <ResolvedCard
                key={e.entryId}
                entry={e}
                myUserId={myUserId}
                displayNames={displayNames}
                authorHue={hueByUid[e.authorId] ?? 270}
              />
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function latestResolveTs(e: Entry): number {
  let t = 0;
  for (const ts of Object.values(e.resolutions)) if (ts > t) t = ts;
  return t;
}

// ---------------------------------------------------------------------------

function TimeOutControls({
  timeOut,
  timeOutActive,
  now,
}: {
  timeOut: TimeOutState;
  timeOutActive: boolean;
  now: number;
}) {
  const { appendEvent } = useRoom();
  const [busy, setBusy] = useState(false);
  const [confirmingEnd, setConfirmingEnd] = useState(false);

  async function start() {
    if (!confirm(`Call a ${DEFAULT_TIMEOUT_SECONDS / 60}-min time-out?`)) return;
    setBusy(true);
    try {
      await appendEvent({
        type: 'time_out_start',
        durationSeconds: DEFAULT_TIMEOUT_SECONDS,
        ts: Date.now(),
      });
    } finally {
      setBusy(false);
    }
  }

  async function end() {
    setBusy(true);
    try {
      await appendEvent({ type: 'time_out_end', ts: Date.now() });
      setConfirmingEnd(false);
    } finally {
      setBusy(false);
    }
  }

  if (timeOutActive) {
    const remainingMs = Math.max(0, timeOut.activeUntilTs - now);
    const mm = Math.floor(remainingMs / 60000).toString().padStart(2, '0');
    const ss = Math.floor((remainingMs % 60000) / 1000).toString().padStart(2, '0');
    return (
      <div className="flex flex-col items-end gap-2">
        <div className="flex items-center gap-2">
          <span className="rounded-full bg-amber-100/85 px-3 py-1 font-display italic text-sm tabular-nums text-amber-950 shadow-sm ring-1 ring-amber-200/70 dark:bg-amber-900/70 dark:text-amber-100 dark:ring-amber-700/60">
            {mm}:{ss}
          </span>
          {!confirmingEnd && (
            <button
              onClick={() => setConfirmingEnd(true)}
              disabled={busy}
              className="group inline-flex items-center gap-2 rounded-full bg-gradient-to-br from-amber-200 via-amber-300 to-amber-400 px-5 py-2.5 font-display italic text-sm text-amber-950 shadow-[0_8px_22px_-4px_rgba(217,119,6,0.55),inset_0_2px_3px_rgba(255,255,255,0.6),inset_0_-3px_6px_rgba(146,64,14,0.25)] ring-1 ring-amber-200/70 transition-all hover:scale-[1.04] hover:shadow-[0_12px_28px_-4px_rgba(217,119,6,0.7),inset_0_2px_3px_rgba(255,255,255,0.6),inset_0_-3px_6px_rgba(146,64,14,0.25)] active:scale-[1.06] disabled:opacity-50"
            >
              <span aria-hidden className="text-base leading-none">🤍</span>
              <span>I&apos;m ready to come back</span>
            </button>
          )}
        </div>
        {confirmingEnd && (
          <div
            role="dialog"
            aria-label="Confirm end time-out"
            className="flex flex-wrap items-center justify-end gap-2 rounded-2xl border border-amber-400 bg-amber-100 p-2.5 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-900 dark:text-amber-100"
          >
            <span className="font-display">Are you sure you want to end this early?</span>
            <button
              onClick={() => setConfirmingEnd(false)}
              disabled={busy}
              autoFocus
              className="rounded-full bg-amber-900 px-3 py-1.5 font-display italic text-xs text-white disabled:opacity-50 dark:bg-amber-200 dark:text-amber-950"
            >
              keep going
            </button>
            <button
              onClick={() => void end()}
              disabled={busy}
              className="group inline-flex items-center gap-2 rounded-full bg-gradient-to-br from-amber-200 via-amber-300 to-amber-400 px-4 py-1.5 font-display italic text-xs text-amber-950 shadow-[0_6px_18px_-4px_rgba(217,119,6,0.55),inset_0_2px_3px_rgba(255,255,255,0.6),inset_0_-3px_6px_rgba(146,64,14,0.25)] ring-1 ring-amber-200/70 transition-all hover:scale-[1.04] active:scale-[1.06] disabled:opacity-50"
            >
              <span aria-hidden className="text-sm leading-none">🤍</span>
              <span>{busy ? 'ending…' : 'I\u2019m ready to come back'}</span>
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    // Time-out is the "we both need to step back" button. Claymorphic
    // amber glow, slow gentle pulse, sized + spaced so it reads as a
    // deliberate, important action rather than a tertiary control.
    <button
      onClick={() => void start()}
      disabled={busy}
      title="pause Safe Space for both of you for 20 minutes"
      className="group inline-flex items-center gap-2 rounded-full bg-gradient-to-br from-amber-200 via-amber-300 to-amber-400 px-5 py-2.5 font-display italic text-sm text-amber-950 shadow-[0_8px_22px_-4px_rgba(217,119,6,0.55),inset_0_2px_3px_rgba(255,255,255,0.6),inset_0_-3px_6px_rgba(146,64,14,0.25)] ring-1 ring-amber-200/70 transition-all hover:scale-[1.04] hover:shadow-[0_12px_28px_-4px_rgba(217,119,6,0.7),inset_0_2px_3px_rgba(255,255,255,0.6),inset_0_-3px_6px_rgba(146,64,14,0.25)] active:scale-[1.06] disabled:opacity-50"
    >
      <span aria-hidden className="text-base leading-none transition-transform group-hover:rotate-[-8deg]">
        ✋
      </span>
      <span>Call time-out</span>
    </button>
  );
}

// ---------------------------------------------------------------------------

function EntryCard({
  entry,
  myUserId,
  memberIds,
  timeOutActive,
  displayNames,
  authorHue,
}: {
  entry: Entry;
  myUserId: string;
  memberIds: string[];
  timeOutActive: boolean;
  displayNames: Record<string, string>;
  /** Hue (0–360) of the author's current vibe — drives the ghost-bubble glow. */
  authorHue: number;
}) {
  const { appendEvent } = useRoom();
  const isAuthor = entry.authorId === myUserId;
  const unlocked = !!entry.unlockedTs;
  const myReadyToTalk = !!entry.readyToTalks[myUserId];
  const myResolved = !!entry.resolutions[myUserId];
  const othersReadyToTalk = memberIds.filter(
    (u) => u !== myUserId && entry.readyToTalks[u],
  );
  const othersResolved = memberIds.filter(
    (u) => u !== myUserId && entry.resolutions[u],
  );

  const [otpInput, setOtpInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wrongOtp, setWrongOtp] = useState(false);

  async function submitUnlock(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setWrongOtp(false);
    if (!/^\d{4}$/.test(otpInput)) {
      setError('OTP must be four digits');
      return;
    }
    if (otpInput !== entry.otp) {
      setWrongOtp(true);
      return;
    }
    setBusy(true);
    try {
      await appendEvent({
        type: 'icebreaker_unlock',
        entryId: entry.entryId,
        otp: otpInput,
        ts: Date.now(),
      });
      setOtpInput('');
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  async function readyToTalk() {
    setBusy(true);
    setError(null);
    try {
      await appendEvent({
        type: 'icebreaker_ready_to_talk',
        entryId: entry.entryId,
        ts: Date.now(),
      });
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  async function resolve() {
    setBusy(true);
    setError(null);
    try {
      await appendEvent({
        type: 'icebreaker_resolve',
        entryId: entry.entryId,
        ts: Date.now(),
      });
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    // Ghost bubble: no fill, hue-matched glowing border. Hue comes from the
    // author's current vibe (drained=warm reds, lifted=pinks, mid=lavender),
    // so each entry visually carries who it's from.
    <li
      className="rounded-2xl border bg-transparent p-3 backdrop-blur-md transition-all"
      style={{
        borderColor: `hsla(${authorHue}, 75%, 65%, 0.55)`,
        boxShadow: `0 0 22px hsla(${authorHue}, 80%, 55%, 0.18), inset 0 0 18px hsla(${authorHue}, 70%, 60%, 0.06)`,
      }}
    >
      <div className="text-[11px] font-medium uppercase tracking-wide text-slate-300/85">
        {isAuthor
          ? 'you posted'
          : `from ${displayName(entry.authorId, displayNames, myUserId, null)}`}
        {' · '}
        <span className="text-slate-400/80">{new Date(entry.createdTs).toLocaleString()}</span>
      </div>

      {/* Author always sees their own content. Non-authors gated by OTP. */}
      {(isAuthor || unlocked) ? (
        <p className="mt-2 whitespace-pre-wrap break-words text-base leading-relaxed text-slate-50">{entry.content}</p>
      ) : (
        <div className="mt-2">
          <p className="text-sm leading-relaxed text-slate-300">
            Enter the 4-digit code your partner shared to unlock.
          </p>
          <form onSubmit={submitUnlock} className="mt-3 flex items-center gap-2">
            <input
              type="text"
              inputMode="numeric"
              pattern="\d{4}"
              maxLength={4}
              value={otpInput}
              onChange={(e) => {
                setOtpInput(e.target.value.replace(/\D/g, '').slice(0, 4));
                setWrongOtp(false);
              }}
              disabled={timeOutActive || busy}
              placeholder="0000"
              className="w-24 rounded-xl border border-white/15 bg-slate-900/60 px-3 py-2 text-center font-mono text-base font-semibold tabular-nums text-slate-50 outline-none focus:border-white/35 focus:ring-2 focus:ring-violet-400/40 disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={timeOutActive || busy || otpInput.length !== 4}
              className="rounded-full bg-gradient-to-br from-violet-300 via-violet-400 to-indigo-500 px-5 py-2 font-display italic text-sm text-white shadow-[0_8px_22px_-4px_rgba(124,58,237,0.55),inset_0_2px_3px_rgba(255,255,255,0.4),inset_0_-3px_6px_rgba(67,56,202,0.35)] ring-1 ring-violet-200/50 transition-all hover:scale-[1.04] active:scale-[1.06] disabled:opacity-50"
            >
              Unlock
            </button>
          </form>
          {wrongOtp && (
            <p className="mt-2 text-xs text-amber-300">
              wrong code — ask them again
            </p>
          )}
        </div>
      )}

      {/* OTP reminder visible only to author before unlock. */}
      {isAuthor && !unlocked && (
        <p className="mt-2 text-xs text-slate-300/85">
          share this code with your partner:{' '}
          <code className="rounded bg-slate-100/10 px-1.5 py-0.5 font-mono text-sm font-semibold tabular-nums text-slate-100">
            {entry.otp}
          </code>
        </p>
      )}

      {/* Status line */}
      <p className="mt-2 text-[11px] text-slate-400/85">
        {!unlocked ? (
          <>awaiting unlock</>
        ) : (
          <>
            unlocked by{' '}
            {entry.unlockedBy
              ? displayName(entry.unlockedBy, displayNames, myUserId)
              : 'someone'}
            {myReadyToTalk && ' · you marked ready to talk'}
            {othersReadyToTalk.length > 0 &&
              ` · ${othersReadyToTalk.length} partner(s) ready to talk`}
            {myResolved && ' · you resolved'}
            {othersResolved.length > 0 &&
              ` · ${othersResolved.length} partner(s) resolved`}
          </>
        )}
      </p>

      {/* Actions after unlock */}
      {unlocked && (
        <div className="mt-3 flex flex-wrap gap-2">
          {!isAuthor && !myReadyToTalk && (
            <button
              onClick={() => void readyToTalk()}
              disabled={busy}
              className="rounded-full bg-gradient-to-br from-violet-300 via-violet-400 to-indigo-500 px-4 py-2 font-display italic text-sm text-white shadow-[0_8px_22px_-4px_rgba(124,58,237,0.55),inset_0_2px_3px_rgba(255,255,255,0.4),inset_0_-3px_6px_rgba(67,56,202,0.35)] ring-1 ring-violet-200/50 transition-all hover:scale-[1.04] active:scale-[1.06] disabled:opacity-50"
            >
              I&apos;ve read this, let&apos;s talk
            </button>
          )}
          {!myResolved && (
            <button
              onClick={() => void resolve()}
              disabled={busy}
              className="rounded-full border border-white/20 bg-white/5 px-4 py-2 font-display italic text-sm text-slate-100 transition-all hover:scale-[1.04] hover:bg-white/10 active:scale-[1.02] disabled:opacity-50"
            >
              Mark resolved
            </button>
          )}
        </div>
      )}

      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </li>
  );
}

// ---------------------------------------------------------------------------

function ResolvedCard({
  entry,
  myUserId,
  displayNames,
  authorHue,
}: {
  entry: Entry;
  myUserId: string;
  displayNames: Record<string, string>;
  authorHue: number;
}) {
  return (
    // Resolved entries: ghost bubble too, but more muted — half the glow,
    // softer border. They've been worked through, they don't need to shout.
    <li
      className="rounded-2xl border bg-transparent p-3 backdrop-blur-md"
      style={{
        borderColor: `hsla(${authorHue}, 50%, 65%, 0.35)`,
        boxShadow: `0 0 14px hsla(${authorHue}, 60%, 55%, 0.1)`,
      }}
    >
      <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-emerald-800 dark:text-emerald-300">
        resolved · posted {new Date(entry.createdTs).toLocaleString()}
      </div>
      <p className="mt-1 text-[10px] text-neutral-500">
        by {displayName(entry.authorId, displayNames, myUserId)}
      </p>
      <p className="mt-1 whitespace-pre-wrap break-words text-xs">
        {entry.content}
      </p>
    </li>
  );
}

// ---------------------------------------------------------------------------

function PostForm({ onDone }: { onDone: () => void }) {
  const { appendEvent } = useRoom();
  const [content, setContent] = useState('');
  const [otp, setOtp] = useState(() =>
    Math.floor(1000 + Math.random() * 9000).toString(),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!content.trim()) return;
    if (!/^\d{4}$/.test(otp)) {
      setError('OTP must be four digits');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await appendEvent({
        type: 'icebreaker_post',
        entryId: crypto.randomUUID(),
        content: content.trim(),
        otp,
        ts: Date.now(),
      });
      setContent('');
      onDone();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  function rerollOtp() {
    setOtp(Math.floor(1000 + Math.random() * 9000).toString());
  }

  function applyTemplate(idx: number) {
    if (idx < 0 || idx >= TEMPLATES.length) return;
    const body = TEMPLATES[idx].body;
    setContent((prev) => (prev.trim().length === 0 ? body : prev + '\n\n' + body));
  }

  return (
    <form
      onSubmit={submit}
      className="mt-3 space-y-4 rounded-2xl border border-white/15 bg-slate-950/35 p-5 shadow-2xl backdrop-blur-md"
    >
      <p className="text-sm leading-relaxed text-slate-300">
        Write what&apos;s sitting with you. A 4-digit code is attached — share
        it with your partner out loud when you&apos;re both ready for them to
        open this.
      </p>

      <div className="space-y-1.5">
        <label className="block text-[11px] font-medium uppercase tracking-[0.18em] text-slate-400">
          Prompt
        </label>
        <select
          defaultValue=""
          onChange={(e) => {
            const idx = Number(e.target.value);
            if (!Number.isNaN(idx)) applyTemplate(idx);
            e.target.value = '';
          }}
          disabled={busy}
          className="block w-full rounded-xl border border-white/15 bg-slate-900/60 px-3 py-2.5 text-sm text-slate-100 outline-none transition-colors focus:border-white/35 focus:ring-2 focus:ring-violet-400/40 disabled:opacity-50"
        >
          <option value="">start from a prompt…</option>
          {TEMPLATES.map((t, i) => (
            <option key={t.label} value={i}>
              {t.label}
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-1.5">
        <label className="block text-[11px] font-medium uppercase tracking-[0.18em] text-slate-400">
          What&apos;s going on for you?
        </label>
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="just start typing — they won't see it until you share the code"
          required
          rows={6}
          maxLength={4000}
          className="block w-full rounded-2xl border border-white/15 bg-slate-900/60 p-4 text-base leading-relaxed text-slate-50 placeholder:italic placeholder:text-slate-500 outline-none transition-colors focus:border-white/35 focus:ring-2 focus:ring-violet-400/40"
        />
      </div>

      <div className="flex items-center gap-3">
        <label className="text-[11px] font-medium uppercase tracking-[0.18em] text-slate-400">
          Code
        </label>
        <input
          type="text"
          inputMode="numeric"
          pattern="\d{4}"
          maxLength={4}
          value={otp}
          onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 4))}
          className="w-24 rounded-xl border border-white/15 bg-slate-900/60 px-3 py-2 text-center font-mono text-base font-semibold tabular-nums text-slate-50 outline-none focus:border-white/35 focus:ring-2 focus:ring-violet-400/40"
        />
        <button
          type="button"
          onClick={rerollOtp}
          disabled={busy}
          className="rounded-full border border-white/20 bg-white/5 px-3 py-1.5 font-display italic text-[11px] text-slate-200 transition-all hover:scale-[1.04] hover:bg-white/10 active:scale-[1.02] disabled:opacity-50"
        >
          ↻ reroll
        </button>
      </div>

      <div className="flex gap-2 pt-1">
        <button
          type="submit"
          disabled={busy || !content.trim() || !/^\d{4}$/.test(otp)}
          className="rounded-full bg-gradient-to-br from-violet-300 via-violet-400 to-indigo-500 px-6 py-2.5 font-display italic text-sm text-white shadow-[0_8px_22px_-4px_rgba(124,58,237,0.55),inset_0_2px_3px_rgba(255,255,255,0.4),inset_0_-3px_6px_rgba(67,56,202,0.35)] ring-1 ring-violet-200/50 transition-all hover:scale-[1.04] hover:shadow-[0_12px_28px_-4px_rgba(124,58,237,0.7),inset_0_2px_3px_rgba(255,255,255,0.4),inset_0_-3px_6px_rgba(67,56,202,0.35)] active:scale-[1.06] disabled:opacity-50"
        >
          {busy ? 'posting…' : 'post'}
        </button>
        <button
          type="button"
          onClick={onDone}
          disabled={busy}
          className="rounded-full border border-white/20 bg-white/5 px-5 py-2.5 font-display italic text-sm text-slate-200 transition-all hover:scale-[1.04] hover:bg-white/10 active:scale-[1.02] disabled:opacity-50"
        >
          cancel
        </button>
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </form>
  );
}
