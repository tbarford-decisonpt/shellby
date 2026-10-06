// `npm run screenshots` renders scripted demo states and saves PNGs to docs/.
// Uses fake account details so no personal info ends up in the README.
const fs = require('fs');
const path = require('path');
const demo = require('./capture-demo');
const streaks = require('./streaks');
const voice = require('./voice');
const { xpSummary } = require('./xp');

const HOME = 'C:\\Users\\you';
const now = Date.now();

const CREW_TAB = {
  id: 'demo-crew', title: 'Audit my Documents, Desktop and Downloads', cwd: HOME, busy: true, pending: 1, crew: 2,
  status: 'Waiting for your OK…',
  items: [
    { kind: 'user', text: 'Send three helpers to audit my Documents, Desktop and Downloads in parallel, then clean up anything obviously junk.' },
    { kind: 'text', text: "On it. I'll send one helper per folder so they run in parallel." },
    { kind: 'tool', id: 'a1', name: 'Agent', label: 'Delegated', detail: 'Audit Documents', agent: { type: 'Explore', description: 'Audit Documents', background: false } },
    { kind: 'tool', id: 'a2', name: 'Agent', label: 'Delegated', detail: 'Audit Desktop', agent: { type: 'general-purpose', description: 'Audit Desktop', background: false } },
    { kind: 'tool', id: 'a3', name: 'Agent', label: 'Delegated', detail: 'Audit Downloads', agent: { type: 'general-purpose', description: 'Audit Downloads', background: false } },
    { kind: 'task', phase: 'started', taskId: 't1', toolUseId: 'a1', description: 'Audit Documents', subagentType: 'Explore' },
    { kind: 'task', phase: 'started', taskId: 't2', toolUseId: 'a2', description: 'Audit Desktop', subagentType: 'general-purpose' },
    { kind: 'task', phase: 'started', taskId: 't3', toolUseId: 'a3', description: 'Audit Downloads', subagentType: 'general-purpose' },
    { kind: 'tool', id: 's1', name: 'Glob', label: 'Searched files', detail: '**/* in ~/Documents', parent: 'a1', sub: true },
    { kind: 'tool_result', id: 's1', text: '1,284 files', parent: 'a1', sub: true },
    { kind: 'task', phase: 'done', taskId: 't1', toolUseId: 'a1', status: 'completed', summary: '**1,284 files, 6.2 GB.** Nothing looks like junk: mostly PDFs and project folders. There are 3 duplicate tax PDFs in `2024/`.', usage: { tokens: 18400, toolUses: 4, durationMs: 21000 } },
    { kind: 'tool_result', id: 'a1', text: 'done', agentStats: { durationMs: 21000, tokens: 18400, toolUses: 4 } },
    { kind: 'tool', id: 's2', name: 'PowerShell', label: 'Ran', detail: 'Get-ChildItem ~/Desktop | Sort LastWriteTime', parent: 'a2', sub: true },
    { kind: 'task', phase: 'progress', taskId: 't2', toolUseId: 'a2', description: 'Grouping 212 shortcuts and screenshots', usage: { tokens: 9100, toolUses: 2 } },
    { kind: 'tool', id: 's3', name: 'Write', label: 'Created', detail: 'C:\\Users\\you\\.shellby\\tools\\clean-installers.ps1', filePath: 'C:\\Users\\you\\.shellby\\tools\\clean-installers.ps1', parent: 'a3', sub: true },
    { kind: 'tool_result', id: 's3', text: 'File created', parent: 'a3', sub: true },
    { kind: 'task', phase: 'progress', taskId: 't3', toolUseId: 'a3', description: 'Wrote a cleanup script; asking to run it', usage: { tokens: 12800, toolUses: 3 } },
    { kind: 'tool', id: 's4', name: 'PowerShell', label: 'Ran', detail: 'powershell -File C:\\Users\\you\\.shellby\\tools\\clean-installers.ps1 -WhatIf:$false', parent: 'a3', sub: true },
    { kind: 'permission', requestId: 'demo-1', toolName: 'PowerShell', label: 'Ran', input: {},
      detail: 'powershell -File C:\\Users\\you\\.shellby\\tools\\clean-installers.ps1 -WhatIf:$false',
      description: 'Delete 14 installers older than 90 days from Downloads (3.1 GB)',
      runsCreated: ['C:\\Users\\you\\.shellby\\tools\\clean-installers.ps1'],
      agent: { taskId: 't3', toolUseId: 'a3', description: 'Audit Downloads', type: 'general-purpose' },
      suggestions: [] },
  ],
};

