'use client';

import type { CSSProperties, ReactNode } from 'react';
import { useDesignMode } from './useDesignMode';

/**
 * Label — small-caps JetBrains Mono text used for section tags, data
 * annotations, and the "engineer who understands feelings" texture from
 * the design brief. Always uppercase, always tracked.
 */
export function Label({
  children,
  style,
  className,
}: {
  children: ReactNode;
  style?: CSSProperties;
  className?: string;
}) {
  const { t } = useDesignMode();
  return (
    <div
      className={className}
      style={{
        fontFamily: 'var(--font-mono), JetBrains Mono, monospace',
        fontSize: 10.5,
        letterSpacing: '0.12em',
        textTransform: 'uppercase',
        color: t.inkDim,
        fontWeight: 500,
        ...style,
      }}
    >
      {children}
    </div>
  );
}
