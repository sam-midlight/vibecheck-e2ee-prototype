'use client';

/**
 * FeatureSheet — bottom-drawer (mobile) / centered modal (desktop) shell for
 * showing a feature in a popover from anywhere. Used by VibeOrb's planet
 * pills and HeartsPill's gratitude shortcut, but generic enough for any
 * future "open this feature in a sheet" entry point.
 *
 * Render inside an <AnimatePresence> in the parent so the slide/fade exits
 * animate cleanly. Body scroll is locked while the sheet is mounted.
 */

import { useEffect } from 'react';
import { motion } from 'framer-motion';

export function FeatureSheet({
  title,
  emoji,
  onClose,
  children,
}: {
  title: string;
  emoji: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  // Lock background scroll for the sheet's lifetime.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // Escape closes.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center sm:items-center">
      <motion.button
        type="button"
        aria-label="close"
        onClick={onClose}
        className="absolute inset-0 bg-neutral-950/40 backdrop-blur-sm"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.18 }}
      />

      <motion.div
        role="dialog"
        aria-label={title}
        className="relative z-10 flex w-full flex-col overflow-hidden border border-white/60 bg-white/90 shadow-2xl backdrop-blur-xl dark:border-white/10 dark:bg-neutral-950/85 sm:w-[min(640px,92vw)] sm:rounded-3xl"
        style={{
          borderTopLeftRadius: '1.75rem',
          borderTopRightRadius: '1.75rem',
          maxHeight: 'min(86dvh, 820px)',
        }}
        initial={{ y: '100%', opacity: 0.6 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: '100%', opacity: 0 }}
        transition={{ type: 'spring', stiffness: 260, damping: 28 }}
      >
        <div className="flex justify-center pt-2 sm:hidden">
          <span className="h-1.5 w-10 rounded-full bg-neutral-300/80 dark:bg-neutral-700" />
        </div>

        <div className="flex items-center justify-between px-5 pb-2 pt-3">
          <h2 className="flex items-center gap-2 font-display italic text-2xl tracking-tight text-neutral-900 dark:text-neutral-100">
            <span aria-hidden>{emoji}</span>
            <span>{title}</span>
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="close"
            className="flex h-8 w-8 items-center justify-center rounded-full border border-white/60 bg-white/70 text-neutral-600 shadow-sm transition-all hover:bg-white/90 active:scale-95 dark:border-white/10 dark:bg-neutral-900/60 dark:text-neutral-300"
          >
            ✕
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-[calc(env(safe-area-inset-bottom,0px)+16px)] pt-2 sm:px-4">
          {children}
        </div>
      </motion.div>
    </div>
  );
}
