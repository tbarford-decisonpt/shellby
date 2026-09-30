// Bridge for the confirmation window only. It can receive the question and send
// back one answer; nothing else. The panel's preload has no access to this.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('shellbyDialog', {
  onShow: cb => ipcRenderer.on('dialog:show', (_e, spec) => cb(spec)),
  respond: index => ipcRenderer.send('dialog:respond', index),
  resize: height => ipcRenderer.send('dialog:resize', height),
});
