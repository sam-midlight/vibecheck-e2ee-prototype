'use client';

/**
 * Low-Stakes Roulette — collaborative decision wheel with deterministic
 * E2EE sync.
 *
 * Data shape:
 *   Slice  { sliceId, label, addedBy, addedTs }     projection of *_add/*_remove
 *   Spin   { spinId, slicesSnapshot, winnerSliceId, fullRotations, ts }
 *
 * Why a snapshot + rotations count in the spin event:
 *   Everyone needs to land their wheel on the same slice after the same
 *   amount of visible spinning. The sender computes a random winner locally,
 *   snapshots the slices, and emits the event. Each client (including the
 *   sender, optimistically) converts that into a local target rotation that
 *   ends with the winner under the pointer. The `fullRotations` number is
 *   sent so the animation duration + drama is identical for everyone;
 *   the exact start wall-clock drifts by realtime round-trip only.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { displayName } from '@/lib/domain/displayName';
import { useRoom, useRoomProjection } from './RoomProvider';

// ---- Domain ---------------------------------------------------------------

interface Slice {
  sliceId: string;
  label: string;
  addedBy: string;
  addedTs: number;
}

interface SpinState {
  spinId: string;
  slicesSnapshot: { sliceId: string; label: string }[];
  winnerSliceId: string;
  fullRotations: number;
  ts: number;
  triggeredBy: string;
}

// Visual constants.
const WHEEL_SIZE = 240; // px
const WHEEL_RADIUS = WHEEL_SIZE / 2;
const LABEL_RADIUS_RATIO = 0.62; // labels sit at 62% of radius
const SPIN_DURATION_MS = 3500;
const SLICE_COLORS = [
  '#f472b6', // pink-400
  '#60a5fa', // blue-400
  '#a78bfa', // violet-400
  '#fbbf24', // amber-400
  '#34d399', // emerald-400
  '#fb7185', // rose-400
  '#818cf8', // indigo-400
  '#22d3ee', // cyan-400
  '#c084fc', // purple-400
  '#f97316', // orange-500
];
const MIN_SLICES = 2;
const MAX_SLICES = 30;

// ---- Component ------------------------------------------------------------

/** Which event namespace this wheel reads/writes. Lets a second instance
 *  (on the Date Night tab) keep a distinct slice pool without bleeding
 *  into the home orb's wheel. Default = 'home'. */
export type RouletteVariant = 'home' | 'date_night';

/**
 * `dateId` opts the wheel into a per-date vault scope. When set:
 *   - reads/writes use the `date_roulette_*` event family (same as
 *     variant='date_night') AND filter by matching `ev.dateId`.
 *   - emitted events carry `dateId` so the room-level wheel skips them.
 *   - When unset, behaviour falls back to the variant prop alone.
 */
