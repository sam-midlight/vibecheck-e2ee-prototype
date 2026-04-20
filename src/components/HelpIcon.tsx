'use client';

/**
 * Tiny inline help affordance: a `?` button that toggles a popover below
 * itself with explanatory text. Dismisses on outside click or Escape.
 *
 * The popover is rendered via React Portal directly into <body> so it
 * escapes every parent stacking context (sibling cards with backdrop-blur,
 * transformed banners, etc) — z-index can't win those battles otherwise.
 * Position is computed from the trigger's bounding rect on open.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const POPOVER_WIDTH = 256;

export function HelpIcon({
  label,
  text,
}: {
  label: string;
  text: string;
}) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLSpanElement>(null);

  // Position on open (and on viewport-affecting events while open).
  useLayoutEffect(() => {
    if (!open) return;
    function place() {
      const el = triggerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      // Prefer below the trigger; flip above if it would overflow the viewport.
      const padding = 8;
      const wouldOverflowBottom = rect.bottom + 200 > window.innerHeight;
      const top = wouldOverflowBottom ? rect.top - padding - 8 : rect.bottom + 4;
      // Clamp left so the box stays on-screen.
      const rawLeft = rect.left;
      const maxLeft = window.innerWidth - POPOVER_WIDTH - 8;
      const left = Math.max(8, Math.min(rawLeft, maxLeft));
      setCoords({ top, left });
    }
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      const trig = triggerRef.current;
      const pop = popoverRef.current;
      const target = e.target as Node;
      if (trig && trig.contains(target)) return;
      if (pop && pop.contains(target)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <span className="relative inline-flex items-center">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={`help for ${label}`}
        aria-expanded={open}
        className="flex h-4 w-4 items-center justify-center rounded-full border border-neutral-300 text-[10px] font-semibold leading-none text-neutral-500 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800"
      >
        ?
      </button>
      {open && coords && typeof document !== 'undefined' &&
        createPortal(
          <span
            ref={popoverRef}
            role="tooltip"
            className="fixed z-[100] rounded-md border border-neutral-200 bg-white p-3 text-[11px] leading-relaxed text-neutral-700 shadow-2xl dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200"
            style={{
              top: coords.top,
              left: coords.left,
              width: POPOVER_WIDTH,
            }}
          >
            {text}
          </span>,
          document.body,
        )}
    </span>
  );
}
