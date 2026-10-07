// Demo data for the README screenshots of the newer pages (capture.js):
// Projects and dev servers, Time, Lean, Us and Finds, and This week.
// These pages read the real clock, so everything is built from `now` = Date.now(),
// not capture.js's captureClock. Fake paths and names only.
const crypto = require('crypto');
const path = require('path');
const out = require('./devservers/output');
const weekly = require('./weekly');
const { withInsights, sessionsFor } = require('./projects/insights');
const journalNotes = require('./journal');

const HOME = 'C:\\Users\\you';
const MIN = 60e3, HOUR = 3600e3, DAY = 864e5;
const dayKey = t => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

// ---------------------------------------------------------------- Projects
// Canned replies for the projects:* and servers:* IPC (the real ones read git
// and run package managers). Display order is array order.
// The 3d-rack page's handoff notes (journal.js): two sessions and a pin.
function demoJournal(now, name, root) {
  let book = journalNotes.record(null, {
    sessionId: 'demo-s2-note', title: 'Rack units ruler', at: now - 3 * HOUR, turns: 4, branch: 'shellby/rack-units-ruler',
    open: ['Snap the ruler to 1U steps'], done: ['Draw the U marks'], next: [], decisions: [],
    files: ['src/ruler.ts', 'src/scene.ts'], moreFiles: 0, dirty: 0, commits: ['feat: rack units ruler'], ended: 'The ruler draws; snapping is next.',
  });
  book = journalNotes.record(book, {
    sessionId: 'demo-s1-note', title: 'Snap cables to the nearest tray', at: now - 25 * MIN, turns: 3, branch: 'main',
    asked: 'Keep the cable slack when it snaps', open: ['Keep slack on snapped cables', 'Test with two trays'],
    next: ['Still need to handle a cable that spans two racks.'],
    decisions: ['Went with snapping on drop instead of while dragging, so the frame rate holds.'],
    done: ['Find the nearest tray'], files: ['src/cables.ts', 'src/trays.ts', 'test/cables.test.ts'], moreFiles: 2, dirty: 3, commits: [],
    ended: 'Cables snap to the nearest tray on drop. Still need to handle a cable that spans two racks.',
  });
  ({ book } = journalNotes.pin(book, { kind: 'decision', text: 'Trays are 1U; never let a cable snap between them.' }, now - DAY));
  return { root, notes: book.notes, pins: book.pins, draft: journalNotes.draft(book, { name, now }) };
}

