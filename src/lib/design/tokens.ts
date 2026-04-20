/**
 * Warm Obsidian / Ember at Dusk — the design-system palette for the
 * 2026-04-19 makeover. Mirrors the token set from the Claude Design
 * handoff (project/vibecheck.jsx TOKENS) so JS consumers get the same
 * palette the CSS layer uses via custom properties in globals.css.
 *
 * Two modes: `light` (warm parchment, the default) and `obsidian` (Safe
 * Space — deep warm near-black with moonstone cool accents). The Safe
 * Space tab flips `html[data-theme]` between them.
 */

export interface ThemeTokens {
  base: string;
  baseTop: string;
  baseBottom: string;
  surface: string;
  surfaceAlt: string;
  ink: string;
  inkDim: string;
  inkFaint: string;
  line: string;
  lineSoft: string;
  ember: string;
  emberDeep: string;
  amber: string;
  brass: string;
  moss: string;
  plum: string;
  clayShadow: string;
  clayShadowHover: string;
  clayInset: string;
}

export const light: ThemeTokens = {
  base: '#F2EBDF',
  baseTop: '#F6EFE3',
  baseBottom: '#EEDFCB',
  surface: 'rgba(255, 247, 235, 0.72)',
  surfaceAlt: 'rgba(247, 232, 210, 0.78)',
  ink: '#1F1A16',
  inkDim: '#6B5D51',
  inkFaint: '#A99A8A',
  line: 'rgba(31,26,22,0.08)',
  lineSoft: 'rgba(31,26,22,0.05)',
  ember: '#D4572A',
  emberDeep: '#A63E18',
  amber: '#E8A04B',
  brass: '#9A7A3E',
  moss: '#6B7A4A',
  plum: '#7A4A5E',
  clayShadow:
    '0 1px 0 rgba(255,255,255,0.9) inset, 0 -1px 0 rgba(80,50,20,0.04) inset, 0 10px 28px -14px rgba(80,50,20,0.22), 0 2px 6px -3px rgba(80,50,20,0.12)',
  clayShadowHover:
    '0 1px 0 rgba(255,255,255,0.95) inset, 0 -1px 0 rgba(80,50,20,0.04) inset, 0 16px 38px -14px rgba(80,50,20,0.28), 0 2px 8px -3px rgba(80,50,20,0.14)',
  clayInset:
    'inset 0 2px 4px rgba(80,50,20,0.10), inset 0 -1px 0 rgba(255,255,255,0.6)',
};

export const obsidian: ThemeTokens = {
  base: '#0F0C0A',
  baseTop: '#14110E',
  baseBottom: '#0A0807',
  surface: 'rgba(34, 22, 16, 0.62)',
  surfaceAlt: 'rgba(44, 30, 22, 0.7)',
  ink: '#EDE3D3',
  inkDim: '#8A7E70',
  inkFaint: '#574E44',
  line: 'rgba(237,227,211,0.08)',
  lineSoft: 'rgba(237,227,211,0.04)',
  ember: '#E8A04B',
  emberDeep: '#D4572A',
  amber: '#F0C07A',
  brass: '#A8B5C4',
  moss: '#8FA07A',
  plum: '#B08598',
  clayShadow:
    '0 1px 0 rgba(255,240,220,0.04) inset, 0 -1px 0 rgba(0,0,0,0.4) inset, 0 10px 28px -14px rgba(0,0,0,0.6), 0 2px 6px -3px rgba(0,0,0,0.4)',
  clayShadowHover:
    '0 1px 0 rgba(255,240,220,0.05) inset, 0 -1px 0 rgba(0,0,0,0.5) inset, 0 16px 38px -14px rgba(0,0,0,0.7)',
  clayInset:
    'inset 0 2px 4px rgba(0,0,0,0.5), inset 0 -1px 0 rgba(255,240,220,0.03)',
};

export type Mode = 'light' | 'obsidian';

export function tokensFor(mode: Mode): ThemeTokens {
  return mode === 'obsidian' ? obsidian : light;
}
