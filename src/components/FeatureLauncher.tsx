'use client';

/**
 * FeatureLauncher — reads `?open=<feature>` from the URL and opens the
 * matching FeatureSheet. Used by the LiveEventNotifier to deep-link
 * notifications into the relevant feature sheet on the home page.
 *
 * Self-cleaning: once a sheet opens, the param is stripped from the
 * URL via router.replace so a refresh doesn't reopen the sheet.
 *
 * Mounted on the room home page; sub-routes (safe-space, date-night,
 * sunday) don't need this since they have their own URLs.
 */

import { useEffect, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Dates } from './Dates';
import { FeatureSheet } from './FeatureSheet';
import { Gratitude } from './Gratitude';
import { HomeworkBanner } from './HomeworkBanner';
import { LoveTank } from './LoveTank';
import { MindReader } from './MindReader';
import { RitualsCard } from './RitualsCard';
import { TimeCapsules } from './TimeCapsules';
import { VibeSliders } from './VibeSliders';
import { Wishlist } from './Wishlist';

type Feature =
  | 'gratitude'
  | 'intention'
  | 'dates'
  | 'wishlist'
  | 'mind_reader'
  | 'time_capsules'
  | 'rituals'
  | 'sliders'
  | 'love_tank';

const TITLES: Record<Feature, { title: string; emoji: string }> = {
  gratitude:     { title: 'Gratitude',     emoji: '🙏' },
  intention:     { title: 'Intention',     emoji: '🌱' },
  dates:         { title: 'Dates',         emoji: '💕' },
  wishlist:      { title: 'Wishlist',      emoji: '🎁' },
  mind_reader:   { title: 'Mind reader',   emoji: '🔮' },
  time_capsules: { title: 'Time capsules', emoji: '⏳' },
  rituals:       { title: 'Rituals',       emoji: '🌅' },
  sliders:       { title: 'Vibe sliders',  emoji: '🎚️' },
  love_tank:     { title: 'Love tank',     emoji: '💖' },
};

const FEATURES = new Set<Feature>(Object.keys(TITLES) as Feature[]);

export function FeatureLauncher() {
  const params = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const [active, setActive] = useState<Feature | null>(null);

  // When the param appears, latch it into local state and strip the
  // param from the URL so the sheet survives the refresh-resistance
  // pattern (close → don't immediately reopen).
  useEffect(() => {
    const raw = params.get('open');
    if (!raw) return;
    if (!FEATURES.has(raw as Feature)) return;
    setActive(raw as Feature);
    const next = new URLSearchParams(params.toString());
    next.delete('open');
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname);
  }, [params, pathname, router]);

  if (!active) return null;
  const meta = TITLES[active];

  return (
    <FeatureSheet title={meta.title} emoji={meta.emoji} onClose={() => setActive(null)}>
      {active === 'gratitude' && <Gratitude />}
      {active === 'intention' && <HomeworkBanner />}
      {active === 'dates' && <Dates />}
      {active === 'wishlist' && <Wishlist />}
      {active === 'mind_reader' && <MindReader />}
      {active === 'time_capsules' && <TimeCapsules />}
      {active === 'rituals' && <RitualsCard />}
      {active === 'sliders' && <VibeSliders />}
      {active === 'love_tank' && <LoveTank />}
    </FeatureSheet>
  );
}
