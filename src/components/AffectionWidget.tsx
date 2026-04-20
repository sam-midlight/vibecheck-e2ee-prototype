'use client';

/**
 * AffectionWidget — sidebar widget for sending and reviewing affection.
 *
 *   - Pick a recipient (other current-gen members).
 *   - Pick a kind (kiss / hug / high-five).
 *   - Tap "Leave one" → enters placement mode; next click places it.
 *   - Bank: list of received affections accumulated over time.
 *
 * The send/receive/retract events live in the encrypted ledger so a
 * refresh restores active gestures and bank history.
 *
 * Heartbeat: a separate toggle that broadcasts an ephemeral "I am
 * pulsing toward you" signal over the room's realtime channel. Pure
 * presence — never persisted, only delivered while both parties are
 * connected.
 */

import { useEffect, useMemo, useState } from 'react';
import { displayName as fmtDisplayName } from '@/lib/domain/displayName';
import { uniqueMembers } from '@/lib/domain/members';
import {
  AFFECTION_KINDS,
  type AffectionKind,
} from '@/lib/domain/events';
import { describeError } from '@/lib/domain/errors';
import { AffectionSendOverlay, KIND_EMOJI } from './AffectionLayer';
import { HelpIcon } from './HelpIcon';
import { useHeartbeat } from './HeartbeatLayer';
import {
  useRoom,
  useRoomProjection,
  type RoomEventRecord,
} from './RoomProvider';

interface ReceivedAffection {
  affectionId: string;
  senderId: string;
  kind: AffectionKind;
  receivedTs: number;
}

const KIND_LABEL: Record<AffectionKind, string> = {
  kiss: 'Kiss',
  hug: 'Hug',
  high_five: 'High five',
};