function demoProjects(now) {
  const code = n => path.win32.join(HOME, 'code', n);
  const R = { shellby: code('shellby'), shellby2: 'D:\\work\\shellby', rack3d: code('3d-rack'), rack: code('rack-builder'), tide: code('tidepool') };

  const VITE_LOG = [
    '> 3d-rack@0.9.0 dev C:\\Users\\you\\code\\3d-rack', '> vite', '',
    '  VITE v6.0.7  ready in 412 ms', '',
    '  ➜  Local:   http://localhost:5173/', '  ➜  Network: use --host to expose', '  ➜  press h + enter to show help',
    '3:41:07 PM [vite] hmr update /src/scene/Rack.tsx',
    '3:42:19 PM [vite] hmr update /src/scene/CableTray.tsx, /src/index.css',
  ];
  const TIDE_LOG = [
    '> tidepool@0.4.0 dev', '> node src/server.js', '',
    '[tidepool] listening on http://localhost:4000',
    'GET /api/stations 200 12ms',
    'GET /api/tides?station=9414290 200 41ms',
    'GET /api/forecast?station=9414290 500 8ms',
    'C:\\Users\\you\\code\\tidepool\\src\\forecast.js:27',
    '  return readings.map(r => ({ t: r.time, h: r.height }));',
    '                  ^', '',
    "TypeError: Cannot read properties of undefined (reading 'map')",
    '    at buildForecast (C:\\Users\\you\\code\\tidepool\\src\\forecast.js:27:19)',
    '    at Layer.handle (C:\\Users\\you\\code\\tidepool\\src\\routes.js:14:22)', '',
    'Node.js v22.11.0',
    'npm error Lifecycle script `dev` failed with error:',
    'npm error code 1',
  ];

  const up = {
    id: 'srv-3drack01', kind: 'server', root: R.rack3d, project: '3d-rack', script: 'dev', manager: 'pnpm', framework: 'vite',
    status: 'up', port: 5173, url: 'http://localhost:5173/', startedAt: now - 42 * MIN, upAt: now - 42 * MIN, endedAt: 0,
    exitCode: null, restarts: 0, seen: false, missed: false, neverUp: false, fixTabId: null, fixedAt: 0,
    command: 'pnpm run dev', canFix: false, hasLog: true,
  };
  const down = {
    ...up, id: 'srv-tidep001', root: R.tide, project: 'tidepool', manager: 'npm', framework: 'node',
    status: 'crashed', port: 4000, url: 'http://localhost:4000/', startedAt: now - 20 * MIN, upAt: now - 20 * MIN,
    endedAt: now - 3 * MIN, exitCode: 1, command: 'npm run dev', canFix: true,
  };
  const servers = {
    settings: { onQuit: 'keep', quitNoteSeen: true, crab: true, sign: true, toast: true },
    servers: [up, down], running: 1, max: 8,
  };
  const logs = { [up.id]: VITE_LOG, [down.id]: TIDE_LOG };

  const gh = (name, o = {}) => ({ repo: `you/${name}`, private: false, url: `https://github.com/you/${name}`, description: '', pushedAt: now - DAY, archived: false, fork: false, ...o });
  const scripts = (...l) => l.map(([name, framework = null, likely = false]) => ({ name, framework, likely }));
  const clone = (root, branch, o = {}) => ({ root, branch, main: true, manager: 'npm', installed: true, scripts: [], lastScript: null, servers: [], ...o });
  const nodeScripts = scripts(['start', null, true], ['test'], ['screenshots'], ['dist']);

  // `git` is one entry per clone, and only on the detail page.
  const projects = [
    { key: 'github:you/3d-rack', name: '3d-rack', github: gh('3d-rack', { private: true, description: 'Plan a server rack in 3D, cable trays and all.' }), lastWorkedAt: now - 5 * MIN, running: true,
      local: [clone(R.rack3d, 'feat/cable-trays', { manager: 'pnpm', lastScript: 'dev', servers: [up],
        scripts: scripts(['dev', 'vite', true], ['preview', 'vite', true], ['build'], ['lint'], ['test']) })],
      git: [{ dirty: 3, unpushed: 2, copies: [{ path: 'C:\\Users\\you\\.shellby\\worktrees\\a1b2c3\\3d-rack', branch: 'shellby/rack-units-a1b2c3' }] }] },
    { key: 'github:you/shellby', name: 'shellby', github: gh('shellby', { description: 'A desktop crab that runs Claude Code for you.' }), lastWorkedAt: now - 40 * MIN, running: false,
      local: [clone(R.shellby, 'main', { lastScript: 'start', scripts: nodeScripts }), { ...clone(R.shellby2, 'release/0.62', { scripts: nodeScripts }), main: false }],
      git: [{ dirty: 0, unpushed: 0, copies: [] }, { dirty: 1, unpushed: 0, copies: [] }] },
    { key: 'github:you/tidepool', name: 'tidepool', github: gh('tidepool', { private: true, description: 'Tide charts and a little forecast API.' }), lastWorkedAt: now - 3 * HOUR, running: false,
      local: [clone(R.tide, 'main', { lastScript: 'dev', servers: [down], scripts: scripts(['dev', 'node', true], ['test']) })],
      git: [{ dirty: 1, unpushed: 0, copies: [] }] },
    { key: `local:${R.rack.toLowerCase()}`, name: 'rack-builder', github: null, lastWorkedAt: now - 2 * DAY, running: false,
      local: [clone(R.rack, 'develop', { manager: null, installed: null })],
      git: [{ dirty: 0, unpushed: 5, copies: [] }] },
    { key: 'github:you/kelp-cli', name: 'kelp-cli', github: gh('kelp-cli', { description: 'Seaweed-fast scaffolding for Go CLIs.', pushedAt: now - 9 * DAY }), lastWorkedAt: 0, running: false,
      local: [], git: [] },
  ];

  // What the rest of Shellby knows about them, joined the real way (projects/insights.js).
  const gitOf = g => ({ dirty: g.dirty, unpushed: g.unpushed, stashes: 0, copies: g.copies.length, copyList: g.copies.map(w => ({ ...w, changed: 2 })) });
  const week = (...mins) => mins.map((m, i) => ({ day: dayKey(now - (mins.length - 1 - i) * DAY), seconds: m * 60 }));
  const sources = {
    now,
    afterDays: 5,
    streaks: {
      [R.rack3d.toLowerCase()]: { lastSeen: now - 5 * MIN, lastCommitAt: now - 2 * HOUR, muted: false },
      [R.shellby.toLowerCase()]: { lastSeen: now - 40 * MIN, lastCommitAt: now - DAY, muted: false },
      [R.tide.toLowerCase()]: { lastSeen: now - 3 * HOUR, lastCommitAt: now - 2 * DAY, muted: false },
      [R.rack.toLowerCase()]: { lastSeen: now - 2 * DAY, lastCommitAt: now - 8 * DAY, muted: false },
    },
    time: (() => {
      const t = [[R.rack3d, week(95, 140, 0, 210, 160)], [R.shellby, week(60, 30, 45, 90, 40)], [R.tide, week(0, 75, 50, 0, 35)]];
      return { days: t[0][1].map(d => d.day), projects: t.map(([key, days]) => ({ key, seconds: days.reduce((n, d) => n + d.seconds, 0), days })) };
    })(),
    prs: [
      { key: 'you/tidepool#14', repo: 'you/tidepool', number: 14, title: 'Forecast endpoint', state: 'failing', failing: ['test (22.x)'], url: 'https://github.com/you/tidepool/pull/14' },
      { key: 'you/3d-rack#31', repo: 'you/3d-rack', number: 31, title: 'Cable trays', state: 'passing', failing: [], url: 'https://github.com/you/3d-rack/pull/31' },
    ],
    deps: [
      { key: R.tide, name: 'tidepool', at: now - DAY, ok: true, outdatedTotal: 4, vulnTotal: 1, vulns: { critical: 0, high: 1, moderate: 0, low: 0 }, worst: 'high', attention: true, summary: '4 outdated (1 major) · 1 high' },
      { key: R.rack3d, name: '3d-rack', at: now - DAY, ok: true, outdatedTotal: 0, vulnTotal: 0, vulns: {}, worst: null, attention: false, summary: 'All up to date' },
    ],
    flaky: [{ key: 'demo3drack', root: R.rack3d, id: 'scene.spec > snaps cables to trays', label: 'scene.spec › snaps cables to trays', week: 2, total: 3, status: 'watching', retry: false }],
    stickers: [],
    servers: servers.servers,
    git: new Map(projects.flatMap(p => p.local.map((c, i) => [c.root.toLowerCase(), gitOf(p.git[i])]))),
  };
  const sessions = [
    { id: 'demo-s1', title: 'Snap cables to the nearest tray', cwd: R.rack3d, updatedAt: now - 25 * MIN },
    { id: 'demo-s2', title: 'Rack units ruler', cwd: 'C:\\Users\\you\\.shellby\\worktrees\\a1b2c3\\3d-rack', updatedAt: now - 3 * HOUR },
    { id: 'demo-s3', title: 'Why is the build slow?', cwd: R.rack3d, updatedAt: now - 2 * DAY, done: true },
  ];

  const list = {
    projects: withInsights(projects.map(({ git: _git, ...p }) => p), sources),
    github: { signedIn: true, enabled: true, privateRepos: true, error: null },
    servers,
    lastCloneParent: path.win32.join(HOME, 'code'),
  };
  const detail = Object.fromEntries(list.projects.map((p, n) => {
    const local = p.local.map((c, i) => ({ ...c, git: gitOf(projects[n].git[i]) }));
    const copies = local.flatMap(c => c.git.copyList.map(w => w.path));
    const journal = local.some(c => c.root === R.rack3d) ? demoJournal(now, p.name, R.rack3d) : null;
    return [p.key, { ...p, local, sessions: sessionsFor(sessions, local.map(c => c.root), copies), journal }];
  }));
  const serverLog = id => (logs[id] ? { lines: logs[id], errors: [...out.errorLines(logs[id])] } : null);
  const fixDraft = ({ id, note = '' } = {}) => {
    const s = servers.servers.find(x => x.id === id);
    if (!s?.canFix) return null;
    const lines = out.tail(logs[id]);
    const prompt = out.fixPrompt(s, lines, note);
    return { prompt, hash: crypto.createHash('sha256').update(prompt).digest('hex').slice(0, 32), lines, root: s.root, project: s.project, note };
  };
  return { list, detail, servers, serverLog, fixDraft };
}

