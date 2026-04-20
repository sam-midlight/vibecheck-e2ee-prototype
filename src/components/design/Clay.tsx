'use client';

/**
 * Clay — the base claymorphic surface wrapper from the Warm Obsidian
 * design system. Soft inset highlight + warm drop shadow, frosted with a
 * backdrop blur so the interactive lava-lamp background washes through.
 *
 * Usage: wrap any card-level UI in <Clay>. Defaults are the subtle clay
 * intensity from the design brief (claymorphism_intensity: Subtle — soft
 * shadows, rounded corners, but still readable and restrained).
 */

import { forwardRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useDesignMode } from './useDesignMode';

export interface ClayProps {
  children?: ReactNode;
  className?: string;
  style?: CSSProperties;
  /** Enable hover lift (elevated shadow). Off by default. */
  hover?: boolean;
  /** Border radius in px. 24 = card, 28 = hero card, 999 = pill. */
  radius?: number;
  /** Use the alt (slightly warmer/deeper) surface tone. */
  alt?: boolean;
  onClick?: () => void;
}

export const Clay = forwardRef<HTMLDivElement, ClayProps>(function Clay(
  { children, className, style, hover = false, radius = 24, alt = false, onClick },
  ref,
) {
  const { t } = useDesignMode();
  const [h, setH] = useState(false);
  return (
    <div
      ref={ref}
      onClick={onClick}
      onMouseEnter={() => setH(true)}
      onMouseLeave={() => setH(false)}
      className={className}
      style={{
        background: alt ? t.surfaceAlt : t.surface,
        backdropFilter: 'blur(20px) saturate(1.4)',
        WebkitBackdropFilter: 'blur(20px) saturate(1.4)',
        borderRadius: radius,
        boxShadow: h && hover ? t.clayShadowHover : t.clayShadow,
        transition: 'box-shadow 240ms ease, transform 240ms ease',
        color: t.ink,
        ...style,
      }}
    >
      {children}
    </div>
  );
});
