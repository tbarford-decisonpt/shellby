// A note's bridge (mischief, src/main/pranks.js): it's told what it says, and
// it can ask to be thrown away. Nothing else.
// Main checks the same list from its side (src/main/ipc-guard.js NOTE_CHANNELS).
const { contextBridge, ipcRenderer } = require('electron');

const on = channel => cb => {
  const handler = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('note', {
  close: () => ipcRenderer.send('note:close'),
  onLook: on('note:look'),
  onSettle: on('note:settle'),
});
