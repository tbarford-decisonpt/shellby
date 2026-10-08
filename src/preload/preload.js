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
    onSound: on('critter:sound'), // a ta-da and the like (src/renderer/critter/sound.js)
    onCalm: on('critter:calm'), // screen locked: stop animating, nobody can see him
    onVisitor: on('critter:visitor'), // a friend's crab dropped by (src/main/friends.js)
    onBuddy: on('critter:buddy'), // his favourite Bugdex catch, following him (src/main/wiring/bugdex.js)
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

  // file links (Settings → Editor) and the panel's text size
  openFile: (tabId, target, /** @type {{ line?: number, reveal?: boolean }} */ { line, reveal } = {}) => ipcRenderer.invoke('file:open', { tabId, target, line, reveal }),
  getEditors: invoke('editors:get'),
  zoom: invoke('panel:zoom'),
  claudeStatus: invoke('claude:status'),
  claudeLogin: invoke('claude:login'),
  claudeLogout: (opts = {}) => ipcRenderer.invoke('claude:logout', { thenSignIn: !!opts.thenSignIn }), // thenSignIn: "Switch account"
  onClaudeStatus: on('claude:status'), // re-checked after the sign-in window closes, or a sign-out
  locateClaude: invoke('claude:locate'), // when the search missed it (unusual install)
  // Keeping Claude Code itself current (claude-update.js): the daily look at the
  // registry, `claude update` on request, and tell | auto | off.
  checkClaudeUpdate: invoke('claude:update-check'),
  updateClaude: invoke('claude:update'),
  setClaudeUpdateMode: mode => ipcRenderer.invoke('claude:update-mode', String(mode)),
  onClaudeUpdate: on('claude:update'),

  // tabs + tasks
  newTab: invoke('tab:new'),
  closeTab: invoke('tab:close'),
  moveTab: (tabId, beforeId) => ipcRenderer.invoke('tab:reorder', { tabId, beforeId }),
  // a conversation in a window of its own (x/y: where it was dropped, in screen pixels)
  popOutTab: (tabId, /** @type {{ x?: number, y?: number, carry?: any }} */ { x, y, carry } = {}) => ipcRenderer.invoke('tab:pop-out', { tabId, x, y, carry }),
  popInTab: (tabId, carry) => ipcRenderer.send('tab:pop-in', { tabId, carry }),
  popoutBootstrap: invoke('popout:bootstrap'),
  seenTab: fire('tab:seen'),
  shownTab: fire('tab:shown'), // the Stream Deck's Stop and Bring it home follow it
  markReviewed: (tabId, reviewed = true, after = null) => ipcRenderer.invoke('tab:reviewed', { tabId, reviewed, after }), // the review inbox
  sendTask: (tabId, text, attachments) => ipcRenderer.invoke('task:send', { tabId, text, attachments }),
  stopTask: fire('task:stop'),
  steerTask: (tabId, turnId, items) => ipcRenderer.send('task:steer', { tabId, turnId, items }),
  freshTab: invoke('tab:fresh'),
  tabCost: invoke('tab:cost'),
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
  // Try it N ways (wiring/tries.js): main always asks, with the cost, before any start
  startTries: (/** @type {string} */ tabId, /** @type {{ n?: number, text?: string, arg?: string, attachments?: string[] }} */ { n, text, arg, attachments } = {}) => ipcRenderer.invoke('tries:start', { tabId, n, text, arg, attachments }),
  stopTries: invoke('tries:stop'),
  triesStatus: invoke('tries:status'),
  onTriesDone: on('tries:done'),                   // { runId, firstId, text }
  // learning from corrections: review comments in, the rule card's buttons, Toolbox → Memory (corrections.js)
  noteReviewComments: (tabId, comments, batch) => ipcRenderer.invoke('corrections:comments', { tabId, comments, batch }),
  lessonState: invoke('lesson:state'),
  lessonPreview: (id, rule) => ipcRenderer.invoke('lesson:preview', { id, rule }),
  addLesson: (id, rule, added) => ipcRenderer.invoke('lesson:add', { id, rule, added }),
  dismissLesson: invoke('lesson:dismiss'),
  draftLesson: invoke('lesson:draft'),
  learnedRules: invoke('learned:list'),
  changeLearnedRule: (root, index, was, text) => ipcRenderer.invoke('learned:change', { root, index, was, text }),
  listStyles: invoke('styles:list'),
  answerPermission: (tabId, requestId, decision, message, answers) => ipcRenderer.invoke('task:permission', { tabId, requestId, decision, message, answers }),
  changesDiff: invoke('changes:diff'),
  undoChanges: invoke('changes:undo'),
  runChecks: invoke('checks:run'),                 // the project's tests on a turn's diff (checks.js)
  onChecksRunning: on('checks:running'),           // { tabId, after, running, commands? }
  openInEditor: invoke('changes:open-editor'),     // one file of a turn in VS Code's diff (editor.js)
  shotImage: invoke('shots:image'),                // a before/after picture, as a data URL (shots.js)
  worktreeStatus: invoke('worktree:status'),
  bringWorktreeHome: invoke('worktree:home'),
  discardWorktree: invoke('worktree:discard'),
  repoStatus: invoke('repo:status'),
  pushRepo: invoke('repo:push'),
  bringAllHome: invoke('repo:home-all'),
  listClashes: invoke('clashes:list'), // copies that changed the same files (wiring/clashes.js)

  // history
  listSessions: invoke('session:list'),
  openSession: invoke('session:open'),
  deleteSession: invoke('session:delete'),
  listTrash: invoke('session:trash'),
  restoreSession: invoke('session:restore'),
  purgeSession: invoke('session:purge'),
  clearSessions: invoke('session:clear'),
  setSessionDone: (id, done) => ipcRenderer.invoke('session:done', { id, done }),
  renameSession: (id, title) => ipcRenderer.invoke('session:rename', { id, title }),

  // between Shellby and a terminal (src/main/handoff.js)
  continueInTerminal: invoke('handoff:terminal'),
  pickUpHere: invoke('handoff:pickup'),
  bringIntoShellby: (id, force = false) => ipcRenderer.invoke('handoff:bring', { id, force }),

  // settings
  setSettings: invoke('settings:set'),
  onSettings: on('settings'), // changed on another PC (sync)
  pickFolder: invoke('folder:pick'),
  pickAnyFolder: invoke('folder:pick-any'),
  setFolder: invoke('folder:set'),
  reloadSkins: invoke('skins:reload'),
  openSkinsFolder: fire('skins:open-folder'),
  openDataFolder: fire('open-data-folder'),
  openExternal: fire('open-external'),
  pickTextMenu: fire('text-menu:pick'), // the right-click menu for text (textmenu.js, main/context-menu.js)
  onTextMenu: on('text-menu'),

  // toolbox
  getToolbox: invoke('toolbox:get'),
  rescanToolbox: invoke('toolbox:rescan'),
  pinTool: (kind, name, pinned) => ipcRenderer.invoke('toolbox:pin', { kind, name, pinned }),
  revealTool: fire('toolbox:reveal'),
  // Your own skill, command or agent to the Recycle Bin, asked first (skillremove.js)
  removeTool: (kind, name) => ipcRenderer.invoke('toolbox:remove', { kind, name }),
  readTool: (kind, path) => ipcRenderer.invoke('toolbox:read', { kind, path }),
  writeTool: (kind, path, text, mtimeMs) => ipcRenderer.invoke('toolbox:write', { kind, path, text, mtimeMs }),
  // Toolbox → Mods (mods-service.js): named by plugin id; turning one on and running its tests ask first
  checkMod: invoke('mods:check'),
  setModEnabled: (id, on) => ipcRenderer.invoke('mods:set-enabled', { id, on }),
  testMod: invoke('mods:test'),
  removeMod: invoke('mods:remove'),
  openMod: invoke('mods:open'),
  revealMod: fire('mods:reveal'),
  draftMod: (name, idea) => ipcRenderer.invoke('mods:draft', { name, idea }),
  // prompt snippets: /name in the box, @name from a terminal
  saveSnippet: (snippet, was = null) => ipcRenderer.invoke('snippets:save', { snippet, was }),
  removeSnippet: invoke('snippets:remove'),
  expandSnippet: invoke('snippets:expand'),
  duplicateSnippet: invoke('snippets:duplicate'),
  snippetUsed: fire('snippets:used'),
  exportSnippets: invoke('snippets:export'),
  importSnippets: invoke('snippets:import'),
  restoreStarterSnippets: invoke('snippets:starters'),
  // hooks and CLAUDE.md memory (every write is re-checked in main; hook changes ask in the confirm window)
  getClaudeSetup: invoke('setup:get'),
  readMemory: invoke('setup:read-memory'),
  writeMemory: (path, text, mtimeMs) => ipcRenderer.invoke('setup:write-memory', { path, text, mtimeMs }),
  saveHook: (scope, hook, at = null, fp = null) => ipcRenderer.invoke('setup:save-hook', { scope, hook, at, fp }),
  removeHook: (scope, at, fp) => ipcRenderer.invoke('setup:remove-hook', { scope, at, fp }),
  pauseHook: (scope, at, fp) => ipcRenderer.invoke('setup:pause-hook', { scope, at, fp }),
  resumeHook: id => ipcRenderer.invoke('setup:resume-hook', id),
  forgetPausedHook: id => ipcRenderer.invoke('setup:forget-paused-hook', id),
  testHook: (hook, payload = null) => ipcRenderer.invoke('setup:test-hook', { hook, payload }),
  sampleHookInput: hook => ipcRenderer.invoke('setup:sample-hook-input', hook),
  draftHook: (request, hook = null, test = null) => ipcRenderer.invoke('setup:draft-hook', { request, hook, test }),
  revealSetupFile: fire('setup:reveal'),
  saveRule: (scope, list, rule) => ipcRenderer.invoke('setup:save-rule', { scope, list, rule }),
  removeRule: (scope, list, rule) => ipcRenderer.invoke('setup:remove-rule', { scope, list, rule }),
  // Toolbox → Team: the repo's .shellby/team.json (team-ipc.js)
  getTeamPack: invoke('team:get'),
  useTeamSnippets: invoke('team:use-snippets'),
  stopTeamSnippets: invoke('team:stop-snippets'),
  addTeamWorkflow: invoke('team:add-workflow'),
  addTeamHook: (key, scope) => ipcRenderer.invoke('team:add-hook', { key, scope }),
  addTeamRule: (key, scope) => ipcRenderer.invoke('team:add-rule', { key, scope }),
  // values: what you typed for the server's blanks; main hands them to `claude mcp add` and keeps nothing.
  addTeamMcp: (name, values) => ipcRenderer.invoke('team:add-mcp', { name, values }),
  setUpTeamPack: values => ipcRenderer.invoke('team:setup-all', { values }),
  draftTeamPack: invoke('team:draft'),
  writeTeamPack: invoke('team:write'),
  revealTeamPack: fire('team:reveal'),
  refreshMcp: invoke('mcp:refresh'),
  reconnectMcp: (tabId, name) => ipcRenderer.invoke('mcp:reconnect', { tabId, name }),
  toggleMcp: (tabId, name, enabled) => ipcRenderer.invoke('mcp:toggle', { tabId, name, enabled }),
  addMcp: invoke('mcp:add'),
  removeMcp: (tabId, name) => ipcRenderer.invoke('mcp:remove', { tabId, name }),
  // Lean Shell: what every conversation carries, and the prompt cache (lean.js)
  leanReport: (refresh = false) => ipcRenderer.invoke('lean:report', { refresh }),
  leanPlugin: (id, on) => ipcRenderer.invoke('lean:plugin', { id, on }),
  leanMcpRemoved: invoke('lean:mcp-removed'),
  leanUsage: (refresh = false) => ipcRenderer.invoke('lean:usage', { refresh }),

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
  setVoice: invoke('wardrobe:set-voice'),
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
  getProfileCard: invoke('profile-card:get'),
  publishProfileCard: invoke('profile-card:publish'),
  profileCardSetup: invoke('profile-card:setup'),
  getPrBadge: invoke('pr-badge:get'),
  setPrBadgePicture: invoke('pr-badge:picture'),
  onPrBadge: on('pr-badge'),
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
  markPrSeen: invoke('ci:seen'),
  reviewWithClaude: invoke('ci:review'),
  onCi: on('ci'),
  // Start a task from a red build or a review (startfrom.js): drafts are shown before anything is sent.
  startFromDraft: invoke('startfrom:draft'),
  startFromSend: invoke('startfrom:send'),
  onStartFromOpen: on('startfrom:open'),
  // Next up on a project's page (wiring/backlog.js): tasks, issues and loose ends, each with Do this.
  backlogView: invoke('backlog:view'),
  backlogEdit: invoke('backlog:edit'),
  backlogAddIssue: invoke('backlog:add-issue'),
  backlogDo: invoke('backlog:do'),
  backlogOpenDoing: invoke('backlog:open-doing'),
  backlogOpenTodo: invoke('backlog:open-todo'),
  backlogOpenIssue: invoke('backlog:open-issue'),
  backlogHide: invoke('backlog:hide'),
  backlogCommit: invoke('backlog:commit'),
  backlogHand: invoke('backlog:hand'),
  backlogTab: invoke('backlog:tab'),
  backlogOpenPr: invoke('backlog:open-pr'),
  backlogTickLinked: invoke('backlog:tick-linked'),
  onBacklogOfferTick: on('backlog:offer-tick'),
  // A project's next release (src/main/projects/releases-ipc.js): nothing is pushed unless you say so.
  getRelease: invoke('releases:get'),
  cutRelease: invoke('releases:cut'),
  pushRelease: invoke('releases:push'),
  releasePolishDraft: invoke('releases:polish'),
  getPlugin: invoke('plugin:get'),
  installPlugin: invoke('plugin:install'),
  updatePlugin: invoke('plugin:update'),
  getStatusLine: invoke('statusline:get'),
  installStatusLine: invoke('statusline:install'),
  removeStatusLine: invoke('statusline:remove'),

  // streaks and nudges
  getStreaks: invoke('streaks:get'),
  setStreaks: invoke('streaks:set'),
  muteProject: (key, muted) => ipcRenderer.invoke('streaks:mute', { key, muted }),
  openProject: fire('streaks:open'),
  reviewProject: invoke('review:start'),
  reviewFromSuggestion: invoke('suggest:review'),
  muteSuggestion: invoke('suggest:mute'),
  onStreaks: on('streaks'),
  onNudge: on('nudge'),
  devCheckNudges: invoke('dev:check-nudges'), // dev builds with SHELLBY_NUDGE_TEST only
  devAway: invoke('dev:away'), // dev builds with SHELLBY_RECAP_TEST only: a fake idle reading
  devUsage: invoke('dev:usage'), // dev builds with SHELLBY_FORECAST_TEST only: a backdated 5-hour reading
  dev: { throw: invoke('dev:throw'), stroll: invoke('dev:stroll'), focusEnd: invoke('dev:focus-end'), critterPos: invoke('dev:critter-pos'), say: invoke('dev:say'), bit: invoke('dev:bit'), temperament: invoke('dev:temperament'), perch: invoke('dev:perch'), perchState: invoke('dev:perch-state'), climb: invoke('dev:climb'), prank: invoke('dev:prank'), edges: invoke('dev:edges'), scene: invoke('dev:scene'), life: invoke('dev:life'), quest: invoke('dev:quest') }, // SHELLBY_MOTION_TEST only
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
  onXpClass: on('xp:class'),

  // rooms: which screens are open yet (rooms.js)
  getRooms: invoke('rooms:get'),
  openRoom: invoke('rooms:open'),
  openAllRooms: invoke('rooms:all'),
  onRooms: on('rooms'),

  // quests: the features worth finding, one at a time (quests.js)
  getQuests: invoke('quests:get'),
  hideQuests: invoke('quests:hide'),
  onQuests: on('quests'),

  // his life between tasks: finds, the bond, the journal, games (life.js, playtime.js)
  getLife: invoke('life:get'),
  setBirthday: invoke('life:birthday'),
  setFavouriteFind: invoke('life:favourite'),
  findsSeen: fire('life:finds-seen'),
  play: invoke('life:play'),
  onLife: on('life'),
  onLifeFound: on('life:found'),   // he dug up a gift
  onLifeMoment: on('life:moment'), // a day worth marking, a closer bond, a finished set
  // looking after him (care.js, needs.js): each answers { ok, error?, life }
  needs: { feed: invoke('needs:feed'), rinse: invoke('needs:rinse'), tuck: invoke('needs:tuck'), introSeen: fire('needs:intro-seen') },

  // the crew: one lasting helper crab per agent type (crew-roster.js)
  getCrew: invoke('crew:get'),
  renameCrew: invoke('crew:rename'),
  setCrewHat: invoke('crew:hat'),
  onCrew: on('crew'),

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
  // the beach: a castle per project shipped, the tide, his finds (beach.js)
  getBeach: invoke('beach:get'),
  beachSeen: invoke('beach:seen'),
  // his tank: decor you place and he lives among (tank.js)
  getTank: invoke('tank:get'),
  saveTank: invoke('tank:save'),
  tankSeen: fire('tank:seen'),
  shareTank: invoke('tank:share'),     // on your calling card (tank-share.js), or off it
  peekTank: invoke('tank:peek'),       // a friend's, from their calling card
  getTankGauges: invoke('tank:gauges'), // live decor: Health and dev servers (tank-gauges.js)
  setTankLive: invoke('tank:live'),
  tankLayouts: invoke('tank:layouts'), // saved layouts, and the seasons' (tank-layouts.js)
  saveTankLayout: invoke('tank:layout-save'),
  useTankLayout: invoke('tank:layout-use'),
  removeTankLayout: invoke('tank:layout-remove'),
  seasonTankLayout: invoke('tank:layout-season'),
  tankTidy: invoke('tank:tidy'),       // he moves a find now and then (tank-tidy.js)
  undoTankTidy: invoke('tank:tidy-undo'),
  setTankTidy: invoke('tank:tidy-set'),
  onTankGauges: on('tank:gauges'),
  tankLife: invoke('tank:life'),       // his favourite piece and the sets on display (tank-life.js)
  tankLived: invoke('tank:lived'),     // what he got up to while you watched
  // dependency checkups and the week in review
  getCheckups: invoke('checkups:get'),
  runCheckup: invoke('checkups:run'),
  onCheckups: on('checkups'),
  // the Bugdex: the bugs Claude has fixed for you, in jars (bugdex.js)
  getBugdex: invoke('bugdex:get'),
  bugdexSeen: fire('bugdex:seen'),
  setFavouriteBug: invoke('bugdex:favourite'),
  openBugTab: fire('bugdex:open-tab'),
  forgetBugdex: invoke('bugdex:forget'),
  onBugdex: on('bugdex'),
  onBugdexCaught: on('bugdex:caught'),
  onBugdexFocus: on('bugdex:focus'),
  getBugBattles: invoke('bugdex:battles'),
  bugdexCue: fire('bugdex:cue'),
  onBugBattles: on('bugdex:battles'),
  onBugdexGift: on('bugdex:gift'),
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
  projectReport: invoke('projects:report'),
  addProject: invoke('projects:add'),
  scanForProjects: invoke('projects:scan'),
  cancelProjectScan: invoke('projects:scan-cancel'),
  addProjects: invoke('projects:add-many'),
  removeProject: invoke('projects:remove'),
  getInbox: invoke('projects:inbox'),
  dismissInboxItem: invoke('projects:inbox-dismiss'),
  deleteBranch: invoke('projects:delete-branch'),
  removeCopy: invoke('projects:remove-copy'),
  chooseCloneFolder: invoke('projects:clone-folder'),
  cloneFolderAgain: invoke('projects:clone-again'),
  cloneTarget: invoke('projects:clone-target'),
  cloneProject: invoke('projects:clone'),
  cancelClone: invoke('projects:clone-cancel'),
  openProjectFolder: invoke('projects:open-folder'),
  openProjectOnGitHub: invoke('projects:open-github'),
  installProject: invoke('projects:install'),
  addProjectTodo: invoke('projects:todo-add'),
  finishProjectTodo: invoke('projects:todo-done'),
  pinToJournal: invoke('projects:journal-pin'),
  removeFromJournal: invoke('projects:journal-remove'),
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
  endTaskGroup: invoke('health:end-group'),
  askAboutProcesses: invoke('health:ask-processes'),
  getStartupApps: invoke('health:startup'),
  askAboutStartup: invoke('health:ask-startup'),
  setStartupApp: invoke('health:set-startup'),
  healthViewed: fire('health:viewed'),
  onHealth: on('health'),
  onHealthLog: on('health:log'),

  // telling you when you're away
  getChannels: invoke('channels:get'),
  setChannels: invoke('channels:set'),
  setChannelSecret: invoke('channels:secret'),
  testChannel: invoke('channels:test'),
  findTelegramChat: invoke('channels:findChat'),
  getPhoneTasks: invoke('phoneTasks:get'),
  setPhoneTasks: invoke('phoneTasks:set'),
  pickPhoneTasksFolder: invoke('phoneTasks:pickFolder'),

  // the browser source for a stream
  getObs: invoke('obs:get'),
  setObs: invoke('obs:set'),
  onObs: on('obs'),

  // hardware keys on a Stream Deck
  getDeck: invoke('deck:get'),
  setDeck: invoke('deck:set'),
  addToStreamDeck: invoke('deck:add'),
  onDeck: on('deck'),
  onDeckPress: on('deck:press'), // { what: 'home' | 'review', tabId? }: a key that needs the panel

  // his mood on the desk lighting
  getRgb: invoke('rgb:get'),
  setRgb: invoke('rgb:set'),
  testRgb: invoke('rgb:test'),
  installOpenRgb: invoke('rgb:install'),

  // listening along
  getNowPlaying: invoke('nowplaying:get'),
  setNowPlaying: invoke('nowplaying:set'),
  onNowPlaying: on('nowplaying'),
  getTyping: invoke('typing:get'),     // tapping along while you type (typing.js)
  setTyping: invoke('typing:set'),
  getWeather: invoke('weather:get'),   // the weather outside (weather-service.js)
  setWeather: invoke('weather:set'),
  searchWeather: invoke('weather:search'),
  checkWeather: invoke('weather:check'),
  onWeather: on('weather'),

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
  chatRoutine: invoke('routines:chat'), // Build it with Claude: one turn of the routine editor's chat
  repairRoutine: invoke('routines:repair'), // Fix with Claude: its last failed run -> a corrected routine for the editor
  testRoutine: invoke('routines:test'),
  routineTestStatus: invoke('routines:test-status'),
  stopRoutineTest: invoke('routines:test-stop'),
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
  estimateUsage: invoke('usage:estimate'), // { tabId, text } -> what a message like it usually costs (usage-ledger.js)
  // usage forecast, and work held for after the reset (forecast.js, held.js)
  getOutlook: invoke('outlook:get'),
  holdForReset: invoke('held:add'),
  cancelHeld: invoke('held:cancel'),
  setQueueKeepAwake: invoke('held:keepAwake'), // the reset queue keeps the PC awake (main.js syncKeepAwake)

  // workflows (docs/plans/workflows.md)
  listWorkflows: invoke('workflows:list'),
  validateWorkflow: invoke('workflows:validate'),
  saveWorkflow: invoke('workflows:save'),
  deleteWorkflow: invoke('workflows:delete'),
  runWorkflow: invoke('workflows:run'),
  draftWorkflow: invoke('workflows:draft'),
  repairWorkflow: invoke('workflows:repair'),
  chatWorkflow: invoke('workflows:chat'), // Build it with Claude: one turn of the editor's chat
  importWorkflow: invoke('workflows:import'),
  exportWorkflow: invoke('workflows:export'),
  listRuns: invoke('workflows:runs'),
  getRun: invoke('workflows:run-get'),
  stopRun: invoke('workflows:run-stop'),
  resumeRun: invoke('workflows:run-resume'),
  answerRun: invoke('workflows:run-answer'),
  setWorkflowSecret: invoke('workflows:secret-set'),
  deleteWorkflowSecret: invoke('workflows:secret-delete'),
  mcpServers: invoke('workflows:mcp-servers'), // (cwd) -> [{ name, scope, transport, direct }]
  mcpTools: invoke('workflows:mcp-tools'),     // (server, cwd) -> { ok, tools } (starts the server)

  // notes
  listNotes: invoke('notes:list'),
  addNote: invoke('notes:add'),
  updateNote: invoke('notes:update'),
  deleteNote: invoke('notes:delete'),
  moveNote: invoke('notes:move'),
  runNote: invoke('notes:run'),

  hide: fire('panel:hide'),
  minimize: fire('panel:minimize'),
  maximize: fire('window:maximize'),
  setPanelRoomy: invoke('panel:roomy'), // widen the panel for a workflow map, or put it back

  onTabItem: on('tab:item'),
  onTabSteering: on('tab:steering'), // queued messages handed to Claude mid-turn
  onTabs: on('tabs'),
  onClashes: on('clashes'), // { clashes, fresh: [key] }: copies that changed the same files
  onTabOpened: on('tab:opened'),
  onTabReturned: on('tab:returned'), // a popped-out conversation's window closed
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
  onTeam: on('team'), // Shellby's folder changed: that repo's team pack, or none
  onTeamNotice: on('team:notice'), // the repo you're in has a team pack you haven't seen
  onLearned: on('toolbox:learned'),
  onRoutines: on('routines'),
  onRoutineTestRun: on('routines:test-run'),
  onWorkflows: on('workflows'),
  onWorkflowRun: on('workflows:run-changed'),
  onWorkflowOpen: on('workflows:open-run'), // a notification about a run was clicked
  onPanelRoomyLost: on('panel:roomy-lost'), // you resized a widened panel yourself
  onNotes: on('notes'),
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
