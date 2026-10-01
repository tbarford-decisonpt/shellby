const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  Marketplace, SUGGESTED, parseCatalog, parseMarketplaces, parseListing, isGithubRepo, parseDetails, parseResultLine, normalizeSource, runsCode, sourceUrl,
} = require('../src/main/marketplace');

// Shapes copied from `claude plugin list --available --json` (Claude Code 2.1).
const CATALOG = {
  installed: [
    { id: 'frontend-design@claude-plugins-official', version: '1.2.0', scope: 'user', enabled: true, installPath: 'C:\\x' },
    { id: 'old-thing@gone-marketplace', version: 'abc', scope: 'user', enabled: false },
  ],
  available: [
    { pluginId: 'frontend-design@claude-plugins-official', name: 'frontend-design', description: 'Make UIs.', marketplaceName: 'claude-plugins-official', source: { source: 'github', repo: 'anthropics/frontend' }, installCount: 12000 },
    { pluginId: '42crunch-api-security-testing@claude-plugins-official', name: '42crunch-api-security-testing', description: 'API\nsecurity.', source: { source: 'git-subdir', url: 'https://github.com/42Crunch-AI/claude-plugins.git', path: 'plugins/x' }, installCount: 3327 },
    { pluginId: 'bad id; rm -rf@x', description: 'nope' },
    { pluginId: '--flag@market', description: 'nope' },
    null,
  ],
};
const DETAILS = `frontend-design
  Source: frontend-design@claude-plugins-official

Component inventory
  Skills (1)  frontend-design
  Agents (0)
  Hooks (2)
  MCP servers (0)
  LSP servers (0)

Projected token cost
  Always-on:   ~1.2k tok   added to every session
`;

// A fake `claude` that records calls and answers from a table.
function fakeRun(answers = {}) {
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    const key = args.slice(0, 3).join(' ');
    const a = answers[key] ?? answers[args.slice(0, 2).join(' ')];
    if (typeof a === 'function') return a(args);
    return a || { ok: true, stdout: '', stderr: '' };
  };
  return { run, calls };
}
const listAnswers = extra => ({
  'plugin list --available': { ok: true, stdout: JSON.stringify(CATALOG) },
  'plugin marketplace list': { ok: true, stdout: JSON.stringify([{ name: 'claude-plugins-official', source: 'github', repo: 'anthropics/claude-plugins-official' }]) },
  'plugin details': { ok: true, stdout: DETAILS },
  ...extra,
});

// ---- parsing
test('catalog: merges available and installed, drops invalid ids', () => {
  const { plugins } = parseCatalog(CATALOG);
  const ids = plugins.map(p => p.id).sort();
  assert.deepEqual(ids, ['42crunch-api-security-testing@claude-plugins-official', 'frontend-design@claude-plugins-official', 'old-thing@gone-marketplace']);
  const fd = plugins.find(p => p.name === 'frontend-design');
  assert.equal(fd.installed, true);
  assert.equal(fd.enabled, true);
  assert.equal(fd.installs, 12000);
  assert.equal(fd.url, 'https://github.com/anthropics/frontend');
  const crunch = plugins.find(p => p.name.startsWith('42crunch'));
  assert.equal(crunch.installed, false);
  assert.equal(crunch.description, 'API security.');
  assert.equal(crunch.url, 'https://github.com/42Crunch-AI/claude-plugins');
  const old = plugins.find(p => p.name === 'old-thing');
  assert.equal(old.enabled, false);
  assert.equal(old.marketplace, 'gone-marketplace');
});

test('catalog: garbage in, empty list out', () => {
  assert.deepEqual(parseCatalog(null).plugins, []);
  assert.deepEqual(parseCatalog({ available: 'x', installed: 5 }).plugins, []);
});

test('sourceUrl: only https or GitHub repos become links', () => {
  assert.equal(sourceUrl({ url: 'http://example.com/x.git' }), null);
  assert.equal(sourceUrl({ url: 'file:///C:/x' }), null);
  assert.equal(sourceUrl({ url: 'https://user:pw@example.com/x' }), null);
  assert.equal(sourceUrl({ repo: '../../evil' }), null);
  assert.equal(sourceUrl({ path: './plugins/x' }), null);
});