export function AffectionWidget() {
  const { myUserId, members, room, displayNames, memberEmojis, onlineUserIds } = useRoom();
  const [kind, setKind] = useState<AffectionKind>('kiss');
  const [recipient, setRecipient] = useState<string | null>(null);
  const [placing, setPlacing] = useState(false);
  const [bankOpen, setBankOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const heartbeat = useHeartbeat();

  const others = useMemo(
    () =>
      room
        ? uniqueMembers(members, room.current_generation).filter(
            (m) => m.user_id !== myUserId,
          )
        : [],
    [room, members, myUserId],
  );

  // Default the recipient to the first other member.
  useEffect(() => {
    if (!recipient && others.length > 0) setRecipient(others[0].user_id);
  }, [others, recipient]);

  // Bank: every affection_send addressed to me that I subsequently
  // receive. Stored newest-first.
  const bank = useRoomProjection<ReceivedAffection[]>((acc, rec) => {
    if (rec.event.type === 'affection_receive') {
      // Reduce again over the events list to find the matching send
      // — but inside this reducer we don't have access. Use a sentinel
      // and a second pass below.
      return acc;
    }
    return acc;
  }, []);
  // Two-pass: index sends, then walk receives in chrono order.
  const bankResolved = useRoomProjection<{
    sends: Map<string, RoomEventRecord>;
    received: ReceivedAffection[];
  }>(
    (acc, rec) => {
      const ev = rec.event;
      if (ev.type === 'affection_send') {
        const next = new Map(acc.sends);
        next.set(ev.affectionId, rec);
        return { sends: next, received: acc.received };
      }
      if (ev.type === 'affection_receive') {
        const send = acc.sends.get(ev.affectionId);
        if (!send || send.event.type !== 'affection_send') return acc;
        if (send.event.to !== myUserId) return acc;
        return {
          sends: acc.sends,
          received: [
            {
              affectionId: ev.affectionId,
              senderId: send.senderId,
              kind: send.event.kind,
              receivedTs: ev.ts,
            },
            ...acc.received,
          ],
        };
      }
      return acc;
    },
    { sends: new Map(), received: [] },
  );
  void bank; // unused first pass kept above to document the rejected approach

  const recipientName =
    (recipient && fmtDisplayName(recipient, displayNames, myUserId, null)) ||
    'partner';
  const recipientOnline = recipient ? onlineUserIds.has(recipient) : false;

  function startPlacing() {
    if (!recipient) return;
    setError(null);
    setPlacing(true);
  }

  return (
    <>
      <section className="space-y-3 rounded-2xl border border-white/60 bg-gradient-to-br from-rose-50/85 via-pink-50/75 to-rose-100/70 p-4 shadow-lg backdrop-blur-md dark:border-white/10 dark:from-rose-950/50 dark:via-pink-950/40 dark:to-rose-900/40">
        <header className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.18em] text-rose-800 dark:text-rose-200">
            <span aria-hidden>💋</span>
            <span>Send some love</span>
          </div>
          <HelpIcon
            label="Affection"
            text="Pick a partner, pick a kiss / hug / high-five, then tap anywhere on the screen to place it. The mark stays visible to both of you until either the receiver taps it (and it goes to their bank) or the sender taps to retract. Heartbeat is separate — toggling it sends a soft pulse animation to your partner's screen until you toggle it off."
          />
        </header>

        {others.length === 0 ? (
          <p className="text-xs leading-relaxed text-rose-900/80 dark:text-rose-200">
            Invite someone to this room to leave them a kiss.
          </p>
        ) : (
          <>
            {/* Recipient row */}
            <div>
              <p className="mb-1 text-[10px] font-medium uppercase tracking-[0.14em] text-rose-800 dark:text-rose-200">
                To
              </p>
              <div className="flex flex-wrap gap-1.5">
                {others.map((m) => {
                  const selected = recipient === m.user_id;
                  const online = onlineUserIds.has(m.user_id);
                  const name = fmtDisplayName(m.user_id, displayNames, myUserId, null);
                  const emoji = memberEmojis[m.user_id];
                  return (
                    <button
                      key={m.user_id}
                      type="button"
                      onClick={() => setRecipient(m.user_id)}
                      className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-all ${
                        selected
                          ? 'border-rose-400 bg-white/90 text-rose-900 shadow-sm dark:border-rose-500 dark:bg-neutral-900/80 dark:text-rose-100'
                          : 'border-rose-200 bg-white/60 text-rose-800 hover:bg-white/80 dark:border-rose-800/60 dark:bg-neutral-900/40 dark:text-rose-200'
                      }`}
                    >
                      {emoji && <span aria-hidden className="leading-none">{emoji}</span>}
                      <span className="font-medium">{firstWord(name)}</span>
                      {online && (
                        <span
                          aria-label={`${firstWord(name)} is in the room`}
                          title={`${firstWord(name)} is in the room`}
                          className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.85)]"
                        />
                      )}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Kind row */}
            <div>
              <p className="mb-1 text-[10px] font-medium uppercase tracking-[0.14em] text-rose-800 dark:text-rose-200">
                Kind
              </p>
              <div className="flex gap-1.5">
                {AFFECTION_KINDS.map((k) => {
                  const selected = kind === k;
                  return (
                    <button
                      key={k}
                      type="button"
                      onClick={() => setKind(k)}
                      className={`flex flex-1 flex-col items-center gap-0.5 rounded-xl border px-2 py-2 text-[11px] transition-all ${
                        selected
                          ? 'border-rose-400 bg-white/95 shadow-sm dark:border-rose-500 dark:bg-neutral-900/85'
                          : 'border-rose-200 bg-white/60 hover:bg-white/80 dark:border-rose-800/60 dark:bg-neutral-900/40'
                      }`}
                    >
                      <span aria-hidden className="text-2xl leading-none">
                        {KIND_EMOJI[k]}
                      </span>
                      <span className="font-medium text-rose-900 dark:text-rose-100">
                        {KIND_LABEL[k]}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Send button */}
            <button
              type="button"
              onClick={startPlacing}
              disabled={!recipient}
              className="w-full rounded-full bg-gradient-to-br from-rose-300 via-rose-400 to-pink-500 px-4 py-2 font-display italic text-sm text-white shadow-[0_8px_20px_-4px_rgba(244,63,94,0.5),inset_0_2px_3px_rgba(255,255,255,0.45),inset_0_-3px_6px_rgba(159,18,57,0.3)] ring-1 ring-rose-200/60 transition-all hover:scale-[1.02] active:scale-[1.04] disabled:opacity-50"
            >
              Leave a {kind === 'high_five' ? 'high five' : kind} for {firstWord(recipientName)}
              {!recipientOnline && ' (offline — they\u2019ll see it next visit)'}
            </button>

            {/* Heartbeat toggle */}
            <div className="flex items-center justify-between rounded-2xl border border-rose-200/70 bg-white/70 px-3 py-2 dark:border-rose-800/50 dark:bg-neutral-900/60">
              <div className="flex flex-col">
                <span className="font-display italic text-sm text-rose-900 dark:text-rose-100">
                  Heartbeat
                </span>
                <span className="text-[10px] text-rose-800/80 dark:text-rose-200">
                  Pulse a steady beat to {firstWord(recipientName)}&apos;s screen
                </span>
              </div>
              <button
                type="button"
                onClick={() => {
                  if (!recipient) return;
                  if (heartbeat.activeFor === recipient) {
                    heartbeat.stop();
                  } else {
                    heartbeat.start(recipient);
                  }
                }}
                disabled={!recipient}
                aria-pressed={heartbeat.activeFor === recipient}
                className={`flex h-9 w-9 items-center justify-center rounded-full text-base shadow-sm transition-all hover:scale-[1.08] active:scale-[1.04] disabled:opacity-50 ${
                  heartbeat.activeFor === recipient
                    ? 'bg-rose-500 text-white shadow-[0_0_18px_rgba(244,63,94,0.65)]'
                    : 'bg-white/80 text-rose-700 dark:bg-neutral-900/70 dark:text-rose-200'
                }`}
                title={
                  heartbeat.activeFor === recipient
                    ? 'stop heartbeat'
                    : 'start heartbeat'
                }
              >
                ♥
              </button>
            </div>

            {/* Bank toggle */}
            <button
              type="button"
              onClick={() => setBankOpen((v) => !v)}
              className="flex w-full items-center justify-between rounded-full border border-rose-200 bg-white/70 px-3 py-1.5 text-xs font-display italic text-rose-900 transition-all hover:bg-white/90 dark:border-rose-800/60 dark:bg-neutral-900/60 dark:text-rose-200"
            >
              <span>Received bank · {bankResolved.received.length}</span>
              <span aria-hidden>{bankOpen ? '▴' : '▾'}</span>
            </button>

            {bankOpen && (
              <div className="max-h-48 space-y-1 overflow-y-auto pr-1">
                {bankResolved.received.length === 0 ? (
                  <p className="text-xs italic text-rose-900/70 dark:text-rose-200">
                    Nothing yet — they&rsquo;re shy.
                  </p>
                ) : (
                  bankResolved.received.map((r) => {
                    const senderName = firstWord(
                      fmtDisplayName(r.senderId, displayNames, myUserId, null),
                    );
                    return (
                      <div
                        key={r.affectionId}
                        className="flex items-center justify-between gap-2 rounded-xl border border-white/60 bg-white/80 px-2.5 py-1.5 text-xs shadow-sm dark:border-white/10 dark:bg-neutral-900/60"
                      >
                        <span className="flex items-center gap-2">
                          <span aria-hidden className="text-base">{KIND_EMOJI[r.kind]}</span>
                          <span className="font-medium text-neutral-800 dark:text-neutral-100">
                            {senderName}
                          </span>
                        </span>
                        <span className="font-mono text-[10px] text-neutral-500 dark:text-neutral-400">
                          {new Date(r.receivedTs).toLocaleDateString([], { month: 'short', day: 'numeric' })}
                        </span>
                      </div>
                    );
                  })
                )}
              </div>
            )}
          </>
        )}

        {error && <p className="text-xs text-red-600">{describeError(error)}</p>}
      </section>

      {placing && recipient && (
        <AffectionSendOverlay
          recipient={recipient}
          kind={kind}
          onPlaced={() => setPlacing(false)}
          onCancel={() => setPlacing(false)}
        />
      )}
    </>
  );
}

function firstWord(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '';
  const idx = trimmed.search(/\s/);
  return idx === -1 ? trimmed : trimmed.slice(0, idx);
}