// ---------------------------------------------------------------- Time
// config 'timeTracking': four projects for three clients over two weeks.
function demoTime(now) {
  const key = t => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  // Short names: the panel's project rows leave little room beside the client.
  const P = {
    site: 'c:\\users\\you\\code\\harbor',
    tide: 'c:\\users\\you\\code\\tidepool',
    rack: 'c:\\users\\you\\code\\3d-rack',
    shell: 'c:\\users\\you\\code\\shellby',
  };
  // Minutes per project [site, tide, rack, shell], today first, going back 13 days. Weekends get a quarter.
  const MINUTES = [
    [134, 41, 0, 26], [187, 63, 22, 0], [96, 118, 47, 31], [212, 0, 74, 18], [158, 87, 0, 44],
    [121, 136, 58, 0], [176, 29, 93, 37], [143, 72, 0, 52], [201, 0, 66, 23], [88, 154, 39, 0],
    [167, 47, 81, 29], [129, 98, 0, 61], [192, 33, 57, 0], [114, 121, 44, 35],
  ];
  const days = {};
  MINUTES.forEach((row, i) => {
    const t = now - i * DAY;
    const weekend = [0, 6].includes(new Date(t).getDay());
    const m = Object.fromEntries([P.site, P.tide, P.rack, P.shell]
      .map((k, j) => [k, Math.round(row[j] * (weekend ? 0.25 : 1) * 60 + ((i * 7 + j * 13) % 50))])
      .filter(([, s]) => s >= 5 * 60));
    if (Object.keys(m).length) days[key(t)] = m;
  });
  return {
    current: { key: P.site, why: 'shellby' },
    timeTracking: {
      enabled: true, idleMinutes: 5, roundMinutes: 15, roundMode: 'nearest', currency: 'USD',
      projects: {
        [P.site]: { name: 'harbor', client: 'Harbor Tree', rate: 120, billable: true },
        [P.tide]: { name: 'tidepool', client: 'Kelp & Co.', rate: 95, billable: true },
        [P.rack]: { name: '3d-rack', client: 'Northwind', rate: 110, billable: true },
        [P.shell]: { name: 'shellby', client: '', rate: null, billable: false },
      },
      days,
      manual: { [key(now - 2 * DAY)]: { [P.site]: 45 * 60 } },
      notes: {
        [key(now - 2 * DAY)]: { [P.site]: 'Client call: homepage review', [P.tide]: 'Tide chart API' },
        [key(now - DAY)]: { [P.site]: 'Booking form and accessibility fixes' },
        [key(now - 4 * DAY)]: { [P.rack]: 'Export to PDF' },
      },
    },
  };
}