const DEMO_TABS = [
  CREW_TAB,
  { id: 'demo-skill', title: 'Build yourself a screenshot-renamer skill', cwd: HOME, outcome: 'ok', unread: true, items: [
    { kind: 'user', text: 'Build yourself a skill that renames screenshots by date, then use it on my Desktop.' },
    { kind: 'result', ok: true, durationMs: 48200, turns: 9 },
  ] },
  { id: 'demo-routine', title: '⟳ Friday Downloads tidy', cwd: `${HOME}\\Downloads`, busy: true, routineId: 'r1', items: [
    { kind: 'user', text: 'Sort my Downloads folder into subfolders by file type.', routine: { id: 'r1', name: 'Friday Downloads tidy', reason: 'scheduled' } },
  ] },
];

const DEMO_TOOLBOX = {
  scannedAt: now,
  skills: [
    { kind: 'skill', name: 'rename-screenshots', description: 'Rename screenshots to YYYY-MM-DD_HH-MM based on EXIF or file time, and sort them into monthly folders.', source: 'user', path: null },
    { kind: 'skill', name: 'csv-cleaner', description: 'Normalize messy CSV exports: fix encodings, split merged columns, dedupe rows, and write a tidy copy.', source: 'user', path: null },
    { kind: 'skill', name: 'frontend-design', description: 'Distinctive, production-grade frontend interfaces that avoid generic AI aesthetics.', source: 'plugin:frontend-design', path: null },
    { kind: 'skill', name: 'pdf', description: 'Read, merge, split, fill and create PDF documents.', source: 'plugin:document-skills', path: null },
    { kind: 'skill', name: 'code-review', description: 'Review a diff for correctness bugs at a chosen effort level.', source: 'cli', path: null },
  ],
  agents: [
    { kind: 'agent', name: 'folder-auditor', description: 'Audits one folder: size, file types, duplicates, junk candidates. Read-only.', source: 'user', path: null },
    { kind: 'agent', name: 'Explore', description: 'Read-only search agent for broad fan-out searches.', source: 'cli', path: null },
  ],
  commands: [{ kind: 'command', name: 'standup', description: 'Summarize what changed in my projects since yesterday.', source: 'user', path: null }],
  mcp: [
    { kind: 'mcp', name: 'obsidian', status: 'connected', source: 'user', path: null, description: '' },
    { kind: 'mcp', name: 'github', status: 'needs-auth', source: 'plugin', path: null, description: '' },
  ],
};

const DEMO_ROUTINES = [
  { id: 'r1', name: 'Friday Downloads tidy', prompt: 'Sort my Downloads folder into subfolders by file type. Don\'t delete anything.', mode: 'acceptEdits', enabled: true, catchUp: true, schedule: { type: 'weekly', time: '17:00', days: [5] }, scheduleText: 'Fri at 5:00 PM', next: now + 3 * 86400e3, running: true, lastRunAt: now - 7 * 86400e3, lastStatus: 'ok' },
  { id: 'r2', name: 'Morning briefing', prompt: 'List files in Documents and Desktop that changed in the last 24 hours.', mode: 'smart', enabled: true, catchUp: true, schedule: { type: 'daily', time: '08:30' }, scheduleText: 'Every day at 8:30 AM', next: now + 14 * 3600e3, lastRunAt: now - 10 * 3600e3, lastStatus: 'ok' },
  { id: 'r3', name: 'Disk space watch', prompt: 'Check free space on every drive and suggest cleanups under 15%.', mode: 'smart', enabled: false, catchUp: true, schedule: { type: 'interval', everyHours: 6 }, scheduleText: 'Every 6 hours', next: null, lastRunAt: null, lastStatus: null },
];

