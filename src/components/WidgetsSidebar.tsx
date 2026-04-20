'use client';

/**
 * Left-rail widget stack.
 *
 * Explicit order (Sam's call): Gratitude balance → Love Tank summary →
 * Top Need → Dates Oracle → Rituals → Notifications (nudge feed).
 *
 * Each widget is its own small card. No outer section header — the rail
 * is ambient context for the main reading column and doesn't need to
 * introduce itself.
 */

import { ActionLog } from './ActionLog';
import { AffectionWidget } from './AffectionWidget';
import { DatesOracle } from './DatesOracle';
import { HeartsPill } from './HeartsPill';
import { LoveTankWidget } from './LoveTankWidget';
import { RitualsCard } from './RitualsCard';
import { MyTopNeedBadge } from './TopNeedBadge';

export function WidgetsSidebar() {
  return (
    <div className="space-y-3">
      <HeartsPill />
      <LoveTankWidget />
      <MyTopNeedBadge />
      <AffectionWidget />
      <DatesOracle />
      <RitualsCard />
      <ActionLog />
    </div>
  );
}
