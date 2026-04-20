'use client';

/**
 * Organic Loaders — 20 indeterminate loading indicators in 200×200 SVG cells.
 * All monochrome blobs, animated via CSS keyframes + an SVG goo filter.
 * Ported verbatim from the Claude Design handoff (chat transcript:
 * "Prototype 20 simple, tasteful indeterminate loading indicators that fit in
 * a 200×200 space, on a wrapping grid. All black and white, no text. All
 * should have an organic, blobby feeling.").
 *
 * Usage:
 *   <OrganicLoader variant={1} />            // pick by number 1..20
 *   <OrganicLoader variant={5} size={48} />  // scale to non-default
 *   <GooFilterDefs />                        // mount once at app root
 *
 * The goo filter must be present in the DOM somewhere or the merging blobs
 * render as separate circles. It's defined in <GooFilterDefs />; either
 * import that and mount it once near the layout root, OR rely on the
 * loader's own auto-mount (it injects the defs lazily on first render).
 */

import { useEffect, useId, useRef, useState } from 'react';

export type OrganicLoaderVariant =
  | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10
  | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20;

export interface OrganicLoaderProps {
  variant: OrganicLoaderVariant;
  /** Pixel size of one side. Default 64. The SVG renders at 200×200 and
   *  scales via the wrapper. */
  size?: number;
  /** Override the default ink colour (currentColor by default). */
  color?: string;
  className?: string;
  'aria-label'?: string;
}

const STYLE_ID = 'organic-loader-styles';
const FILTER_ID = 'organic-loader-filters';

/**
 * Mount this once at your app root if you want the goo filter + keyframes
 * available before any loader renders. The loader itself will auto-mount
 * if you forget, but pre-mounting avoids a tiny first-paint flash.
 */
export function GooFilterDefs() {
  return (
    <>
      <StyleInjector />
      <FilterDefs />
    </>
  );
}

function StyleInjector() {
  useEffect(() => {
    if (typeof document === 'undefined') return;
    if (document.getElementById(STYLE_ID)) return;
    const el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = LOADER_CSS;
    document.head.appendChild(el);
  }, []);
  return null;
}

function FilterDefs() {
  // Mount once. SVG <filter> defs are global by id, so a single instance is
  // enough for every loader on the page.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    if (typeof document === 'undefined') return;
    if (document.getElementById(FILTER_ID)) return;
    setMounted(true);
  }, []);
  if (!mounted) return null;
  return (
    <svg
      id={FILTER_ID}
      width="0"
      height="0"
      style={{ position: 'absolute', pointerEvents: 'none' }}
      aria-hidden
    >
      <defs>
        <filter id="ol-goo">
          <feGaussianBlur in="SourceGraphic" stdDeviation="6" result="blur" />
          <feColorMatrix
            in="blur"
            mode="matrix"
            values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 22 -11"
            result="goo"
          />
          <feBlend in="SourceGraphic" in2="goo" />
        </filter>
        <filter id="ol-goo-soft">
          <feGaussianBlur in="SourceGraphic" stdDeviation="4" result="blur" />
          <feColorMatrix
            in="blur"
            mode="matrix"
            values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 18 -8"
            result="goo"
          />
        </filter>
      </defs>
    </svg>
  );
}

export function OrganicLoader({
  variant,
  size = 64,
  color = 'currentColor',
  className,
  'aria-label': ariaLabel = 'loading',
}: OrganicLoaderProps) {
  return (
    <span
      role="status"
      aria-label={ariaLabel}
      className={className}
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        color,
        lineHeight: 0,
      }}
    >
      <GooFilterDefs />
      <svg
        width={size}
        height={size}
        viewBox="0 0 200 200"
        style={{ display: 'block', overflow: 'visible' }}
        aria-hidden
      >
        {renderVariant(variant)}
      </svg>
    </span>
  );
}

