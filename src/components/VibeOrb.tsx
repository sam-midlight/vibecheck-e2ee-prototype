'use client';

/**
 * VibeOrb — the "sun" / center-of-gravity element. Bottom-right anchored
 * per the Warm Obsidian design brief (moved from bottom-centered so it no
 * longer occludes the center reading column). Tapping it fans 8 planet
 * pills into an upper-left arc, each routing to a feature sheet.
 *
 * The orb itself is the whimsical liquid-swirl version from the Claude
 * Design handoff: internal drifting colour blobs, rotating corona rays,
 * outer glow aura pulsing with the breath loop, 4 idle satellite
 * particles orbiting when closed, sparkle emitters on hover + while
 * open, squish-and-bounce on click, and 3 concentric dashed orbit rings
 * rotating in alternating directions when the planets are deployed.
 *
 * Mode-aware: obsidian theme swaps the sun palette for a cool moon
 * palette (parchment/moonstone/slate) via useDesignMode. Planet hues
 * stay warm in both modes — they're "planets" regardless of day/night.
 *
 * Feature routing preserved from the previous orb: each PLANETS row
 * specifies a React Component that renders inside <FeatureSheet> when
 * activated. Escape closes the sheet first, then collapses the fan.
 */

import { useEffect, useRef, useState, type ComponentType } from 'react';
import { useReducedMotionPref } from '@/lib/motionPrefs';
import { DateGeneratorWidget } from './DateGeneratorWidget';
import { Dates } from './Dates';
import { FeatureSheet } from './FeatureSheet';
import { LoveTank } from './LoveTank';
import { MindReader } from './MindReader';
import { Roulette } from './Roulette';
import { TimeCapsules } from './TimeCapsules';
import { VibeSliders } from './VibeSliders';
import { Wishlist } from './Wishlist';
import { Icon } from './design/Icon';
import { useDesignMode } from './design/useDesignMode';
import type { IconName } from './design/Icon';

// ---------------------------------------------------------------------------
// Planet catalog
// ---------------------------------------------------------------------------

interface Planet {
  id: string;
  label: string;
  iconName: IconName;
  /** Emoji shown in the FeatureSheet header when the sheet opens. */
  emoji: string;
  /** Planet hue — warm set from the Warm Obsidian design brief. */
  hue: string;
  Component: ComponentType;
  /** Angle in degrees around the orb's center — upper-left arc from a
   *  bottom-right anchored sun. 180° = due left, 270° = due up. */
  angle: number;
}

// Full upper semicircle arc (180° = due left → 270° = due up → 360° =
// due right) for the bottom-center-anchored sun. Eight planets evenly
// spaced across 180° of arc, ~25.7° apart.
const PLANETS: readonly Planet[] = [
  { id: 'vibe_sliders',   label: 'Sliders',    iconName: 'spark',    emoji: '🎚️', hue: '#7FA8C9', Component: VibeSliders,         angle: 180 },
  { id: 'love_tank',      label: 'Love Tank',  iconName: 'heart',    emoji: '💖', hue: '#FF8FA3', Component: LoveTank,            angle: 206 },
  { id: 'wishlist',       label: 'Wishlist',   iconName: 'gift',     emoji: '🎁', hue: '#FFB347', Component: Wishlist,            angle: 231 },
  { id: 'dates',          label: 'Dates',      iconName: 'heart',    emoji: '💕', hue: '#FF6B4A', Component: Dates,               angle: 257 },
  { id: 'date_generator', label: 'Idea gen',   iconName: 'dice',     emoji: '🎲', hue: '#C967A3', Component: DateGeneratorWidget, angle: 283 },
  { id: 'mind_reader',    label: 'Mind reader',iconName: 'brain',    emoji: '🔮', hue: '#8A7FC9', Component: MindReader,          angle: 309 },
  { id: 'time_capsules',  label: 'Capsules',   iconName: 'hourglass',emoji: '⏳', hue: '#E8A04B', Component: TimeCapsules,        angle: 334 },
  { id: 'roulette',       label: 'Roulette',   iconName: 'compass',  emoji: '🎡', hue: '#6B9A7A', Component: Roulette,            angle: 360 },
] as const;

const ORB_SIZE = 160;
const ORB_SIZE_NARROW = 120;
// Wider radius gives the fanned planets visible breathing room.
const ORBIT_RADIUS = 165;
const ORBIT_RADIUS_NARROW = 118;
const PLANET_SIZE = 62;
const PLANET_SIZE_NARROW = 50;

