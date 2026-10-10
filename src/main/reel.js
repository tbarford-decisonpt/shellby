// `npm run reel` plays a short scripted story through the real UI and records
// both windows frame by frame; scripts/make-reel.py turns the frames into the
// README GIF (and an MP4). Throwaway profile, fake account, nothing is sent to
// Claude: the panel is fed the same stream items a real run produces.
//
// Story: type a task → Shellby goes to work → three helper crabs head out and
// work in their lanes → they come home → done → first trophy, confetti, wear it.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { panelReady } = require('./capture');

const FPS = 15;
const TAB = 'reel';
const HOME = 'C:\\Users\\you';
const TASK = 'Send three helpers to audit my Documents, Desktop and Downloads';
const wait = ms => new Promise(r => setTimeout(r, ms));

const CREW = [
  { id: 't1', tabId: TAB, label: 'Audit Documents', type: 'Explore' },
  { id: 't2', tabId: TAB, label: 'Audit Desktop', type: 'general-purpose' },
  { id: 't3', tabId: TAB, label: 'Audit Downloads', type: 'general-purpose' },
];

async function run({ app, critter, panel, showPanel, send, setCrewSlots, wardrobe, captureClock, broadcastWardrobe }) {
  const dir = process.env.SHELLBY_REEL_DIR || path.join(os.tmpdir(), 'shellby-reel');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const js = code => panel.webContents.executeJavaScript(code);
  const item = it => send(panel, 'tab:item', { tabId: TAB, item: it });
  // His own lines from src/main/voice.js, so the reel shows him talking.
  let line = null;
  const say = text => { line = text ? { text, occasion: 'reel', until: Date.now() + 60e3 } : null; };
  const mood = (state, crew = []) => send(critter, 'critter:state', { state, busy: state === 'working' ? 1 : 0, crew, moreCrew: 0, background: 0, say: line });
  const marks = [];
  let t0 = 0;
  const mark = caption => marks.push({ t: Date.now() - t0, caption });

  try {
    // Off-season, so no seasonal outfit sneaks into the reel.
    captureClock.now = new Date(2026, 5, 10, 12);
    wardrobe.collectSeasonals();
    broadcastWardrobe();
    await panelReady(panel);
    await panel.webContents.insertCSS('.quest-card { display: none !important; }');
    for (const w of [critter, panel]) w.webContents.setBackgroundThrottling(false);
    critter.setAlwaysOnTop(true, 'screen-saver');
    showPanel({ focusInput: false });

    // Lay the scene out: the panel on the left, Shellby on the "desktop" to its right.
    const { screen } = require('electron');
    const wa = screen.getPrimaryDisplay().workArea;
    const pb = { x: wa.x + 80, y: wa.y + 80, width: 440, height: 620 };
    panel.setBounds(pb);
    const cb = critter.getBounds();
    critter.setBounds({ x: pb.x + pb.width + 620 - cb.width, y: pb.y + pb.height - cb.height, width: cb.width, height: cb.height });
    send(panel, 'demo', { tabs: [{ id: TAB, title: 'New task', cwd: HOME, items: [] }], active: TAB, learned: [], pinned: [] });
    mood('idle');
    await wait(1500);

    // ---------------------------------------------------------------- record
    const frames = [];
    let recording = true;
    t0 = Date.now();
    const recorder = (async () => {
      for (let i = 0; recording; i++) {
        const t = Date.now() - t0;
        const [p, c] = await Promise.all([panel.webContents.capturePage(), critter.webContents.capturePage()]);
        fs.writeFileSync(path.join(dir, `p${i}.jpg`), p.toJPEG(92));
        fs.writeFileSync(path.join(dir, `c${i}.png`), c.toPNG());
        frames.push({ i, t, panel: panel.getBounds(), critter: critter.getBounds() });
        await wait(Math.max(0, t0 + (i + 1) * (1000 / FPS) - Date.now()));
      }
    })();

    // ---------------------------------------------------------------- 1. a task
    mark('Give Shellby a task');
    await wait(900);
    await js("SB.$('input').focus()");
    for (let n = 2; n <= TASK.length + 1; n += 2) {
      await js(`(i => { i.value = ${JSON.stringify(TASK.slice(0, n))}; i.dispatchEvent(new Event('input')); })(SB.$('input'))`);
      await wait(42);
    }
    await wait(450);
    // "Send" without calling the real CLI: render exactly what SB.send() would.
    await js(`(() => {
      const t = SB.activeTab();
      t.render({ kind: 'user', text: ${JSON.stringify(TASK)} });
      Object.assign(t, { busy: true, saved: true, statusText: 'Working…', title: 'Audit Documents, Desktop and Downloads' });
      const i = SB.$('input'); i.value = ''; i.dispatchEvent(new Event('input'));
      SB.syncBusyUi(); SB.renderTabStrip();
    })()`);
    say('claws out');
    mood('working');
    await wait(900);
    item({ kind: 'text', text: "On it. I'll send one helper per folder so they run in parallel." });
    await wait(800);

    // ---------------------------------------------------------------- 2. helpers
    mark('He sends out helper crabs');
    for (let n = 1; n <= 3; n++) {
      const a = `a${n}`, c = CREW[n - 1];
      item({ kind: 'tool', id: a, name: 'Agent', label: 'Delegated', detail: c.label, agent: { type: c.type, description: c.label, background: false } });
      item({ kind: 'task', phase: 'started', taskId: c.id, toolUseId: a, description: c.label, subagentType: c.type });
      setCrewSlots(n);
      mood('working', CREW.slice(0, n));
      await wait(420);
    }
    say('all claws in');
    mood('working', CREW);
    await js("SB.activeTab().setStatus('3 helpers working…')");
    await wait(500);
    const sub = [
      { kind: 'tool', id: 's1', name: 'Glob', label: 'Searched files', detail: '**/* in ~/Documents', parent: 'a1', sub: true },
      { kind: 'tool', id: 's2', name: 'PowerShell', label: 'Ran', detail: 'Get-ChildItem ~/Desktop | Sort LastWriteTime', parent: 'a2', sub: true },
      { kind: 'tool', id: 's3', name: 'Glob', label: 'Searched files', detail: '*.exe, *.msi in ~/Downloads', parent: 'a3', sub: true },
      { kind: 'tool_result', id: 's1', text: '1,284 files', parent: 'a1', sub: true },
      { kind: 'task', phase: 'progress', taskId: 't2', toolUseId: 'a2', description: 'Grouping 212 shortcuts and screenshots', usage: { tokens: 9100, toolUses: 2 } },
      { kind: 'tool_result', id: 's2', text: '212 items', parent: 'a2', sub: true },
      { kind: 'tool_result', id: 's3', text: '14 installers, 3.1 GB', parent: 'a3', sub: true },
      { kind: 'task', phase: 'progress', taskId: 't3', toolUseId: 'a3', description: 'Found 14 old installers (3.1 GB)', usage: { tokens: 11200, toolUses: 3 } },
    ];
    for (const s of sub) { item(s); await wait(380); }
    say(null);
    await wait(500);

    // Helpers finish one by one and walk home.
    const done = [
      { taskId: 't1', a: 'a1', summary: '**1,284 files, 6.2 GB.** Mostly PDFs and projects. 3 duplicate tax PDFs in `2024/`.', ms: 21000, tokens: 18400, tools: 4 },
      { taskId: 't2', a: 'a2', summary: '**212 items** on the Desktop: 140 screenshots could move to `Pictures/Screenshots`.', ms: 24500, tokens: 15200, tools: 3 },
      { taskId: 't3', a: 'a3', summary: '**14 installers older than 90 days** in Downloads, 3.1 GB. Safe to delete.', ms: 27800, tokens: 16900, tools: 5 },
    ];
    for (let k = 0; k < done.length; k++) {
      const d = done[k];
      item({ kind: 'task', phase: 'done', taskId: d.taskId, toolUseId: d.a, status: 'completed', summary: d.summary, usage: { tokens: d.tokens, toolUses: d.tools, durationMs: d.ms } });
      item({ kind: 'tool_result', id: d.a, text: 'done', agentStats: { durationMs: d.ms, tokens: d.tokens, toolUses: d.tools } });
      const left = CREW.slice(k + 1);
      mood('working', left);
      setCrewSlots(left.length);
      await wait(750);
    }
    await wait(500);
    item({ kind: 'text', text: 'All three folders audited. **3.1 GB of old installers** can go, and 140 screenshots could move to `Pictures/Screenshots`. Want me to do both?' });
    await wait(500);
    item({ kind: 'result', ok: true, durationMs: 41200, turns: 12 });
    await js('SB.renderTabStrip()'); // the real app gets this from the tab summary
    say('nailed it');
    mood('success');
    await wait(1500);
    say(null);

    // ---------------------------------------------------------------- 3. trophy
    mark('Finish tasks, earn outfits');
    wardrobe.record('task-completed'); // first task ever: "Hello, World" → confetti + party hat
    await wait(2600);
    await js("document.querySelector('.celebrate .cel-actions .btn.primary')?.click()");
    await wait(3000);

    recording = false;
    await recorder;
    fs.writeFileSync(path.join(dir, 'frames.json'), JSON.stringify({ fps: FPS, frames, marks }, null, 1));
    console.log(`reel: ${frames.length} frames over ${(frames.at(-1).t / 1000).toFixed(1)}s -> ${dir}`);
  } catch (e) {
    console.error('reel failed:', e);
  }
  app.exit(0);
}

module.exports = { run };
