#!/usr/bin/env node
/**
 * Keeps `public/livekit-e2ee-worker.mjs` in sync with the installed
 * `livekit-client` version. Run from `postinstall` + `prebuild` so both
 * dev and Vercel deploys pick up the right file.
 *
 * Why not `new URL('livekit-client/e2ee-worker', import.meta.url)`: Turbopack
 * (Next.js 16) can't resolve bare module specifiers for Worker URLs and
 * throws cryptic `e.indexOf is not a function` at runtime. Shipping the
 * worker as a static public asset sidesteps the bundler entirely.
 */

import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);

const src = join(
  root,
  'node_modules',
  'livekit-client',
  'dist',
  'livekit-client.e2ee.worker.mjs',
);
const destDir = join(root, 'public');
const dest = join(destDir, 'livekit-e2ee-worker.mjs');

if (!existsSync(src)) {
  console.warn(
    `[sync-livekit-worker] source not found at ${src}; skipping. ` +
      `Run \`npm install livekit-client\` first.`,
  );
  process.exit(0);
}

if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });

copyFileSync(src, dest);
console.log(`[sync-livekit-worker] ${src} -> ${dest}`);