test('sourceUrl: relative sources link into their GitHub marketplace', () => {
  assert.equal(sourceUrl('./plugins/code-review', 'anthropics/claude-plugins-official'), 'https://github.com/anthropics/claude-plugins-official/tree/HEAD/plugins/code-review');
  assert.equal(sourceUrl('./plugins/x', null), null);
  assert.equal(sourceUrl('./plugins/../../etc', 'a/b'), null);
  assert.equal(sourceUrl('/abs/path', 'a/b'), null);
  assert.equal(sourceUrl('./x', '../evil'), null);
  const { plugins } = parseCatalog({ available: [{ pluginId: 'cr@official', source: './plugins/cr' }] }, { repos: { official: 'anthropics/claude-plugins-official' } });
  assert.match(plugins[0].url, /claude-plugins-official\/tree\/HEAD\/plugins\/cr$/);
  assert.equal(parseCatalog({ available: [{ pluginId: 'cr@toString', source: './p' }] }).plugins[0].url, null, 'no prototype lookups');
});

test('marketplaces: names only from well-formed entries', () => {
  const m = parseMarketplaces([{ name: 'ecc', url: 'https://github.com/x/y.git' }, { name: '../bad' }, 'str', { repo: 'no-name' }]);
  assert.deepEqual(m, [{ name: 'ecc', source: 'https://github.com/x/y.git', repo: null, dir: null }]);
});

test('marketplaces: local clones are only trusted under the plugins folder', () => {
  const root = 'C:\\Users\\me\\.claude\\plugins';
  const dirOf = loc => parseMarketplaces([{ name: 'm', installLocation: loc }], { pluginsRoot: root })[0].dir;
  assert.equal(dirOf('C:\\Users\\me\\.claude\\plugins\\marketplaces\\m'), 'C:\\Users\\me\\.claude\\plugins\\marketplaces\\m');
  assert.equal(dirOf('\\\\attacker\\share\\m'), null, 'UNC');
  assert.equal(dirOf('C:\\Windows\\System32'), null);
  assert.equal(dirOf('C:\\Users\\me\\.claude\\plugins\\..\\..\\secrets'), null);
  assert.equal(dirOf('relative\\m'), null);
  assert.equal(parseMarketplaces([{ name: 'm', installLocation: 'C:\\Users\\me\\.claude\\plugins\\x' }])[0].dir, null, 'no root, no reads');
});

test('listings: installed plugins get descriptions from their marketplace catalog', async () => {
  const listing = { plugins: [{ name: 'frontend-design', description: 'Listed desc', source: './plugins/fd' }, { name: '../x' }, 7] };
  assert.deepEqual(Object.keys(parseListing(listing, 'claude-plugins-official')), ['frontend-design@claude-plugins-official']);
  const reads = [];
  const { run } = fakeRun(listAnswers({
    'plugin list --available': { ok: true, stdout: JSON.stringify({ installed: CATALOG.installed, available: [] }) },
    'plugin marketplace list': { ok: true, stdout: JSON.stringify([
      { name: 'claude-plugins-official', repo: 'anthropics/claude-plugins-official', installLocation: 'C:\\mk\\official' },
      { name: 'elsewhere', installLocation: 'D:\\other\\m' },
    ]) },
  }));
  const m = new Marketplace({ run, pluginsRoot: 'C:\\mk', readJson: f => { reads.push(f); return listing; } });
  const r = await m.list();
  const fd = r.plugins.find(p => p.name === 'frontend-design');
  assert.equal(fd.description, 'Listed desc');
  assert.equal(fd.url, 'https://github.com/anthropics/claude-plugins-official/tree/HEAD/plugins/fd');
  assert.equal(reads.length, 1, 'only clones under the plugins folder are read');
  assert.ok(reads[0].endsWith('marketplace.json'));
  assert.ok(!('dir' in r.marketplaces[0]), 'local paths stay in main');
});