// ---------------------------------------------------------------- Us and Finds
// config 'bond', 'finds', 'play', 'scenesSeen' and 'voice' (the seed picks a chipper crab).
function demoLife(now, voice) {
  const ago = d => now - d * DAY;
  const item = (n, firstAgo, lastAgo = firstAgo) => ({ n, first: ago(firstAgo), last: ago(lastAgo) });
  return {
    bond: {
      hatchedAt: ago(203), points: 1124, days: 187, level: 4, lastDay: null,
      birthday: { m: 11, d: 14 }, celebrated: [], recalled: [],
      journal: [ // newest first: the Us page lists it in stored order
        { kind: 'set-done', at: ago(2) - 3 * HOUR, data: { set: 'Beach day' } },
        { kind: 'visitor', at: ago(6), data: { login: 'mira-codes' } },
        { kind: 'rare-find', at: ago(11), data: { item: 'Compass' } },
        { kind: 'hide-found', at: ago(19), data: { ms: 47000 } },
        { kind: 'level', at: ago(34), data: { name: 'Best friends' } },
        { kind: 'big-ride', at: ago(58), data: { app: 'Chrome', px: 3412 } },
        { kind: 'days', at: ago(96), data: { n: 100 } },
        { kind: 'shaken', at: ago(131), data: { app: 'Excel' } },
        { kind: 'first-find', at: ago(198), data: { item: 'Smooth pebble' } },
        { kind: 'hatched', at: ago(203), data: {} },
      ],
    },
    finds: {
      items: {
        pebble: item(4, 198, 9), 'sand-dollar': item(2, 170, 40), 'tiny-shell': item(3, 150, 22),
        driftwood: item(1, 120), kelp: item(2, 88, 30), starfish: item(1, 2), // Beach day, complete
        'sea-glass-green': item(3, 160, 15), 'sea-glass-blue': item(1, 77), 'sea-glass-amber': item(1, 41),
        paperclip: item(2, 180, 50), 'rubber-band': item(1, 140), button: item(1, 101),
        'bottle-cap': item(2, 66, 12), 'lost-key': item(1, 54), 'guitar-pick': item(1, 25),
        'old-coin': item(1, 17), compass: item(1, 11), // the pirate's hoard, with one rare
        'painted-egg': item(1, 160), 'beach-ball': item(1, 80),
        marble: item(1, 45),
      },
      digs: 71, dry: 0, day: null, today: 0,
      lastFindAt: ago(2) - 3 * HOUR, lastManualAt: now - 5 * HOUR,
      specials: [], favourite: 'compass', unseen: [], // anything unseen is cleared (and rewritten) after 2.5 s
    },
    play: { hide: { games: 9, found: 7, won: 2, best: 47000 }, fetch: { throws: 26, fetched: 23, longest: 1840 } },
    scenesSeen: ['sneeze', 'hiccups', 'bubbles', 'castle', 'fly', 'juggle', 'friday', 'showfind', 'heart', 'wave', 'pounce', 'coffee'],
    voice: { ...(voice || {}), seed: 'readme-crab' },
  };
}

