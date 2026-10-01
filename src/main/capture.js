// `npm run screenshots` renders scripted demo states and saves PNGs to docs/.
// Uses fake account details so no personal info ends up in the README.
const fs = require('fs');
const path = require('path');

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

async function run({ app, critter, panel, showPanel, send, ROOT, setCrewSlots, wardrobe, captureClock, broadcastWardrobe, health }) {
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
    send(panel, 'demo', { ...base, tabs: DEMO_TABS, active: 'demo-crew', view: 'wardrobe' });
    await wait(1400);
    await shot(panel, path.join(out, 'screenshot-wardrobe.png'));
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
  } catch (e) {
    console.error('capture failed:', e);
  }
  app.exit(0);
}

const FAKE_STATUS = {
  installed: true, exe: 'claude.exe', version: '2.1.286', loggedIn: true,
  authMethod: 'claude.ai', subscriptionType: 'max', email: 'you@example.com',
};

module.exports = { run, FAKE_STATUS };
