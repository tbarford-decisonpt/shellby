// Moving a conversation between Shellby and a terminal (src/main/handoff.js):
// what goes on the command line, which folder, which session, and the tab
// manager refusing to send while a conversation is out in a terminal.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const handoff = require('../src/main/handoff');
const { terminalEnv, billingScrub, BILLING_ENV } = require('../src/main/claude/cli');
const { SessionManager, IN_TERMINAL } = require('../src/main/sessions');
const { History } = require('../src/main/history');
const { ExternalSessions, applyHookEvent, summarize } = require('../src/main/external');
const { parseArgs } = require('../src/cli/shellby');
const { wireHandoff } = require('../src/main/wiring/handoff');

const ID = '0b7c3f9e-2a41-4d6b-9f00-1c2d3e4f5a6b';
const EXE = 'C:\\Users\\me\\.local\\bin\\claude.exe';
const CWD = 'C:\\code\\my app';
const SYS = { wt: 'C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe', powershell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', cmd: 'C:\\Windows\\System32\\cmd.exe' };
const decode = b64 => Buffer.from(b64, 'base64').toString('utf16le');
// The start plans carry their whole line as one verbatim string, so go by words.
const scriptOf = plan => {
  const words = plan.args.join(' ').split(' ');
  return decode(words[words.indexOf('-EncodedCommand') + 1]);
};

// ---------------------------------------------------------------- ids and paths

test('only Claude Code UUIDs count as session ids', () => {
  assert.equal(handoff.isSessionId(ID), true);
  assert.equal(handoff.isSessionId(ID.toUpperCase()), true);
  for (const bad of ['', 'abc', `${ID} & calc`, `${ID}\n`, '../../x', null, 42, `"${ID}"`, '0b7c3f9e2a414d6b9f001c2d3e4f5a6b']) {
    assert.equal(handoff.isSessionId(bad), false, String(bad));
  }
});

test('psQuote doubles every kind of single quote PowerShell honours', () => {
  assert.equal(handoff.psQuote("C:\\it's"), "'C:\\it''s'");
  assert.equal(handoff.psQuote('C:\\it\u2019s'), "'C:\\it\u2019\u2019s'");
  assert.equal(handoff.psQuote('C:\\$(calc)'), "'C:\\$(calc)'", '$() is inert inside single quotes');
});

test('terminalCwd prefers a copy of the repo that is still there, then the folder', () => {
  const there = new Set(['C:\\wt\\copy\\src', 'C:\\code\\app']);
  const exists = p => there.has(p);
  assert.equal(handoff.terminalCwd({ cwd: 'C:\\code\\app', worktree: { cwd: 'C:\\wt\\copy\\src', path: 'C:\\wt\\copy' } }, exists), 'C:\\wt\\copy\\src');
  assert.equal(handoff.terminalCwd({ cwd: 'C:\\code\\app', worktree: { cwd: 'C:\\gone', path: 'C:\\gone' } }, exists), 'C:\\code\\app', 'a tidied-away copy falls back');
  assert.equal(handoff.terminalCwd({ cwd: 'C:\\nowhere' }, exists), null);
  assert.equal(handoff.terminalCwd({ cwd: 'relative\\dir' }), null, 'never a relative path');
  assert.equal(handoff.terminalCwd({ cwd: 'C:\\code\nrm' }), null, 'never a control character');
  assert.equal(handoff.terminalCwd({ cwd: '\\\\evil\\share\\app' }), null, 'never another machine');
  assert.equal(handoff.terminalCwd({ cwd: '\\\\?\\C:\\app' }), null, 'never a device path');
});

test('a hook naming a network share gets no folder kept, so it can never be brought in', () => {
  const m = applyHookEvent(new Map(), { hook_event_name: 'SessionStart', session_id: ID, cwd: '\\\\evil\\share\\app' }, 1).sessions;
  const [s] = summarize(m).sessions;
  assert.equal(s.cwd, null);
  assert.equal(handoff.bringInCheck({ ...s, live: false }).ok, false);
  assert.equal(handoff.bringInCheck({ ...s, cwd: '\\\\evil\\share', live: false }).ok, false, 'nor one handed in directly');
});

// ---------------------------------------------------------------- the command line

test('launchPlans: Windows Terminal first, then PowerShell, then cmd', () => {
  const r = handoff.launchPlans({ exe: EXE, cwd: CWD, sessionId: ID, ...SYS });
  assert.equal(r.ok, true);
  assert.deepEqual(r.plans.map(p => p.shell), ['wt', 'powershell', 'cmd']);
  const [wt, ps, cmd] = r.plans;
  assert.equal(wt.file, SYS.wt);
  assert.deepEqual(wt.args.slice(0, 5), ['-w', 'new', '-d', CWD, SYS.powershell]);
  // Through start: a detached console program spawned directly gets no window.
  assert.equal(ps.file, SYS.cmd);
  assert.equal(ps.args.length, 3);
  assert.ok(ps.args[2].startsWith(`start "" "${SYS.powershell}" -NoLogo -NoExit -EncodedCommand `), ps.args[2]);
  assert.equal(cmd.file, SYS.cmd);
  assert.deepEqual(cmd.args, ['/d', '/c', `start "" "${SYS.cmd}" /d /k "${EXE}" --resume ${ID}`]);
  for (const p of r.plans) {
    assert.equal(p.options.cwd, CWD);
    assert.equal(p.options.detached, true, 'outliving Shellby');
    assert.equal(p.options.windowsHide, false);
    assert.equal(p.options.windowsVerbatimArguments, p.shell === 'wt' ? undefined : true, 'the start line reaches cmd as written');
  }
});

test('the script resumes in the folder, with the CLI and id as literals', () => {
  const { plans } = handoff.launchPlans({ exe: EXE, cwd: CWD, sessionId: ID, ...SYS });
  const script = scriptOf(plans[1]);
  assert.equal(scriptOf(plans[0]), script, 'Windows Terminal runs the same script');
  assert.match(script, /Set-Location -LiteralPath 'C:\\code\\my app'/);
  assert.match(script, new RegExp(`& 'C:\\\\Users\\\\me\\\\\\.local\\\\bin\\\\claude\\.exe' --resume ${ID}$`));
  assert.match(script, /Remove-Item -LiteralPath 'Env:SHELLBY_OWNED'/, 'the terminal session is outside Shellby: the plugin reports it');
});

test('"Always use my Claude plan" drops the billing variables inside the window too', () => {
  const on = scriptOf(handoff.launchPlans({ exe: EXE, cwd: CWD, sessionId: ID, scrub: billingScrub(true), ...SYS }).plans[1]);
  for (const k of BILLING_ENV) assert.match(on, new RegExp(`'Env:${k}'`));
  const off = scriptOf(handoff.launchPlans({ exe: EXE, cwd: CWD, sessionId: ID, scrub: billingScrub(false), ...SYS }).plans[1]);
  assert.doesNotMatch(off, /ANTHROPIC_API_KEY/);
  const odd = handoff.resumeScript({ exe: EXE, cwd: CWD, sessionId: ID, scrub: ["X'; calc; '"] });
  assert.doesNotMatch(odd, /calc/, 'a variable name is never anything but a name');
});

test('a hostile folder name stays a folder name', () => {
  const cwd = "C:\\x'; Start-Process calc; '\u2019 & echo %PATH% ;wt";
  const r = handoff.launchPlans({ exe: EXE, cwd, sessionId: ID, ...SYS });
  assert.equal(r.ok, true);
  const wt = r.plans.find(p => p.shell === 'wt');
  assert.equal(wt.args.includes('-d'), false, 'a ; would start another Windows Terminal tab, so -d is left out');
  const script = scriptOf(wt);
  assert.match(script, /Set-Location -LiteralPath 'C:\\x''; Start-Process calc; ''\u2019\u2019 & echo %PATH% ;wt'/);
  for (const p of r.plans.filter(x => x.shell !== 'wt')) {
    assert.equal(p.args.join(' ').includes(cwd), false, `${p.shell} gets the folder as its working directory, never on its line`);
  }
});

test('cmd is skipped when the CLI path has cmd syntax in it', () => {
  const r = handoff.launchPlans({ exe: 'C:\\tools & more\\claude.exe', cwd: CWD, sessionId: ID, ...SYS });
  assert.deepEqual(r.plans.map(p => p.shell), ['wt', 'powershell']);
});

test('no Windows Terminal: PowerShell is first', () => {
  const r = handoff.launchPlans({ exe: EXE, cwd: CWD, sessionId: ID, ...SYS, wt: null });
  assert.deepEqual(r.plans.map(p => p.shell), ['powershell', 'cmd']);
});

test('launchPlans refuses a bad id, CLI or folder', () => {
  assert.equal(handoff.launchPlans({ exe: EXE, cwd: CWD, sessionId: `${ID};calc`, ...SYS }).ok, false);
  assert.equal(handoff.launchPlans({ exe: 'claude', cwd: CWD, sessionId: ID, ...SYS }).ok, false);
  assert.equal(handoff.launchPlans({ exe: EXE, cwd: 'C:\\a\u0000b', sessionId: ID, ...SYS }).ok, false);
  assert.equal(handoff.launchPlans({ exe: EXE, cwd: CWD, sessionId: ID }).ok, false, 'no terminal at all');
});

test('launch falls through to the next terminal when one will not start', async () => {
  const tried = [];
  const fake = (file) => {
    tried.push(file);
    const child = new EventEmitter();
    child.unref = () => { child.unrefd = true; };
    setImmediate(() => child.emit(file === SYS.wt ? 'error' : 'spawn', new Error('ENOENT')));
    return child;
  };
  const { plans } = handoff.launchPlans({ exe: EXE, cwd: CWD, sessionId: ID, ...SYS });
  assert.deepEqual(await handoff.launch(plans, fake), { ok: true, shell: 'powershell' });
  assert.deepEqual(tried, [SYS.wt, SYS.cmd]);
  const none = await handoff.launch(plans, () => { throw new Error('nope'); });
  assert.equal(none.ok, false);
});

test('terminalEnv scrubs like Shellby but leaves the plugin free to report', () => {
  const env = terminalEnv({ PATH: 'x', ANTHROPIC_API_KEY: 'k', SHELLBY_OWNED: '1' }, { onlyPlan: true });
  assert.equal(env.SHELLBY_OWNED, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(terminalEnv({ ANTHROPIC_API_KEY: 'k' }, { onlyPlan: false }).ANTHROPIC_API_KEY, 'k', 'how it signs in is your call');
  assert.deepEqual(billingScrub(false), []);
});

// ---------------------------------------------------------------- when it may go

test('continueCheck: not mid-turn, not before the first message, not just rewound', () => {
  assert.deepEqual(handoff.continueCheck({ sessionId: ID }), { ok: true });
  assert.match(handoff.continueCheck({ sessionId: ID, busy: true }).error, /still working/);
  assert.match(handoff.continueCheck({ sessionId: ID, pending: 1 }).error, /still working/);
  assert.match(handoff.continueCheck({ sessionId: ID, crew: 2 }).error, /still working/);
  assert.match(handoff.continueCheck({}).error, /send this conversation something first/);
  assert.match(handoff.continueCheck({ sessionId: ID, resumeAt: 'abc' }).error, /rewound/);
  assert.equal(handoff.continueCheck({ sessionId: 'not-a-uuid' }).ok, false);
});

// ---------------------------------------------------------------- the other way

const row = over => ({ id: ID, cwd: 'C:\\code\\app', project: 'app', state: 'idle', client: 'Windows Terminal', lastAt: 1, ...over });

test('bringInCheck asks first while the terminal is open, and refuses mid-turn', () => {
  const open = handoff.bringInCheck(row({ live: true }));
  assert.equal(open.ok, false);
  assert.equal(open.confirm, true);
  assert.match(open.error, /still open in Windows Terminal, in C:\\code\\app\. Type \/exit there first/);
  assert.deepEqual(handoff.bringInCheck(row({ live: true }), { force: true }), { ok: true });
  assert.deepEqual(handoff.bringInCheck(row({ live: false })), { ok: true }, 'closed: nothing to ask');
  const busy = handoff.bringInCheck(row({ live: true, state: 'working' }), { force: true });
  assert.equal(busy.ok, false);
  assert.equal(busy.confirm, undefined, 'no "bring it in anyway" mid-turn');
  assert.match(handoff.bringInCheck(row({ live: true, state: 'working' }), { fromInside: true }).warning, /Type \/exit in Windows Terminal/);
  assert.equal(handoff.bringInCheck(null).ok, false);
  assert.equal(handoff.bringInCheck(row({ id: 'abc' })).ok, false);
  assert.equal(handoff.bringInCheck(row({ cwd: null })).ok, false);
});

test('externalFor: by id, else this folder, else the folder above', () => {
  const other = '1b7c3f9e-2a41-4d6b-9f00-1c2d3e4f5a6b';
  const third = '2b7c3f9e-2a41-4d6b-9f00-1c2d3e4f5a6b';
  const sessions = [
    row({ id: ID, cwd: 'C:\\code\\app', lastAt: 5 }),
    row({ id: other, cwd: 'c:/code/app/', lastAt: 9 }),
    row({ id: third, cwd: 'C:\\code', lastAt: 99 }),
    row({ id: 'junk', cwd: 'C:\\code\\app', lastAt: 100 }),
  ];
  assert.equal(handoff.externalFor(sessions, { id: ID }).id, ID);
  assert.equal(handoff.externalFor(sessions, { cwd: 'C:\\Code\\App' }).id, other, 'the newest in this folder, however it was spelled');
  assert.equal(handoff.externalFor(sessions, { cwd: 'C:\\code\\lib' }).id, third, 'started a level up');
  assert.equal(handoff.externalFor(sessions, { cwd: 'D:\\elsewhere' }), null);
  assert.equal(handoff.externalFor(sessions, { cwd: 'C:\\codex' }), null, 'a prefix is not a parent');
  assert.equal(handoff.externalFor(sessions, { id: 'junk' }), null);
});

test('entryFor maps a session back to the conversation that sent it out', () => {
  const entries = [
    { id: 'a', claudeSessionId: ID, updatedAt: 1 },
    { id: 'b', claudeSessionId: ID, updatedAt: 3 },
    { id: 'c', claudeSessionId: null, updatedAt: 9 },
  ];
  assert.equal(handoff.entryFor(entries, ID).id, 'b');
  assert.equal(handoff.entryFor(entries, '1b7c3f9e-2a41-4d6b-9f00-1c2d3e4f5a6b'), null);
  assert.equal(handoff.entryFor(entries, null), null);
  assert.equal(handoff.titleFor(row()), 'app, from Windows Terminal');
  assert.equal(handoff.titleFor({ project: 'app' }), 'app, from a terminal');
});

// ---------------------------------------------------------------- external.js keeps what bringing in needs

test('external sessions keep their id and the folder they started in', () => {
  let m = new Map();
  m = applyHookEvent(m, { hook_event_name: 'SessionStart', session_id: ID, cwd: 'C:\\code\\app' }, 1).sessions;
  m = applyHookEvent(m, { hook_event_name: 'PreToolUse', session_id: ID, cwd: 'C:\\code\\app\\src', tool_name: 'Bash' }, 2).sessions;
  const [s] = summarize(m).sessions;
  assert.equal(s.id, ID);
  assert.equal(s.cwd, 'C:\\code\\app', 'where Claude Code filed the conversation, not where it wandered to');
  let late = new Map();
  late = applyHookEvent(late, { hook_event_name: 'Stop', session_id: ID, cwd: 'C:\\code\\b' }, 1).sessions;
  assert.equal(summarize(late).sessions[0].cwd, 'C:\\code\\b', 'heard mid-session: the first folder it named');
});

test('a session that just ended can still be brought in, and says it is closed', () => {
  const ext = new ExternalSessions({ port: 0, now: () => 1000 });
  ext.ingest({ hook_event_name: 'SessionStart', session_id: ID, cwd: 'C:\\code\\app' }, { 'x-shellby-host': 'wt' });
  assert.equal(ext.known(ID).live, true);
  assert.equal(ext.known(ID).client, 'Windows Terminal');
  ext.ingest({ hook_event_name: 'SessionEnd', session_id: ID, cwd: 'C:\\code\\app' });
  assert.equal(ext.summary.sessions.length, 0);
  const gone = ext.known(ID);
  assert.equal(gone.live, false);
  assert.equal(gone.cwd, 'C:\\code\\app');
  assert.equal(ext.known('1b7c3f9e-2a41-4d6b-9f00-1c2d3e4f5a6b'), null);
});

// ---------------------------------------------------------------- the tab manager

test('a tab carried on in a terminal refuses to send until it is picked up, across a restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-handoff-'));
  const history = new History(dir);
  const opts = { getExe: () => process.execPath, argsPrefix: [path.join(__dirname, 'fixtures', 'fake-claude.js')], history, getMode: () => 'ask', getModel: () => '' };
  history.create({ id: 'tab-t', title: 'Fix it', cwd: os.tmpdir(), mode: 'ask' });
  history.update('tab-t', { claudeSessionId: ID });
  const mgr = new SessionManager(opts);
  try {
    mgr.open({ tabId: 'tab-t', historyEntry: history.get('tab-t') });
    assert.equal(mgr.setInTerminal('tab-t', 1234), true);
    assert.equal(mgr.summary[0].inTerminal, 1234);
    assert.throws(() => mgr.send('tab-t', 'hi', { kind: 'user', text: 'hi' }), { message: IN_TERMINAL });
    assert.equal(history.get('tab-t').inTerminal, 1234, 'kept in History');
    mgr.close('tab-t');

    const again = new SessionManager(opts);
    again.open({ tabId: 'tab-t', historyEntry: history.get('tab-t') });
    assert.equal(again.tabs.get('tab-t').inTerminal, 1234, 'still out there after a restart');
    again.setInTerminal('tab-t', null);
    assert.equal(again.tabs.get('tab-t').inTerminal, null);
    assert.equal(history.get('tab-t').inTerminal, null);
    again.closeAll({ kill: true });
  } finally {
    mgr.closeAll({ kill: true });
  }
});

