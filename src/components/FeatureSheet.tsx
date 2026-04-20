'use client';

import { type ReactNode, useEffect } from 'react';
import { motion } from 'framer-motion';

/** Stub during merge — full FeatureSheet (claymorphic bottom-sheet with
 *  emoji+title header, drag-to-dismiss, safe-area respect) lands in a
 *  later wave. This version renders a minimal but functional sheet so
 *  the vibe layer's feature-sheet invocations are actually usable. */
export function FeatureSheet({
  title,
  emoji,
  onClose,
  children,
}: {
  title: string;
  emoji?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 backdrop-blur-sm sm:items-center"
    >
      <button
        type="button"
        aria-label="close sheet"
        onClick={onClose}
        className="absolute inset-0 cursor-default"
      />
      <motion.div
        initial={{ y: 40, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 40, opacity: 0 }}
        transition={{ type: 'spring', stiffness: 300, damping: 30 }}
        className="relative z-10 max-h-[85vh] w-full max-w-xl overflow-y-auto rounded-t-3xl border border-white/60 bg-white/95 p-5 shadow-2xl backdrop-blur-md sm:rounded-3xl dark:border-white/10 dark:bg-neutral-900/95"
        role="dialog"
        aria-label={title}
      >
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="flex items-center gap-2 font-display text-xl italic text-neutral-900 dark:text-neutral-100">
            {emoji && <span aria-hidden>{emoji}</span>}
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-full border border-neutral-200 bg-white text-sm text-neutral-600 shadow-sm transition-all hover:bg-neutral-50 hover:shadow-md dark:border-white/10 dark:bg-neutral-800 dark:text-neutral-300"
            aria-label="close"
          >
            ✕
          </button>
        </div>
        {children}
      </motion.div>
    </motion.div>
  );
}
