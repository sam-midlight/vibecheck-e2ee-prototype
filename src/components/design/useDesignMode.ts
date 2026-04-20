'use client';

import { useEffect, useState } from 'react';
import { light, obsidian, type Mode, type ThemeTokens } from '@/lib/design/tokens';

export type Palette = 'ember' | 'amber' | 'plum';

/**
 * Subscribe to the current design mode (light / obsidian) + lava palette.
 * Controlled by `document.documentElement.dataset.theme` ("obsidian" or
 * unset) and `dataset.palette` ("ember" / "amber" / "plum"). The Safe
 * Space tab flips theme; the Tweaks panel flips both.
 */
export function useDesignMode(): {
  mode: Mode;
  palette: Palette;
  t: ThemeTokens;
} {
  const [mode, setMode] = useState<Mode>('light');
  const [palette, setPalette] = useState<Palette>('ember');

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const readMode = (): Mode =>
      document.documentElement.dataset.theme === 'obsidian' ? 'obsidian' : 'light';
    const readPalette = (): Palette => {
      const p = document.documentElement.dataset.palette;
      return p === 'amber' || p === 'plum' ? p : 'ember';
    };
    setMode(readMode());
    setPalette(readPalette());
    const obs = new MutationObserver(() => {
      setMode(readMode());
      setPalette(readPalette());
    });
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-palette'],
    });
    return () => obs.disconnect();
  }, []);

  return { mode, palette, t: mode === 'obsidian' ? obsidian : light };
}