test('details: reads component counts and always-on cost', () => {
  const d = parseDetails(DETAILS);
  assert.deepEqual(d, { skills: 1, agents: 0, hooks: 2, mcp: 0, lsp: 0, alwaysOnTokens: 1200 });
  assert.equal(runsCode(d), true);
  assert.equal(runsCode({ skills: 3, hooks: 0, mcp: 0, lsp: 0 }), false);
  assert.equal(runsCode(null), false);
  assert.deepEqual(parseDetails('nothing useful'), { skills: null, agents: null, hooks: null, mcp: null, lsp: null, alwaysOnTokens: null });
});

test('result line: finds the JSON line among human output', () => {
  assert.deepEqual(parseResultLine('✔ done\n{"outcome":"installed"}\n'), { outcome: 'installed' });
  assert.equal(parseResultLine('no json here'), null);
  assert.equal(parseResultLine('{broken'), null);
});

test('display text: bidi overrides and zero-width characters are removed', () => {
  const { plugins } = parseCatalog({ available: [{ pluginId: 'x@m', description: 'safe\u202Etxt.exe\u200B tool' }] });
  assert.equal(plugins[0].description, 'safe txt.exe tool');
});

test('isGithubRepo: real owner/repo shapes only', () => {
  assert.equal(isGithubRepo('anthropics/skills'), true);
  assert.equal(isGithubRepo('a/my.repo'), true);
  for (const bad of ['a/..', 'a/.', 'a/x.git', '-a/b', 'a/b/c', 'a', 'Documents/', null]) assert.equal(isGithubRepo(bad), false, String(bad));
});

test('normalizeSource: GitHub repos and public https only', () => {
  assert.equal(normalizeSource('anthropics/skills'), 'anthropics/skills');
  assert.equal(normalizeSource(' https://github.com/anthropics/skills.git '), 'anthropics/skills');
  assert.equal(normalizeSource('github.com/a/b/'), 'a/b');
  assert.equal(normalizeSource('https://example.com/marketplace.json'), 'https://example.com/marketplace.json');
  for (const bad of ['', '--scope', '-x/y', 'C:\\plugins', '../x', 'a/..', 'github.com/a/..', 'http://example.com/m.json', 'file:///C:/x',
    'https://u:p@example.com/x', 'a/b; calc', 'https://localhost/x', 'https://127.0.0.1/m.json', 'https://10.0.0.5/m.json',
    'https://169.254.169.254/latest', 'https://[::1]/x', 'https://nas.local/m.json', 'https://example.com:8443/m.json',
    'https://exa\tmple.com/m.json', 'https://example.com/\u202Em.json', null, 'x'.repeat(400)]) {
    assert.equal(normalizeSource(bad), null, JSON.stringify(bad));
  }
});

// ---- Marketplace
test('list: caches, and refresh updates marketplaces first (rate-limited)', async () => {
  let t = 100000;
  const { run, calls } = fakeRun(listAnswers());
  const m = new Marketplace({ run, now: () => t });
  const a = await m.list();
  assert.equal(a.ok, true);
  assert.equal(a.plugins.length, 3);
  assert.deepEqual(a.suggested.map(s => s.name), ['anthropic-agent-skills']);
  const n = calls.length;
  await m.list();
  assert.equal(calls.length, n, 'served from cache');
  await m.list({ refresh: true });
  assert.deepEqual(calls[n], ['plugin', 'marketplace', 'update']);
  await m.list({ refresh: true });
  assert.equal(calls.filter(c => c[2] === 'update').length, 1, 'a second refresh within 30s skips the git pull');
  t += 10 * 60 * 1000;
  const before = calls.length;
  await m.list();
  assert.ok(calls.length > before, 'stale cache re-lists');
});

test('list: concurrent callers share one CLI run', async () => {
  const { run, calls } = fakeRun(listAnswers());
  const m = new Marketplace({ run });
  await Promise.all([m.list(), m.list(), m.list()]);
  assert.equal(calls.filter(c => c[1] === 'list').length, 1);
});

