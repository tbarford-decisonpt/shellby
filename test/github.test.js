const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { scopesFor, covers, TokenStore } = require('../src/main/github/auth');
const { GitHubApi } = require('../src/main/github/api');
const { merge, snapshot, syncNow, FILE } = require('../src/main/github/sync');
const { publishPack } = require('../src/main/github/publish');
const { GitHubService, gitEnv, normalizeState } = require('../src/main/github/service');
const { startMockGitHub } = require('./fixtures/mock-github');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-gh-'));
const fakeCrypto = { isEncryptionAvailable: () => true, encryptString: s => Buffer.from(`enc:${Buffer.from(s).toString('base64')}`), decryptString: b => Buffer.from(b.toString().slice(4), 'base64').toString() };
class MemConfig {
  constructor(data = {}) { this.data = { ...data }; }
  get(k) { return this.data[k]; }
  set(p) { this.data = { ...this.data, ...p }; return this.data; }
}
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await new Promise(r => setTimeout(r, 50)); } return false; };

test('scopes: only what the features need; repo covers public_repo', () => {
  assert.deepEqual(scopesFor([]), ['read:user']);
  assert.deepEqual(scopesFor(['sync', 'publish']), ['gist', 'public_repo', 'read:user']);
  assert.deepEqual(scopesFor(['publish', 'claude']), ['read:user', 'repo']);
  assert.equal(covers(['repo'], 'publish'), true);
  assert.equal(covers(['read:user'], 'sync'), false);
});

test('the token file is encrypted and unreadable without the OS key', () => {
  const file = path.join(tmp(), 'github.bin');
  const store = new TokenStore(file, fakeCrypto);
  store.save({ token: 'gho_secret', scopes: ['gist'] });
  assert.equal(fs.readFileSync(file, 'utf8').includes('gho_secret'), false);
  assert.deepEqual(store.load(), { token: 'gho_secret', scopes: ['gist'] });
  assert.equal(new TokenStore(file, { isEncryptionAvailable: () => false }).load(), null);
  assert.throws(() => new TokenStore(file, { isEncryptionAvailable: () => false }).save({ token: 'x' }));
  store.clear();
  assert.equal(store.load(), null);
});

test('git credential helper env answers github.com with the token (and nothing is written to git config)', () => {
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: tmp(), USERPROFILE: tmp(), ...gitEnv('gho_abc') };
  const r = spawnSync('git', ['credential', 'fill'], { input: 'protocol=https\nhost=github.com\n\n', env, encoding: 'utf8' });
  assert.match(r.stdout, /username=x-access-token/);
  assert.match(r.stdout, /password=gho_abc/);
  assert.equal(gitEnv('gho_abc').GITHUB_PERSONAL_ACCESS_TOKEN, 'gho_abc', 'the GitHub plugin MCP tools read this one');
  assert.equal(gitEnv(null).GH_TOKEN, undefined);
  const offset = gitEnv('t', { GIT_CONFIG_COUNT: '2' });
  assert.equal(offset.GIT_CONFIG_COUNT, '4');
  assert.equal(offset.GIT_CONFIG_KEY_2, 'credential.https://github.com.helper');
});

test('sync merge only adds progress; outfit and skin follow the newer change', () => {
  const a = { wardrobe: { unlocked: ['first-task'], collected: ['hat/a'], outfit: { hat: 'hat/a' }, outfitAt: 10 }, xp: { total: 100, log: [] }, days: ['2026-09-01'], skin: 'classic', skinAt: 50 };
  const b = { wardrobe: { unlocked: ['night-owl'], collected: ['hat/b'], outfit: { hat: 'hat/b' }, outfitAt: 20 }, xp: { total: 80, log: [] }, days: ['2026-09-02'], skin: 'reef', skinAt: 5 };
  const m = merge(a, b);
  assert.deepEqual(m.wardrobe.unlocked.sort(), ['first-task', 'night-owl']);
  assert.deepEqual(m.wardrobe.collected.sort(), ['hat/a', 'hat/b']);
  assert.equal(m.wardrobe.outfit.hat, 'hat/b');
  assert.equal(m.xp.total, 100);
  assert.deepEqual(m.days, ['2026-09-01', '2026-09-02']);
  assert.equal(m.skin, 'classic');
  assert.deepEqual(merge(m, a), merge(a, m), 'order does not matter');
});

