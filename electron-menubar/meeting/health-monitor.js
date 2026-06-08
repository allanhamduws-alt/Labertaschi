// health-monitor.js — Ampel-Logik fuer Meeting-Recorder. CommonJS.
// Vertrag: evaluateHealth(state) → { color: 'green'|'yellow'|'red', reason: string }
// Regelkaskade (absteigend nach Prioritaet):
//   diskError                         → rot  "Speicherproblem"
//   systemPermissionDenied            → rot  "Systemaudio-Berechtigung fehlt"
//   !systemProcessAlive               → rot  "System-Audio gestoppt"
//   !micWriteOk                       → rot  "Aufnahme wird nicht gesichert"
//   secondsSinceSystemAudio > 60      → gelb "System-Audio still"
//   sonst                             → gruen "Aufnahme läuft & wird gesichert"

/**
 * @param {{
 *   micWriteOk: boolean,
 *   systemProcessAlive: boolean,
 *   systemPermissionDenied: boolean,
 *   diskError: boolean,
 *   micLevel: number,
 *   systemLevel: number,
 *   secondsSinceSystemAudio: number
 * }} state
 * @returns {{ color: 'green'|'yellow'|'red', reason: string }}
 */
function evaluateHealth({
  micWriteOk,
  systemProcessAlive,
  systemPermissionDenied,
  systemAudioError,
  diskError,
  micLevel,
  systemLevel,
  secondsSinceSystemAudio,
}) {
  if (diskError) {
    return { color: 'red', reason: 'Speicherproblem' };
  }
  if (systemPermissionDenied) {
    return { color: 'red', reason: 'Systemaudio-Berechtigung fehlt' };
  }
  if (systemAudioError) {
    return { color: 'red', reason: 'System-Audio-Fehler: ' + systemAudioError };
  }
  if (!systemProcessAlive) {
    return { color: 'red', reason: 'System-Audio gestoppt' };
  }
  if (!micWriteOk) {
    return { color: 'red', reason: 'Aufnahme wird nicht gesichert' };
  }
  if (secondsSinceSystemAudio > 60) {
    return { color: 'yellow', reason: 'System-Audio still' };
  }
  return { color: 'green', reason: 'Aufnahme läuft & wird gesichert' };
}

module.exports = { evaluateHealth };