const DEMO_USAGE = { kind: 'usage', fiveHour: { pct: 23, resetsAt: now + 2.5 * 3600e3 }, sevenDay: { pct: 61, resetsAt: now + 3 * 86400e3 } };
const LEARNED = [{ kind: 'skill', name: 'rename-screenshots', at: now - 3600e3 }];
const PINNED = [{ kind: 'skill', name: 'rename-screenshots' }, { kind: 'skill', name: 'csv-cleaner' }, { kind: 'agent', name: 'folder-auditor' }];

const wait = ms => new Promise(r => setTimeout(r, ms));

async function shot(win, file) {
  // Hide transient toasts so they never cover README screenshots.
  await win.webContents.executeJavaScript("{ const t = document.getElementById('toast'); if (t) t.hidden = true; }");
  win.webContents.invalidate();
  await wait(120);
  const img = await win.webContents.capturePage();
  fs.writeFileSync(file, img.toPNG());
  console.log('wrote', path.relative(process.cwd(), file));
}

// Projects for the sticker shots (stickers.js): a mix of tiers, marks and ages.
function demoStickers(now) {
  const DAY = 24 * 3600 * 1000;
  const list = [
    ['5b1c0de0a1f2', 'shellby', 'JavaScript', 42, ['live', 'release', 'v1', 'merged'], 300, 0],
    ['9e3a7c21d4b8', '3d-rack', 'TypeScript', 17, ['live', 'merged', 'green'], 120, 2],
    ['c47f02e9a5d1', 'rack-builder', 'Python', 6, ['release'], 60, 5],
    ['0d8e6b13f7a2', 'tidepool', 'Rust', 2, [], 20, 1],
    ['71a9c3e05b6f', 'kelp-cli', 'Go', 1, ['moon'], 200, 75],
    ['e2f4a8b6c0d3', 'dotfiles', 'Shell', 3, [], 400, 190],
  ];
  const projects = {};
  for (const [id, name, lang, ships, marks, firstAgo, lastAgo] of list) {
    projects[id] = { name, lang, ships, marks, firstShipAt: now - firstAgo * DAY, lastShipAt: now - lastAgo * DAY, deploys: marks.includes('live') ? 3 : 0, releases: marks.includes('release') ? 2 : 0, lastVersion: marks.includes('v1') ? '1.2.0' : null };
  }
  const home = list.slice(0, 5).map(([id], i) => ({ id, slot: i, z: 5 - i, flip: false, nudge: [0, 0] }));
  return { projects, layouts: { home }, card: 'art', unseen: [] };
}

