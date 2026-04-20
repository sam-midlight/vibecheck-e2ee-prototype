'use client';

import type { CSSProperties, ReactNode } from 'react';
import { useDesignMode } from './useDesignMode';

/**
 * Pill — rounded chip for member tags, filter buttons, context pills.
 * Inactive: clay-white, warm inset highlight. Active: ink-filled with a
 * cool drop shadow. Optional coloured dot slot for status/accent.
 */
export function Pill({
  children,
  active,
  accent,
  icon,
  style,
  className,
  onClick,
}: {
  children: ReactNode;
  active?: boolean;
  accent?: string;
  icon?: ReactNode;
  style?: CSSProperties;
  className?: string;
  onClick?: () => void;
}) {
  const { t } = useDesignMode();
  const bg = active ? t.ink : t.surface;
  const color = active ? t.base : t.ink;
  return (
    <button
      onClick={onClick}
      type="button"
      className={className}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '6px 12px',
        borderRadius: 999,
        background: bg,
        color,
        border: 'none',
        cursor: onClick ? 'pointer' : 'default',
        fontFamily: 'var(--font-sans), Geist, system-ui, sans-serif',
        fontSize: 12.5,
        fontWeight: 500,
        boxShadow: active
          ? 'inset 0 1px 0 rgba(255,255,255,0.08), 0 4px 10px -4px rgba(0,0,0,0.25)'
          : `inset 0 1px 0 rgba(255,255,255,0.8), 0 1px 2px ${t.line}`,
        ...style,
      }}
    >
      {icon}
      {accent && (
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: 999,
            background: accent,
          }}
        />
      )}
      {children}
    </button>
  );
}