export function Roulette({
  variant = 'home',
  dateId,
}: {
  variant?: RouletteVariant;
  dateId?: string;
} = {}) {
  const { appendEvent, myUserId, displayNames } = useRoom();
  // dateId implies the date_roulette_* event family even if the
  // caller forgot to pass variant='date_night'.
  const isDateNight = variant === 'date_night' || dateId != null;
  const isVaultScoped = dateId != null;

  const slices = useRoomProjection<Slice[]>((acc, rec) => {
    const ev = rec.event;
    const addType = isDateNight ? 'date_roulette_slice_add' : 'roulette_slice_add';
    const removeType = isDateNight ? 'date_roulette_slice_remove' : 'roulette_slice_remove';
    if (ev.type === addType) {
      const evDateId = 'dateId' in ev ? ev.dateId : undefined;
      if (isVaultScoped) {
        // Vault wheel only consumes events for THIS date.
        if (evDateId !== dateId) return acc;
      } else if (isDateNight) {
        // Room-level date-night wheel skips per-date vault slices.
        if (evDateId) return acc;
      }
      if (acc.find((s) => s.sliceId === ev.sliceId)) return acc;
      return [
        ...acc,
        {
          sliceId: ev.sliceId,
          label: ev.label,
          addedBy: rec.senderId,
          addedTs: ev.ts,
        },
      ];
    }
    if (ev.type === removeType) {
      const evDateId = 'dateId' in ev ? ev.dateId : undefined;
      if (isVaultScoped) {
        if (evDateId !== dateId) return acc;
      } else if (isDateNight) {
        if (evDateId) return acc;
      }
      return acc.filter((s) => s.sliceId !== ev.sliceId);
    }
    return acc;
  }, [], [isDateNight, isVaultScoped, dateId]);

  // Keep only the most recent spin event — prior spins are history we don't
  // need to replay.
  const latestSpin = useRoomProjection<SpinState | null>((acc, rec) => {
    const spinType = isDateNight ? 'date_roulette_spin' : 'roulette_spin';
    if (rec.event.type !== spinType) return acc;
    const evDateId = 'dateId' in rec.event ? rec.event.dateId : undefined;
    if (isVaultScoped) {
      if (evDateId !== dateId) return acc;
    } else if (isDateNight) {
      if (evDateId) return acc;
    }
    if (acc && acc.ts > rec.event.ts) return acc;
    return {
      spinId: rec.event.spinId,
      slicesSnapshot: rec.event.slicesSnapshot,
      winnerSliceId: rec.event.winnerSliceId,
      fullRotations: rec.event.fullRotations,
      ts: rec.event.ts,
      triggeredBy: rec.senderId,
    };
  }, null, [isDateNight, isVaultScoped, dateId]);

  // Local rotation accumulator. Never normalized — CSS handles unbounded
  // rotation values fine, and keeping a growing value means sequential spins
  // each run a fresh full-rotation animation without visually stuttering.
  const [rotationDeg, setRotationDeg] = useState<number>(0);
  const [animating, setAnimating] = useState<boolean>(false);
  // handledSpinId is a ref, not state — putting it in state and the effect's
  // deps caused the effect to re-run as soon as we set it inside, which
  // immediately ran the cleanup and cancelled the "spin done" timer. After
  // the first spin, animating would stay `true` forever and the button would
  // stay disabled until the component remounted.
  const handledSpinIdRef = useRef<string | null>(null);
  const [winnerSliceId, setWinnerSliceId] = useState<string | null>(null);
  const [celebration, setCelebration] = useState<SpinState | null>(null);

  useEffect(() => {
    if (!latestSpin) return;
    if (handledSpinIdRef.current === latestSpin.spinId) return;
    handledSpinIdRef.current = latestSpin.spinId;

    // Compute a LOCAL target rotation that ends with the winner under the
    // pointer, regardless of where the wheel currently sits. All clients
    // apply the same fullRotations, so the animation reads identically.
    const snap = latestSpin.slicesSnapshot;
    const winnerIdx = snap.findIndex(
      (s) => s.sliceId === latestSpin.winnerSliceId,
    );
    if (winnerIdx === -1) return;
    const sliceAngle = 360 / snap.length;
    const winnerCenter = winnerIdx * sliceAngle + sliceAngle / 2;
    // Visual target: -winnerCenter mod 360 lands the winner at 0° (top).
    const visualTarget = ((360 - winnerCenter) % 360 + 360) % 360;
    const currentVisual = ((rotationDeg % 360) + 360) % 360;
    const deltaVisual =
      (visualTarget - currentVisual + 360) % 360;
    const nextRotation =
      rotationDeg + latestSpin.fullRotations * 360 + deltaVisual;

    // If the spin is very old (user opened the room after everyone spun
    // and left), skip the animation and jump to final state — reduces jank
    // and gets out of the way of live activity.
    const age = Date.now() - latestSpin.ts;
    if (age > SPIN_DURATION_MS + 5000) {
      setRotationDeg(nextRotation);
      setWinnerSliceId(latestSpin.winnerSliceId);
      setCelebration(null);
      return;
    }

    // Normal path: fire transition.
    setAnimating(true);
    setWinnerSliceId(null);
    setCelebration(null);
    requestAnimationFrame(() => setRotationDeg(nextRotation));
    const done = setTimeout(() => {
      setAnimating(false);
      setWinnerSliceId(latestSpin.winnerSliceId);
      setCelebration(latestSpin);
    }, SPIN_DURATION_MS);
    return () => clearTimeout(done);
    // `rotationDeg` is intentionally excluded — we only want to react to a
    // NEW spin, not to our own rotation side-effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latestSpin]);

  async function addSlice(label: string) {
    if (slices.length >= MAX_SLICES) return;
    const sliceId = crypto.randomUUID();
    const labelTrimmed = label.trim().slice(0, 60);
    const ts = Date.now();
    if (isDateNight) {
      await appendEvent({
        type: 'date_roulette_slice_add',
        sliceId,
        label: labelTrimmed,
        dateId,
        ts,
      });
    } else {
      await appendEvent({ type: 'roulette_slice_add', sliceId, label: labelTrimmed, ts });
    }
  }

  async function removeSlice(sliceId: string) {
    const ts = Date.now();
    if (isDateNight) {
      await appendEvent({
        type: 'date_roulette_slice_remove',
        sliceId,
        dateId,
        ts,
      });
    } else {
      await appendEvent({ type: 'roulette_slice_remove', sliceId, ts });
    }
  }

  async function handleSpin() {
    if (slices.length < MIN_SLICES || animating) return;
    const winnerIdx = pickRandomIndex(slices.length);
    const winner = slices[winnerIdx];
    const fullRotations = 4 + pickRandomIndex(4); // 4–7 turns
    const spinId = crypto.randomUUID();
    const slicesSnapshot = slices.map((s) => ({ sliceId: s.sliceId, label: s.label }));
    const ts = Date.now();
    if (isDateNight) {
      await appendEvent({
        type: 'date_roulette_spin',
        spinId,
        slicesSnapshot,
        winnerSliceId: winner.sliceId,
        fullRotations,
        dateId,
        ts,
      });
    } else {
      await appendEvent({
        type: 'roulette_spin',
        spinId,
        slicesSnapshot,
        winnerSliceId: winner.sliceId,
        fullRotations,
        ts,
      });
    }
  }

  if (!myUserId) return null;

  const canSpin = slices.length >= MIN_SLICES && !animating;

  return (
    <section className="rounded-2xl border border-white/50 bg-fuchsia-50/70 p-6 text-sm shadow-xl backdrop-blur-md dark:border-white/10 dark:bg-fuchsia-950/40">
      <div className="flex items-center justify-between">
        <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-fuchsia-800 dark:text-fuchsia-300">
          Roulette 🎡
        </div>
        {animating && (
          <span className="text-[11px] font-medium uppercase tracking-[0.18em] text-fuchsia-700/70 dark:text-fuchsia-200">
            spinning…
          </span>
        )}
      </div>

      <div className="mt-4 flex flex-col items-center gap-4">
        <Wheel
          slices={slices}
          rotationDeg={rotationDeg}
          animating={animating}
          winnerSliceId={winnerSliceId}
        />

        <button
          type="button"
          onClick={() => void handleSpin()}
          disabled={!canSpin}
          className="rounded-full bg-fuchsia-900 px-6 py-2 text-sm font-medium text-white shadow-md transition-all hover:shadow-lg active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50 dark:bg-fuchsia-200 dark:text-fuchsia-950"
        >
          {animating
            ? 'spinning…'
            : slices.length < MIN_SLICES
              ? `add ${MIN_SLICES - slices.length} more`
              : 'spin'}
        </button>
      </div>

      {celebration && !animating && (
        <WinnerBanner
          slices={slices}
          snapshot={celebration.slicesSnapshot}
          winnerSliceId={celebration.winnerSliceId}
          triggeredBy={celebration.triggeredBy}
          myUserId={myUserId}
          displayNames={displayNames}
        />
      )}

      <SliceManager
        slices={slices}
        onAdd={addSlice}
        onRemove={removeSlice}
        busy={animating}
      />
    </section>
  );
}

// ---- Wheel drawing --------------------------------------------------------

function Wheel({
  slices,
  rotationDeg,
  animating,
  winnerSliceId,
}: {
  slices: Slice[];
  rotationDeg: number;
  animating: boolean;
  winnerSliceId: string | null;
}) {
  const sliceAngle = slices.length > 0 ? 360 / slices.length : 360;
  const labelR = WHEEL_RADIUS * LABEL_RADIUS_RATIO;

  // Conic-gradient background colour stops for each slice.
  const gradient = useMemo(() => {
    if (slices.length === 0) return 'conic-gradient(#e5e7eb 0deg 360deg)';
    const stops = slices
      .map((s, i) => {
        const color = SLICE_COLORS[i % SLICE_COLORS.length];
        const from = i * sliceAngle;
        const to = (i + 1) * sliceAngle;
        return `${color} ${from}deg ${to}deg`;
      })
      .join(', ');
    return `conic-gradient(from 0deg, ${stops})`;
  }, [slices, sliceAngle]);

  return (
    <div
      className="relative"
      style={{ width: WHEEL_SIZE, height: WHEEL_SIZE }}
    >
      {/* Fixed pointer at top */}
      <div
        aria-hidden
        className="absolute left-1/2 top-0 z-10 -translate-x-1/2 -translate-y-1"
        style={{ filter: 'drop-shadow(0 2px 3px rgba(0,0,0,0.25))' }}
      >
        <div
          className="h-5 w-5 bg-neutral-900 dark:bg-white"
          style={{ clipPath: 'polygon(50% 100%, 0 0, 100% 0)' }}
        />
      </div>

      {/* Rotating wheel */}
      <div
        className="absolute inset-0 rounded-full shadow-lg ring-4 ring-white/80 dark:ring-neutral-900/80"
        style={{
          background: gradient,
          transform: `rotate(${rotationDeg}deg)`,
          transition: animating
            ? `transform ${SPIN_DURATION_MS}ms cubic-bezier(0.22, 0.9, 0.2, 1)`
            : 'none',
        }}
      >
        {slices.map((s, i) => {
          const centerAngle = i * sliceAngle + sliceAngle / 2;
          const isWinner = s.sliceId === winnerSliceId;
          return (
            <div
              key={s.sliceId}
              className="absolute left-1/2 top-1/2 origin-[0_0]"
              style={{
                transform: `rotate(${centerAngle}deg) translateY(-${labelR}px) rotate(-${centerAngle}deg) translate(-50%, -50%)`,
              }}
            >
              <span
                className={`inline-block max-w-[80px] truncate rounded-full px-2 py-0.5 text-[11px] font-semibold leading-none shadow-sm transition-all ${
                  isWinner
                    ? 'bg-white text-neutral-900 ring-2 ring-neutral-900 dark:bg-neutral-900 dark:text-white dark:ring-white'
                    : 'bg-white/85 text-neutral-900 dark:bg-neutral-900/85 dark:text-neutral-100'
                }`}
                title={s.label}
              >
                {s.label}
              </span>
            </div>
          );
        })}
      </div>

      {/* Hub */}
      <div
        aria-hidden
        className="absolute left-1/2 top-1/2 h-10 w-10 -translate-x-1/2 -translate-y-1/2 rounded-full border-4 border-white bg-neutral-900 shadow-md dark:border-neutral-900 dark:bg-white"
      />
    </div>
  );
}

// ---- Winner banner --------------------------------------------------------

function WinnerBanner({
  slices,
  snapshot,
  winnerSliceId,
  triggeredBy,
  myUserId,
  displayNames,
}: {
  slices: Slice[];
  snapshot: { sliceId: string; label: string }[];
  winnerSliceId: string;
  triggeredBy: string;
  myUserId: string;
  displayNames: Record<string, string>;
}) {
  // Prefer the live label (keeps renames consistent) but fall back to the
  // snapshot so a since-deleted slice still displays its winning name.
  const liveLabel =
    slices.find((s) => s.sliceId === winnerSliceId)?.label;
  const snapshotLabel =
    snapshot.find((s) => s.sliceId === winnerSliceId)?.label;
  const label = liveLabel ?? snapshotLabel ?? '—';
  const spinner =
    triggeredBy === myUserId
      ? 'you'
      : displayName(triggeredBy, displayNames, myUserId);
  return (
    <div className="mt-4 rounded-2xl border border-fuchsia-300/60 bg-white/80 p-4 text-center shadow-md backdrop-blur-md dark:border-fuchsia-700/60 dark:bg-neutral-900/70">
      <p className="text-[10px] uppercase tracking-[0.2em] text-fuchsia-700 dark:text-fuchsia-300">
        Winner
      </p>
      <p className="mt-1 text-xl font-semibold text-neutral-900 dark:text-neutral-100">
        🎉 {label}
      </p>
      <p className="mt-1 text-[11px] text-neutral-500">spun by {spinner}</p>
    </div>
  );
}

// ---- Slice manager --------------------------------------------------------

function SliceManager({
  slices,
  onAdd,
  onRemove,
  busy,
}: {
  slices: Slice[];
  onAdd: (label: string) => Promise<void>;
  onRemove: (sliceId: string) => Promise<void>;
  busy: boolean;
}) {
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = draft.trim();
    if (!trimmed) return;
    await onAdd(trimmed);
    setDraft('');
    inputRef.current?.focus();
  }

  return (
    <div className="mt-4 space-y-2">
      <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-fuchsia-800 dark:text-fuchsia-300">
        Slices ({slices.length})
      </p>
      <ul className="flex flex-wrap gap-1.5">
        {slices.map((s, i) => (
          <li
            key={s.sliceId}
            className="inline-flex items-center gap-1 rounded-full border border-fuchsia-200/70 bg-white/70 py-0.5 pl-2 pr-1 text-[11px] shadow-sm backdrop-blur-md dark:border-fuchsia-800/50 dark:bg-neutral-900/60"
          >
            <span
              aria-hidden
              className="h-2 w-2 flex-shrink-0 rounded-full"
              style={{
                backgroundColor: SLICE_COLORS[i % SLICE_COLORS.length],
              }}
            />
            <span className="max-w-[120px] truncate text-neutral-800 dark:text-neutral-200">
              {s.label}
            </span>
            <button
              type="button"
              onClick={() => void onRemove(s.sliceId)}
              disabled={busy}
              aria-label={`remove ${s.label}`}
              className="rounded-full px-1 text-neutral-500 hover:bg-red-500/10 hover:text-red-700 disabled:opacity-40"
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      <form onSubmit={submit} className="flex gap-2">
        <input
          ref={inputRef}
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value.slice(0, 60))}
          placeholder="add a slice…"
          disabled={busy || slices.length >= MAX_SLICES}
          maxLength={60}
          className="flex-1 rounded-xl border border-fuchsia-200 bg-white/85 px-3 py-2 text-sm text-neutral-900 placeholder:italic placeholder:text-fuchsia-300 outline-none transition-colors focus:border-fuchsia-300 focus:ring-2 focus:ring-fuchsia-300/40 disabled:opacity-50 dark:border-fuchsia-800 dark:bg-neutral-950 dark:text-neutral-100"
        />
        <button
          type="submit"
          disabled={!draft.trim() || busy || slices.length >= MAX_SLICES}
          className="rounded-full border border-fuchsia-300 bg-white/80 px-4 py-2 font-display italic text-sm text-fuchsia-900 transition-all hover:scale-[1.04] hover:bg-white active:scale-[1.02] disabled:opacity-50 dark:border-fuchsia-700 dark:bg-neutral-900/60 dark:text-fuchsia-200"
        >
          add
        </button>
      </form>
      {slices.length >= MAX_SLICES && (
        <p className="text-[10px] text-neutral-500">
          max {MAX_SLICES} slices reached
        </p>
      )}
    </div>
  );
}

// ---- Helpers --------------------------------------------------------------

/** Unbiased integer [0, n). Uses crypto for boring-decision fairness. */
function pickRandomIndex(n: number): number {
  if (n <= 0) return 0;
  // Rejection sampling over a 32-bit word to avoid modulo bias.
  const maxValid = Math.floor(0xffffffff / n) * n;
  const buf = new Uint32Array(1);
  for (let attempt = 0; attempt < 8; attempt++) {
    crypto.getRandomValues(buf);
    if (buf[0] < maxValid) return buf[0] % n;
  }
  // Fallback (extremely rare): accept a mildly biased value.
  return buf[0] % n;
}
