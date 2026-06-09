import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Drift-Schutz: Beide Settings-UIs (eingebettete Dashboard-Ansicht UND separates
// Settings-Fenster) müssen dieselben nutzer-relevanten Einstellungen anbieten.
// Schlägt fehl, sobald ein künftiger Edit nur EINE der beiden UIs anfasst.
//
// Geprüft wird, ob der jeweilige Store-Key-String in beiden Quellen vorkommt
// (settings.<key>, onSettingChange('<key>', …) bzw. handleSave('<key>', …)).

const ROOT = path.join(__dirname, '..');
const DASHBOARD = path.join(ROOT, 'src/apps/dashboard/Dashboard.tsx');
const SETTINGS_APP = path.join(ROOT, 'src/apps/settings/SettingsApp.tsx');

// Kanonische, in BEIDEN UIs bedienbare Einstellungen.
const CANONICAL_KEYS = [
  'groqApiKey',
  'diarizationEnabled',
  'meetingHotkey',
  'shortcut',
  'autopaste',
  'enablePolish',
  'beepEnabled',
  'autoStart',
  'copyToClipboard',
  'language',
  'hideDock',
];

describe('Settings-UIs sind synchron', () => {
  const dashboard = fs.readFileSync(DASHBOARD, 'utf8');
  const settingsApp = fs.readFileSync(SETTINGS_APP, 'utf8');

  for (const key of CANONICAL_KEYS) {
    it(`"${key}" wird in der Dashboard-Ansicht referenziert`, () => {
      expect(dashboard.includes(key)).toBe(true);
    });
    it(`"${key}" wird im Settings-Fenster referenziert`, () => {
      expect(settingsApp.includes(key)).toBe(true);
    });
  }
});