async function run({ app, critter, panel, showPanel, send, ROOT, setCrewSlots, wardrobe, captureClock, broadcastWardrobe, health, config, broadcastSkin, makeTimeTracker }) {
  const out = path.join(ROOT, 'docs');
  fs.mkdirSync(out, { recursive: true });
  const base = { toolbox: DEMO_TOOLBOX, routines: DEMO_ROUTINES, learned: LEARNED, pinned: PINNED, usage: DEMO_USAGE };
  // Off-season for the plain shots; each wardrobe shot sets its own date.
  const setDate = (y, m, d) => { captureClock.now = new Date(y, m - 1, d, 12); wardrobe.collectSeasonals(); broadcastWardrobe(); };
  setDate(2026, 6, 10);
  try {
    await wait(2500);
    // Occluded windows stop painting, so capturePage would return stale frames.
    for (const w of [critter, panel]) w.webContents.setBackgroundThrottling(false);
    critter.setAlwaysOnTop(true, 'screen-saver');
    showPanel({ focusInput: false });

    send(panel, 'demo', { ...base, tabs: DEMO_TABS, active: 'demo-crew' });
    await wait(1600);
    await shot(panel, path.join(out, 'screenshot-crew.png'));

    send(panel, 'demo', { ...base, tabs: [{ id: 'demo-new', title: 'New task', cwd: HOME, items: [] }, ...DEMO_TABS.slice(1)], active: 'demo-new' });
    await wait(900);
    await shot(panel, path.join(out, 'screenshot-empty.png'));

    send(panel, 'demo', { ...base, tabs: [{ id: 'demo-new', title: 'New task', cwd: HOME, items: [] }], active: 'demo-new', slash: '/re' });
    await wait(700);
    await shot(panel, path.join(out, 'screenshot-slash.png'));

    send(panel, 'demo', { ...base, tabs: DEMO_TABS, active: 'demo-crew', view: 'toolbox' });
    await wait(900);
    await shot(panel, path.join(out, 'screenshot-toolbox.png'));

    send(panel, 'demo', { ...base, tabs: DEMO_TABS, active: 'demo-crew', view: 'routines' });
    await wait(900);
    await shot(panel, path.join(out, 'screenshot-routines.png'));

    send(panel, 'demo', { ...base, tabs: DEMO_TABS, active: 'demo-crew', view: 'settings' });
    await wait(900);
    await shot(panel, path.join(out, 'screenshot-settings.png'));

    // Desktop critter: solo states, then with a crew of helpers.
    const crew = [
      { id: 'c1', tabId: 'demo-crew', label: 'Audit Documents', type: 'Explore' },
      { id: 'c2', tabId: 'demo-crew', label: 'Audit Desktop', type: 'general-purpose' },
      { id: 'c3', tabId: 'demo-crew', label: 'Audit Downloads', type: 'general-purpose' },
    ];
    for (const s of ['idle', 'working', 'asking', 'success', 'learned', 'sleeping']) {
      send(critter, 'critter:state', { state: s, busy: 1, crew: [], moreCrew: 0 });
      await wait(s === 'sleeping' ? 1500 : 700);
      await shot(critter, path.join(out, `critter-${s}.png`));
    }
    setCrewSlots(3);
    await wait(300);
    send(critter, 'critter:state', { state: 'working', busy: 2, crew, moreCrew: 0 });
    await wait(1200);
    await shot(critter, path.join(out, 'critter-crew.png'));
    send(critter, 'critter:state', { state: 'idle', busy: 0, crew: [], moreCrew: 0 });
    setCrewSlots(0);
    await wait(1300);

    // ---- Health: ~11 minutes of scripted readings that warm up into a hot GPU,
    // polled on a fake clock so the sparklines have history.
    let clock = Date.now() - 11 * 60 * 1000;
    health.monitor.now = () => clock;
    health.monitor.running = true; // shows as live; the loop itself never starts here
    for (let i = 0; i < 132; i++) {
      if (i === 100) health.sensors.setScenario('hot');
      await health.monitor.poll();
      clock += 5000;
    }
    send(panel, 'demo', { ...base, tabs: DEMO_TABS, active: 'demo-crew', view: 'health' });
    await wait(1600);
    await shot(panel, path.join(out, 'screenshot-health.png'));
    for (const mood of ['hot', 'scorching', 'dizzy', 'stuffed']) {
      health.sensors.setScenario(mood);
      await health.monitor.poll();
      await wait(1300);
      await shot(critter, path.join(out, `critter-${mood}.png`));
    }
    health.sensors.setScenario('calm');
    await health.monitor.poll();
    await wait(600);

    // ---- Wardrobe: earn some trophies, then dress up for the seasons
    for (let i = 0; i < 12; i++) wardrobe.record('task-completed');
    wardrobe.record('helper-spawned');
    wardrobe.record('crew-size', { n: 3 });
    wardrobe.record('trick-learned');
    wardrobe.record('plan-approved');
    send(panel, 'demo', { ...base, tabs: DEMO_TABS, active: 'demo-crew', view: 'trophies' });
    await wait(900);
    await shot(panel, path.join(out, 'screenshot-trophies.png'));

    setDate(2026, 10, 15); // Spooky Season
    wardrobe.wearSeason();
    await wait(600);
    send(critter, 'critter:state', { state: 'idle', busy: 0, crew: [], moreCrew: 0 });
    await wait(1500);
    await shot(critter, path.join(out, 'critter-halloween.png'));

    setDate(2026, 12, 12); // Winter Holidays
    wardrobe.wearSeason();
    await wait(1600);
    await shot(critter, path.join(out, 'critter-winter.png'));

    setDate(2026, 6, 10);
    wardrobe.setOptions({ unlockAll: true });
    wardrobe.setOutfit({ hat: 'wizard-hat', held: 'coffee-mug', face: null, neck: null, shell: null, effect: 'sparkles' });
    await wait(1400);
    await shot(critter, path.join(out, 'critter-wizard.png'));

    // The Outfits screen in an everyday look, so the README doesn't date with the seasons.
    send(panel, 'demo', { ...base, tabs: DEMO_TABS, active: 'demo-crew', view: 'wardrobe' });
    await wait(1400);
    await shot(panel, path.join(out, 'screenshot-wardrobe.png'));

    // Shell stickers: a few shipped projects on his own shell, and the Sticker Book.
    config.set({ stickers: demoStickers(captureClock.now.getTime()) });
    wardrobe.setOutfit({ hat: null, held: null, face: null, neck: null, shell: null, effect: null });
    broadcastSkin();
    send(panel, 'demo', { ...base, tabs: DEMO_TABS, active: 'demo-crew', view: 'stickers' });
    await wait(1600);
    await shot(panel, path.join(out, 'screenshot-stickers.png'));
    await shot(critter, path.join(out, 'critter-stickers.png'));
    wardrobe.setOutfit({ hat: 'wizard-hat', held: 'coffee-mug', effect: 'sparkles' });

    // The shareable crab card, with the trophies earned above.
    for (let i = 0; i < 30; i++) wardrobe.record('helper-spawned');
    await wait(800);
    const card = await panel.webContents.executeJavaScript('SB.crabCard.render().then(r => r.canvas.toDataURL("image/png"))');
    fs.writeFileSync(path.join(out, 'crab-card.png'), Buffer.from(card.split(',')[1], 'base64'));
    console.log('wrote', path.relative(process.cwd(), path.join(out, 'crab-card.png')));

    // A bare shell for the rest: at lineup size his stickers read as noise.
    // The projects stay, for the week card.
    config.set({ stickers: { ...config.get('stickers'), layouts: { home: [] } } });
    broadcastSkin();

    await captureLife({ critter, panel, send, out, wardrobe, config, broadcastSkin, base });
    await capturePages({ panel, send, out, config, base, makeTimeTracker });
  } catch (e) {
    console.error('capture failed:', e);
  }
  app.exit(0);
}