// ---------------------------------------------------------------- This week
// config 'weekly', 'xp' and 'streaks'. The sticker ids are capture.js's demoStickers.
function demoWeek(now, xp) {
  const key = ago => { const d = new Date(now); d.setDate(d.getDate() - ago); return weekly.dayKey(d.getTime()); };
  const P = { shellby: '5b1c0de0a1f2', rack: '9e3a7c21d4b8', builder: 'c47f02e9a5d1', tide: '0d8e6b13f7a2' };
  const days = {
    [key(0)]: { task: 4, tests: 3, fixed: 1, ship: 2, release: 1, projects: { [P.shellby]: 'shellby' }, work: { shellby: 4 },
      trophies: { liftoff: { name: 'Liftoff', icon: '🚀' } } },
    [key(1)]: { task: 6, tests: 4, fixed: 2, ship: 1, deploy: 1, focus: 1, projects: { [P.rack]: '3d-rack' }, work: { shellby: 3, '3d-rack': 3 },
      trophies: { 'green-light': { name: 'Green Light', icon: '🟢' } } },
    [key(2)]: { task: 3, tests: 2, deps: 1, work: { shellby: 2, 'rack-builder': 1 } },
    [key(3)]: { task: 5, tests: 3, fixed: 1, ship: 1, merge: 1, projects: { [P.builder]: 'rack-builder' }, work: { 'rack-builder': 3, shellby: 2 },
      trophies: { 'night-owl': { name: 'Night Owl', icon: '🦉' } } },
    [key(4)]: { task: 4, tests: 2, ship: 1, projects: { [P.shellby]: 'shellby' }, work: { shellby: 4 } },
    // last week, lighter, for "vs last week"
    [key(7)]: { task: 3, tests: 1, ship: 1, projects: { [P.tide]: 'tidepool' }, work: { tidepool: 3 } },
    [key(8)]: { task: 2, work: { shellby: 2 } },
    [key(10)]: { task: 4, fixed: 1, work: { shellby: 4 } },
    [key(11)]: { task: 2, work: { '3d-rack': 2 } },
  };
  const daily = { [key(0)]: 340, [key(1)]: 520, [key(2)]: 260, [key(3)]: 610, [key(4)]: 380,
    [key(7)]: 240, [key(8)]: 150, [key(10)]: 330, [key(11)]: 190 };
  const streakDays = [0, 1, 2, 3, 4, ...Array.from({ length: 21 }, (_, i) => 30 + i)].map(key); // 5 now, 21 longest
  // The XP log under the chart, newest first.
  const log = [
    [12, 'ship', 40, 'Pushed code', 'shellby'], [35, 'tests', 25, 'Tests passed', 'shellby'],
    [70, 'trophy', 20, 'Earned a trophy', null], [130, 'deploy', 50, 'Deployed', '3d-rack'],
    [190, 'fixed', 40, 'Tests green again', '3d-rack'], [260, 'task', 10, 'Finished a task', 'shellby'],
    [330, 'trick', 150, 'Wrote himself a new trick', null], [420, 'flakefix', 40, 'Fixed a flaky test', 'rack-builder'],
  ].map(([m, kind, gained, label, project]) => ({ at: now - m * MIN, kind, xp: gained, label, project }));
  // What the plan bought: Claude's hours each day, and four fixes, one undone by a later red.
  const at = (ago, hour) => { const d = new Date(now); d.setDate(d.getDate() - ago); d.setHours(hour, 0, 0, 0); return d.getTime(); };
  [[0, 4.2], [1, 6.1], [2, 2.6], [3, 5.4], [4, 3.8], [7, 3.1], [10, 4.4]].forEach(([ago, h]) => { days[key(ago)].ms = Math.round(h * HOUR); });
  days[key(0)].fixes = [{ at: at(0, 9), key: 't:shellby' }];
  days[key(1)].fixes = [{ at: at(1, 11), key: 't:3d-rack' }, { at: at(1, 15), key: 'ci:x-salmon/3d-rack#41' }];
  days[key(3)].fixes = [{ at: at(3, 10), key: 't:rack-builder' }];
  days[key(2)].reds = { 't:rack-builder': at(2, 14) };
  // The week's work: routines overnight, pull requests, branches brought home.
  Object.assign(days[key(1)], { away: 2, awayMs: Math.round(1.9 * HOUR), pr: 2, home: 2 });
  Object.assign(days[key(3)], { away: 1, awayMs: Math.round(1.25 * HOUR), pr: 1, home: 1, undone: 2 });
  return {
    weekly: { days, since: key(13), wrapped: null },
    lastUsage: { status: 'allowed', fiveHour: { pct: 22, resetsAt: now + 3 * HOUR }, sevenDay: { pct: 64, resetsAt: now + 2 * DAY }, at: now },
    xp: { ...(xp || {}), total: 48250, daily, log },
    streaks: { days: streakDays, projects: {}, nudges: false },
  };
}

