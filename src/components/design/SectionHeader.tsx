'use client';

/**
 * SectionHeader — the small-caps JetBrains-Mono label + optional
 * Instrument-Serif italic title pattern used across the new design
 * system (Love Tank widget, Rituals card, Zero-Knowledge card). Use
 * this in place of bespoke per-section h2 headers so every card reads
 * with the same restrained, classy voice.
 *
 *   <SectionHeader label="Gratitude" />
 *   <SectionHeader label="Memory jar" emoji="📿" />
 *   <SectionHeader label="Vibe oracle" pulse />
 *
 * Title is shown only if you pass `title` — most cards are happy with
 * just the label (the content below carries the meaning).
 */

import type { ReactNode } from 'react';
import { useDesignMode } from './useDesignMode';

export function SectionHeader({
  label,
  title,
  emoji,
  /** Tiny pulsing dot in the ember accent — useful for "live" sections. */
  pulse,
  trailing,
}: {
  label: string;
  title?: string;
  emoji?: string;
  pulse?: boolean;
  trailing?: ReactNode;
}) {
  const { t } = useDesignMode();
  return (
    <div className="mb-3">
      <div className="flex items-center justify-between gap-3">
        <div
          className="flex items-center gap-2"
          style={{
            fontFamily: 'var(--font-mono), JetBrains Mono, monospace',
            fontSize: 17,
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            color: t.inkDim,
            fontWeight: 500,
          }}
        >
          {pulse && (
            <span
              aria-hidden
              style={{
                width: 6,
                height: 6,
                borderRadius: 999,
                background: t.ember,
                boxShadow: `0 0 8px ${t.ember}`,
                animation: 'pulse 1.6s ease-in-out infinite',
              }}
            />
          )}
          {emoji && <span aria-hidden>{emoji}</span>}
          {label}
        </div>
        {trailing && <div>{trailing}</div>}
      </div>
      {title && (
        <h2
          className="font-display italic"
          style={{
            fontSize: 26,
            fontWeight: 400,
            lineHeight: 1.15,
            color: t.ink,
            letterSpacing: '-0.01em',
            marginTop: 4,
          }}
        >
          {title}
        </h2>
      )}
    </div>
  );
}
