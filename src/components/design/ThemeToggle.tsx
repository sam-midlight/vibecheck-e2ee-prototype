'use client';

/**
 * ThemeToggle — small pill in the top nav that flips between light
 * (Dusk) and obsidian (deep night) modes. Writes to the same
 * localStorage key + html.dataset.theme attribute the TweaksPanel
 * uses, so the two stay in sync. Persists across reloads.
 *
 * Sun icon shows in light mode (tap to switch to dark);
 * Moon icon shows in obsidian mode (tap to switch back to light).
 */

import { Icon } from './Icon';
import { useDesignMode } from './useDesignMode';

const STORAGE_KEY = 'vc:design-prefs';

interface Prefs {
  mode: 'light' | 'obsidian';
  palette: 'ember' | 'amber' | 'plum';
}

function readPrefs(): Prefs {
  if (typeof localStorage === 'undefined') return { mode: 'light', palette: 'ember' };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { mode: 'light', palette: 'ember' };
    const parsed = JSON.parse(raw) as Partial<Prefs>;
    return {
      mode: parsed.mode === 'obsidian' ? 'obsidian' : 'light',
      palette:
        parsed.palette === 'amber' || parsed.palette === 'plum'
          ? parsed.palette
          : 'ember',
    };
  } catch {
    return { mode: 'light', palette: 'ember' };
  }
}

export function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const { mode, t } = useDesignMode();
  const next = mode === 'obsidian' ? 'light' : 'obsidian';
  const isDark = mode === 'obsidian';

  function flip() {
    const cur = readPrefs();
    const updated: Prefs = { ...cur, mode: next };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
    } catch {
      /* private mode / quota — ignore */
    }
    document.documentElement.dataset.theme = next === 'obsidian' ? 'obsidian' : '';
  }

  if (compact) {
    return (
      <button
        type="button"
        onClick={flip}
        aria-label={isDark ? 'switch to light mode' : 'switch to dark mode'}
        title={isDark ? 'Switch to Dusk' : 'Switch to Obsidian'}
        className="flex h-9 w-9 items-center justify-center rounded-full border border-white/50 bg-white/60 text-neutral-600 shadow-sm backdrop-blur-md transition-all hover:bg-white/80 hover:text-neutral-900 active:scale-[0.96] dark:border-white/10 dark:bg-neutral-900/60 dark:text-neutral-300"
      >
        <Icon name={isDark ? 'sun' : 'moon'} size={15} />
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={flip}
      aria-label={isDark ? 'switch to light mode' : 'switch to dark mode'}
      title={isDark ? 'Switch to Dusk' : 'Switch to Obsidian'}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '6px 12px',
        borderRadius: 999,
        border: 'none',
        cursor: 'pointer',
        background: t.surface,
        color: t.ink,
        fontFamily: 'var(--font-sans), Geist, system-ui, sans-serif',
        fontSize: 12,
        boxShadow: `inset 0 1px 0 rgba(255,255,255,0.6), 0 1px 2px ${t.line}`,
      }}
    >
      <Icon name={isDark ? 'sun' : 'moon'} size={13} />
      <span>{isDark ? 'Dusk' : 'Obsidian'}</span>
    </button>
  );
}
