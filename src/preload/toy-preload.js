// The pebble's bridge (fetch, src/main/playtime.js): it can be dragged and
// thrown, and it's told what it looks like. Nothing else.
// Main checks the same list from its side (src/main/ipc-guard.js TOY_CHANNELS).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('toy', {
  dragStart: () => ipcRenderer.send('toy:drag-start'),
  dragMove: (dx, dy) => ipcRenderer.send('toy:drag-move', { dx, dy }),
  dragEnd: () => ipcRenderer.send('toy:drag-end'),
  onLook: cb => {
    const handler = (_e, look) => cb(look);
    ipcRenderer.on('toy:look', handler);
    return () => ipcRenderer.removeListener('toy:look', handler);
  },
});