// ---------------------------------------------------------------- The beach
// config 'stickers', 'streaks' and 'beach': a year and a half of shipping, so
// the beach is wider than the panel, a streak on and a better one behind it,
// and a few projects still being worked on (plots). Finds come from demoLife.
function demoBeach(now) {
  const list = [
    ['dotfiles', 3, [], 540], ['kelp-cli', 1, ['moon'], 470], ['shellby', 52, ['live', 'release', 'v1', 'merged'], 410],
    ['tidepool', 2, [], 380], ['3d-rack', 17, ['live', 'merged', 'green'], 330], ['rack-builder', 6, ['release'], 290],
    ['reef-notes', 9, ['merged'], 240], ['barnacle', 1, [], 205], ['lighthouse', 24, ['live', 'release'], 170],
    ['sea-glass', 4, [], 130], ['undertow', 41, ['live', 'release', 'v1'], 95], ['driftwood', 5, ['merged'], 60],
    ['salt-api', 2, ['live'], 26], ['pier-ui', 1, [], 4],
  ];
  const projects = {};
  list.forEach(([name, ships, marks, firstAgo], i) => {
    const id = `bea${String(i).padStart(9, '0')}`;
    projects[id] = {
      name, ships, marks, lang: null, root: path.win32.join(HOME, 'code', name),
      firstShipAt: now - firstAgo * DAY, lastShipAt: now - Math.max(0, firstAgo - 30) * DAY,
      deploys: marks.includes('live') ? Math.ceil(ships / 4) : 0, releases: marks.includes('release') ? Math.ceil(ships / 8) : 0,
      merges: marks.includes('merged') ? Math.ceil(ships / 3) : 0, lastVersion: marks.includes('v1') ? '1.4.0' : null,
    };
  });
  const key = ago => { const d = new Date(now); d.setDate(d.getDate() - ago); return weekly.dayKey(d.getTime()); };
  const days = [...Array.from({ length: 9 }, (_, i) => i), ...Array.from({ length: 34 }, (_, i) => 40 + i)].map(key);
  const plot = (name, ago) => [path.win32.join(HOME, 'code', name).toLowerCase(), { name, lastSeen: now - ago * DAY, lastCommitAt: null, lastNudgeAt: null, muted: false }];
  return {
    stickers: { projects, layouts: { home: [] }, card: 'art', unseen: [] },
    streaks: { days, projects: Object.fromEntries([plot('moon-jelly', 0), plot('rockpool', 2), plot('crab-mail', 6)]), nudges: false },
    // Seen just now: the README shot shows it built, not rising.
    beach: { seenAt: now + 1, tiers: {}, highWater: 0 },
  };
}

