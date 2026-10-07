// The Projects page from a terminal, as the service answers it
// (src/main/projects/service.js: addTodo, finishTodo, resolve, forTerminal).
// Nothing here runs git: list() and detail() are stubbed with plain projects,
// and the git runner resolve() falls back on is a fake.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { Projects, normalize } = require('../src/main/projects/service');

const NOW = Date.parse('2026-10-04T12:00:00');
const ROOT = path.resolve('C:\\code\\site');
const WEB = path.resolve('C:\\code\\web');
const COPY = path.resolve('C:\\Users\\me\\AppData\\Roaming\\Shellby\\worktrees\\ab12cd\\site');
const SITE_KEY = 'github:me/site';
const WEB_KEY = 'github:me/web';

const project = (key, name, root, extra = {}) => ({
  key, name, github: { repo: `me/${name}` }, local: [{ root, branch: 'main', main: true, servers: [] }], insights: {}, sessions: [], ...extra,
});

/** A config like Shellby's: get(key), set(patch), over a plain object. Remembers every set. */
function fakeConfig(initial = {}) {
  const data = { ...initial };
  const sets = [];
  return { data, sets, get: k => data[k], set: patch => { sets.push(patch); Object.assign(data, patch); } };
}

function fakeDevServers(logs = {}) {
  return { view: () => ({ servers: [], settings: {} }), forRoot: () => [], lastScript: () => null, log: id => logs[id] };
}

/** A service over fake deps whose list() answers `projects` and whose detail() finds them in it. */
function service({ projects = [], saved, logs, run, extra = {} } = {}) {
  const config = fakeConfig(saved ? { projects: saved } : {});
  const svc = new Projects({
    config, devServers: fakeDevServers(logs), known: () => [], lastWorked: () => new Map(),
    github: () => ({ signedIn: false, can: () => false }), now: () => NOW, run, ...extra,
  });
  svc.list = async () => ({ projects });
  svc.detail = async key => {
    const found = projects.find(p => p.key === key);
    return found ? { ...found, todo: svc.state.todo[key] || [] } : null;
  };
  svc.keys = new Set(projects.map(p => p.key));
  return { svc, config };
}

const site = project(SITE_KEY, 'site', ROOT);
const web = project(WEB_KEY, 'web', WEB);

// ------------------------------------------------------------------ the to-do list

test('the saved to-do lists are read back, and checked, when the service starts', () => {
  const saved = { added: [], hidden: [], todo: { [SITE_KEY]: [{ id: 't-abcd1234', text: ' keep  me ' }, { id: 'bad', text: 'drop me' }], nonsense: [{ id: 't-abcd1235', text: 'x' }] } };
  const { svc } = service({ projects: [site], saved });
  assert.deepEqual(Object.keys(svc.state.todo), [SITE_KEY]);
  assert.equal(svc.state.todo[SITE_KEY].length, 1);
  assert.equal(svc.state.todo[SITE_KEY][0].text, 'keep me');
  assert.deepEqual(normalize(undefined).todo, {});
});

test('addTodo saves the item to config and says the page changed', () => {
  const { svc, config } = service({ projects: [site] });
  let changes = 0;
  svc.on('change', () => { changes++; });
  const r = svc.addTodo(SITE_KEY, 'Write the release notes', 'claude');
  assert.equal(r.ok, true);
  assert.equal(r.existed, false);
  assert.equal(r.count, 1);
  assert.equal(r.item.text, 'Write the release notes');
  assert.equal(r.item.from, 'claude');
  assert.equal(r.item.at, NOW);
  assert.equal(changes, 1);
  assert.equal(config.sets.length, 1);
  assert.deepEqual(config.data.projects.todo[SITE_KEY], [r.item]);
  assert.deepEqual(svc.state.todo[SITE_KEY], [r.item]);
});

test('addTodo defaults to a to-do from you, and counts the list', () => {
  const { svc } = service({ projects: [site] });
  assert.equal(svc.addTodo(SITE_KEY, 'one').item.from, 'you');
  const second = svc.addTodo(SITE_KEY, 'two');
  assert.equal(second.count, 2);
});

