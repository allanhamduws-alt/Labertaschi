const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Settings
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (settings) => ipcRenderer.invoke('settings:set', settings),

  // History
  getHistory: () => ipcRenderer.invoke('history:get'),
  clearHistory: () => ipcRenderer.invoke('history:clear'),
  copyHistoryItem: (id) => ipcRenderer.invoke('history:copy', id),

  // Recording
  onRecordingStart: (cb) => ipcRenderer.on('recording:start', cb),
  onRecordingStop: (cb) => ipcRenderer.on('recording:stop', cb),
  onStatusUpdate: (cb) => ipcRenderer.on('status:update', (_e, status) => cb(status)),
  sendAudio: (audioData) => ipcRenderer.send('recording:audio', audioData),

  // Accessibility
  openAccessibilitySettings: () => ipcRenderer.send('open:accessibility'),
});
