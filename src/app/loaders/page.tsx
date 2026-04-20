'use client';

/**
 * /loaders — preview gallery for the 20 organic indeterminate loading
 * indicators. Visits this page to pick a favourite, then we wire it in as
 * the global "loading…" replacement.
 */

import { GooFilterDefs, OrganicLoader, type OrganicLoaderVariant } from '@/components/OrganicLoader';

const VARIANTS: OrganicLoaderVariant[] = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
  11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
];

const NAMES: Record<OrganicLoaderVariant, string> = {
  1: 'Orbit merge',
  2: 'Two blobs kissing',
  3: 'Mitosis (splitting cell)',
  4: 'Single morphing blob',
  5: 'Pulsing heartbeat',
  6: 'Lobed rotation',
  7: 'Three drops orbit',
  8: 'Lava drip',
  9: 'Breathing ring',
  10: 'Filling blob',
  11: 'Collision (sketch)',
  12: 'Wiggling worm',
  13: 'Amoeba wander',
  14: 'Bubble column',
  15: 'Yin-yang blobs',
  16: 'Ripple drops',
  17: 'Tadpoles',
  18: 'Gathering dots',
  19: 'Spiral sweep',
  20: 'Inchworm',
};

export default function LoadersGalleryPage() {
  return (
    <main
      className="min-h-screen px-6 py-16 sm:px-12"
      style={{ background: '#f4f2ed', color: '#111111' }}
    >
      <GooFilterDefs />
      <div className="mx-auto max-w-6xl">
        <header className="mb-10">
          <h1 className="text-xs font-medium uppercase tracking-[0.14em]">
            Organic Loaders
          </h1>
          <p className="mt-1.5 text-sm" style={{ color: '#9a9791' }}>
            Twenty indeterminate indicators — pick one, tell me the number, I&apos;ll
            wire it in everywhere.
          </p>
        </header>

        <div
          className="grid gap-6"
          style={{
            gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
          }}
        >
          {VARIANTS.map((v) => (
            <div
              key={v}
              className="relative grid aspect-square place-items-center overflow-hidden rounded-2xl bg-white"
              style={{
                boxShadow:
                  '0 1px 0 rgba(17,17,17,0.04), 0 8px 24px -16px rgba(17,17,17,0.1)',
              }}
            >
              <span
                className="absolute left-3.5 top-3 text-[10px] tabular-nums tracking-[0.14em]"
                style={{ color: '#c9c6bf' }}
              >
                {String(v).padStart(2, '0')}
              </span>
              <div className="grid h-[200px] w-[200px] place-items-center">
                <OrganicLoader variant={v} size={200} color="#111" />
              </div>
              <span
                className="absolute bottom-3 left-1/2 -translate-x-1/2 text-[10px] tracking-[0.08em]"
                style={{ color: '#9a9791' }}
              >
                {NAMES[v]}
              </span>
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}
