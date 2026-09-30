// The only bridge between the sandboxed renderers and the main process.
// Every channel is explicit; renderers get no Node.js access.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const on = channel => cb => {
  const handler = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('shellby', {
  critter: {
    dragStart: () => ipcRenderer.send('critter:drag-start'),
    dragMove: (dx, dy) => ipcRenderer.send('critter:drag-move', { dx, dy }),
    dragEnd: () => ipcRenderer.send('critter:drag-end'),
    click: () => ipcRenderer.send('critter:click'),
    menu: () => ipcRenderer.send('critter:menu'),
    drop: files => ipcRenderer.send('critter:drop', files),
    onState: on('critter:state'),
    onSkin: on('critter:skin'),
  },

  // Resolve dropped File objects to absolute paths (sandbox-safe).
  pathsForFiles: files => Array.from(files || []).map(f => { try { return webUtils.getPathForFile(f); } catch { return ''; } }).filter(Boolean),

  bootstrap: () => ipcRenderer.invoke('app:bootstrap'),
  claudeStatus: () => ipcRenderer.invoke('claude:status'),
  claudeLogin: () => ipcRenderer.invoke('claude:login'),

  sendTask: (text, attachments) => ipcRenderer.invoke('task:send', { text, attachments }),
  stopTask: () => ipcRenderer.send('task:stop'),
  answerPermission: (requestId, decision, message) => ipcRenderer.invoke('task:permission', { requestId, decision, message }),

  newSession: () => ipcRenderer.invoke('session:new'),
  listSessions: () => ipcRenderer.invoke('session:list'),
  openSession: id => ipcRenderer.invoke('session:open', id),
  deleteSession: id => ipcRenderer.invoke('session:delete', id),

  setSettings: patch => ipcRenderer.invoke('settings:set', patch),
  pickFolder: () => ipcRenderer.invoke('folder:pick'),
  setFolder: dir => ipcRenderer.invoke('folder:set', dir),
  reloadSkins: () => ipcRenderer.invoke('skins:reload'),
  openSkinsFolder: () => ipcRenderer.send('skins:open-folder'),
  openDataFolder: () => ipcRenderer.send('open-data-folder'),
  openExternal: url => ipcRenderer.send('open-external', url),

  hide: () => ipcRenderer.send('panel:hide'),
  minimize: () => ipcRenderer.send('panel:minimize'),

  onItem: on('session:item'),
  onBusy: on('session:busy'),
  onReset: on('session:reset'),
  onSessions: on('sessions'),
  onAttach: on('panel:attach'),
  onFocusInput: on('panel:focus-input'),
  onView: on('panel:view'),
  onSkin: on('skin'),
  onUpdateReady: on('update-ready'),
  onDemo: on('demo'),
});