// The things he does on his own (0.17+): talking, guarding focus, red CI,
// listening along, the head-to-tail sets, other crab species, grown shells,
// and the Settings sections that reach beyond the PC.
async function captureLife({ critter, panel, send, out, wardrobe, config, broadcastSkin, base }) {
  const idle = { state: 'idle', busy: 0, crew: [], moreCrew: 0, background: 0 };
  const pose = async (file, state, ms = 1400) => {
    // Main sends his real state too, without the pose's sign or bubble: each
    // trophy unlocked along the way refreshes him 7 seconds later. Keep
    // putting the pose back until the shot is taken.
    const hold = () => send(critter, 'critter:state', { ...idle, ...state });
    hold();
    const holding = setInterval(hold, 50);
    try {
      await wait(ms);
      await shot(critter, path.join(out, `critter-${file}.png`));
    } finally {
      clearInterval(holding);
    }
  };
  const say = text => ({ text, occasion: 'demo', until: Date.now() + 60e3 });
  const bare = { hat: null, face: null, neck: null, held: null, shell: null, effect: null };
  const wear = async look => {
    const r = wardrobe.setOutfit({ ...bare, ...look });
    if (!r.ok) throw new Error(`couldn't wear ${JSON.stringify(look)}: ${r.error}`);
    await wait(500);
  };

  await wear({});
  await pose('voice', { state: 'working', busy: 1, say: say('fingers crossed') });
  await pose('focus', { focus: { phase: 'focus', endsAt: Date.now() + 18 * 60e3, minutes: 25 } });
  await pose('ci', { ci: { failing: 1 }, say: say('build is red') });

  await wear({ hat: 'headphones', held: 'boombox', effect: 'music-notes' });
  await pose('music', { say: say('good one') });

  const sets = {
    'dev-desk': { hat: 'keycap', face: 'sticky-note', neck: 'greenbar', held: 'rubber-duck', shell: 'hard-drive', effect: 'cursors' },
    'tide-pool': { hat: 'starfish', face: 'dive-mask', neck: 'puka-shells', held: 'kelp-frond', shell: 'barnacles', effect: 'bubbles' },
    'on-call': { hat: 'beacon', face: 'face-shield', neck: 'pager', held: 'fire-extinguisher', shell: 'high-vis', effect: 'embers' },
  };
  for (const [name, look] of Object.entries(sets)) {
    await wear(look);
    await pose(`set-${name}`, {});
  }

  // Other crabs, bare, so the shape is what you see.
  await wear({});
  for (const id of ['fiddler', 'coconut', 'porcelain', 'spider']) {
    config.set({ skin: id });
    broadcastSkin();
    await pose(`species-${id}`, {}, 1200);
  }
  config.set({ skin: 'classic' });

  // The Golden Conch, at level 20.
  config.set({ xp: { ...(config.get('xp') || {}), total: 1e6 }, home: { worn: 'golden-conch', seen: ['snail', 'tin-can', 'teacup', 'toy-brick', 'golden-conch'] } });
  broadcastSkin();
  await pose('conch', { state: 'success' });
  config.set({ home: { worn: 'home', seen: [] } });
  broadcastSkin();

  // Settings: phone notifications in one QR scan.
  send(panel, 'demo', { ...base, tabs: DEMO_TABS, active: 'demo-crew', view: 'settings' });
  await wait(900);
  const js = code => panel.webContents.executeJavaScript(code);
  await js("document.getElementById('chEnabled').click()");
  await wait(1400);
  await js("document.getElementById('channelsGroup').scrollIntoView({ block: 'start' })");
  await wait(500);
  await shot(panel, path.join(out, 'screenshot-away.png'));
}

