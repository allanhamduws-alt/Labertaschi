#!/usr/bin/env node
/**
 * Stellt das AudioTee-Binary unter resources/bin/audiotee bereit (macOS-only).
 * Das Binary wird vom npm-Paket `audiotee` mitgeliefert (universal arm64+x64,
 * ad-hoc signiert; erbt beim electron-builder-Sign die App-Signatur).
 * Vorbild: scripts/build-globe-listener.js. Auf Nicht-macOS still übersprungen.
 */
const path = require('path');
const fs = require('fs');

const OUT_DIR = path.join(__dirname, '..', 'resources', 'bin');
const OUT = path.join(OUT_DIR, 'audiotee');

if (process.platform !== 'darwin') {
  console.log('[audiotee] Skip — nicht macOS');
  process.exit(0);
}

const candidates = [
  path.join(__dirname, '..', 'node_modules', 'audiotee', 'bin', 'audiotee'),
  path.join(__dirname, '..', 'node_modules', 'audiotee', 'audiotee'),
];
const src = candidates.find((p) => fs.existsSync(p));
if (!src) {
  console.error('[audiotee] Binary nicht gefunden in node_modules/audiotee — npm install audiotee?');
  process.exit(1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.copyFileSync(src, OUT);
fs.chmodSync(OUT, 0o755);
console.log(`[audiotee] Bereitgestellt: ${OUT}`);
