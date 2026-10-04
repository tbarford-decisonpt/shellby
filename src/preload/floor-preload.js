// The floor strip's bridge (src/main/floor.js): told what to draw, and it says
// when the pointer is over a pal (so that pal can be clicked) and when one was
// poked. Nothing else. Main checks the same list (src/main/ipc-guard.js FLOOR_CHANNELS).
const { contextBridge, ipcRenderer } = require('electron');

const on = channel => cb => {
  const handler = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('floor', {
  hit: over => ipcRenderer.send('floor:hit', !!over),
  poke: () => ipcRenderer.send('floor:poke'),
  onSkin: on('floor:skin'),
  onColony: on('floor:colony'),
  onShellby: on('floor:shellby'),
  onEvent: on('floor:event'),
  onCalm: on('floor:calm'),
});
