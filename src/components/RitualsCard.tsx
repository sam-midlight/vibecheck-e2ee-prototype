'use client';

/**
 * RitualsCard — "Morning" + "Evening" ritual slots. Either member can
 * pick a ritual from the suggestion list or type their own; the choice
 * is stored as a `ritual_set` event (latest-wins per slot). Each member
 * independently ticks the ritual done for today, which publishes a
 * `ritual_complete` event keyed by local YYYY-MM-DD. The row shows each
 * completed member's room emoji (or initial) next to the ritual name.
 *
 * Lives in the left rail, replaces the previous Zero-Knowledge card.
 * Uses the shared design primitives (Clay, Label, Icon) so it
 * participates in the warm-obsidian → dusk-obsidian flip.
 */

import { useMemo, useState } from 'react';
import { Clay } from './design/Clay';
import { Icon } from './design/Icon';
import { Label } from './design/Label';
import { useDesignMode } from './design/useDesignMode';
import { useRoom } from './RoomProvider';
import type { RitualSlot } from '@/lib/domain/events';

const SLOTS: { slot: RitualSlot; label: string; emoji: string }[] = [
  { slot: 'morning', label: 'Morning', emoji: '☀️' },
  { slot: 'evening', label: 'Evening', emoji: '🌙' },
];

// Small, curated pool of ideas grouped by slot. Short + action-oriented.
// Tap one to adopt it; tap "custom" to type your own.
const SUGGESTIONS: Record<RitualSlot, string[]> = {
  morning: [
    'Share one thing you\u2019re grateful for',
    'Trade 30-second highs from yesterday',
    'Read your partner one line of a poem',
    'Stretch together for a minute',
    'Exchange tender eye contact — 10 seconds',
    'Make each other coffee / tea',
    'Name one thing you\u2019ll do for your partner today',
    'Set an intention together',
  ],
  evening: [
    'One high + one low of the day',
    'Kiss goodnight — no phones in hand',
    'Whisper a thank-you',
    'Read to each other for 5 minutes',
    'Share one tiny delight',
    'Slow dance in the kitchen',
    'Trade back-rubs for two minutes',
    'Set tomorrow\u2019s soft goal together',
  ],
};

function todayKey(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function RitualsCard() {
  const { t } = useDesignMode();
  const { events, myUserId, memberEmojis, displayNames, appendEvent } = useRoom();
  const [editingSlot, setEditingSlot] = useState<RitualSlot | null>(null);

  const today = todayKey();

  // Project the event stream into the current ritual per slot + today's
  // completion set per slot. Latest-wins by ts.
  const { names, completionsBySlot } = useMemo(() => {
    const names: Record<RitualSlot, { name: string; ts: number }> = {
      morning: { name: '', ts: 0 },
      evening: { name: '', ts: 0 },
    };
    // A per-user completion toggle: track the latest of complete/uncomplete
    // per (slot, user). If the latest event is a complete, they're done.
    type Key = string; // `${slot}:${userId}`
    const latest = new Map<Key, { kind: 'done' | 'undone'; ts: number }>();

    for (const rec of events) {
      const ev = rec.event;
      if (ev.type === 'ritual_set') {
        if (ev.ts > names[ev.slot].ts) {
          names[ev.slot] = { name: ev.name, ts: ev.ts };
        }
      } else if (ev.type === 'ritual_complete' && ev.dateKey === today) {
        const k: Key = `${ev.slot}:${rec.senderId}`;
        const prev = latest.get(k);
        if (!prev || ev.ts > prev.ts) {
          latest.set(k, { kind: 'done', ts: ev.ts });
        }
      } else if (ev.type === 'ritual_uncomplete' && ev.dateKey === today) {
        const k: Key = `${ev.slot}:${rec.senderId}`;
        const prev = latest.get(k);
        if (!prev || ev.ts > prev.ts) {
          latest.set(k, { kind: 'undone', ts: ev.ts });
        }
      }
    }

    const completionsBySlot: Record<RitualSlot, string[]> = {
      morning: [],
      evening: [],
    };
    for (const [k, v] of latest) {
      if (v.kind !== 'done') continue;
      const [slot, userId] = k.split(':') as [RitualSlot, string];
      completionsBySlot[slot].push(userId);
    }

    return { names, completionsBySlot };
  }, [events, today]);

  async function setRitual(slot: RitualSlot, name: string) {
    await appendEvent({ type: 'ritual_set', slot, name, ts: Date.now() });
    setEditingSlot(null);
  }

  async function toggleDone(slot: RitualSlot) {
    if (!myUserId) return;
    const iAmDone = completionsBySlot[slot].includes(myUserId);
    await appendEvent(
      iAmDone
        ? { type: 'ritual_uncomplete', slot, dateKey: today, ts: Date.now() }
        : { type: 'ritual_complete', slot, dateKey: today, ts: Date.now() },
    );
  }

  return (
    <Clay radius={22} style={{ padding: 18 }}>
      <Label style={{ marginBottom: 10 }}>Rituals</Label>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {SLOTS.map(({ slot, label, emoji }) => {
          const name = names[slot].name.trim();
          const completed = completionsBySlot[slot];
          const iAmDone = !!myUserId && completed.includes(myUserId);
          const isEditing = editingSlot === slot;
          return (
            <div
              key={slot}
              style={{
                borderRadius: 14,
                padding: 10,
                background: t.base,
                boxShadow: t.clayInset,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                }}
              >
                <span aria-hidden style={{ fontSize: 14 }}>
                  {emoji}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    className="font-mono"
                    style={{
                      fontSize: 10,
                      letterSpacing: '0.12em',
                      textTransform: 'uppercase',
                      color: t.inkFaint,
                    }}
                  >
                    {label}
                  </div>
                  {!isEditing && (
                    <button
                      type="button"
                      onClick={() => setEditingSlot(slot)}
                      style={{
                        border: 'none',
                        background: 'transparent',
                        padding: 0,
                        cursor: 'pointer',
                        color: name ? t.ink : t.inkDim,
                        fontFamily: 'inherit',
                        fontSize: 12.5,
                        textAlign: 'left',
                        width: '100%',
                        fontStyle: name ? 'normal' : 'italic',
                      }}
                    >
                      {name || 'Set a ritual\u2026'}
                    </button>
                  )}
                </div>

                {/* Completion pips — one per member who's ticked it today */}
                <div style={{ display: 'flex', gap: 4 }}>
                  {completed.map((uid) => {
                    const e = memberEmojis[uid];
                    const name = displayNames[uid];
                    const initial = name ? name[0]?.toUpperCase() : '?';
                    return (
                      <span
                        key={uid}
                        title={`${name ?? uid.slice(0, 6)} \u2022 done`}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          width: 22,
                          height: 22,
                          borderRadius: '50%',
                          background: e ? 'transparent' : t.surface,
                          fontSize: e ? 14 : 10,
                          color: t.ink,
                          boxShadow: e ? 'none' : t.clayShadow,
                        }}
                      >
                        {e ?? initial}
                      </span>
                    );
                  })}
                </div>

                {/* Done / Undo toggle */}
                {!isEditing && name && (
                  <button
                    type="button"
                    onClick={() => void toggleDone(slot)}
                    aria-label={iAmDone ? 'mark not done' : 'mark done'}
                    style={{
                      width: 26,
                      height: 26,
                      flexShrink: 0,
                      borderRadius: '50%',
                      border: 'none',
                      cursor: 'pointer',
                      background: iAmDone ? t.ember : 'transparent',
                      color: iAmDone ? '#FFF' : t.inkDim,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      boxShadow: iAmDone
                        ? `0 0 0 2px ${t.ember}33`
                        : `inset 0 0 0 1.5px ${t.inkFaint}`,
                      transition: 'all 180ms ease',
                    }}
                  >
                    {iAmDone ? (
                      <svg viewBox="0 0 16 16" width={12} height={12} fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <path d="m3.5 8.5 3 3 6-7" />
                      </svg>
                    ) : null}
                  </button>
                )}
              </div>

              {/* Edit drawer: suggestion pills + custom input */}
              {isEditing && (
                <Editor
                  slot={slot}
                  current={name}
                  onSave={setRitual}
                  onCancel={() => setEditingSlot(null)}
                />
              )}
            </div>
          );
        })}
      </div>
    </Clay>
  );
}

