'use client';

/**
 * Gratitude.
 *
 * Append-only `gratitude_send { to, amount, message }`. Any member may send
 * to any other member. No delete, no edit — gratitude is a permanent gift.
 *
 * Projections:
 *   - balances: sum of received amounts per userId
 *   - feed: chronological list of events
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { displayName } from '@/lib/domain/displayName';
import { useHeartBalances } from '@/lib/domain/hearts';
import { describeError } from '@/lib/domain/errors';
import { uniqueMembers } from '@/lib/domain/members';
import { HelpIcon } from './HelpIcon';
import { Clay } from './design/Clay';
import { Icon } from './design/Icon';
import { SectionHeader } from './design/SectionHeader';
import { useDesignMode } from './design/useDesignMode';
import { ReactionBar } from './Reactions';
import { useRoom, useRoomProjection } from './RoomProvider';
import type { RoomEventRecord } from './RoomProvider';

/** Stable hue per userId — turns the user's UUID into a hex hex-rotated
 *  through warm-design-system anchors so two members get visibly distinct
 *  but on-palette mini-orbs in the gratitude feed. */
const MEMBER_HUES = ['#D97A8C', '#E8A04B', '#7FA8C9', '#C967A3', '#9A7A3E', '#6B9A7A', '#B89EC4', '#FF8FA3'];
function hueForUser(userId: string): string {
  let h = 0;
  for (let i = 0; i < userId.length; i++) h = (h * 31 + userId.charCodeAt(i)) | 0;
  return MEMBER_HUES[Math.abs(h) % MEMBER_HUES.length];
}

function MemberDot({ userId, name, size = 22 }: { userId: string; name: string; size?: number }) {
  const hue = hueForUser(userId);
  const initial = (name?.[0] ?? '?').toUpperCase();
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: `radial-gradient(circle at 30% 28%, ${hue}aa, ${hue}ee)`,
        boxShadow: `inset 0 1px 2px rgba(255,255,255,0.5), inset 0 -2px 3px rgba(0,0,0,0.2), 0 2px 6px -2px ${hue}99`,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'rgba(255,255,255,0.95)',
        fontFamily: 'var(--font-sans), Geist, system-ui, sans-serif',
        fontWeight: 600,
        fontSize: Math.round(size * 0.4),
        flexShrink: 0,
      }}
    >
      {initial}
    </div>
  );
}

export function Gratitude() {
  const { myUserId, members, room, displayNames } = useRoom();

  // Balance is now cross-feature: gratitude received + bribes received
  // − bribes sent. See useHeartBalances() for the single-pass implementation.
  const balances = useHeartBalances();

  const feed = useRoomProjection<RoomEventRecord[]>((acc, rec) => {
    if (rec.event.type !== 'gratitude_send') return acc;
    return [...acc, rec];
  }, [], []);

  const sorted = useMemo(
    () => [...feed].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [feed],
  );

  const otherMembers = useMemo(
    () =>
      room
        ? uniqueMembers(members, room.current_generation).filter(
            (m) => m.user_id !== myUserId,
          )
        : [],
    [members, room, myUserId],
  );

  return <GratitudeBanner myUserId={myUserId} balances={balances} sorted={sorted} otherMembers={otherMembers} displayNames={displayNames} />;
}

