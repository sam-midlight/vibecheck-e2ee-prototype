'use client';

/**
 * LavaLamp — interactive canvas background from the Warm Obsidian design
 * brief. Five vivid warm blobs drift, wobble, and pull toward the user's
 * pointer (parallax — each blob has its own strength). The rendered
 * canvas is blurred 40px and saturated 1.15, so the colour washes the
 * whole viewport rather than showing as distinct shapes.
 *
 * Mounted once at app root (src/app/layout.tsx) so every page inherits
 * the ambient wash. Cards above it use Clay's backdrop-filter so the
 * colour frosts through instead of getting hidden.
 *
 * Palette flips with the `obsidian` theme attribute on <html>; the
 * obsidian variant dials alpha down so card contrast stays readable.
 *
 * Sourced from the collaborator's Claude Design handoff, adapted to
 * Next.js/TypeScript and hooked into the existing design-mode store.
 */

import { useEffect, useRef } from 'react';
import { useDesignMode } from './useDesignMode';

type Swatch = { h: string; a: number };

interface Palettes {
  ember: { light: Swatch[]; obsidian: Swatch[] };
  amber: { light: Swatch[]; obsidian: Swatch[] };
  plum: { light: Swatch[]; obsidian: Swatch[] };
}

const PALETTES: Palettes = {
  ember: {
    light: [
      { h: '#FF6B4A', a: 0.55 },
      { h: '#FFB347', a: 0.5 },
      { h: '#FF8FA3', a: 0.45 },
      { h: '#FFD36E', a: 0.5 },
      { h: '#E85D75', a: 0.4 },
    ],
    obsidian: [
      { h: '#FF6B4A', a: 0.38 },
      { h: '#FFB347', a: 0.32 },
      { h: '#FF8FA3', a: 0.28 },
      { h: '#FFD36E', a: 0.3 },
      { h: '#C94C6D', a: 0.3 },
    ],
  },
  amber: {
    light: [
      { h: '#FFB347', a: 0.55 },
      { h: '#FFD36E', a: 0.5 },
      { h: '#F2C94C', a: 0.5 },
      { h: '#FF9A3C', a: 0.45 },
      { h: '#E8A04B', a: 0.45 },
    ],
    obsidian: [
      { h: '#FFB347', a: 0.32 },
      { h: '#FFD36E', a: 0.3 },
      { h: '#F2C94C', a: 0.28 },
      { h: '#FF9A3C', a: 0.28 },
      { h: '#E8A04B', a: 0.28 },
    ],
  },
  plum: {
    light: [
      { h: '#C967A3', a: 0.5 },
      { h: '#FF8FA3', a: 0.5 },
      { h: '#9D5C8C', a: 0.45 },
      { h: '#E85D75', a: 0.45 },
      { h: '#FFB347', a: 0.38 },
    ],
    obsidian: [
      { h: '#C967A3', a: 0.32 },
      { h: '#FF8FA3', a: 0.3 },
      { h: '#9D5C8C', a: 0.3 },
      { h: '#E85D75', a: 0.28 },
      { h: '#FFB347', a: 0.25 },
    ],
  },
};

function hexWithAlpha(hex: string, a: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

export function LavaLamp({
  palette: paletteProp,
}: {
  /** Override the palette. Defaults to the runtime one from useDesignMode. */
  palette?: 'ember' | 'amber' | 'plum';
}) {
  const { mode, palette: runtimePalette } = useDesignMode();
  const palette = paletteProp ?? runtimePalette;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pointerRef = useRef({ x: null as number | null, y: null as number | null, active: false });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    let w = (canvas.width = window.innerWidth * dpr);
    let h = (canvas.height = window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';

    const swatches = PALETTES[palette][mode === 'obsidian' ? 'obsidian' : 'light'];

    const blobs = swatches.map((sw) => ({
      ...sw,
      x: Math.random() * w,
      y: Math.random() * h,
      vx: (Math.random() - 0.5) * 0.3 * dpr,
      vy: (Math.random() - 0.5) * 0.3 * dpr,
      r: (280 + Math.random() * 180) * dpr,
      phase: Math.random() * Math.PI * 2,
      speed: 0.0003 + Math.random() * 0.0003,
    }));

    const onResize = () => {
      w = canvas.width = window.innerWidth * dpr;
      h = canvas.height = window.innerHeight * dpr;
      canvas.style.width = window.innerWidth + 'px';
      canvas.style.height = window.innerHeight + 'px';
    };
    window.addEventListener('resize', onResize);

    const onMove = (e: MouseEvent) => {
      pointerRef.current.x = e.clientX * dpr;
      pointerRef.current.y = e.clientY * dpr;
      pointerRef.current.active = true;
    };
    const onLeave = () => {
      pointerRef.current.active = false;
    };
    const onTouch = (e: TouchEvent) => {
      if (e.touches[0]) {
        pointerRef.current.x = e.touches[0].clientX * dpr;
        pointerRef.current.y = e.touches[0].clientY * dpr;
        pointerRef.current.active = true;
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseleave', onLeave);
    window.addEventListener('touchmove', onTouch, { passive: true });

    let raf: number;
    const tick = () => {
      ctx.clearRect(0, 0, w, h);

      const p = pointerRef.current;

      blobs.forEach((b, i) => {
        b.phase += b.speed * 16;
        b.x += b.vx;
        b.y += b.vy;

        if (p.active && p.x != null && p.y != null) {
          const dx = p.x - b.x;
          const dy = p.y - b.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          const strength = (0.00025 + i * 0.00015) * (1 - Math.min(1, dist / (w * 0.7)));
          b.vx += dx * strength;
          b.vy += dy * strength;
        }

        // gentle return toward center
        b.vx += (w / 2 - b.x) * 0.000008;
        b.vy += (h / 2 - b.y) * 0.000008;

        // damping
        b.vx *= 0.985;
        b.vy *= 0.985;

        // softly contain
        const margin = b.r * 0.5;
        if (b.x < -margin) b.vx += 0.02;
        if (b.x > w + margin) b.vx -= 0.02;
        if (b.y < -margin) b.vy += 0.02;
        if (b.y > h + margin) b.vy -= 0.02;

        const rr = b.r * (1 + Math.sin(b.phase) * 0.08);
        const grad = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, rr);
        grad.addColorStop(0, hexWithAlpha(b.h, b.a));
        grad.addColorStop(0.55, hexWithAlpha(b.h, b.a * 0.35));
        grad.addColorStop(1, hexWithAlpha(b.h, 0));
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(b.x, b.y, rr, 0, Math.PI * 2);
        ctx.fill();
      });

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseleave', onLeave);
      window.removeEventListener('touchmove', onTouch);
    };
  }, [mode, palette]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      style={{
        position: 'fixed',
        inset: 0,
        width: '100vw',
        height: '100vh',
        pointerEvents: 'none',
        // z-index -1 puts the lava behind every in-flow element by
        // default (was zIndex: 0 which painted ABOVE static-position
        // content like the call + settings pages, occluding their
        // text). Cards that use Clay still get to participate in
        // their own stacking context via backdrop-filter, so they
        // visually sit in front of the lava as before.
        zIndex: -1,
        filter: 'blur(40px) saturate(1.15)',
        opacity: mode === 'obsidian' ? 0.85 : 1,
      }}
    />
  );
}
