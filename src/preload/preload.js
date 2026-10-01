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
    onBurst: on('critter:burst'),
    onXp: on('critter:xp'),
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
  answerPermission: (tabId, requestId, decision, message, answers) => ipcRenderer.invoke('task:permission', { tabId, requestId, decision, message, answers }),

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

  // skill shop (Claude Code plugin marketplaces)
  shopList: invoke('shop:list'),
  shopInstall: invoke('shop:install'),
  shopUninstall: invoke('shop:uninstall'),
  shopAddMarketplace: invoke('shop:add-marketplace'),
  shopOpen: fire('shop:open'),

  // wardrobe
  wardrobeView: invoke('wardrobe:view'),
  setOutfit: invoke('wardrobe:set-outfit'),
  wearSeason: invoke('wardrobe:wear-season'),
  randomizeOutfit: invoke('wardrobe:randomize'),
  setWardrobeOptions: invoke('wardrobe:options'),
  markSeen: fire('wardrobe:seen'),
  installPack: invoke('wardrobe:install'),
  removePack: invoke('wardrobe:remove-pack'),
  outfitCode: invoke('wardrobe:code'),
  previewOutfitCode: invoke('wardrobe:code-preview'),
  wearOutfitCode: invoke('wardrobe:code-wear'),
  installFromRegistry: invoke('wardrobe:install-registry'),
  openPacksFolder: fire('wardrobe:open-folder'),
  onWardrobe: on('wardrobe'),
  onUnlocked: on('wardrobe:unlocked'),
  onCollected: on('wardrobe:collected'),
  onPackInstalled: on('wardrobe:installed'), // result of an "Add to Shellby" gallery link

  // Claude Code status line
  getStatusLine: invoke('statusline:get'),
  installStatusLine: invoke('statusline:install'),
  removeStatusLine: invoke('statusline:remove'),

  // XP and levels
  getXp: invoke('xp:get'),
  onXp: on('xp'),
  onLevelUp: on('xp:levelup'),

  // Claude Code sessions elsewhere (plugin hooks)
  getExternal: invoke('external:get'),
  setExternal: invoke('external:set'),
  onExternal: on('external'),
  copyText: fire('clipboard:text'),

  // health
  getHealth: invoke('health:get'),
  setHealth: invoke('health:set'),
  recheckHealth: invoke('health:recheck'),
  askAboutHealth: invoke('health:ask'),
  clearHealthLog: invoke('health:clear-log'),
  healthViewed: fire('health:viewed'),
  onHealth: on('health'),
  onHealthLog: on('health:log'),

  // shareable crab card
  saveCard: invoke('card:save'),
  copyCard: invoke('card:copy'),
  revealCard: fire('card:reveal'),

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