function Editor({
  slot,
  current,
  onSave,
  onCancel,
}: {
  slot: RitualSlot;
  current: string;
  onSave: (slot: RitualSlot, name: string) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useDesignMode();
  const [custom, setCustom] = useState(current);
  const suggestions = SUGGESTIONS[slot];

  async function pick(name: string) {
    await onSave(slot, name);
  }

  return (
    <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div
        className="font-mono"
        style={{
          fontSize: 10,
          letterSpacing: '0.12em',
          textTransform: 'uppercase',
          color: t.inkFaint,
        }}
      >
        Pick or write your own
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {suggestions.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => void pick(s)}
            style={{
              padding: '6px 10px',
              borderRadius: 999,
              border: 'none',
              cursor: 'pointer',
              background: t.surface,
              color: t.ink,
              fontFamily: 'inherit',
              fontSize: 11.5,
              boxShadow: `inset 0 1px 0 rgba(255,255,255,0.6), 0 1px 2px ${t.line}`,
            }}
          >
            {s}
          </button>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          type="text"
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          placeholder="Or type your own\u2026"
          maxLength={80}
          style={{
            flex: 1,
            minWidth: 0,
            padding: '7px 12px',
            borderRadius: 999,
            border: `1px solid ${t.line}`,
            background: t.surface,
            color: t.ink,
            fontFamily: 'inherit',
            fontSize: 12.5,
            outline: 'none',
          }}
        />
        <button
          type="button"
          onClick={() => void pick(custom.trim())}
          disabled={!custom.trim()}
          style={{
            padding: '7px 14px',
            borderRadius: 999,
            border: 'none',
            cursor: custom.trim() ? 'pointer' : 'default',
            background: custom.trim() ? t.ink : t.surface,
            color: custom.trim() ? t.base : t.inkDim,
            fontFamily: 'inherit',
            fontSize: 11.5,
            fontWeight: 500,
            opacity: custom.trim() ? 1 : 0.55,
          }}
        >
          Save
        </button>
        <button
          type="button"
          onClick={onCancel}
          style={{
            padding: '7px 10px',
            borderRadius: 999,
            border: 'none',
            cursor: 'pointer',
            background: 'transparent',
            color: t.inkDim,
            fontFamily: 'inherit',
            fontSize: 11.5,
          }}
        >
          Cancel
        </button>
      </div>
      {current && (
        <button
          type="button"
          onClick={() => void onSave(slot, '')}
          style={{
            alignSelf: 'flex-start',
            padding: 0,
            border: 'none',
            background: 'transparent',
            cursor: 'pointer',
            color: t.inkDim,
            fontFamily: 'inherit',
            fontSize: 11,
            textDecoration: 'underline',
            textUnderlineOffset: 2,
          }}
        >
          Clear ritual
        </button>
      )}
    </div>
  );
}
