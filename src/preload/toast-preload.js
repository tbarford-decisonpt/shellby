// Bridge for a notification window only. It can receive its notice and report a
// click, a dismissal or its height; nothing else.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('shellbyToast', {
  onShow: cb => ipcRenderer.on('toast:show', (_e, spec) => cb(spec)),
  click: () => ipcRenderer.send('toast:click'),
  dismiss: () => ipcRenderer.send('toast:dismiss'),
  resize: height => ipcRenderer.send('toast:resize', height),
});