test('sync: two PCs meet in one private gist', async () => {
  const mock = await startMockGitHub();
  try {
    const gh = new GitHubApi({ token: mock.state.token, api: mock.base });
    const pc1 = new MemConfig({ wardrobe: { unlocked: ['first-task'] }, xp: { total: 300 }, streaks: { days: ['2026-09-30'] } });
    const pc2 = new MemConfig({ wardrobe: { unlocked: ['night-owl'] }, xp: { total: 50 }, streaks: { days: ['2026-10-01'] } });
    const io = c => ({ get: k => c.get(k), set: p => c.set(p) });
    const first = await syncNow(gh, io(pc1));
    assert.equal(first.pushed, true);
    const gist = mock.state.gists.get(first.gistId);
    assert.equal(gist.public, false, 'the gist is private');
    assert.ok(gist.files[FILE]);
    const second = await syncNow(gh, io(pc2));
    assert.deepEqual([second.gistId, second.pulled, second.pushed], [first.gistId, true, true], 'pc2 finds the same gist');
    assert.deepEqual(pc2.get('wardrobe').unlocked.sort(), ['first-task', 'night-owl']);
    assert.equal(pc2.get('xp').total, 300);
    await syncNow(gh, io(pc1));
    assert.deepEqual(snapshot(k => pc1.get(k)).days, ['2026-09-30', '2026-10-01']);
    const again = await syncNow(gh, io(pc1));
    assert.deepEqual([again.pulled, again.pushed], [false, false], 'nothing new, nothing written');
  } finally { await mock.close(); }
});

test('sync tolerates a hostile gist', async () => {
  const mock = await startMockGitHub();
  try {
    const gh = new GitHubApi({ token: mock.state.token, api: mock.base });
    mock.state.gists.set('evil', { id: 'evil', files: { [FILE]: { content: JSON.stringify({ wardrobe: { unlocked: ['<img onerror=x>', 'ok-one'], outfit: { hat: '../../etc' } }, xp: { total: 'lots' }, skin: 'javascript:alert(1)', days: ['nope'] }), size: 200 } } });
    const pc = new MemConfig({});
    await syncNow(gh, { get: k => pc.get(k), set: p => pc.set(p) });
    assert.deepEqual(pc.get('wardrobe').unlocked, ['ok-one']);
    assert.equal(pc.get('wardrobe').outfit.hat, null);
    assert.equal(pc.get('skin'), undefined);
    assert.deepEqual(pc.get('streaks').days, []);
  } finally { await mock.close(); }
});

const PACK = { format: 1, id: 'reef-hats', name: 'Reef Hats', version: '1.0.0', author: 'crabfan', description: 'Hats from the reef.', accessories: [] };

test('publish: forks, adds packs/<id>/pack.json on a branch, opens a PR to the gallery', async () => {
  const mock = await startMockGitHub();
  try {
    const gh = new GitHubApi({ token: mock.state.token, api: mock.base });
    const r = await publishPack(gh, { login: 'crabfan', pack: PACK, now: 1000, sleep: async () => {} });
    assert.equal(r.ok, true);
    assert.match(r.url, /x-salmon\/shellby-packs\/pull\/1$/);
    assert.ok(mock.state.forks.has('crabfan/shellby-packs'));
    const file = mock.state.files.get(`crabfan/shellby-packs:pack-reef-hats-${(1000).toString(36)}:packs/reef-hats/pack.json`);
    assert.deepEqual(JSON.parse(Buffer.from(file.content, 'base64').toString()), PACK);
    const pr = mock.state.pulls[0];
    assert.equal(pr.head, `crabfan:pack-reef-hats-${(1000).toString(36)}`);
    assert.equal(pr.base, 'main');
    assert.match(pr.body, /CC BY 4\.0/);
  } finally { await mock.close(); }
});