test('adding the same to-do again changes nothing and says it existed', () => {
  const { svc, config } = service({ projects: [site] });
  const first = svc.addTodo(SITE_KEY, 'Cut a tag');
  let changes = 0;
  svc.on('change', () => { changes++; });
  const again = svc.addTodo(SITE_KEY, 'cut A TAG');
  assert.equal(again.ok, true);
  assert.equal(again.existed, true);
  assert.equal(again.item.id, first.item.id);
  assert.equal(again.count, 1);
  assert.equal(changes, 0);
  assert.equal(config.sets.length, 1);
});

test('addTodo refuses a project that is not on the page, and saves nothing', () => {
  const { svc, config } = service({ projects: [site] });
  let changes = 0;
  svc.on('change', () => { changes++; });
  for (const key of ['github:me/unlisted', '__proto__', '', undefined]) {
    const r = svc.addTodo(key, 'sneak in');
    assert.equal(r.ok, false, String(key));
    assert.match(r.error, /isn't on the Projects page/);
  }
  assert.equal(changes, 0);
  assert.deepEqual(config.sets, []);
});

test('addTodo passes todo.js its refusals on: an empty to-do, a full list', () => {
  const { svc, config } = service({ projects: [site] });
  assert.match(svc.addTodo(SITE_KEY, '  \n ').error, /empty/);
  assert.deepEqual(config.sets, []);
  for (let i = 0; i < 30; i++) assert.equal(svc.addTodo(SITE_KEY, `job ${i}`).ok, true);
  const full = svc.addTodo(SITE_KEY, 'one more');
  assert.equal(full.ok, false);
  assert.match(full.error, /30 to-dos/);
  assert.equal(config.sets.length, 30);
});

test('finishTodo removes the item, saves, and counts what is left', () => {
  const { svc, config } = service({ projects: [site] });
  svc.addTodo(SITE_KEY, 'a');
  svc.addTodo(SITE_KEY, 'b');
  let changes = 0;
  svc.on('change', () => { changes++; });
  const r = svc.finishTodo(SITE_KEY, 1);
  assert.equal(r.ok, true);
  assert.equal(r.item.text, 'a');
  assert.equal(r.left, 1);
  assert.equal(changes, 1);
  assert.deepEqual(config.data.projects.todo[SITE_KEY].map(x => x.text), ['b']);
  const last = svc.finishTodo(SITE_KEY, svc.state.todo[SITE_KEY][0].id);
  assert.equal(last.left, 0);
  assert.equal(Object.hasOwn(config.data.projects.todo, SITE_KEY), false);
});

test('finishTodo with a bad number saves nothing', () => {
  const { svc, config } = service({ projects: [site] });
  assert.match(svc.finishTodo(SITE_KEY, 1).error, /nothing on its to-do list/);
  svc.addTodo(SITE_KEY, 'a');
  const sets = config.sets.length;
  const r = svc.finishTodo(SITE_KEY, 5);
  assert.equal(r.ok, false);
  assert.match(r.error, /no to-do number 5/);
  assert.equal(config.sets.length, sets);
});

test('saving a to-do keeps the rest of the projects settings', () => {
  const saved = { added: [ROOT], hidden: ['github:me/old'], lastCloneParent: path.resolve('C:\\code'), todo: {} };
  const { svc, config } = service({ projects: [site], saved });
  svc.addTodo(SITE_KEY, 'x');
  assert.deepEqual(config.data.projects.added, [ROOT]);
  assert.deepEqual(config.data.projects.hidden, ['github:me/old']);
  assert.equal(config.data.projects.lastCloneParent, path.resolve('C:\\code'));
});

// ------------------------------------------------------------------ resolve

test('resolve finds a project by name, or by the folder the question came from', async () => {
  const { svc } = service({ projects: [site, web] });
  assert.equal((await svc.resolve({ project: 'web' })).project, web);
  assert.equal((await svc.resolve({ cwd: path.join(ROOT, 'src') })).project, site);
  assert.equal((await svc.resolve({ project: 'web', cwd: ROOT })).project, web);
  assert.match((await svc.resolve({ project: 'nope' })).error, /No project called "nope"/);
});

test('resolve from a folder in no project is an error, and git is asked about it once', async () => {
  const calls = [];
  const { svc } = service({ projects: [site], run: async args => { calls.push(args); return null; } });
  const nowhere = path.resolve('C:\\temp\\scratch');
  const r = await svc.resolve({ cwd: nowhere });
  assert.match(r.error, /isn't in any project on Shellby's Projects page/);
  assert.ok(r.error.includes(nowhere));
  assert.deepEqual(calls, [['-C', nowhere, 'rev-parse', '--show-toplevel']]);
  assert.match((await svc.resolve({})).error, /couldn't tell which project/);
});

test('resolve finds a folder in one of Shellby\'s copies through its main checkout', async () => {
  const run = async args => {
    if (args.join(' ') === `-C ${COPY} rev-parse --show-toplevel`) return `${COPY}\n`;
    if (args.join(' ') === `-C ${COPY} rev-parse --git-common-dir`) return `${path.join(ROOT, '.git')}\n`;
    return null;
  };
  const { svc } = service({ projects: [site, web], run });
  const r = await svc.resolve({ cwd: COPY });
  assert.equal(r.project, site);
});

test('resolve through git still finds nothing when the repository is not a listed project', async () => {
  const other = path.resolve('C:\\elsewhere\\repo');
  const run = async args => (args.includes('--show-toplevel') ? other : path.join(other, '.git'));
  const { svc } = service({ projects: [site], run });
  assert.match((await svc.resolve({ cwd: path.join(other, 'src') })).error, /isn't in any project/);
});

test('resolve survives git failing', async () => {
  const { svc } = service({ projects: [site], run: async () => { throw new Error('git is gone'); } });
  assert.match((await svc.resolve({ cwd: path.resolve('C:\\temp') })).error, /isn't in any project/);
});

test('resolve does not ask git about a share', async () => {
  const calls = [];
  const { svc } = service({ projects: [site], run: async a => { calls.push(a); return null; } });
  await svc.resolve({ cwd: '\\\\server\\share\\repo' });
  assert.deepEqual(calls, []);
});

// ------------------------------------------------------------------ forTerminal

test('forTerminal projects lists them with their to-do counts, worded for the caller', async () => {
  const { svc } = service({ projects: [site, web] });
  svc.addTodo(WEB_KEY, 'a');
  svc.addTodo(WEB_KEY, 'b');
  const mcp = await svc.forTerminal({ action: 'projects', via: 'mcp' });
  assert.match(mcp.text, /^2 projects on Shellby's Projects page/);
  assert.match(mcp.text, /- web \(me\/web\): .* · 2 to-dos/);
  assert.doesNotMatch(mcp.text, /- site .*to-do/);
  assert.match(mcp.text, /Ask next_up about one/);
  assert.match((await svc.forTerminal({ action: 'projects', via: 'cli' })).text, /shellby next <name>$/);
  assert.match((await svc.forTerminal({ action: 'projects' })).text, /Ask next_up/);
});

test('forTerminal next_up for the folder it came from', async () => {
  const { svc } = service({ projects: [site, web] });
  svc.addTodo(SITE_KEY, 'Write the changelog', 'claude');
  const r = await svc.forTerminal({ action: 'next_up', cwd: path.join(ROOT, 'src'), via: 'mcp' });
  assert.match(r.text, /^Next up in site \(me\/site\):/);
  assert.match(r.text, /1\. \[to-do 1, id t-[a-z0-9]{8}\] Write the changelog \(added by Claude Code\)/);
  assert.match(r.text, /finish_task ticks off/);
});

test('forTerminal next_up for a named project, and from the CLI', async () => {
  const { svc } = service({ projects: [site, web] });
  const r = await svc.forTerminal({ action: 'next_up', project: 'web', cwd: ROOT, via: 'cli' });
  assert.match(r.text, /^Nothing to do in web \(me\/web\)/);
});

test('forTerminal next_up uses the project it was given when detail has nothing', async () => {
  const { svc } = service({ projects: [site] });
  svc.detail = async () => null;
  assert.match((await svc.forTerminal({ action: 'next_up', project: 'site' })).text, /^Nothing to do in site/);
});

test('forTerminal next_up everywhere puts the project with a crash first', async () => {
  const crashed = project(WEB_KEY, 'web', WEB, { local: [{ root: WEB, servers: [{ id: 's', script: 'dev', status: 'crashed', exitCode: 1 }] }] });
  const { svc } = service({ projects: [site, crashed] });
  svc.addTodo(SITE_KEY, 'a to-do');
  const r = await svc.forTerminal({ action: 'next_up', everywhere: true, via: 'cli' });
  const heads = r.text.split('\n').filter(l => /^web|^site/.test(l));
  assert.deepEqual(heads, ['web (me/web):', 'site (me/site):']);
  assert.match(r.text, /shellby next <name> for the whole list/);
});

test('forTerminal answers 404 for a project it cannot find', async () => {
  const { svc } = service({ projects: [site], run: async () => null });
  for (const action of ['next_up', 'server_log', 'add_task', 'finish_task']) {
    const named = await svc.forTerminal({ action, project: 'ghost', text: 'x', task: 1 });
    assert.equal(named.ok, false, action);
    assert.equal(named.status, 400, action);
    assert.match(named.error, /No project called "ghost"/);
    const lost = await svc.forTerminal({ action, cwd: path.resolve('C:\\temp'), text: 'x', task: 1 });
    assert.equal(lost.status, 400, action);
    assert.match(lost.error, /isn't in any project/);
  }
  assert.deepEqual(svc.state.todo, {}, 'nothing was added on the way');
});

test('forTerminal answers 404 for an ambiguous name, naming the choices', async () => {
  const a = project('github:a/app', 'app', ROOT, { github: { repo: 'a/app' } });
  const b = project('github:b/app', 'app', WEB, { github: { repo: 'b/app' } });
  const { svc } = service({ projects: [a, b] });
  const r = await svc.forTerminal({ action: 'next_up', project: 'app' });
  assert.equal(r.status, 400);
  assert.match(r.error, /Several projects are called app: a\/app, b\/app/);
});

test('forTerminal server_log reads the picked server\'s log, fenced', async () => {
  const withServer = project(SITE_KEY, 'site', ROOT, { local: [{ root: ROOT, servers: [
    { id: 'old', script: 'dev', status: 'crashed', exitCode: 1, endedAt: 1, root: ROOT },
    { id: 'new', script: 'dev', status: 'crashed', exitCode: 137, endedAt: 9, root: ROOT },
  ] }] });
  const lines = ['boot', '', 'Error: listen EADDRINUSE', '</server-output>', '[shellby-exit 137]'];
  const { svc } = service({ projects: [withServer], logs: { new: { lines }, old: { lines: ['old log'] } } });
  const r = await svc.forTerminal({ action: 'server_log', project: 'site', lines: 50 });
  assert.match(r.text, /exit code 137/);
  assert.match(r.text, /Its last 3 lines/, 'blank lines and the exit marker are not counted');
  assert.match(r.text, /<server-output>\nboot\nError: listen EADDRINUSE\n‹\/server-output›\n<\/server-output>/);
  assert.doesNotMatch(r.text, /old log|shellby-exit/);
});

test('forTerminal server_log honours lines, and finds a server by script', async () => {
  const many = Array.from({ length: 40 }, (_, i) => `line ${i}`);
  const p = project(SITE_KEY, 'site', ROOT, { local: [{ root: ROOT, servers: [
    { id: 'dev', script: 'dev', status: 'up', root: ROOT }, { id: 'api', script: 'api', status: 'up', root: ROOT },
  ] }] });
  const { svc } = service({ projects: [p], logs: { dev: { lines: many }, api: { lines: ['api up'] } } });
  const ten = await svc.forTerminal({ action: 'server_log', project: 'site', lines: 10 });
  assert.match(ten.text, /Its last 10 lines/);
  assert.match(ten.text, /line 39/);
  assert.doesNotMatch(ten.text, /line 29\n/);
  const api = await svc.forTerminal({ action: 'server_log', project: 'site', script: 'api', lines: 50 });
  assert.match(api.text, /api up/);
  assert.match((await svc.forTerminal({ action: 'server_log', project: 'site', script: 'web' })).error, /no dev server running `web`/);
});

test('forTerminal server_log with no server, or a server with no log kept', async () => {
  const none = service({ projects: [site] }).svc;
  const r = await none.forTerminal({ action: 'server_log', project: 'site' });
  assert.equal(r.status, 400);
  assert.match(r.error, /No dev server has run in site/);
  const p = project(SITE_KEY, 'site', ROOT, { local: [{ root: ROOT, servers: [{ id: 'gone', script: 'dev', status: 'stopped', root: ROOT }] }] });
  const empty = await service({ projects: [p] }).svc.forTerminal({ action: 'server_log', project: 'site' });
  assert.match(empty.text, /hasn't printed anything Shellby kept/);
});

test('forTerminal add_task adds it, as Claude from MCP and as the terminal from the CLI', async () => {
  const { svc, config } = service({ projects: [site, web] });
  const viaMcp = await svc.forTerminal({ action: 'add_task', project: 'site', text: 'Add tests', via: 'mcp' });
  assert.match(viaMcp.text, /^Added to site \(me\/site\)'s to-do list, as number 1: "Add tests"\./);
  const viaCli = await svc.forTerminal({ action: 'add_task', cwd: ROOT, text: 'Update the docs', via: 'cli' });
  assert.match(viaCli.text, /as number 2: "Update the docs"/);
  assert.deepEqual(config.data.projects.todo[SITE_KEY].map(x => x.from), ['claude', 'terminal']);
  const repeat = await svc.forTerminal({ action: 'add_task', project: 'site', text: 'add TESTS', via: 'mcp' });
  assert.equal(repeat.text, "That's already on site (me/site)'s to-do list.");
  assert.equal(svc.state.todo[SITE_KEY].length, 2);
  assert.equal(Object.hasOwn(svc.state.todo, WEB_KEY), false);
});

test('forTerminal add_task answers 400 when the to-do is refused', async () => {
  const { svc } = service({ projects: [site] });
  const empty = await svc.forTerminal({ action: 'add_task', project: 'site', text: '   ' });
  assert.equal(empty.ok, false);
  assert.equal(empty.status, 400);
  assert.match(empty.error, /empty/);
  for (let i = 0; i < 30; i++) await svc.forTerminal({ action: 'add_task', project: 'site', text: `job ${i}` });
  const full = await svc.forTerminal({ action: 'add_task', project: 'site', text: 'too many' });
  assert.equal(full.status, 400);
  assert.match(full.error, /30 to-dos/);
});

test('forTerminal add_task for a project the page was never listed with is a 400, not a save', async () => {
  const { svc, config } = service({ projects: [site] });
  svc.keys = new Set();
  const r = await svc.forTerminal({ action: 'add_task', project: 'site', text: 'x' });
  assert.equal(r.status, 400);
  assert.match(r.error, /isn't on the Projects page/);
  assert.deepEqual(config.sets, []);
});

test('forTerminal finish_task ticks off by number or id, then says the list is empty', async () => {
  const { svc } = service({ projects: [site] });
  await svc.forTerminal({ action: 'add_task', project: 'site', text: 'first' });
  await svc.forTerminal({ action: 'add_task', project: 'site', text: 'second' });
  const id = svc.state.todo[SITE_KEY][1].id;
  const one = await svc.forTerminal({ action: 'finish_task', project: 'site', task: 1 });
  assert.equal(one.text, 'Ticked off in site (me/site): "first". 1 to-do left.');
  const two = await svc.forTerminal({ action: 'finish_task', cwd: ROOT, task: id });
  assert.equal(two.text, 'Ticked off in site (me/site): "second". Its to-do list is empty.');
});

test('forTerminal finish_task answers 400 for a number that is not there', async () => {
  const { svc } = service({ projects: [site] });
  const empty = await svc.forTerminal({ action: 'finish_task', project: 'site', task: 1 });
  assert.equal(empty.status, 400);
  assert.match(empty.error, /nothing on its to-do list/);
  await svc.forTerminal({ action: 'add_task', project: 'site', text: 'only' });
  const past = await svc.forTerminal({ action: 'finish_task', project: 'site', task: 2 });
  assert.equal(past.status, 400);
  assert.match(past.error, /no to-do number 2/);
  assert.equal(svc.state.todo[SITE_KEY].length, 1);
});

test('forTerminal refuses an action it does not know', async () => {
  const { svc } = service({ projects: [site] });
  const r = await svc.forTerminal({ action: 'delete_everything', project: 'site' });
  assert.deepEqual(r, { ok: false, error: 'Unknown question.', status: 400 });
});

// ------------------------------------------------------------------ after review

test('resolve finds a copy named by its folder (shellby next .), not only one asked from', async () => {
  const run = async args => {
    if (args.join(' ') === `-C ${COPY} rev-parse --show-toplevel`) return `${COPY}\n`;
    if (args.join(' ') === `-C ${COPY} rev-parse --git-common-dir`) return `${path.join(ROOT, '.git')}\n`;
    return null;
  };
  const { svc } = service({ projects: [site, web], run });
  assert.equal((await svc.resolve({ project: COPY, cwd: WEB })).project, site, 'the folder named wins over the one asked from');
});

test('resolve by a name that matches nothing says so, and never asks git', async () => {
  const calls = [];
  const { svc } = service({ projects: [site], run: async args => { calls.push(args); return null; } });
  assert.match((await svc.resolve({ project: 'ghost', cwd: ROOT })).error, /No project called "ghost"/);
  assert.deepEqual(calls, []);
});

test('projects and next_up everywhere read git before they answer, so "nothing unpushed" is never "not read yet"', async () => {
  const cold = project(SITE_KEY, 'site', ROOT);
  const read = project(SITE_KEY, 'site', ROOT, { insights: { git: { unpushed: 5 }, reasons: [{ id: 'unpushed', count: 5, weight: 2 }], attention: 2 } });
  const { svc } = service({ projects: [cold] });
  let lists = 0;
  svc.list = async () => ({ projects: [lists++ ? read : cold] });
  const asked = [];
  svc.readStale = async roots => { asked.push(roots); return true; };
  let changes = 0;
  svc.on('change', () => { changes++; });

  const all = await svc.forTerminal({ action: 'next_up', everywhere: true, via: 'mcp' });
  assert.deepEqual(asked, [[ROOT]]);
  assert.match(all.text, /5 commits not pushed yet/);
  assert.equal(changes, 1, 'the page hears about what was read');

  lists = 0;
  const listed = await svc.forTerminal({ action: 'projects', via: 'cli' });
  assert.match(listed.text, /5 unpushed/);
});

test('when git has nothing new, the list is read once', async () => {
  const { svc } = service({ projects: [site] });
  let lists = 0;
  svc.list = async () => { lists++; return { projects: [site] }; };
  svc.readStale = async () => false;
  await svc.forTerminal({ action: 'projects', via: 'mcp' });
  assert.equal(lists, 1);
});

test('detail takes the project it was handed instead of listing them all again', async () => {
  const config = fakeConfig();
  const svc = new Projects({
    config, devServers: fakeDevServers(), known: () => [], lastWorked: () => new Map(),
    github: () => ({ signedIn: false, can: () => false }), now: () => NOW,
  });
  let lists = 0;
  svc.list = async () => { lists++; return { projects: [site] }; };
  svc.readGit = async () => false;
  const p = await svc.detail(SITE_KEY, { listed: site });
  assert.equal(lists, 0);
  assert.equal(p.key, SITE_KEY);
  assert.deepEqual(p.todo, []);
  await svc.detail(SITE_KEY, { listed: web });
  assert.equal(lists, 1, 'a project that is not the one asked for is not taken');
});