test('History keeps the handoff notes for replay', () => {
  const history = new History(fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-handoff-')));
  history.create({ id: 'h1', title: 't', cwd: os.tmpdir(), mode: 'ask' });
  history.append('h1', { kind: 'handoff', to: 'terminal', shell: 'wt' });
  assert.equal(history.load('h1')[0].shell, 'wt');
});

// ---------------------------------------------------------------- shellby take

test('shellby take: this folder, or one session id and nothing else', () => {
  assert.deepEqual(parseArgs(['take']), { cmd: 'take' });
  assert.deepEqual(parseArgs(['take', ID]), { cmd: 'take', id: ID });
  assert.match(parseArgs(['take', 'abc']).error, /isn't a Claude Code session id/);
  assert.match(parseArgs(['take', ID, ID]).error, /at most a session id/);
});

// ---------------------------------------------------------------- the wiring, without opening anything

function rig() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-handoff-'));
  const project = path.join(root, 'app');
  const configDir = path.join(root, 'claude');
  fs.mkdirSync(project);
  const history = new History(path.join(root, 'sessions'));
  const sent = [];
  const tabs = new Map();
  const ext = new ExternalSessions({ port: 0, now: () => 1000 });
  const d = {
    claudeStatus: { installed: true, loggedIn: true, exe: EXE },
    claudePath: () => null,
    claudeConfigDir: () => configDir,
    config: { get: k => ({ mode: 'ask', crabOnly: false })[k] },
    history,
    manager: {
      tabs,
      note: (id, item) => history.append(id, item),
      setInTerminal: (id, at) => { tabs.get(id).inTerminal = at; },
    },
    openTab: ({ tabId, historyEntry }) => { const t = { id: tabId, historyEntry, inTerminal: historyEntry.inTerminal || null }; tabs.set(tabId, t); return t; },
    external: ext,
    send: (_w, channel, payload) => sent.push({ channel, payload }),
    showPanel: () => {}, wake: () => {}, log: { info: () => {} },
    randomUUID: () => 'tab-new', panel: null,
  };
  // Claude Code filed this conversation under another folder (say it started a level up).
  const filed = path.join(configDir, 'projects', 'elsewhere');
  fs.mkdirSync(filed, { recursive: true });
  fs.writeFileSync(path.join(filed, `${ID}.jsonl`), '{}\n');
  return { d, project, configDir, history, sent, tabs, ext };
}

test('Bring it into Shellby: asks while open, then opens a tab where --resume will find it', () => {
  const { d, project, configDir, history, sent, tabs, ext } = rig();
  const h = wireHandoff(d);
  ext.ingest({ hook_event_name: 'SessionStart', session_id: ID, cwd: project }, { 'x-shellby-host': 'wt' });

  const ask = h.bringIn({ id: ID });
  assert.equal(ask.confirm, true);
  assert.equal(tabs.size, 0, 'nothing opened yet');

  const r = h.bringIn({ id: ID, force: true });
  assert.deepEqual(r, { ok: true, tabId: 'tab-new' });
  const entry = history.get('tab-new');
  assert.equal(entry.claudeSessionId, ID);
  assert.equal(entry.cwd, project);
  assert.equal(entry.title, 'app, from Windows Terminal');
  const dirName = path.resolve(project).replace(/[^a-zA-Z0-9]/g, '-');
  assert.ok(fs.existsSync(path.join(configDir, 'projects', dirName, `${ID}.jsonl`)), 'the transcript is where Claude Code will look');
  assert.equal(history.load('tab-new')[0].kind, 'handoff');
  assert.equal(sent.find(s => s.channel === 'tab:opened').payload.busy, false);

  assert.equal(h.bringIn({ id: 'nope' }).ok, false);
});

test('a conversation sent to a terminal comes back to its own tab, not a new one', () => {
  const { d, project, history, tabs, ext } = rig();
  const h = wireHandoff(d);
  history.create({ id: 'mine', title: 'Fix it', cwd: project, mode: 'ask' });
  history.update('mine', { claudeSessionId: ID, inTerminal: 5 });
  d.openTab({ tabId: 'mine', historyEntry: history.get('mine') });
  ext.ingest({ hook_event_name: 'SessionStart', session_id: ID, cwd: project });
  ext.ingest({ hook_event_name: 'SessionEnd', session_id: ID, cwd: project });

  assert.deepEqual(h.bringIn({ id: ID }), { ok: true, tabId: 'mine' }, 'closed there: no question');
  assert.equal(tabs.size, 1);
  assert.equal(tabs.get('mine').inTerminal, null, 'picked back up');
});

test('shellby take finds the session in its folder and says to /exit', () => {
  const { d, project, tabs, ext } = rig();
  const h = wireHandoff(d);
  assert.equal(h.take({ action: 'take', args: { cwd: project } }).status, 404, 'no session there yet');
  ext.ingest({ hook_event_name: 'UserPromptSubmit', session_id: ID, cwd: project }, { 'x-shellby-host': 'wt' });
  const r = h.take({ action: 'take', args: { cwd: project } });
  assert.match(r.text, /^It's open in Shellby\. Type \/exit in Windows Terminal/);
  assert.equal(tabs.size, 1);
  assert.equal(h.take({ action: 'take', args: { cwd: project, id: 'x' } }).status, 400);
  assert.equal(h.take({ action: 'take', args: { cwd: path.join(project, 'missing') } }).status, 400);
});

test('Continue in terminal refuses mid-turn and before the first message, without opening anything', async () => {
  const { d, project, history, tabs } = rig();
  const h = wireHandoff(d);
  const session = { sessionId: ID, busy: true, pending: new Map(), runningCrew: () => [], cwd: project, stop: async () => { throw new Error('must not stop a working tab'); } };
  tabs.set('busy', { id: 'busy', session });
  assert.match((await h.continueInTerminal('busy')).error, /still working/);
  history.create({ id: 'blank', title: 't', cwd: project, mode: 'ask' });
  assert.match((await h.continueInTerminal('blank')).error, /send this conversation something first/);
  assert.equal((await h.continueInTerminal('gone')).ok, false);
});

test('launchPlans can start a fresh session on the ultra review, and on nothing else', () => {
  const r = handoff.launchPlans({ exe: EXE, cwd: CWD, prompt: handoff.TERMINAL_PROMPTS.ultraReview, ...SYS });
  assert.equal(r.ok, true);
  const script = scriptOf(r.plans.find(p => p.shell === 'powershell'));
  assert.ok(script.includes(`& '${EXE}' '/code-review ultra'`), 'a literal, never expanded');
  assert.ok(!script.includes('--resume'));
  const line = r.plans.find(p => p.shell === 'cmd').args.at(-1);
  assert.ok(line.endsWith(`/k "${EXE}" "/code-review ultra"`), line);
  assert.ok(!line.includes('--resume'));
  for (const p of Object.values(handoff.TERMINAL_PROMPTS)) assert.ok(!/["%^&|<>!]/.test(p), 'nothing cmd reads as its own');
  for (const prompt of ['/code-review ultra; calc', 'rm -rf /', '', 42]) {
    assert.equal(handoff.launchPlans({ exe: EXE, cwd: CWD, prompt, ...SYS }).ok, false, String(prompt));
  }
  // No prompt: still a resume, and still only of a real session id.
  assert.equal(handoff.launchPlans({ exe: EXE, cwd: CWD, ...SYS }).ok, false);
});