test('list: CLI errors are friendly, and a missing CLI says so', async () => {
  const bad = fakeRun({ 'plugin list --available': { ok: false, stdout: '{"error":"boom"}' } });
  const r = await new Marketplace({ run: bad.run }).list();
  assert.equal(r.ok, false);
  assert.match(r.error, /plugin list/);

  const none = fakeRun({ 'plugin list --available': { ok: false, notInstalled: true, stdout: '' }, 'plugin marketplace list': { ok: false, notInstalled: true, stdout: '' } });
  assert.deepEqual(await new Marketplace({ run: none.run }).list(), { ok: false, notInstalled: true, error: 'Claude Code is not installed.' });
  assert.equal((await new Marketplace({}).list()).notInstalled, true);
});

test('list: if the marketplace list fails, nothing is suggested', async () => {
  const { run } = fakeRun(listAnswers({ 'plugin marketplace list': { ok: false, stdout: '' } }));
  const r = await new Marketplace({ run }).list();
  assert.equal(r.ok, true);
  assert.deepEqual(r.suggested, []);
});

test('list: a snapshot taken during a change is not cached as fresh', async () => {
  let release;
  let listCalls = 0;
  const gate = new Promise(r => { release = r; });
  const withCrunch = { ...CATALOG, installed: [...CATALOG.installed, { id: '42crunch-api-security-testing@claude-plugins-official', scope: 'user' }] };
  const { run } = fakeRun(listAnswers({
    'plugin list --available': async () => {
      listCalls++;
      const snapshot = listCalls >= 3 ? withCrunch : CATALOG;
      if (listCalls === 2) await gate; // the second list straddles an install
      return { ok: true, stdout: JSON.stringify(snapshot) };
    },
    'plugin install': { ok: true, stdout: '{"outcome":"installed"}' },
  }));
  const m = new Marketplace({ run });
  await m.list();
  m.cache.at = 0;
  const slowList = m.list();
  await new Promise(r => setTimeout(r, 5));
  await m.install('42crunch-api-security-testing@claude-plugins-official');
  release();
  const r = await slowList;
  assert.equal(r.plugins.find(p => p.name.startsWith('42crunch')).installed, true, 'retried after the change');
});

test('suggestedFor: name alone is not enough', async () => {
  const fake = fakeRun(listAnswers({ 'plugin marketplace list': { ok: true, stdout: JSON.stringify([{ name: 'claude-plugins-official', repo: 'evil/claude-plugins-official' }]) } }));
  const m1 = new Marketplace({ run: fake.run });
  await m1.list();
  assert.equal(m1.suggestedFor('claude-plugins-official'), null);
  const real = fakeRun(listAnswers());
  const m2 = new Marketplace({ run: real.run });
  await m2.list();
  assert.equal(m2.suggestedFor('claude-plugins-official'), SUGGESTED[0]);
});

test('install: only ids the CLI listed, never with -y', async () => {
  const { run, calls } = fakeRun(listAnswers({ 'plugin install': { ok: true, stdout: '{"command":"install","outcome":"installed"}' } }));
  const m = new Marketplace({ run });
  assert.equal((await m.install('42crunch-api-security-testing@claude-plugins-official')).ok, false, 'nothing listed yet');
  await m.list();
  assert.equal((await m.install('evil@nowhere')).ok, false);
  assert.equal((await m.install('--scope@x')).ok, false);
  const r = await m.install('42crunch-api-security-testing@claude-plugins-official');
  assert.equal(r.ok, true);
  assert.equal(r.runsCode, true);
  assert.equal(r.details.skills, 1);
  assert.deepEqual(calls.find(c => c[1] === 'install'), ['plugin', 'install', '42crunch-api-security-testing@claude-plugins-official', '--json']);
  assert.ok(!calls.flat().includes('-y') && !calls.flat().includes('--yes'));
});

test('install: the cache shows it installed even if the next list fails', async () => {
  let fail = false;
  const { run } = fakeRun(listAnswers({
    'plugin install': { ok: true, stdout: '{"outcome":"installed"}' },
    'plugin list --available': () => (fail ? { ok: false, stdout: '' } : { ok: true, stdout: JSON.stringify(CATALOG) }),
  }));
  const m = new Marketplace({ run });
  await m.list();
  await m.install('42crunch-api-security-testing@claude-plugins-official');
  fail = true;
  assert.equal((await m.list()).ok, false);
  assert.equal(m.view().plugins.find(p => p.name.startsWith('42crunch')).installed, true);
});