// The pages from 0.55 on: Us and Finds, This week and its card, Time, Lean,
// and Projects with a dev server up and one crashed (data in capture-demo.js).
// Last, because the Us seed changes his temperament.
async function capturePages({ panel, send, out, config, base, makeTimeTracker }) {
  const { ipcMain } = require('electron');
  const now = Date.now();
  const js = code => panel.webContents.executeJavaScript(code);
  const show = async (view, ms = 1200) => { send(panel, 'demo', { ...base, tabs: DEMO_TABS, active: 'demo-crew', view }); await wait(ms); };
  // These pages ask main for data that capture mode never builds (life, the
  // projects service) or that reads real repos, so their IPC answers here
  // instead. The guard registers on Electron's own ipcMain, so these replace it.
  const fake = (channel, fn) => { ipcMain.removeHandler(channel); ipcMain.handle(channel, fn); };

  // His life only needs config to describe itself; it's never started here.
  config.set(demo.demoLife(now, config.get('voice')));
  const life = require('./life').createLife({
    config, toPanel() {}, enabled: () => false, seasons: () => [],
    temperament: () => voice.temperamentOf(voice.normalize(config.get('voice')).seed),
    playView: () => require('./play').normalize(config.get('play')),
  });
  fake('life:get', () => life.view());
  await show('us');
  await shot(panel, path.join(out, 'screenshot-us.png'));
  await show('finds');
  await shot(panel, path.join(out, 'screenshot-finds.png'));

  // demoWeek's stickers are the ones run() put on his shell.
  config.set(demo.demoWeek(now, config.get('xp')));
  send(panel, 'xp', xpSummary(config.get('xp'), now, streaks.streakOf(config.get('streaks'), now).current));
  await show('trophies');
  await js("document.getElementById('xpWeek').scrollIntoView({ block: 'start' })");
  await wait(300);
  await shot(panel, path.join(out, 'screenshot-week.png'));
  const week = await js('SB.weekCard.render().then(r => r.canvas.toDataURL("image/png"))');
  fs.writeFileSync(path.join(out, 'week-card.png'), Buffer.from(week.split(',')[1], 'base64'));
  console.log('wrote', path.relative(process.cwd(), path.join(out, 'week-card.png')));

  // The tracker reads its settings once, so they go in before it's built.
  const time = demo.demoTime(now);
  config.set({ timeTracking: time.timeTracking });
  makeTimeTracker().current = time.current;
  await show('time', 1500);
  await shot(panel, path.join(out, 'screenshot-time.png'));

  // Lean only asks main for a report when it has none, so it can be handed one.
  await show('toolbox', 900);
  await js(`SB.state.lean = ${JSON.stringify(demo.demoLean(now))}; SB.showToolbox('lean'); document.getElementById('toolGroups').scrollIntoView({ block: 'start' }); 1`);
  await wait(700);
  await shot(panel, path.join(out, 'screenshot-lean.png'));
  await js("SB.showToolbox('skill'); 1");

  const pj = demo.demoProjects(now);
  fake('projects:list', () => pj.list);
  fake('projects:detail', (_e, key) => pj.detail[key] ?? null);
  fake('servers:get', () => pj.servers);
  fake('servers:log', (_e, id) => pj.serverLog(id));
  fake('servers:fix-draft', (_e, a) => pj.fixDraft(a || {}));
  const openRow = name => js(`[...document.querySelectorAll('#pjProjects .pj-row')].find(b => b.querySelector('.pj-row-name b').textContent === ${JSON.stringify(name)})?.click()`);
  await show('projects');
  await shot(panel, path.join(out, 'screenshot-projects.png'));
  // One project's page: how it's going, what needs it, where you left off.
  await openRow('3d-rack');
  await wait(700);
  await js("document.activeElement?.blur(); 1");
  await shot(panel, path.join(out, 'screenshot-project-page.png'));
  await js("document.querySelector('#pjDetailScreen .pj-detail-head button')?.click()");
  await wait(300);
  await openRow('tidepool');
  await wait(1000); // its log and the Ask Claude sheet open by themselves
  // The crash, with its error lines marked, then the sheet that asks before
  // anything goes to Claude.
  await js("document.activeElement?.blur(); document.getElementById('srv-card-srv-tidep001')?.scrollIntoView({ block: 'start' })");
  await wait(300);
  await shot(panel, path.join(out, 'screenshot-devserver.png'));
  await js("document.querySelector('#srv-card-srv-tidep001 .pj-approve')?.scrollIntoView({ block: 'end' })");
  await wait(300);
  await shot(panel, path.join(out, 'screenshot-devserver-fix.png'));
  await js("document.querySelector('#pjDetailScreen .pj-detail-head button')?.click()");

  // The beach, built and at night (the brand's hour), then its snapshot.
  // Last, because its seed replaces the stickers and streaks.
  config.set(demo.demoBeach(now));
  await js("SB.beachPaint.timeOfDay = () => 'night'; 1");
  await show('beach', 1800);
  await shot(panel, path.join(out, 'screenshot-beach.png'));
  const beachCard = await js('SB.beachCard.render().then(r => r.canvas.toDataURL("image/png"))');
  fs.writeFileSync(path.join(out, 'beach-card.png'), Buffer.from(beachCard.split(',')[1], 'base64'));
  console.log('wrote', path.relative(process.cwd(), path.join(out, 'beach-card.png')));
}

const FAKE_STATUS = {
  installed: true, exe: 'claude.exe', version: '2.1.290', loggedIn: true,
  authMethod: 'claude.ai', subscriptionType: 'max', email: 'you@example.com',
};

module.exports = { run, FAKE_STATUS };
