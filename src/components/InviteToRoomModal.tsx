'use client';

/**
 * InviteModal — stub during the vibecheck2 merge.
 *
 * Parent's current room page still owns the working invite flow; the
 * composed shell's header / tabs reference this component, so we keep a
 * minimal modal here that hints users toward the existing entry point
 * until the full Child-shaped invite flow is ported.
 */
export function InviteModal({ onClose }: { onClose: () => void }) {
  return (
    <div
      role="dialog"
      aria-label="invite someone"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm rounded-2xl border border-white/60 bg-white/95 p-5 text-sm shadow-xl backdrop-blur-md dark:border-white/10 dark:bg-neutral-900/95"
      >
        <p className="font-display italic text-base">Invite someone</p>
        <p className="mt-2 leading-relaxed text-neutral-600 dark:text-neutral-300">
          The redesigned invite flow is coming online soon. For now use the
          invite surface on your room page.
        </p>
        <button
          type="button"
          onClick={onClose}
          className="mt-4 rounded-full border border-neutral-200 bg-white/80 px-4 py-1.5 font-display italic text-xs text-neutral-700 dark:border-neutral-700 dark:bg-neutral-900/60 dark:text-neutral-200"
        >
          close
        </button>
      </div>
    </div>
  );
}