function renderVariant(v: OrganicLoaderVariant): React.ReactElement {
  switch (v) {
    case 1:
      return (
        <g filter="url(#ol-goo)">
          <circle className="ol-l01-a" cx="160" cy="100" r="22" fill="currentColor" />
          <circle className="ol-l01-b" cx="40" cy="100" r="22" fill="currentColor" />
          <circle cx="100" cy="100" r="18" fill="currentColor" />
        </g>
      );
    case 2:
      return (
        <g filter="url(#ol-goo)">
          <circle className="ol-l02-a" cx="100" cy="100" r="26" fill="currentColor" />
          <circle className="ol-l02-b" cx="100" cy="100" r="26" fill="currentColor" />
        </g>
      );
    case 3:
      return (
        <g filter="url(#ol-goo)">
          <circle className="ol-l03-a" cx="100" cy="100" r="24" fill="currentColor" />
          <circle className="ol-l03-b" cx="100" cy="100" r="24" fill="currentColor" />
        </g>
      );
    case 4:
      return (
        <svg className="ol-l04" width="200" height="200" viewBox="0 0 200 200" x="0" y="0">
          <path
            fill="currentColor"
            d="M100,40 C140,40 160,70 160,100 C160,135 135,160 100,160 C65,160 40,135 40,100 C40,70 60,40 100,40 Z"
          />
        </svg>
      );
    case 5:
      return (
        <g className="ol-l05" style={{ transformOrigin: 'center' }}>
          <path
            fill="currentColor"
            d="M100,50 C138,52 152,82 150,108 C148,138 122,152 98,150 C70,148 52,126 54,100 C56,72 72,48 100,50 Z"
          />
        </g>
      );
    case 6:
      return (
        <g className="ol-l06" style={{ transformOrigin: 'center' }}>
          <path
            fill="currentColor"
            d="M100,40 C130,40 140,60 150,78 C160,96 165,120 150,140 C132,162 108,160 92,155 C70,148 48,138 42,118 C36,96 46,74 62,58 C76,44 90,40 100,40 Z"
          />
        </g>
      );
    case 7:
      return (
        <g filter="url(#ol-goo)">
          <circle cx="100" cy="100" r="14" fill="currentColor" />
          <g className="ol-l07-orbit">
            <circle cx="155" cy="100" r="16" fill="currentColor" />
            <circle cx="72" cy="148" r="12" fill="currentColor" />
            <circle cx="72" cy="52" r="12" fill="currentColor" />
          </g>
        </g>
      );
    case 8:
      return (
        <g filter="url(#ol-goo)">
          <ellipse cx="100" cy="30" rx="34" ry="22" fill="currentColor" />
          <ellipse className="ol-l08-drop1" cx="100" cy="30" rx="18" ry="18" fill="currentColor" />
          <ellipse className="ol-l08-drop2" cx="100" cy="30" rx="14" ry="14" fill="currentColor" />
          <ellipse cx="100" cy="186" rx="30" ry="10" fill="currentColor" />
        </g>
      );
    case 9:
      return (
        <g className="ol-l09" style={{ transformOrigin: 'center' }}>
          <g filter="url(#ol-goo)" className="ol-l09-spin">
            <circle cx="100" cy="40" r="14" fill="currentColor" />
            <circle cx="152" cy="70" r="14" fill="currentColor" />
            <circle cx="152" cy="130" r="14" fill="currentColor" />
            <circle cx="100" cy="160" r="14" fill="currentColor" />
            <circle cx="48" cy="130" r="14" fill="currentColor" />
            <circle cx="48" cy="70" r="14" fill="currentColor" />
          </g>
        </g>
      );
    case 10: {
      // Love-tank palette: rose-300 outline, pink/rose vertical gradient
      // for the rising fluid. Matches LoveTank.tsx's pink-500 fill bar +
      // rose-400 highlights so the loader reads as "filling up your love
      // meter" rather than a generic monochrome blob.
      const idSuffix = Math.random().toString(36).slice(2, 8);
      const clipId = `ol-l10-clip-${idSuffix}`;
      const gradId = `ol-l10-grad-${idSuffix}`;
      return (
        <g>
          <defs>
            <clipPath id={clipId}>
              <path d="M100,30 C148,32 166,70 164,108 C162,152 128,170 98,168 C58,165 36,132 38,96 C40,58 62,28 100,30 Z" />
            </clipPath>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#fb7185" />
              <stop offset="55%" stopColor="#f472b6" />
              <stop offset="100%" stopColor="#ec4899" />
            </linearGradient>
          </defs>
          <path
            d="M100,30 C148,32 166,70 164,108 C162,152 128,170 98,168 C58,165 36,132 38,96 C40,58 62,28 100,30 Z"
            fill="none"
            stroke="#fda4af"
            strokeWidth={3}
          />
          <g clipPath={`url(#${clipId})`}>
            <g className="ol-l10-wave">
              <path d="M-20,140 Q20,120 60,140 T140,140 T220,140 T300,140 V260 H-20 Z" fill={`url(#${gradId})`} />
              <path d="M-20,200 Q20,180 60,200 T140,200 T220,200 T300,200 V320 H-20 Z" fill={`url(#${gradId})`} />
              <path d="M-20,260 Q20,240 60,260 T140,260 T220,260 T300,260 V380 H-20 Z" fill={`url(#${gradId})`} />
            </g>
          </g>
        </g>
      );
    }
    case 11:
      return (
        <g filter="url(#ol-goo)">
          <circle className="ol-l11-a" cx="100" cy="100" r="22" fill="currentColor" />
          <circle className="ol-l11-b" cx="100" cy="100" r="22" fill="currentColor" />
        </g>
      );
    case 12:
      return (
        <g className="ol-l12-wig" style={{ transformOrigin: 'center' }}>
          <path
            d="M30,100 C55,60 85,140 115,100 S175,60 190,100"
            className="ol-l12"
            fill="none"
            stroke="currentColor"
            strokeWidth={22}
            strokeLinecap="round"
            strokeDasharray="18 14"
          />
        </g>
      );
    case 13:
      return (
        <g className="ol-l13" style={{ transformOrigin: 'center' }}>
          <g className="ol-l13-shift">
            <path
              fill="currentColor"
              d="M100,50 C140,55 150,85 148,105 C146,135 120,150 95,148 C65,146 50,120 52,95 C54,65 70,48 100,50 Z"
            />
          </g>
        </g>
      );
    case 14:
      return (
        <g filter="url(#ol-goo)">
          <ellipse cx="100" cy="180" rx="48" ry="18" fill="currentColor" />
          <circle className="ol-l14-b" cx="92" cy="100" r="12" fill="currentColor" />
          <circle className="ol-l14-b" cx="108" cy="100" r="10" fill="currentColor" />
          <circle className="ol-l14-b" cx="96" cy="100" r="14" fill="currentColor" />
          <circle className="ol-l14-b" cx="104" cy="100" r="11" fill="currentColor" />
          <circle className="ol-l14-b" cx="100" cy="100" r="9" fill="currentColor" />
        </g>
      );
    case 15:
      return (
        <g className="ol-l15">
          <g filter="url(#ol-goo)">
            <circle cx="100" cy="62" r="28" fill="currentColor" />
            <circle cx="100" cy="138" r="28" fill="currentColor" />
            <circle cx="100" cy="100" r="8" fill="currentColor" />
          </g>
        </g>
      );
    case 16:
      return (
        <g>
          <g>
            <path
              className="ol-l16-r"
              d="M100,40 C140,42 160,70 158,102 C156,138 128,160 100,158 C66,156 42,132 44,98 C46,64 68,38 100,40 Z"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
            />
            <path
              className="ol-l16-r"
              d="M100,40 C140,42 160,70 158,102 C156,138 128,160 100,158 C66,156 42,132 44,98 C46,64 68,38 100,40 Z"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
            />
            <path
              className="ol-l16-r"
              d="M100,40 C140,42 160,70 158,102 C156,138 128,160 100,158 C66,156 42,132 44,98 C46,64 68,38 100,40 Z"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
            />
          </g>
          <g className="ol-l16-center">
            <circle cx="100" cy="100" r="16" fill="currentColor" />
          </g>
        </g>
      );
    case 17:
      return (
        <g filter="url(#ol-goo)" className="ol-l17-orbit">
          <circle className="ol-l17-head" cx="160" cy="100" r="16" fill="currentColor" />
          <circle cx="148" cy="100" r="11" fill="currentColor" />
          <circle cx="138" cy="100" r="8" fill="currentColor" />
          <circle cx="130" cy="100" r="5" fill="currentColor" />
        </g>
      );
    case 18:
      return (
        <g filter="url(#ol-goo)">
          <circle className="ol-l18-d" style={{ ['--a' as string]: '0deg' }} cx="100" cy="100" r="12" fill="currentColor" />
          <circle className="ol-l18-d" style={{ ['--a' as string]: '60deg' }} cx="100" cy="100" r="12" fill="currentColor" />
          <circle className="ol-l18-d" style={{ ['--a' as string]: '120deg' }} cx="100" cy="100" r="12" fill="currentColor" />
          <circle className="ol-l18-d" style={{ ['--a' as string]: '180deg' }} cx="100" cy="100" r="12" fill="currentColor" />
          <circle className="ol-l18-d" style={{ ['--a' as string]: '240deg' }} cx="100" cy="100" r="12" fill="currentColor" />
          <circle className="ol-l18-d" style={{ ['--a' as string]: '300deg' }} cx="100" cy="100" r="12" fill="currentColor" />
        </g>
      );
    case 19:
      return (
        <g className="ol-l19" filter="url(#ol-goo)">
          <circle className="ol-l19-dot" cx="100" cy="44" r="16" fill="currentColor" />
          <circle className="ol-l19-dot" style={{ animationDelay: '-0.2s' }} cx="146" cy="72" r="12" fill="currentColor" />
          <circle className="ol-l19-dot" style={{ animationDelay: '-0.4s' }} cx="156" cy="122" r="9" fill="currentColor" />
          <circle className="ol-l19-dot" style={{ animationDelay: '-0.6s' }} cx="122" cy="150" r="7" fill="currentColor" />
          <circle className="ol-l19-dot" style={{ animationDelay: '-0.8s' }} cx="88" cy="140" r="5" fill="currentColor" />
        </g>
      );
    case 20:
      return (
        <g filter="url(#ol-goo)">
          <ellipse className="ol-l20-a" cx="100" cy="100" rx="22" ry="22" fill="currentColor" />
          <ellipse className="ol-l20-b" cx="100" cy="100" rx="22" ry="22" fill="currentColor" />
        </g>
      );
    default:
      return <g />;
  }
}