// ---------------------------------------------------------------- Lean
// What lean:report returns (lean.js buildReport). Keep token counts under a
// million: SB.compact has no M suffix.
/**
 * The Bugdex for the screenshots: 17 kinds caught (one golden, the Nullfish
 * evolved, the Burrows finished), a few only seen, and two on the loose.
 */
function demoBugdex(now) {
  const bugdex = require('./bugdex');
  const SHELLBY = '5b1c0de0a1f2', RACK = '9e3a7c21d4b8';
  const fp = i => i.toString(16).padStart(12, '0');
  let s = null;
  let i = 0;
  const caught = (species, daysAgo, opts = {}) => {
    const t = now - daysAgo * DAY;
    s = bugdex.recordCatch(s, { species, fp: fp(++i), project: opts.project || SHELLBY, name: opts.name || 'shellby', firstAt: t - (opts.took || 9 * 60 * 1000), firstTry: !!opts.firstTry, device: 'demo-pc', rand: () => 0.5, lang: opts.lang || 'js' }, t).state;
  };
  for (let n = 0; n < 6; n++) caught('nullfish', 60 - n * 9, { lang: n % 2 ? 'ts' : 'js' });
  ['shell-less-hermit', 'locked-limpet', 'clingy-barnacle', 'mixed-up-mussel', 'overstuffed-pufferfish'].forEach((id, n) => caught(id, 40 - n * 3));
  caught('shapeshifter-shrimp', 31, { firstTry: true, took: 3 * 60 * 1000 }); // golden
  caught('syntax-slug', 29);
  caught('two-headed-crab', 27, { lang: 'git' });
  caught('red-snapper', 25, { name: 'rack-builder', project: RACK });
  caught('flaky-phantom', 22, { name: 'rack-builder', project: RACK });
  caught('red-tide', 18, { lang: 'ci' });
  caught('beached-whale', 15);
  caught('stray-module-minnow', 12);
  caught('port-squatter', 9);
  caught('type-tangle', 6, { lang: 'ts' });
  caught('segfault-squid', 3, { lang: 'rust', name: 'rack-builder', project: RACK });
  for (const species of ['ouroboros-eel', 'keyless-krill', 'closed-clam', 'lint-louse']) s = bugdex.recordSeen(s, { species, fp: fp(++i), project: SHELLBY }, now - 2 * DAY).state;
  s = bugdex.spot(s, { species: 'slowpoke-snail', fp: fp(++i), project: SHELLBY, name: 'shellby', source: 'bash', keys: [], kind: 'tests' }, now - 25 * 60 * 1000).state;
  s = bugdex.engage(s, SHELLBY, now - 20 * 60 * 1000);
  s = bugdex.spot(s, { species: 'assertive-lobster', fp: fp(++i), project: RACK, name: 'rack-builder', source: 'bash', keys: [], kind: 'tests' }, now - 7 * 60 * 1000).state;
  return { ...bugdex.setFavourite(s, 'segfault-squid'), unseen: ['segfault-squid', 'type-tangle'] };
}

