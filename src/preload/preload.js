// The only bridge between the sandboxed renderers and the main process.
// Every channel is explicit; renderers get no Node.js access.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const on = channel => cb => {
  const handler = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};
const invoke = channel => (...args) => ipcRenderer.invoke(channel, ...args);
const fire = channel => (...args) => ipcRenderer.send(channel, ...args);

contextBridge.exposeInMainWorld('shellby', {
  critter: {
    dragStart: fire('critter:drag-start'),
    dragMove: (dx, dy) => ipcRenderer.send('critter:drag-move', { dx, dy }),
    dragEnd: fire('critter:drag-end'),
    click: fire('critter:click'),
    crewClick: fire('critter:crew-click'),
    menu: fire('critter:menu'),
    drop: fire('critter:drop'),
    onState: on('critter:state'),
    onSkin: on('critter:skin'),
  },

  // Resolve dropped File objects to absolute paths (sandbox-safe).
  pathsForFiles: files => Array.from(files || []).map(f => { try { return webUtils.getPathForFile(f); } catch { return ''; } }).filter(Boolean),

  bootstrap: invoke('app:bootstrap'),
  claudeStatus: invoke('claude:status'),
  claudeLogin: invoke('claude:login'),

  // tabs + tasks
  newTab: invoke('tab:new'),
  closeTab: invoke('tab:close'),
  seenTab: fire('tab:seen'),
  sendTask: (tabId, text, attachments) => ipcRenderer.invoke('task:send', { tabId, text, attachments }),
  stopTask: fire('task:stop'),
  answerPermission: (tabId, requestId, decision, message) => ipcRenderer.invoke('task:permission', { tabId, requestId, decision, message }),

  // history
  listSessions: invoke('session:list'),
  openSession: invoke('session:open'),
  deleteSession: invoke('session:delete'),

  // settings
  setSettings: invoke('settings:set'),
  pickFolder: invoke('folder:pick'),
  pickAnyFolder: invoke('folder:pick-any'),
  setFolder: invoke('folder:set'),
  reloadSkins: invoke('skins:reload'),
  openSkinsFolder: fire('skins:open-folder'),
  openDataFolder: fire('open-data-folder'),
  openExternal: fire('open-external'),

  // toolbox
  getToolbox: invoke('toolbox:get'),
  rescanToolbox: invoke('toolbox:rescan'),
  pinTool: (kind, name, pinned) => ipcRenderer.invoke('toolbox:pin', { kind, name, pinned }),
  revealTool: fire('toolbox:reveal'),

  // routines
  listRoutines: invoke('routines:list'),
  saveRoutine: invoke('routines:save'),
  deleteRoutine: invoke('routines:delete'),
  runRoutine: invoke('routines:run'),

  hide: fire('panel:hide'),
  minimize: fire('panel:minimize'),

  onTabItem: on('tab:item'),
  onTabs: on('tabs'),
  onTabOpened: on('tab:opened'),
  onTabFocus: on('tab:focus'),
  onNewTabRequest: on('tab:new-request'),
  onUsage: on('usage'),
  onToolbox: on('toolbox'),
  onLearned: on('toolbox:learned'),
  onRoutines: on('routines'),
  onAttach: on('panel:attach'),
  onFocusInput: on('panel:focus-input'),
  onView: on('panel:view'),
  onSkin: on('skin'),
  onUpdateReady: on('update-ready'),
  onDemo: on('demo'),
});
