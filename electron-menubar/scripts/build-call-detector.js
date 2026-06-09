#!/usr/bin/env node
/**
 * Build script for the macOS Call Detector.
 * Compiles the Swift source into a native binary at resources/bin/macos-call-detector.
 * Detects whether another process (not Paply) is using the microphone (= likely a call).
 * Only runs on macOS — skipped silently on other platforms.
 */
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const SRC = path.join(__dirname, '..', 'resources', 'bin', 'macos-call-detector.swift');
const OUT = path.join(__dirname, '..', 'resources', 'bin', 'macos-call-detector');

if (process.platform !== 'darwin') {
  console.log('[call-detector] Skipping build — not on macOS');
  process.exit(0);
}

if (!fs.existsSync(SRC)) {
  console.error(`[call-detector] Source not found: ${SRC}`);
  process.exit(1);
}

try {
  console.log('[call-detector] Compiling Swift binary...');
  execSync(`swiftc -O -o "${OUT}" "${SRC}" -framework CoreAudio -framework Foundation`, {
    stdio: 'inherit',
  });
  fs.chmodSync(OUT, 0o755);
  console.log(`[call-detector] Built successfully: ${OUT}`);
} catch (err) {
  console.error('[call-detector] Build failed:', err.message);
  console.error('[call-detector] Make sure Xcode Command Line Tools are installed: xcode-select --install');
  process.exit(1);
}
