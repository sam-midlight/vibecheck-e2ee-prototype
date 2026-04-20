'use client';

/**
 * TweaksPanel — the design-system control surface from the Warm Obsidian
 * brief. Small floating pill at bottom-left that expands into a panel
 * with Mode (Dusk / Obsidian) + Palette (Ember / Amber / Plum) toggles.
 *
 * Settings persist to localStorage and drive `html.dataset.theme` +
 * `html.dataset.palette`, which useDesignMode subscribes to so every
 * surface re-renders with fresh tokens + the LavaLamp re-seeds its blob
 * colours.
 *
 * Mounted in app/layout.tsx so it's globally accessible. Hidden by
 * default on mobile to preserve the focused reading experience; tap the
 * collapsed pill to open.
 */

import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { useDesignMode, type Palette } from './useDesignMode';

const STORAGE_KEY = 'vc:design-prefs';

interface Prefs {
  mode: 'light' | 'obsidian';
  palette: Palette;
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

function writePrefs(p: Prefs) {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
  } catch {
    /* quota / private mode — ignore */
  }
  document.documentElement.dataset.theme = p.mode === 'obsidian' ? 'obsidian' : '';
  document.documentElement.dataset.palette = p.palette;
}

export function TweaksPanel() {
  const [open, setOpen] = useState(false);
  const { t, mode, palette } = useDesignMode();

  // Restore prefs on first mount.
  useEffect(() => {
    writePrefs(readPrefs());
  }, []);

  const setMode = (m: Prefs['mode']) => {
    writePrefs({ mode: m, palette });
  };
  const setPalette = (p: Palette) => {
    writePrefs({ mode, palette: p });
  };

  return (
    <div
      style={{
        position: 'fixed',
        left: 'calc(env(safe-area-inset-left, 0px) + 16px)',
        bottom: 'calc(env(safe-area-inset-bottom, 0px) + 16px)',
        zIndex: 45,
      }}
    >
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="open design tweaks"
          style={{
            width: 36,
            height: 36,
            borderRadius: 999,
            border: 'none',
            cursor: 'pointer',
            background: t.surface,
            color: t.inkDim,
            backdropFilter: 'blur(16px) saturate(1.3)',
            WebkitBackdropFilter: 'blur(16px) saturate(1.3)',
            boxShadow: t.clayShadow,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            transition: 'color 180ms ease',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = t.ink;
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = t.inkDim;
          }}
        >
          <Icon name="dots" size={18} />
        </button>
      )}
      {open && (
        <div
          role="dialog"
          aria-label="design tweaks"
          style={{
            width: 260,
            padding: 16,
            borderRadius: 20,
            background: t.surface,
            color: t.ink,
            backdropFilter: 'blur(20px) saturate(1.4)',
            WebkitBackdropFilter: 'blur(20px) saturate(1.4)',
            boxShadow: t.clayShadowHover,
            fontFamily: 'var(--font-sans), Geist, system-ui, sans-serif',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <span
              style={{
                fontFamily: 'var(--font-mono), JetBrains Mono, monospace',
                fontSize: 10.5,
                letterSpacing: '0.12em',
                textTransform: 'uppercase',
                color: t.inkDim,
              }}
            >
              Tweaks
            </span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="close"
              style={{
                width: 24,
                height: 24,
                borderRadius: 999,
                border: 'none',
                cursor: 'pointer',
                background: 'transparent',
                color: t.inkDim,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Icon name="x" size={14} />
            </button>
          </div>

          {/* Mode */}
          <div
            style={{
              fontFamily: 'var(--font-mono), JetBrains Mono, monospace',
              fontSize: 10,
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
              color: t.inkFaint,
              marginBottom: 6,
            }}
          >
            Mode
          </div>
          <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
            {(['light', 'obsidian'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                style={{
                  flex: 1,
                  padding: '8px 10px',
                  borderRadius: 12,
                  border: 'none',
                  cursor: 'pointer',
                  background: mode === m ? t.ink : t.surfaceAlt,
                  color: mode === m ? t.base : t.ink,
                  fontFamily: 'inherit',
                  fontSize: 12,
                  fontWeight: 500,
                  textTransform: 'capitalize',
                  boxShadow:
                    mode === m
                      ? 'inset 0 1px 0 rgba(255,255,255,0.08)'
                      : `inset 0 1px 0 rgba(255,255,255,0.6)`,
                }}
              >
                {m === 'light' ? 'Dusk' : 'Obsidian'}
              </button>
            ))}
          </div>

          {/* Palette */}
          <div
            style={{
              fontFamily: 'var(--font-mono), JetBrains Mono, monospace',
              fontSize: 10,
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
              color: t.inkFaint,
              marginBottom: 6,
            }}
          >
            Lava palette
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            {(['ember', 'amber', 'plum'] as const).map((p) => {
              const swatch =
                p === 'ember' ? '#FF6B4A' : p === 'amber' ? '#FFB347' : '#C967A3';
              const active = palette === p;
              return (
                <button
                  key={p}
                  type="button"
                  onClick={() => setPalette(p)}
                  style={{
                    flex: 1,
                    padding: '8px 10px',
                    borderRadius: 12,
                    border: 'none',
                    cursor: 'pointer',
                    background: active ? t.ink : t.surfaceAlt,
                    color: active ? t.base : t.ink,
                    fontFamily: 'inherit',
                    fontSize: 12,
                    fontWeight: 500,
                    textTransform: 'capitalize',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 6,
                  }}
                >
                  <span
                    aria-hidden
                    style={{
                      width: 10,
                      height: 10,
                      borderRadius: 999,
                      background: swatch,
                      boxShadow: `0 0 6px ${swatch}80`,
                    }}
                  />
                  {p}
                </button>
              );
            })}
          </div>

          <p
            style={{
              marginTop: 14,
              marginBottom: 0,
              fontSize: 11,
              lineHeight: 1.4,
              color: t.inkFaint,
            }}
          >
            Saved locally. Safe Space still forces obsidian while you&apos;re in it.
          </p>
        </div>
      )}
    </div>
  );
}
