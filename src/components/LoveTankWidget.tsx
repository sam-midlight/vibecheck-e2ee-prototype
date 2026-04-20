'use client';

/**
 * LoveTankWidget — compact at-a-glance summary card for the left rail,
 * matching the Warm Obsidian mock. Shows your own current Love Tank
 * level (0–100) as a big Instrument-Serif number, an amber→ember
 * gradient progress bar, and a tiny one-line status that surfaces the
 * change since this time yesterday (or invites you to set it the first
 * time).
 *
 * The full interactive Love Tank lives in the sun-orb's "Love Tank"
 * planet; this widget is read-only ambient context.
 */

import { useMemo, useState } from 'react';
import { Clay } from './design/Clay';
import { FeatureSheet } from './FeatureSheet';
import { Label } from './design/Label';
import { LoveTank } from './LoveTank';
import { useDesignMode } from './design/useDesignMode';
import { useRoom } from './RoomProvider';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export function LoveTankWidget() {
  const { t } = useDesignMode();
  const { events, myUserId } = useRoom();
  const [open, setOpen] = useState(false);

  // Project the event stream into:
  //   - latest level you've ever set (or null)
  //   - latest level you'd set BEFORE the last 24h (for a "since
  //     yesterday" delta)
  const { current, prior } = useMemo(() => {
    if (!myUserId) return { current: null as number | null, prior: null as number | null };
    const cutoff = Date.now() - ONE_DAY_MS;
    let cur: { level: number; ts: number } | null = null;
    let pri: { level: number; ts: number } | null = null;
    for (const rec of events) {
      if (rec.senderId !== myUserId) continue;
      if (rec.event.type !== 'love_tank_set') continue;
      const ev = rec.event;
      if (!cur || ev.ts > cur.ts) cur = { level: ev.level, ts: ev.ts };
      if (ev.ts < cutoff && (!pri || ev.ts > pri.ts)) {
        pri = { level: ev.level, ts: ev.ts };
      }
    }
    return { current: cur?.level ?? null, prior: pri?.level ?? null };
  }, [events, myUserId]);

  const level = current ?? 0;
  const delta = current != null && prior != null ? current - prior : null;

  return (
    <>
    <Clay
      radius={22}
      hover
      onClick={() => setOpen(true)}
      style={{ padding: 18, cursor: 'pointer' }}
    >
      <Label style={{ marginBottom: 10 }}>Love tank</Label>

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <div
          className="font-display"
          style={{
            fontSize: 42,
            color: t.ink,
            lineHeight: 1,
            fontWeight: 400,
          }}
        >
          {current == null ? '—' : level}
        </div>
        <div
          style={{
            fontSize: 12,
            color: t.inkDim,
          }}
        >
          / 100
        </div>
      </div>

      {/* Filled bar */}
      <div
        style={{
          marginTop: 12,
          height: 8,
          borderRadius: 999,
          background: t.base,
          boxShadow: t.clayInset,
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: `${level}%`,
            height: '100%',
            background: `linear-gradient(90deg, ${t.amber}, ${t.ember})`,
            boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.3)',
            transition: 'width 280ms ease',
          }}
        />
      </div>

      <div
        style={{
          fontSize: 11.5,
          color: t.inkDim,
          marginTop: 10,
          lineHeight: 1.5,
        }}
      >
        {current == null
          ? 'Tap the sun \u2192 Love Tank to set yours.'
          : delta == null
            ? 'No change yet \u2014 your first reading lands here.'
            : delta > 0
              ? `+${delta} since yesterday. Lifting nicely.`
              : delta < 0
                ? `${delta} since yesterday. Worth a check-in.`
                : 'Held steady since yesterday.'}
      </div>
    </Clay>
    {open && (
      <FeatureSheet title="Love Tank" emoji="💖" onClose={() => setOpen(false)}>
        <LoveTank />
      </FeatureSheet>
    )}
    </>
  );
}