/** Convert a #rrggbb hex into an `rgba(r,g,b,a)` string. */
function hexToRgba(hex: string, alpha: number): string {
  const h = hex.startsWith('#') ? hex.slice(1) : hex;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function useIsNarrow(): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia('(max-width: 640px)');
    setNarrow(mq.matches);
    const h = (e: MediaQueryListEvent) => setNarrow(e.matches);
    mq.addEventListener('change', h);
    return () => mq.removeEventListener('change', h);
  }, []);
  return narrow;
}

// ---------------------------------------------------------------------------
// Main orb
// ---------------------------------------------------------------------------

export function VibeOrb() {
  const [open, setOpen] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [hover, setHover] = useState(false);
  const [squish, setSquish] = useState(0);
  const [tick, setTick] = useState(0);
  const [sparkles, setSparkles] = useState<
    Array<{ id: number; born: number; angle: number; speed: number; hue: string }>
  >([]);
  const startRef = useRef<number>(0);

  const reduced = useReducedMotionPref();
  const narrow = useIsNarrow();
  const { mode, t } = useDesignMode();
  const isMoon = mode === 'obsidian';

  const orbSize = narrow ? ORB_SIZE_NARROW : ORB_SIZE;
  const orbitR = narrow ? ORBIT_RADIUS_NARROW : ORBIT_RADIUS;
  const planetSize = narrow ? PLANET_SIZE_NARROW : PLANET_SIZE;

  // Sun vs moon colour stops — lightest → deepest
  const sunStops = ['#FFF1C9', '#FFB347', '#FF6B4A', '#D4572A'];
  const moonStops = ['#F0E8D9', '#C3CAD6', '#8592A3', '#3C4556'];
  const stops = isMoon ? moonStops : sunStops;

  // Animation loop — drives the breath, wobble, corona rotation, satellites,
  // liquid swirl. Killed for reduced-motion users.
  useEffect(() => {
    if (reduced) return;
    startRef.current = performance.now();
    let raf: number;
    const loop = () => {
      setTick(performance.now() - startRef.current);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [reduced]);

  // Sparkle emitter — bursts on hover/open, each sparkle has its own angle
  // + speed and fades over 1.2s. Cleaned up in the same effect's teardown.
  useEffect(() => {
    if (reduced || (!hover && !open)) return;
    const id = setInterval(() => {
      setSparkles((s) => {
        const now = performance.now();
        const next = s.filter((p) => now - p.born < 1200);
        const count = open ? 2 : 1;
        for (let i = 0; i < count; i++) {
          const a = Math.random() * Math.PI * 2;
          const speed = 30 + Math.random() * 40;
          const hues = ['#FFD36E', '#FFB347', '#FF8FA3', '#FFF1C9'];
          next.push({
            id: Math.random(),
            born: now,
            angle: a,
            speed,
            hue: hues[Math.floor(Math.random() * hues.length)],
          });
        }
        return next;
      });
    }, 90);
    return () => clearInterval(id);
  }, [hover, open, reduced]);

  // Escape closes sheet first, then the orbit fan.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      if (activeId) setActiveId(null);
      else if (open) setOpen(false);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, activeId]);

  const breath = (Math.sin(tick / 1600) + 1) / 2;
  const wobble = Math.sin(tick / 900) * 0.04;
  const scale = reduced ? 1 : 1 + breath * 0.04 + wobble - squish * 0.18;
  const squashY = 1 - squish * 0.1;

  const idleSatellites = [
    { r: 78, speed: 0.0012, phase: 0, size: 8, color: '#FFB347' },
    { r: 92, speed: -0.0009, phase: 1.7, size: 6, color: '#FF6B4A' },
    { r: 70, speed: 0.0018, phase: 3.3, size: 5, color: '#FFD36E' },
    { r: 102, speed: -0.0007, phase: 4.8, size: 7, color: '#FF8FA3' },
  ];

  function handleOrbClick() {
    if (activeId) return;
    if ('vibrate' in navigator) {
      try { navigator.vibrate(open ? 8 : 14); } catch { /* noop */ }
    }
    if (!reduced) {
      setSquish(1);
      setTimeout(() => setSquish(0), 280);
    }
    setOpen((v) => !v);
  }

  function pickPlanet(p: Planet) {
    if ('vibrate' in navigator) {
      try { navigator.vibrate(10); } catch { /* noop */ }
    }
    setActiveId(p.id);
    setOpen(false);
  }

  const activePlanet = activeId ? PLANETS.find((p) => p.id === activeId) ?? null : null;

  return (
    <>
      {/* Dim backdrop when the planet fan is open — click to collapse. */}
      {open && (
        <button
          type="button"
          aria-label="close vibe menu"
          onClick={() => setOpen(false)}
          className="fixed inset-0 z-40"
          style={{
            background: isMoon ? 'rgba(0,0,0,0.35)' : 'rgba(31,26,22,0.18)',
            backdropFilter: 'blur(2px)',
            WebkitBackdropFilter: 'blur(2px)',
          }}
        />
      )}

      {/* Orb anchor — bottom-center. Safe-area inset for iOS home
          indicator. translateX(-50%) centers horizontally without
          disturbing the planet ring's absolute children. */}
      <div
        className="pointer-events-none fixed z-50"
        style={{
          left: '50%',
          transform: 'translateX(-50%)',
          bottom: 'calc(env(safe-area-inset-bottom, 0px) + 20px)',
          width: orbSize,
          height: orbSize,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {/* Planet ring — frosted-glass discs that match the design-system
            Clay surface. Two transform layers: outer wrapper owns the
            slide-out + arc position (changes only on open toggle), inner
            button owns the hover scale (CSS-only, no JS interference).
            The planet's hue lingers as a tinted glow shadow + a tiny
            accent dot so each planet is still distinguishable without
            losing the frosted-glass language. */}
        {PLANETS.map((p, i) => {
          const rad = (p.angle * Math.PI) / 180;
          const x = Math.cos(rad) * orbitR;
          const y = Math.sin(rad) * orbitR;
          return (
            <div
              key={p.id}
              style={{
                position: 'absolute',
                top: '50%',
                left: '50%',
                marginTop: -planetSize / 2,
                marginLeft: -planetSize / 2,
                width: planetSize,
                height: planetSize,
                transform: open
                  ? `translate(${x}px, ${y}px) scale(1)`
                  : 'translate(0px, 0px) scale(0)',
                opacity: open ? 1 : 0,
                transition: reduced
                  ? 'opacity 200ms ease'
                  : `transform 620ms cubic-bezier(0.34, 1.7, 0.5, 1) ${i * 36}ms, opacity 360ms ease ${i * 36}ms`,
                pointerEvents: open ? 'auto' : 'none',
                zIndex: 2,
                willChange: 'transform, opacity',
              }}
            >
              <button
                type="button"
                onClick={() => open && pickPlanet(p)}
                aria-label={`open ${p.label}`}
                aria-hidden={!open}
                tabIndex={open ? 0 : -1}
                className="group block h-full w-full origin-center cursor-pointer transition-transform duration-300 ease-out hover:scale-[1.45] focus-visible:scale-[1.45] active:scale-[1.55]"
                style={{
                  borderRadius: '50%',
                  border: `1px solid ${hexToRgba(p.hue, 0.45)}`,
                  padding: 0,
                  // Coloured frosted glass: the planet's hue tinted into a
                  // semi-transparent fill with a soft white inner highlight,
                  // so the lava-lamp + warm parchment behind shows through.
                  background: `radial-gradient(circle at 32% 28%, ${hexToRgba('#FFFFFF', 0.45)} 0%, ${hexToRgba(p.hue, 0.55)} 50%, ${hexToRgba(p.hue, 0.45)} 100%)`,
                  backdropFilter: 'blur(20px) saturate(1.5)',
                  WebkitBackdropFilter: 'blur(20px) saturate(1.5)',
                  boxShadow: `inset 0 1px 0 rgba(255,255,255,0.55), inset 0 -1px 0 rgba(0,0,0,0.06), 0 8px 22px -6px ${hexToRgba(p.hue, 0.6)}, 0 2px 5px rgba(31,26,22,0.12)`,
                  color: t.ink,
                  fontFamily: 'var(--font-mono), JetBrains Mono, monospace',
                  letterSpacing: '0.06em',
                  textTransform: 'uppercase',
                  fontWeight: 500,
                  position: 'relative',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 2,
                }}
              >
                <Icon name={p.iconName} size={Math.round(planetSize * 0.32)} />
                <span style={{ fontSize: Math.round(planetSize * 0.12), opacity: 0.95 }}>
                  {p.label}
                </span>
              </button>
            </div>
          );
        })}

        {/* Orbit rings — dashed, rotate alternating directions when open */}
        {!reduced && [orbitR, orbitR * 0.72, orbitR * 0.54].map((r, i) => (
          <div
            key={i}
            style={{
              position: 'absolute',
              width: r * 2 + 50,
              height: r * 2 + 50,
              borderRadius: '50%',
              border: `1px dashed ${isMoon ? 'rgba(237,227,211,0.15)' : 'rgba(255, 107, 74, 0.2)'}`,
              opacity: open ? 0.65 - i * 0.15 : 0,
              transform: `rotate(${tick * 0.005 * (i + 1) * (i % 2 ? -1 : 1)}deg)`,
              transition: 'opacity 500ms ease',
              pointerEvents: 'none',
            }}
          />
        ))}

        {/* Idle satellites — always orbiting when closed, pause when open */}
        {!reduced && idleSatellites.map((sat, i) => {
          const angle = sat.phase + tick * sat.speed * (open ? 0.15 : 1);
          const x = Math.cos(angle) * sat.r;
          const y = Math.sin(angle) * sat.r;
          return (
            <div
              key={i}
              style={{
                position: 'absolute',
                top: '50%',
                left: '50%',
                transform: `translate(-50%, -50%) translate(${x}px, ${y}px)`,
                width: sat.size,
                height: sat.size,
                borderRadius: '50%',
                background: sat.color,
                boxShadow: `0 0 12px ${sat.color}, 0 0 4px ${sat.color}, inset 0 1px 2px rgba(255,255,255,0.6)`,
                opacity: open ? 0.3 : 0.9,
                transition: 'opacity 400ms ease',
                pointerEvents: 'none',
                zIndex: 4,
              }}
            />
          );
        })}

        {/* Sparkle particles */}
        {!reduced && sparkles.map((sp) => {
          const age = (performance.now() - sp.born) / 1200;
          const dist = sp.speed * age;
          const x = Math.cos(sp.angle) * dist;
          const y = Math.sin(sp.angle) * dist - age * 20;
          const opacity = 1 - age;
          return (
            <div
              key={sp.id}
              style={{
                position: 'absolute',
                top: '50%',
                left: '50%',
                width: 4,
                height: 4,
                borderRadius: '50%',
                background: sp.hue,
                boxShadow: `0 0 8px ${sp.hue}, 0 0 3px ${sp.hue}`,
                transform: `translate(-50%, -50%) translate(${x}px, ${y}px) scale(${1 - age * 0.5})`,
                opacity,
                pointerEvents: 'none',
                zIndex: 5,
              }}
            />
          );
        })}

        {/* Outer glow aura — pulses with breath */}
        <div
          style={{
            position: 'absolute',
            width: orbSize * 2,
            height: orbSize * 2,
            borderRadius: '50%',
            background: `radial-gradient(circle, ${stops[2]}55 0%, ${stops[2]}22 30%, transparent 60%)`,
            filter: 'blur(24px)',
            transform: reduced ? 'scale(1)' : `scale(${1 + breath * 0.12 + (open ? 0.15 : 0)})`,
            transition: 'transform 300ms ease',
            pointerEvents: 'none',
          }}
        />

        {/* Corona rays — rotate slowly */}
        {!reduced && (
          <svg
            width={orbSize * 1.8}
            height={orbSize * 1.8}
            viewBox="0 0 200 200"
            style={{
              position: 'absolute',
              transform: `rotate(${tick * 0.015}deg)`,
              opacity: 0.55,
              pointerEvents: 'none',
              filter: `blur(1px) drop-shadow(0 0 8px ${stops[1]})`,
            }}
            aria-hidden
          >
            {Array.from({ length: 12 }).map((_, i) => {
              const a = (i / 12) * Math.PI * 2;
              const len = 8 + (i % 3) * 4 + Math.sin(tick / 800 + i) * 3;
              const x1 = 100 + Math.cos(a) * 78;
              const y1 = 100 + Math.sin(a) * 78;
              const x2 = 100 + Math.cos(a) * (78 + len);
              const y2 = 100 + Math.sin(a) * (78 + len);
              return (
                <line
                  key={i}
                  x1={x1}
                  y1={y1}
                  x2={x2}
                  y2={y2}
                  stroke={stops[1]}
                  strokeWidth={2.5}
                  strokeLinecap="round"
                />
              );
            })}
          </svg>
        )}

        {/* The orb itself — liquid swirl interior */}
        <button
          type="button"
          onClick={handleOrbClick}
          onMouseEnter={() => setHover(true)}
          onMouseLeave={() => setHover(false)}
          aria-label={open ? 'close vibe menu' : 'open vibe menu'}
          aria-expanded={open}
          className="pointer-events-auto"
          style={{
            position: 'relative',
            width: orbSize,
            height: orbSize,
            borderRadius: '50%',
            border: 'none',
            cursor: 'pointer',
            padding: 0,
            background: `radial-gradient(circle at 35% 28%, ${stops[0]}, ${stops[1]} 40%, ${stops[2]} 75%, ${stops[3]} 100%)`,
            boxShadow: `inset 0 6px 14px rgba(255,255,255,0.6), inset 0 -10px 22px rgba(0,0,0,0.3), inset 0 0 30px rgba(255, 180, 100, 0.3), 0 24px 60px -12px ${stops[2]}cc, 0 6px 16px rgba(0,0,0,0.2), 0 0 80px ${stops[2]}44`,
            transform: `scale(${scale}, ${scale * squashY})`,
            transition: squish
              ? 'transform 280ms cubic-bezier(0.34, 1.8, 0.5, 1)'
              : 'transform 60ms linear',
            zIndex: 3,
            overflow: 'hidden',
          }}
        >
          {/* Liquid swirl blobs */}
          {!reduced && (
            <>
              <div
                aria-hidden
                style={{
                  position: 'absolute',
                  top: `${30 + Math.sin(tick / 1100) * 12}%`,
                  left: `${25 + Math.cos(tick / 900) * 10}%`,
                  width: '55%',
                  height: '55%',
                  borderRadius: '50%',
                  background: `radial-gradient(circle, ${stops[0]}cc, ${stops[0]}00 70%)`,
                  filter: 'blur(6px)',
                  mixBlendMode: 'screen',
                }}
              />
              <div
                aria-hidden
                style={{
                  position: 'absolute',
                  top: `${45 + Math.cos(tick / 1300) * 15}%`,
                  left: `${45 + Math.sin(tick / 1000) * 12}%`,
                  width: '50%',
                  height: '50%',
                  borderRadius: '50%',
                  background: `radial-gradient(circle, ${stops[3]}88, ${stops[3]}00 70%)`,
                  filter: 'blur(8px)',
                  mixBlendMode: 'multiply',
                }}
              />
              <div
                aria-hidden
                style={{
                  position: 'absolute',
                  top: `${20 + Math.sin(tick / 800 + 2) * 10}%`,
                  left: `${55 + Math.cos(tick / 700 + 1) * 8}%`,
                  width: '35%',
                  height: '35%',
                  borderRadius: '50%',
                  background: `radial-gradient(circle, ${stops[1]}, ${stops[1]}00 70%)`,
                  filter: 'blur(4px)',
                  mixBlendMode: 'screen',
                }}
              />
            </>
          )}

          {/* Highlight */}
          <div
            aria-hidden
            style={{
              position: 'absolute',
              top: '10%',
              left: '20%',
              width: '42%',
              height: '32%',
              borderRadius: '50%',
              background: 'radial-gradient(ellipse, rgba(255,255,255,0.8), transparent 65%)',
              filter: 'blur(3px)',
            }}
          />

          {/* Secondary twinkle */}
          {!reduced && (
            <div
              aria-hidden
              style={{
                position: 'absolute',
                top: '22%',
                left: '55%',
                width: '10%',
                height: '10%',
                borderRadius: '50%',
                background: 'rgba(255,255,255,0.9)',
                filter: 'blur(2px)',
                opacity: 0.4 + Math.sin(tick / 500) * 0.3,
              }}
            />
          )}

          {/* Center icon — rotates 135° when open */}
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              zIndex: 2,
            }}
          >
            <div
              style={{
                transform: open ? 'rotate(135deg) scale(0.9)' : 'rotate(0deg) scale(1)',
                transition: 'transform 420ms cubic-bezier(0.34, 1.56, 0.64, 1)',
                color: 'rgba(255,255,255,0.98)',
                filter: 'drop-shadow(0 2px 4px rgba(0,0,0,0.3))',
              }}
            >
              <Icon name={isMoon ? 'moon' : 'plus'} size={Math.round(orbSize * 0.24)} />
            </div>
          </div>
        </button>
      </div>

      {/* Feature sheet */}
      {activePlanet && (
        <FeatureSheet
          key={activePlanet.id}
          title={activePlanet.label}
          emoji={activePlanet.emoji}
          onClose={() => setActiveId(null)}
        >
          <activePlanet.Component />
        </FeatureSheet>
      )}
    </>
  );
}
