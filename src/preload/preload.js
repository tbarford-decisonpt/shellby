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
    onVisitor: on('critter:visitor'), // a friend's crab dropped by (src/main/friends.js)
    onTogether: on('critter:together'), // ...and the two of them do something together
    onSticker: on('critter:sticker'), // a project shipped for the first time: slap its sticker on (src/main/stickers.js)
    onStickerGlint: on('critter:sticker-glint'), // ...or one already on his shell catches the light
    pet: fire('critter:pet'),
    hit: fire('critter:hit'),           // the pointer is over him (perched, the rest of his window lets clicks through)
    onPerch: on('critter:perch'),       // up on a window, or back down (src/main/perching.js)
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
  freshTab: invoke('tab:fresh'),
  // the terminal's conveniences (parity.js)
  suggestFiles: (tabId, query) => ipcRenderer.invoke('files:suggest', { tabId, query }),
  promptHistory: invoke('prompt:history'),
  runShell: (tabId, command) => ipcRenderer.invoke('shell:run', { tabId, command }),
  rewindPoints: invoke('rewind:points'),
  rewind: (tabId, turnId, opts) => ipcRenderer.invoke('rewind:run', { tabId, turnId, ...opts }),
  exportSession: (id, to) => ipcRenderer.invoke('session:export', { id, to }),
  // trying again from any turn, in a new tab (branching.js)
  branch: (tabId, turnId, opts) => ipcRenderer.invoke('branch:run', { tabId, turnId, ...opts }),
  branchFamily: invoke('branch:family'),
  compareBranches: (tabId, otherId) => ipcRenderer.invoke('branch:compare', { tabId, otherId }),
  compareDiff: (tabId, otherId, file) => ipcRenderer.invoke('branch:compare-diff', { tabId, otherId, file }),
  keepBranch: invoke('branch:keep'),
  listStyles: invoke('styles:list'),
  answerPermission: (tabId, requestId, decision, message, answers) => ipcRenderer.invoke('task:permission', { tabId, requestId, decision, message, answers }),
  changesDiff: invoke('changes:diff'),
  undoChanges: invoke('changes:undo'),
  worktreeStatus: invoke('worktree:status'),
  bringWorktreeHome: invoke('worktree:home'),
  discardWorktree: invoke('worktree:discard'),
  repoStatus: invoke('repo:status'),
  pushRepo: invoke('repo:push'),
  bringAllHome: invoke('repo:home-all'),

  // history
  listSessions: invoke('session:list'),
  openSession: invoke('session:open'),
  deleteSession: invoke('session:delete'),
  listTrash: invoke('session:trash'),
  restoreSession: invoke('session:restore'),
  purgeSession: invoke('session:purge'),
  setSessionDone: (id, done) => ipcRenderer.invoke('session:done', { id, done }),
  renameSession: (id, title) => ipcRenderer.invoke('session:rename', { id, title }),

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
  // prompt snippets: /name in the box, @name from a terminal
  saveSnippet: (snippet, was = null) => ipcRenderer.invoke('snippets:save', { snippet, was }),
  removeSnippet: invoke('snippets:remove'),
  expandSnippet: invoke('snippets:expand'),
  // hooks and CLAUDE.md memory (every write is re-checked in main; hook changes ask in the confirm window)
  getClaudeSetup: invoke('setup:get'),
  readMemory: invoke('setup:read-memory'),
  writeMemory: (path, text, mtimeMs) => ipcRenderer.invoke('setup:write-memory', { path, text, mtimeMs }),
  saveHook: (scope, hook, at = null, fp = null) => ipcRenderer.invoke('setup:save-hook', { scope, hook, at, fp }),
  removeHook: (scope, at, fp) => ipcRenderer.invoke('setup:remove-hook', { scope, at, fp }),
  revealSetupFile: fire('setup:reveal'),
  saveRule: (scope, list, rule) => ipcRenderer.invoke('setup:save-rule', { scope, list, rule }),
  removeRule: (scope, list, rule) => ipcRenderer.invoke('setup:remove-rule', { scope, list, rule }),
  refreshMcp: invoke('mcp:refresh'),
  reconnectMcp: (tabId, name) => ipcRenderer.invoke('mcp:reconnect', { tabId, name }),
  toggleMcp: (tabId, name, enabled) => ipcRenderer.invoke('mcp:toggle', { tabId, name, enabled }),
  addMcp: invoke('mcp:add'),
  removeMcp: (tabId, name) => ipcRenderer.invoke('mcp:remove', { tabId, name }),

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
  getFriends: invoke('friends:get'),
  friendsRefresh: invoke('friends:refresh'),
  friendsAdd: invoke('friends:add'),
  friendsRemove: invoke('friends:remove'),
  friendsInvite: invoke('friends:invite'),
  friendsWave: invoke('friends:wave'),
  onFriends: on('friends'),
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
  devUsage: invoke('dev:usage'), // dev builds with SHELLBY_FORECAST_TEST only: a backdated 5-hour reading
  dev: { throw: invoke('dev:throw'), stroll: invoke('dev:stroll'), focusEnd: invoke('dev:focus-end'), critterPos: invoke('dev:critter-pos'), say: invoke('dev:say'), bit: invoke('dev:bit'), temperament: invoke('dev:temperament'), perch: invoke('dev:perch'), perchState: invoke('dev:perch-state'), scene: invoke('dev:scene'), life: invoke('dev:life') }, // SHELLBY_MOTION_TEST only
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
  onXpBounty: on('xp:bounty'),

  // his life between tasks: finds, the bond, the journal, games (life.js, playtime.js)
  getLife: invoke('life:get'),
  setBirthday: invoke('life:birthday'),
  setFavouriteFind: invoke('life:favourite'),
  findsSeen: fire('life:finds-seen'),
  play: invoke('life:play'),
  onLife: on('life'),
  onLifeFound: on('life:found'),   // he dug up a gift
  onLifeMoment: on('life:moment'), // a day worth marking, a closer bond, a finished set

  // shell stickers: one per project shipped (stickers.js)
  getStickers: invoke('stickers:get'),
  placeSticker: (id, slot, shell) => ipcRenderer.invoke('stickers:place', { id, slot, shell }),
  removeSticker: (id, shell) => ipcRenderer.invoke('stickers:remove', { id, shell }),
  restackSticker: (id, dir, shell) => ipcRenderer.invoke('stickers:restack', { id, dir, shell }),
  flipSticker: (id, shell) => ipcRenderer.invoke('stickers:flip', { id, shell }),
  arrangeStickers: shell => ipcRenderer.invoke('stickers:arrange', { shell }),
  hideSticker: (id, hidden) => ipcRenderer.invoke('stickers:hide', { id, hidden }),
  setStickerOptions: invoke('stickers:options'),
  stickersSeen: fire('stickers:seen'),
  openStickerProject: fire('stickers:open'),
  checkupSticker: invoke('stickers:checkup'),
  // dependency checkups and the week in review
  getCheckups: invoke('checkups:get'),
  runCheckup: invoke('checkups:run'),
  onCheckups: on('checkups'),
  // the flaky test detective (flaky.js)
  getFlaky: invoke('flaky:get'),
  flakyAct: invoke('flaky:act'),
  forgetFlaky: invoke('flaky:forget'),
  onFlaky: on('flaky'),
  onFlakyFocus: on('flaky:focus'),
  getWeek: invoke('week:get'),
  onWeekReady: on('week:ready'),
  // time on each project (src/main/timetrack-service.js)
  getTime: invoke('time:get'),
  setTimeSettings: invoke('time:settings'),
  setTimeProject: invoke('time:project'),
  removeTimeProject: invoke('time:remove'),
  addTime: invoke('time:add'),
  addTimeFolder: invoke('time:add-folder'),
  exportTimeCsv: invoke('time:export-csv'),
  exportTimePdf: invoke('time:export-pdf'),
  copyTime: invoke('time:copy'),
  showTimeFile: invoke('time:show-file'),
  onTimeNow: on('time:now'),
  // Projects and their dev servers (src/main/projects/ipc.js)
  listProjects: invoke('projects:list'),
  projectDetail: invoke('projects:detail'),
  addProject: invoke('projects:add'),
  scanForProjects: invoke('projects:scan'),
  cancelProjectScan: invoke('projects:scan-cancel'),
  addProjects: invoke('projects:add-many'),
  removeProject: invoke('projects:remove'),
  chooseCloneFolder: invoke('projects:clone-folder'),
  cloneFolderAgain: invoke('projects:clone-again'),
  cloneTarget: invoke('projects:clone-target'),
  cloneProject: invoke('projects:clone'),
  cancelClone: invoke('projects:clone-cancel'),
  openProjectFolder: invoke('projects:open-folder'),
  openProjectOnGitHub: invoke('projects:open-github'),
  installProject: invoke('projects:install'),
  onProjectsChanged: on('projects:changed'),
  onProjectsShow: on('projects:show'),
  onCloneProgress: on('projects:clone-progress'),
  onProjectInstalled: on('projects:installed'),
  getServers: invoke('servers:get'),
  startServer: invoke('servers:start'),
  stopServer: invoke('servers:stop'),
  restartServer: invoke('servers:restart'),
  dismissServer: invoke('servers:dismiss'),
  serverSeen: invoke('servers:seen'),
  serverLog: invoke('servers:log'),
  serverFixDraft: invoke('servers:fix-draft'),
  sendServerFix: invoke('servers:fix-send'),
  openServer: invoke('servers:open'),
  openServerLog: invoke('servers:open-log'),
  stopAllServers: invoke('servers:stop-all'),
  setServerSettings: invoke('servers:settings'),
  onServersChanged: on('servers:changed'),
  onStickers: on('stickers'),
  onStickerNew: on('stickers:new'),
  onStickerNews: on('stickers:news'), // a tier-up or a new mark on one already earned

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
  getHogs: invoke('health:hogs'),
  endTask: invoke('health:end-task'),
  getStartupApps: invoke('health:startup'),
  askAboutStartup: invoke('health:ask-startup'),
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
  routineTemplates: invoke('routines:templates'),
  saveRoutine: invoke('routines:save'),
  draftRoutine: invoke('routines:draft'),
  deleteRoutine: invoke('routines:delete'),
  runRoutine: invoke('routines:run'),
  // dependency watch
  getDepWatch: invoke('depwatch:get'),
  setDepWatch: invoke('depwatch:set'),
  scanDeps: invoke('depwatch:scan'),
  bumpDeps: invoke('depwatch:bump'),
  depRoutine: invoke('depwatch:routine'),
  onDepWatch: on('depwatch'),
  usageBreakdown: invoke('usage:breakdown'),
  // usage forecast, and work held for after the reset (forecast.js, held.js)
  getOutlook: invoke('outlook:get'),
  holdForReset: invoke('held:add'),
  cancelHeld: invoke('held:cancel'),

  // workflows (docs/plans/workflows.md)
  listWorkflows: invoke('workflows:list'),
  validateWorkflow: invoke('workflows:validate'),
  saveWorkflow: invoke('workflows:save'),
  deleteWorkflow: invoke('workflows:delete'),
  runWorkflow: invoke('workflows:run'),
  draftWorkflow: invoke('workflows:draft'),
  repairWorkflow: invoke('workflows:repair'),
  importWorkflow: invoke('workflows:import'),
  exportWorkflow: invoke('workflows:export'),
  listRuns: invoke('workflows:runs'),
  getRun: invoke('workflows:run-get'),
  stopRun: invoke('workflows:run-stop'),
  resumeRun: invoke('workflows:run-resume'),
  answerRun: invoke('workflows:run-answer'),
  setWorkflowSecret: invoke('workflows:secret-set'),
  deleteWorkflowSecret: invoke('workflows:secret-delete'),

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
  onOutlook: on('outlook'),
  onTabSent: on('tab:sent'), // a held message went out after the reset
  onHeldReturned: on('held:returned'), // one that couldn't, back to its box
  onToolbox: on('toolbox'),
  onSnippets: on('snippets'),
  onLearned: on('toolbox:learned'),
  onRoutines: on('routines'),
  onWorkflows: on('workflows'),
  onWorkflowRun: on('workflows:run-changed'),
  onWorkflowOpen: on('workflows:open-run'), // a notification about a run was clicked
  onAttach: on('panel:attach'),
  onFocusInput: on('panel:focus-input'),
  onDictated: on('panel:dictated'), // push-to-talk: what you said, for the box (see dictation.js)
  onView: on('panel:view'),
  onSkin: on('skin'),
  onCalm: on('panel:calm'), // unfocused or locked: pause the decorative animation
  onUpdates: on('updates'),
  onJump: on('panel:jump'),
  onDemo: on('demo'),
});