// All keyframes + class rules from the design handoff, namespaced with `ol-`
// so they don't collide with any other animation in the app. Injected once
// per page via StyleInjector above.
const LOADER_CSS = `
@keyframes ol-l01-orbit { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
.ol-l01-a, .ol-l01-b { animation: ol-l01-orbit 2.4s ease-in-out infinite; transform-origin: 100px 100px; }
.ol-l01-b { animation-delay: -1.2s; }

.ol-l02-a { animation: ol-l02-left 1.8s ease-in-out infinite; }
.ol-l02-b { animation: ol-l02-right 1.8s ease-in-out infinite; }
@keyframes ol-l02-left { 0%, 100% { transform: translateX(-46px); } 50% { transform: translateX(-6px); } }
@keyframes ol-l02-right { 0%, 100% { transform: translateX(46px); } 50% { transform: translateX(6px); } }

.ol-l03-a { animation: ol-l03-left 2.2s ease-in-out infinite; }
.ol-l03-b { animation: ol-l03-right 2.2s ease-in-out infinite; }
@keyframes ol-l03-left { 0% { transform: translateX(0) scale(1); } 40% { transform: translateX(0) scale(1.05); } 70%,100% { transform: translateX(-30px) scale(0.85); } }
@keyframes ol-l03-right { 0% { transform: translateX(0) scale(1); } 40% { transform: translateX(0) scale(1.05); } 70%,100% { transform: translateX(30px) scale(0.85); } }

.ol-l04 path { animation: ol-l04-morph 3s ease-in-out infinite; transform-origin: 100px 100px; }
@keyframes ol-l04-morph {
  0%, 100% { d: path("M100,40 C140,40 160,70 160,100 C160,135 135,160 100,160 C65,160 40,135 40,100 C40,70 60,40 100,40 Z"); }
  50%      { d: path("M100,48 C150,45 155,85 158,110 C160,150 120,158 95,160 C55,160 42,125 45,92 C48,60 65,50 100,48 Z"); }
}

.ol-l05 { animation: ol-l05-pulse 1.2s ease-in-out infinite; }
@keyframes ol-l05-pulse {
  0%, 100% { transform: scale(0.82); }
  45%      { transform: scale(1.02); }
  55%      { transform: scale(0.92); }
  65%      { transform: scale(1.06); }
}

.ol-l06 { animation: ol-l06-rot 3.2s linear infinite; }
@keyframes ol-l06-rot { to { transform: rotate(360deg); } }

.ol-l07-orbit { animation: ol-l07-spin 2.4s linear infinite; transform-origin: 100px 100px; }
@keyframes ol-l07-spin { to { transform: rotate(360deg); } }

.ol-l08-drop1 { animation: ol-l08-fall 2.4s ease-in infinite; }
.ol-l08-drop2 { animation: ol-l08-fall 2.4s ease-in infinite; animation-delay: -1.2s; }
@keyframes ol-l08-fall {
  0%   { transform: translateY(-20px) scale(0.4, 0.8); }
  30%  { transform: translateY(40px) scale(1, 1); }
  60%  { transform: translateY(120px) scale(0.9, 1.2); }
  100% { transform: translateY(200px) scale(0.6, 0.6); }
}

.ol-l09 { animation: ol-l09-breath 2.4s ease-in-out infinite; }
@keyframes ol-l09-breath { 0%, 100% { transform: scale(0.9); } 50% { transform: scale(1.08); } }
.ol-l09-spin { animation: ol-l09-spin 6s linear infinite; transform-origin: 100px 100px; }
@keyframes ol-l09-spin { to { transform: rotate(360deg); } }

.ol-l10-wave { animation: ol-l10-wave 2.4s ease-in-out infinite; }
@keyframes ol-l10-wave { 0% { transform: translateY(60px); } 100% { transform: translateY(-140px); } }

.ol-l11-a { animation: ol-l11-a 2s ease-in-out infinite; }
.ol-l11-b { animation: ol-l11-b 2s ease-in-out infinite; }
@keyframes ol-l11-a {
  0%       { transform: translate(-60px, -22px) scale(1); }
  45%,55%  { transform: translate(-8px, 0px) scale(1.1); }
  100%     { transform: translate(60px, 22px) scale(0.6); opacity: 0; }
}
@keyframes ol-l11-b {
  0%       { transform: translate(60px, 22px) scale(1); }
  45%,55%  { transform: translate(8px, 0px) scale(1.1); }
  100%     { transform: translate(-60px,-22px) scale(0.6); opacity: 0; }
}

.ol-l12 { animation: ol-l12-slide 2.4s linear infinite; }
@keyframes ol-l12-slide { 0% { stroke-dashoffset: 0; } 100% { stroke-dashoffset: -120; } }
.ol-l12-wig { animation: ol-l12-wig 2s ease-in-out infinite; }
@keyframes ol-l12-wig { 0%,100% { transform: rotate(-4deg); } 50% { transform: rotate(4deg); } }

.ol-l13 path { animation: ol-l13-morph 4s ease-in-out infinite; }
@keyframes ol-l13-morph {
  0%,100% { d: path("M100,50 C140,55 150,85 148,105 C146,135 120,150 95,148 C65,146 50,120 52,95 C54,65 70,48 100,50 Z"); }
  33%     { d: path("M100,45 C135,50 158,80 150,112 C142,145 110,155 90,150 C55,142 48,118 55,90 C60,65 75,42 100,45 Z"); }
  66%     { d: path("M100,55 C145,60 155,95 145,120 C132,148 115,152 95,145 C60,135 48,105 55,82 C62,62 75,52 100,55 Z"); }
}
.ol-l13-shift { animation: ol-l13-shift 4s ease-in-out infinite; transform-origin: center; }
@keyframes ol-l13-shift {
  0%,100% { transform: translate(0,0) rotate(0); }
  25%     { transform: translate(4px,-4px) rotate(6deg); }
  50%     { transform: translate(-4px,4px) rotate(-4deg); }
  75%     { transform: translate(3px,3px) rotate(8deg); }
}

.ol-l14-b { animation: ol-l14-rise 3s ease-in infinite; }
.ol-l14-b:nth-child(2) { animation-delay: 0s; }
.ol-l14-b:nth-child(3) { animation-delay: -0.6s; }
.ol-l14-b:nth-child(4) { animation-delay: -1.2s; }
.ol-l14-b:nth-child(5) { animation-delay: -1.8s; }
.ol-l14-b:nth-child(6) { animation-delay: -2.4s; }
@keyframes ol-l14-rise {
  0%   { transform: translateY(80px) scale(0.4); }
  30%  { transform: translateY(40px) scale(0.9); }
  70%  { transform: translateY(-60px) scale(1); }
  100% { transform: translateY(-100px) scale(0.4); }
}

.ol-l15 { animation: ol-l15-rot 3s ease-in-out infinite; transform-origin: 100px 100px; }
@keyframes ol-l15-rot { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }

.ol-l16-r { transform-origin: center; transform-box: fill-box; animation: ol-l16 2.4s ease-out infinite; opacity: 0; }
.ol-l16-r:nth-child(2) { animation-delay: -0.8s; }
.ol-l16-r:nth-child(3) { animation-delay: -1.6s; }
@keyframes ol-l16 { 0% { transform: scale(0.3); opacity: 1; } 100% { transform: scale(1.6); opacity: 0; } }
.ol-l16-center { animation: ol-l16c 2.4s ease-in-out infinite; transform-origin: center; transform-box: fill-box; }
@keyframes ol-l16c { 0%,100% { transform: scale(1); } 50% { transform: scale(0.85); } }

.ol-l17-orbit { animation: ol-l17-spin 2s linear infinite; transform-origin: 100px 100px; }
@keyframes ol-l17-spin { to { transform: rotate(360deg); } }
.ol-l17-head { animation: ol-l17-pulse 0.8s ease-in-out infinite; transform-origin: center; transform-box: fill-box; }
@keyframes ol-l17-pulse { 0%,100% { transform: scale(1); } 50% { transform: scale(1.2); } }

.ol-l18-d { animation: ol-l18 2.4s ease-in-out infinite; transform-origin: 100px 100px; }
@keyframes ol-l18 {
  0%,100% { transform: rotate(0deg) translate(60px,0) rotate(0deg); }
  45%,55% { transform: rotate(var(--a)) translate(6px,0) rotate(calc(-1 * var(--a))); }
}

.ol-l19 { animation: ol-l19 2s linear infinite; transform-origin: 100px 100px; }
@keyframes ol-l19 { to { transform: rotate(360deg); } }
.ol-l19-dot { animation: ol-l19-scale 1.6s ease-in-out infinite; transform-origin: center; transform-box: fill-box; }
@keyframes ol-l19-scale { 0%,100% { transform: scale(0.6); } 50% { transform: scale(1.1); } }

.ol-l20-a { animation: ol-l20-a 1.8s ease-in-out infinite; }
.ol-l20-b { animation: ol-l20-b 1.8s ease-in-out infinite; }
@keyframes ol-l20-a { 0%,100% { transform: translateX(-40px) scale(0.9,1.05); } 50% { transform: translateX(0) scale(1.3,0.85); } }
@keyframes ol-l20-b { 0%,100% { transform: translateX(40px) scale(0.9,1.05); } 50% { transform: translateX(0) scale(1.3,0.85); } }
`;

// Suppress unused import warning — useId/useRef are exported for potential
// extension but the current implementation doesn't need them.
void useId;
void useRef;

// ---------------------------------------------------------------------------
// <Loading /> — convenience wrapper that mounts the love-tank-themed #10
// loader with optional caption + sensible spacing for in-app use.
// ---------------------------------------------------------------------------

export interface LoadingProps {
  /** Pixel size of the loader. Default 56. */
  size?: number;
  /** Optional caption shown beneath the loader. */
  label?: string;
  /** Visual density. `inline` is unpadded; `block` adds vertical breathing
   *  room so it sits comfortably as a full-page placeholder. */
  density?: 'inline' | 'block';
  className?: string;
}

export function Loading({
  size = 56,
  label,
  density = 'block',
  className,
}: LoadingProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={
        (density === 'block'
          ? 'flex flex-col items-center justify-center gap-3 py-12 '
          : 'flex items-center gap-2 ') + (className ?? '')
      }
    >
      <OrganicLoader variant={10} size={size} aria-label={label ?? 'loading'} />
      {label && (
        <span className="text-xs text-pink-900/70 dark:text-pink-200/70">
          {label}
        </span>
      )}
    </div>
  );
}