test('publish: the gallery owner branches in the repo itself; same version needs a bump', async () => {
  const mock = await startMockGitHub({ login: 'x-salmon' });
  try {
    const gh = new GitHubApi({ token: mock.state.token, api: mock.base });
    mock.publish('reef-hats', PACK);
    const same = await publishPack(gh, { login: 'x-salmon', pack: PACK, sleep: async () => {} });
    assert.equal(same.same, true);
    const bump = await publishPack(gh, { login: 'x-salmon', pack: { ...PACK, name: 'Reef Hats!' }, sleep: async () => {} });
    assert.equal(bump.needsBump, true);
    const ok = await publishPack(gh, { login: 'x-salmon', pack: { ...PACK, version: '1.1.0' }, now: 7, sleep: async () => {} });
    assert.equal(ok.ok && ok.update, true);
    assert.equal(mock.state.forks.size, 0, 'no fork of your own repo');
    assert.equal(mock.state.pulls[0].head, 'pack-reef-hats-7');
    assert.match(mock.state.pulls[0].title, /^Update pack/);
  } finally { await mock.close(); }
});

test('service: device-flow sign-in, profile, features, widening and sign-out', async () => {
  const mock = await startMockGitHub();
  const dir = tmp();
  try {
    const config = new MemConfig({});
    const svc = new GitHubService({ config, store: new TokenStore(path.join(dir, 'gh.bin'), fakeCrypto), web: mock.base, api: mock.base, clientId: 'test-client' });
    assert.equal(svc.view().signedIn, false);
    assert.equal((await svc.signIn(['sync'])).ok, true);
    assert.equal(svc.view().flow.code, 'CRAB-1234');
    assert.match(mock.state.requestedScope, /gist/);
    mock.approve();
    assert.ok(await until(() => svc.view().signedIn && svc.view().login === 'crabfan'), 'signed in after approval');
    const v = svc.view();
    assert.equal(v.name, 'Crab Fan');
    assert.equal(v.avatar, null, 'avatars only from GitHub\'s avatar host');
    assert.equal(v.features.sync.on && v.features.sync.granted, true);
    assert.equal(JSON.stringify(config.data).includes(mock.state.token), false, 'the token never lands in settings');
    assert.ok(await until(() => mock.state.gists.size === 1), 'first sync made the gist');

    // Claude access needs `repo`: turning it on asks GitHub again.
    assert.deepEqual(svc.claudeEnv(), {});
    const widen = await svc.setFeature('claude', true);
    assert.equal(widen.needsApproval, true);
    assert.match(mock.state.requestedScope, /\brepo\b/);
    assert.match(mock.state.requestedScope, /gist/, 'keeps the features already on');
    assert.ok(await until(() => svc.view().features.claude.granted));
    assert.equal(svc.claudeEnv().GH_TOKEN, mock.state.token);

    // A new Service (restart) picks the sign-in up from the encrypted file.
    const again = new GitHubService({ config, store: new TokenStore(path.join(dir, 'gh.bin'), fakeCrypto), web: mock.base, api: mock.base });
    assert.equal(again.view().signedIn, true);
    again.signOut();
    assert.equal(again.view().signedIn, false);
    assert.equal(normalizeState(config.get('github')).features.claude, false, 'Claude access is switched off on sign-out');
    assert.equal(fs.existsSync(path.join(dir, 'gh.bin')), false);
    svc.stop(); again.stop();
  } finally { await mock.close(); }
});

test('service: a declined sign-in reports why; a foreign verification page is refused', async () => {
  const mock = await startMockGitHub();
  try {
    const svc = new GitHubService({ config: new MemConfig({}), store: new TokenStore(path.join(tmp(), 'gh.bin'), fakeCrypto), web: mock.base, api: mock.base });
    const errors = [];
    svc.on('error', e => errors.push(e));
    await svc.signIn([]);
    mock.deny();
    assert.ok(await until(() => errors.length === 1));
    assert.match(errors[0], /declined/);
    assert.equal(svc.view().flow, null);
    assert.equal(svc.safeVerificationUrl('https://evil.example/login/device'), null);
    assert.ok(svc.safeVerificationUrl(`${mock.base}/login/device`));
    svc.stop();
  } finally { await mock.close(); }
});