test('install: CLI failures and command-source plugins are reported', async () => {
  const fail = fakeRun(listAnswers({ 'plugin install': { ok: true, stdout: '{"outcome":"failed","failureCode":"not_found","message":"Plugin not found"}' } }));
  const m1 = new Marketplace({ run: fail.run });
  await m1.list();
  const r1 = await m1.install('42crunch-api-security-testing@claude-plugins-official');
  assert.deepEqual([r1.ok, r1.error], [false, 'Plugin not found']);

  for (const answer of [
    { ok: false, stdout: '{"outcome":"failed","shownCommand":{"sha256":"ab"}}' },
    { ok: true, stdout: '{"outcome":"failed","failureCode":"command_confirmation_required"}' },
  ]) {
    const cmd = fakeRun(listAnswers({ 'plugin install': answer }));
    const m2 = new Marketplace({ run: cmd.run });
    await m2.list();
    const r2 = await m2.install('42crunch-api-security-testing@claude-plugins-official');
    assert.equal(r2.needsTerminal, true);
    assert.equal(r2.command, 'claude plugin install 42crunch-api-security-testing@claude-plugins-official');
  }

  const crash = fakeRun(listAnswers({ 'plugin install': { ok: false, stdout: '', stderr: 'boom' } }));
  const m3 = new Marketplace({ run: crash.run });
  await m3.list();
  assert.equal((await m3.install('42crunch-api-security-testing@claude-plugins-official')).ok, false);
});

test('changes run one at a time', async () => {
  let active = 0, peak = 0;
  const slow = async () => { active++; peak = Math.max(peak, active); await new Promise(r => setTimeout(r, 20)); active--; return { ok: true, stdout: '{"outcome":"installed"}' }; };
  const { run } = fakeRun(listAnswers({ 'plugin install': slow, 'plugin uninstall': slow }));
  const m = new Marketplace({ run });
  await m.list();
  await Promise.all([
    m.install('42crunch-api-security-testing@claude-plugins-official'),
    m.uninstall('frontend-design@claude-plugins-official'),
  ]);
  assert.equal(peak, 1);
});

test('uninstall: user-scope plugins only; project installs point to the terminal', async () => {
  const catalog = { ...CATALOG, installed: [
    { id: 'frontend-design@claude-plugins-official', scope: 'user', enabled: true },
    { id: 'old-thing@gone-marketplace', scope: 'project', enabled: true },
  ] };
  const { run, calls } = fakeRun(listAnswers({
    'plugin list --available': { ok: true, stdout: JSON.stringify(catalog) },
    'plugin uninstall': { ok: true, stdout: '{"outcome":"uninstalled"}' },
  }));
  const m = new Marketplace({ run });
  await m.list();
  assert.equal((await m.uninstall('42crunch-api-security-testing@claude-plugins-official')).ok, false, 'not installed');
  const proj = await m.uninstall('old-thing@gone-marketplace');
  assert.deepEqual([proj.ok, proj.needsTerminal, proj.command], [false, true, 'claude plugin uninstall old-thing@gone-marketplace --scope project']);
  assert.equal((await m.uninstall('frontend-design@claude-plugins-official')).ok, true);
  assert.deepEqual(calls.filter(c => c[1] === 'uninstall'), [['plugin', 'uninstall', 'frontend-design@claude-plugins-official', '--json']]);
  assert.equal(m.view().plugins.find(p => p.name === 'frontend-design').installed, false);
});

test('addMarketplace: validates before calling the CLI', async () => {
  const { run, calls } = fakeRun(listAnswers());
  const m = new Marketplace({ run });
  assert.equal((await m.addMarketplace('--scope project')).ok, false);
  assert.equal((await m.addMarketplace('Documents/..')).ok, false);
  assert.equal(calls.length, 0);
  const r = await m.addMarketplace('https://github.com/anthropics/skills');
  assert.equal(r.ok, true);
  assert.deepEqual(calls[0], ['plugin', 'marketplace', 'add', 'anthropics/skills']);
});
