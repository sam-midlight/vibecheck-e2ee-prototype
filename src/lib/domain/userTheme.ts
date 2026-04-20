/**
 * Per-user theme color — deterministic from the userId, no event needed.
 *
 * Lifted from Gratitude.tsx so every surface that wants to mark "this
 * is X's data" (slider tracks, sidebar widgets, mood orbs, gratitude
 * dots) can share the same palette and stay consistent.
 *
 * Picker UI deliberately omitted — keeping it deterministic means a
 * brand-new partner instantly has a colour that everyone else sees
 * the same way, no event-replication-lag concerns.
 */

const MEMBER_HUES = [
  '#D97A8C', // warm rose
  '#E8A04B', // ember amber
  '#7FA8C9', // moonstone blue
  '#C967A3', // dusk magenta
  '#9A7A3E', // antique gold
  '#6B9A7A', // sage
  '#B89EC4', // soft violet
  '#FF8FA3', // hot pink
] as const;

/** Stable hex per userId. Same input → same colour. */
export function hueForUser(userId: string): string {
  let h = 0;
  for (let i = 0; i < userId.length; i++) {
    h = (h * 31 + userId.charCodeAt(i)) | 0;
  }
  return MEMBER_HUES[Math.abs(h) % MEMBER_HUES.length];
}

/** Convert #rrggbb to rgba(r,g,b,a) for inline track tints. */
export function hexToRgba(hex: string, alpha: number): string {
  const h = hex.startsWith('#') ? hex.slice(1) : hex;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Approximate WCAG relative luminance (0–1). Used to pick black-or-white
 *  text on top of a theme colour swatch. */
export function relativeLuminance(hex: string): number {
  const h = hex.startsWith('#') ? hex.slice(1) : hex;
  const toLin = (n: number) => {
    const s = n / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const r = toLin(parseInt(h.slice(0, 2), 16));
  const g = toLin(parseInt(h.slice(2, 4), 16));
  const b = toLin(parseInt(h.slice(4, 6), 16));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Returns 'light' if the theme colour is dark enough that white text
 *  reads cleanly on it; 'dark' otherwise. WCAG-aware threshold. */
export function readableInkOn(hex: string): 'light' | 'dark' {
  return relativeLuminance(hex) < 0.5 ? 'light' : 'dark';
}
