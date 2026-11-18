'use strict';
// The small API the desktop app adds to Nova's pages: app settings, updates and Discord status.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('novaDesktop', {
  platform: process.platform,
  info: () => ipcRenderer.invoke('nova:info'),
  setSettings: (patch) => ipcRenderer.invoke('nova:settings', patch),
  relaunch: () => ipcRenderer.invoke('nova:relaunch'),
  checkForUpdates: () => ipcRenderer.invoke('nova:update:check'),
  installUpdate: () => ipcRenderer.invoke('nova:update:install'),
  onUpdate: (cb) => {
    const handler = (_e, state) => cb(state);
    ipcRenderer.on('nova:update', handler);
    return () => ipcRenderer.removeListener('nova:update', handler);
  },
  setActivity: (activity) => ipcRenderer.send('nova:activity', activity ?? null),
});