function GratitudeBanner({
  myUserId,
  balances,
  sorted,
  otherMembers,
  displayNames,
}: {
  myUserId: string | null;
  balances: Record<string, number>;
  sorted: RoomEventRecord[];
  otherMembers: { user_id: string }[];
  displayNames: Record<string, string>;
}) {
  const { t } = useDesignMode();
  return (
    <Clay radius={20} style={{ padding: 14 }}>
      <SectionHeader
        label="Gratitude"
        emoji="🙏"
        trailing={
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {myUserId && (
              <div
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 5,
                  padding: '3px 9px',
                  borderRadius: 999,
                  background: t.surfaceAlt,
                  fontFamily: 'var(--font-mono), JetBrains Mono, monospace',
                  fontSize: 10.5,
                  color: t.ink,
                  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.5)',
                }}
              >
                <Icon name="heart" size={10} color={t.ember} />
                {balances[myUserId] ?? 0}
              </div>
            )}
            <HelpIcon
              label="Gratitude"
              text="Send 1–5 hearts with a short note. Append-only — no edits, no deletes. Received hearts add to your balance; you can spend hearts to boost a date idea or reveal a Mind Reader thought."
            />
          </div>
        }
      />

      {/* Send form — compact composer, only when there's someone to thank. */}
      {otherMembers.length > 0 && (
        <SendForm
          otherMembers={otherMembers.map((m) => m.user_id)}
          displayNames={displayNames}
          myUserId={myUserId}
        />
      )}

      {otherMembers.length === 0 && (
        <p style={{ color: t.inkDim, fontSize: 12.5, marginTop: 6 }}>
          Invite someone into this room to start sending gratitude.
        </p>
      )}

      {/* Feed — entry rows matching the mock: from-orb → chevron → to-orb,
          message on the right. Newest first, tight spacing. */}
      {sorted.length === 0 ? (
        <p style={{ color: t.inkDim, fontSize: 12.5, marginTop: 10, lineHeight: 1.5 }}>
          No gratitude yet. Be the one to go first 🙏
        </p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 10 }}>
          {sorted.map((rec) => {
            if (rec.event.type !== 'gratitude_send') return null;
            const fromName = displayName(rec.senderId, displayNames, myUserId);
            const toName = displayName(rec.event.to, displayNames, myUserId);
            const hearts = '♥'.repeat(rec.event.amount);
            return (
              <div
                key={rec.id}
                style={{
                  display: 'flex',
                  gap: 10,
                  padding: '8px 10px',
                  borderRadius: 12,
                  background: t.base,
                  boxShadow: t.clayInset,
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                    flexShrink: 0,
                  }}
                >
                  <MemberDot userId={rec.senderId} name={fromName} size={18} />
                  <span aria-hidden style={{ display: 'inline-flex', color: t.inkFaint }}>
                    <Icon name="chevron" size={8} style={{ transform: 'rotate(-90deg)' }} />
                  </span>
                  <MemberDot userId={rec.event.to} name={toName} size={18} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  {rec.event.message && (
                    <p
                      style={{
                        fontSize: 12.5,
                        color: t.ink,
                        lineHeight: 1.35,
                        margin: 0,
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                      }}
                    >
                      {rec.event.message}
                    </p>
                  )}
                  <div
                    style={{
                      marginTop: rec.event.message ? 2 : 0,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      fontSize: 10,
                      color: t.inkDim,
                    }}
                  >
                    <span style={{ color: t.ember }}>{hearts}</span>
                    <span style={{ fontFamily: 'var(--font-mono), JetBrains Mono, monospace', fontSize: 9.5 }}>
                      {new Date(rec.createdAt).toLocaleDateString([], {
                        month: 'short',
                        day: 'numeric',
                      })}
                    </span>
                  </div>
                  {!rec.id.startsWith('temp-') && <ReactionBar targetId={rec.id} />}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Clay>
  );
}

function SendForm({
  otherMembers,
  displayNames,
  myUserId,
}: {
  otherMembers: string[];
  displayNames: Record<string, string>;
  myUserId: string | null;
}) {
  const { appendEvent } = useRoom();
  const [to, setTo] = useState<string>(otherMembers[0] ?? '');
  const [amount, setAmount] = useState<number>(1);
  const [message, setMessage] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!to) return;
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      await appendEvent({
        type: 'gratitude_send',
        to,
        amount,
        message: message.trim(),
        ts: Date.now(),
      });
      setMessage('');
      setAmount(1);
      setStatus('sent ♥');
      setTimeout(() => setStatus(null), 2000);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={send}
      className="mt-2 space-y-2 rounded-xl border border-white/60 bg-white/80 p-3 shadow-sm backdrop-blur-md dark:border-white/10 dark:bg-neutral-900/60"
    >
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-[11px] font-medium uppercase tracking-[0.18em] text-neutral-500">
          To
        </label>
        <select
          value={to}
          onChange={(e) => setTo(e.target.value)}
          className="rounded-xl border border-rose-200 bg-white/90 px-3 py-1.5 text-sm text-rose-900 outline-none transition-colors focus:ring-2 focus:ring-rose-300/60 dark:border-rose-800 dark:bg-neutral-950 dark:text-rose-200"
        >
          {otherMembers.map((uid) => (
            <option key={uid} value={uid}>
              {displayName(uid, displayNames, myUserId, null)}
            </option>
          ))}
        </select>
      </div>

      <ChargingHeart amount={amount} onChange={setAmount} disabled={busy} />
      <textarea
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        placeholder="what are you grateful for? (optional)"
        rows={3}
        maxLength={500}
        className="block w-full rounded-2xl border border-rose-200 bg-white/90 p-3 text-sm leading-relaxed text-neutral-900 placeholder:italic placeholder:text-rose-300 outline-none transition-colors focus:border-rose-300 focus:ring-2 focus:ring-rose-300/40 dark:border-rose-800 dark:bg-neutral-950 dark:text-neutral-100 dark:placeholder:text-rose-700"
      />
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={busy || amount < 1}
          className="rounded-full bg-gradient-to-br from-rose-300 via-rose-400 to-pink-500 px-5 py-2 font-display italic text-sm text-white shadow-[0_8px_20px_-4px_rgba(244,63,94,0.5),inset_0_2px_3px_rgba(255,255,255,0.5),inset_0_-3px_6px_rgba(159,18,57,0.3)] ring-1 ring-rose-200/60 transition-all hover:scale-[1.04] hover:shadow-[0_12px_26px_-4px_rgba(244,63,94,0.65),inset_0_2px_3px_rgba(255,255,255,0.5),inset_0_-3px_6px_rgba(159,18,57,0.3)] active:scale-[1.06] disabled:opacity-50"
        >
          {busy ? 'sending…' : `Send ${'♥'.repeat(Math.max(1, amount))}`}
        </button>
        {status && (
          <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400">
            {status}
          </span>
        )}
        {error && <span className="text-xs text-red-600">{error}</span>}
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// ChargingHeart — press-and-hold heart that grows from 1× to 5× over 3s,
// ticking +1 heart every 600ms. At 5 it locks and greys out; user releases
// and presses Send to commit. Releasing mid-charge keeps the current
// amount so casual taps = 1 heart, long holds = more.
// ---------------------------------------------------------------------------

const CHARGE_MAX = 5;
const TICK_MS = 600;
const FULL_CHARGE_MS = TICK_MS * CHARGE_MAX;

function ChargingHeart({
  amount,
  onChange,
  disabled,
}: {
  amount: number;
  onChange: (next: number) => void;
  disabled?: boolean;
}) {
  const [charging, setCharging] = useState(false);
  const tickRef = useRef<number | null>(null);
  const amountRef = useRef(amount);
  amountRef.current = amount;

  function clearTicker() {
    if (tickRef.current != null) {
      window.clearInterval(tickRef.current);
      tickRef.current = null;
    }
  }

  useEffect(() => clearTicker, []);

  function start() {
    if (disabled) return;
    if (amountRef.current >= CHARGE_MAX) return;
    setCharging(true);
    clearTicker();
    tickRef.current = window.setInterval(() => {
      const next = Math.min(CHARGE_MAX, amountRef.current + 1);
      onChange(next);
      amountRef.current = next;
      if (next >= CHARGE_MAX) {
        clearTicker();
        setCharging(false);
      }
    }, TICK_MS);
  }

  function stop() {
    clearTicker();
    setCharging(false);
  }

  const locked = amount >= CHARGE_MAX;
  // Scale from 1× (idle) up to 3× (max). Capped at 3× so the heart grows
  // boldly without exploding out of the bounded stage — the softened
  // inner container keeps it visually contained.
  const progress = Math.max(0, Math.min(CHARGE_MAX, amount)) / CHARGE_MAX;
  const scale = 1 + progress * 2;

  return (
    <div
      className="relative flex flex-col items-center gap-1.5 overflow-hidden rounded-2xl border border-rose-200/60 bg-gradient-to-br from-rose-50/80 via-pink-50/70 to-rose-100/70 px-4 py-3 shadow-inner dark:border-rose-800/50 dark:from-rose-950/50 dark:via-pink-950/40 dark:to-rose-900/40"
    >
      {/* Soft aura behind the heart — brightens as you charge. */}
      <motion.span
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(ellipse at 50% 55%, rgba(244,63,94,0.22), transparent 62%)',
        }}
        animate={{ opacity: 0.6 + progress * 0.4 }}
        transition={{ duration: 0.25 }}
      />
      <p className="relative text-[10px] font-medium uppercase tracking-[0.2em] text-rose-500/80 dark:text-rose-100">
        {locked ? 'Max — ready to send' : charging ? 'Keep holding…' : 'Hold the heart'}
      </p>

      <div className="relative flex h-24 w-full items-center justify-center">
        <motion.button
          type="button"
          aria-label={`charge gratitude, currently ${amount} heart${amount === 1 ? '' : 's'}`}
          aria-disabled={disabled || locked}
          disabled={disabled}
          onPointerDown={start}
          onPointerUp={stop}
          onPointerLeave={stop}
          onPointerCancel={stop}
          className="relative flex h-10 w-10 select-none items-center justify-center rounded-full text-[28px] leading-none text-rose-500 disabled:opacity-60"
          style={{
            originX: 0.5,
            originY: 0.5,
            cursor: locked ? 'default' : disabled ? 'not-allowed' : 'pointer',
          }}
          animate={{
            scale,
            filter: locked
              ? 'drop-shadow(0 0 24px rgba(244,63,94,0.85))'
              : charging
                ? 'drop-shadow(0 0 18px rgba(244,63,94,0.7))'
                : 'drop-shadow(0 0 10px rgba(244,63,94,0.45))',
          }}
          transition={{
            scale: charging
              ? { duration: TICK_MS / 1000, ease: 'easeOut' }
              : { type: 'spring', stiffness: 240, damping: 22 },
            filter: { duration: 0.25 },
          }}
        >
          <motion.span
            aria-hidden
            className="absolute inset-0 flex items-center justify-center"
            animate={
              !charging && !locked
                ? { scale: [1, 1.08, 1] }
                : { scale: 1 }
            }
            transition={
              !charging && !locked
                ? { duration: 1.3, repeat: Infinity, ease: 'easeInOut' }
                : { duration: 0.2 }
            }
          >
            ♥
          </motion.span>
        </motion.button>
      </div>

      <div className="relative flex items-center gap-2">
        <span className="font-display italic text-base tabular-nums text-rose-900 dark:text-rose-100">
          {amount}
        </span>
        <span className="text-[11px] leading-none text-rose-500/80 dark:text-rose-100">
          {amount === 1 ? 'heart queued' : 'hearts queued'}
        </span>
        {locked && (
          <button
            type="button"
            onClick={() => onChange(1)}
            className="ml-1 rounded-full border border-rose-200 bg-white/70 px-2.5 py-0.5 font-display italic text-[10px] text-rose-700 transition-all hover:scale-[1.04] hover:bg-white active:scale-[1.02] dark:border-rose-800 dark:bg-neutral-900/60 dark:text-rose-200"
          >
            reset
          </button>
        )}
      </div>
    </div>
  );
}