function demoLean(now) {
  return {
    ok: true,
    setup: { key: 'c:\\users\\you\\code\\tidepool', name: 'tidepool', tokens: 24300, at: now - 40 * MIN },
    plugins: [ // idle first, then by tokens, as the real report sorts them
      { id: 'vercel@claude-plugins-official', name: 'vercel', scope: 'user', tokens: 2100, lastUsed: null, background: false, idle: true },
      { id: 'figma@claude-plugins-official', name: 'figma', scope: 'user', tokens: 1400, lastUsed: null, background: false, idle: true },
      { id: 'superpowers@claude-plugins-official', name: 'superpowers', scope: 'user', tokens: 1600, lastUsed: now - 2 * HOUR, background: true, idle: false },
      { id: 'document-skills@anthropic-agent-skills', name: 'document-skills', scope: 'user', tokens: 1200, lastUsed: now - 3 * DAY, background: false, idle: false },
      { id: 'github@claude-plugins-official', name: 'github', scope: 'user', tokens: 900, lastUsed: now - 5 * HOUR, background: false, idle: false },
      { id: 'frontend-design@claude-plugins-official', name: 'frontend-design', scope: 'user', tokens: 450, lastUsed: now - 26 * HOUR, background: false, idle: false },
      { id: 'code-review@claude-plugins-official', name: 'code-review', scope: 'user', tokens: 250, lastUsed: now - 50 * MIN, background: false, idle: false },
    ],
    mcp: [
      { name: 'sqlite', status: 'connected', lastUsed: null, idle: true },
      { name: 'obsidian', status: 'connected', lastUsed: now - 4 * HOUR, idle: false },
    ],
    skills: [ // idle first, then by what each costs in every conversation
      { kind: 'skill', name: 'changelog-writer', source: 'user', listTokens: 140, useTokens: 2300, uses: 0, lastUsed: null, idle: true },
      { kind: 'skill', name: 'tide-tables', source: 'project', listTokens: 95, useTokens: 1800, uses: 14, lastUsed: now - 3 * HOUR, idle: false },
      { kind: 'agent', name: 'reviewer', source: 'user', listTokens: 60, useTokens: 900, uses: 6, lastUsed: now - 2 * DAY, idle: false },
    ],
    memory: [
      { path: 'C:\\Users\\you\\.claude\\CLAUDE.md', scope: 'user', tokens: 1620, onDemand: false },
      { path: 'C:\\Users\\you\\code\\tidepool\\CLAUDE.md', scope: 'project', tokens: 980, onDemand: false },
      { path: 'C:\\Users\\you\\.claude\\rules\\typescript.md', scope: 'user', tokens: 310, onDemand: true },
    ],
    totals: { plugins: 7900, idlePlugins: 3500, memory: 2600, memoryOnDemand: 310, skills: 295, idleCount: 4 },
    watched: true, watchedFrom: now - 45 * DAY, idleDays: 21,
    cache: {
      today: { input: 3100, write: 21400, read: 171500, calls: 6, total: 196000, rate: 0.875, saved: 154350 },
      week: { input: 18200, write: 140600, read: 1063000, calls: 41, total: 1221800, rate: 0.870, saved: 956700 },
      lastWeek: { input: 24900, write: 182300, read: 780100, calls: 37, total: 987300, rate: 0.790, saved: 702090 },
    },
    off: [{ id: 'playwright@claude-plugins-official', name: 'playwright' }],
  };
}

module.exports = { demoProjects, demoTime, demoLife, demoWeek, demoBeach, demoLean, demoBugdex };
