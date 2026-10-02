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
    bgClick: fire('critter:bg-click'),
    menu: fire('critter:menu'),
    drop: fire('critter:drop'),
    onState: on('critter:state'),
    onSkin: on('critter:skin'),
    onBurst: on('critter:burst'),
    onXp: on('critter:xp'),
    onMolt: on('critter:molt'),
    onMotion: on('critter:motion'),
    onBit: on('critter:bit'),
    onChirp: on('critter:chirp'),
    onCalm: on('critter:calm'), // screen locked: stop animating, nobody can see him
    pet: fire('critter:pet'),
  },

  // Resolve dropped File objects to absolute paths (sandbox-safe).
  pathsForFiles: files => Array.from(files || []).map(f => { try { return webUtils.getPathForFile(f); } catch { return ''; } }).filter(Boolean),
  // The same, for a drop or a paste that may hold a picture with no file behind
  // it (a Win+Shift+S snip, an image dragged out of a browser): main saves those
  // first. Resolves to { paths, error } — error is the last thing that failed.
  attachFiles: async files => {
    const paths = [];
    let error = null;
    for (const f of Array.from(files || []).slice(0, 20)) {
      let p = '';
      try { p = webUtils.getPathForFile(f); } catch { /* not on disk */ }
      if (p) { paths.push(p); continue; }
      if (!/^image\//.test(f.type)) continue;
      const r = await ipcRenderer.invoke('attach:image', new Uint8Array(await f.arrayBuffer()));
      if (r?.path) paths.push(r.path); else error = r?.error || 'Couldn’t attach that picture.';
    }
    return { paths, error };
  },
  attachThumb: invoke('attach:thumb'),
  pickFiles: invoke('attach:pick'),

  bootstrap: invoke('app:bootstrap'),
  claudeStatus: invoke('claude:status'),
  claudeLogin: invoke('claude:login'),
  locateClaude: invoke('claude:locate'), // when the search missed it (unusual install)

  // tabs + tasks
  newTab: invoke('tab:new'),
  closeTab: invoke('tab:close'),
  moveTab: (tabId, beforeId) => ipcRenderer.invoke('tab:reorder', { tabId, beforeId }),
  seenTab: fire('tab:seen'),
  sendTask: (tabId, text, attachments) => ipcRenderer.invoke('task:send', { tabId, text, attachments }),
  stopTask: fire('task:stop'),
  answerPermission: (tabId, requestId, decision, message, answers) => ipcRenderer.invoke('task:permission', { tabId, requestId, decision, message, answers }),
  changesDiff: invoke('changes:diff'),
  undoChanges: invoke('changes:undo'),
  worktreeStatus: invoke('worktree:status'),
  bringWorktreeHome: invoke('worktree:home'),
  discardWorktree: invoke('worktree:discard'),

  // history
  listSessions: invoke('session:list'),
  openSession: invoke('session:open'),
  deleteSession: invoke('session:delete'),
  setSessionDone: (id, done) => ipcRenderer.invoke('session:done', { id, done }),

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
  clearBackground: invoke('external:clear-background'),
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
  resetCritterPosition: fire('critter:reset-position'),
  getGitHub: invoke('github:get'),
  githubSignIn: invoke('github:sign-in'),
  githubOpenCode: () => ipcRenderer.send('github:open-code'),
  githubCancel: () => ipcRenderer.send('github:cancel'),
  githubSignOut: invoke('github:sign-out'),
  githubSetFeature: invoke('github:set-feature'),
  githubSync: invoke('github:sync'),
  githubManage: () => ipcRenderer.send('github:manage'),
  publishPack: invoke('github:publish'),
  onGitHub: on('github'),
  onGitHubSignedIn: on('github:signed-in'),
  onGitHubError: on('github:error'),
  getCi: invoke('ci:get'),
  pollCi: invoke('ci:poll'),
  openPr: fire('ci:open'),
  askAboutCi: invoke('ci:ask'),
  onCi: on('ci'),
  getPlugin: invoke('plugin:get'),
  installPlugin: invoke('plugin:install'),
  getStatusLine: invoke('statusline:get'),
  installStatusLine: invoke('statusline:install'),
  removeStatusLine: invoke('statusline:remove'),

  // streaks and nudges
  getStreaks: invoke('streaks:get'),
  setStreaks: invoke('streaks:set'),
  muteProject: (key, muted) => ipcRenderer.invoke('streaks:mute', { key, muted }),
  openProject: fire('streaks:open'),
  reviewProject: invoke('review:start'),
  onStreaks: on('streaks'),
  onNudge: on('nudge'),
  devCheckNudges: invoke('dev:check-nudges'), // dev builds with SHELLBY_NUDGE_TEST only
  devAway: invoke('dev:away'), // dev builds with SHELLBY_RECAP_TEST only: a fake idle reading
  dev: { throw: invoke('dev:throw'), stroll: invoke('dev:stroll'), focusEnd: invoke('dev:focus-end'), critterPos: invoke('dev:critter-pos'), say: invoke('dev:say'), bit: invoke('dev:bit'), temperament: invoke('dev:temperament') }, // SHELLBY_MOTION_TEST only
  onNewTabIn: on('tab:new-in'),

  // focus sessions
  getFocus: invoke('focus:get'),
  startFocus: invoke('focus:start'),
  stopFocus: invoke('focus:stop'),
  onFocus: on('focus'),

  // XP and levels
  getXp: invoke('xp:get'),
  getHomes: invoke('homes:get'),
  wearHome: invoke('homes:wear'),
  homesSeen: fire('homes:seen'),
  onHomes: on('homes'),
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

  // telling you when you're away
  getChannels: invoke('channels:get'),
  setChannels: invoke('channels:set'),
  setChannelSecret: invoke('channels:secret'),
  testChannel: invoke('channels:test'),
  findTelegramChat: invoke('channels:findChat'),

  // the browser source for a stream
  getObs: invoke('obs:get'),
  setObs: invoke('obs:set'),
  onObs: on('obs'),

  // his mood on the desk lighting
  getRgb: invoke('rgb:get'),
  setRgb: invoke('rgb:set'),
  testRgb: invoke('rgb:test'),
  installOpenRgb: invoke('rgb:install'),

  // listening along
  getNowPlaying: invoke('nowplaying:get'),
  setNowPlaying: invoke('nowplaying:set'),
  onNowPlaying: on('nowplaying'),

  // the shellby command
  getCli: invoke('cli:get'),
  installCli: invoke('cli:install'),
  removeCli: invoke('cli:remove'),
  revealCli: fire('cli:reveal'),

  // shareable crab card
  saveCard: invoke('card:save'),
  copyCard: invoke('card:copy'),
  revealCard: fire('card:reveal'),

  // updates
  checkUpdates: invoke('updates:check'),
  installUpdate: invoke('updates:install'),

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
  onRecap: on('recap'), // back after an hour away: what happened (see recap.js)
  onLimit: on('limit'),
  onToolbox: on('toolbox'),
  onLearned: on('toolbox:learned'),
  onRoutines: on('routines'),
  onAttach: on('panel:attach'),
  onFocusInput: on('panel:focus-input'),
  onView: on('panel:view'),
  onSkin: on('skin'),
  onCalm: on('panel:calm'), // unfocused or locked: pause the decorative animation
  onUpdates: on('updates'),
  onJump: on('panel:jump'),
  onDemo: on('demo'),
});
