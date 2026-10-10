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

test('scopes: pushing a CI workflow needs `workflow`, which `repo` does not cover', () => {
  // GitHub refuses any push touching .github/workflows without this scope, even
  // with full `repo`, so it has to be asked for separately.
  assert.deepEqual(scopesFor(['claude', 'workflows']), ['read:user', 'repo', 'workflow']);
  assert.equal(covers(['repo'], 'workflows'), false, 'repo is not enough');
  assert.equal(covers(['repo', 'workflow'], 'workflows'), true);
  // And it is not dragged in by anything else.
  assert.equal(scopesFor(['claude']).includes('workflow'), false);
  assert.equal(scopesFor(['sync', 'publish', 'ci']).includes('workflow'), false);
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

test('sync: XP earned on two PCs adds up, and syncing again never counts it twice', async () => {
  const mock = await startMockGitHub();
  try {
    const gh = new GitHubApi({ token: mock.state.token, api: mock.base });
    // Both start from the same synced 300, from before XP was counted per PC.
    const pc1 = new MemConfig({ xp: { total: 300, device: 'pc-one1', byDevice: { legacy: 300, 'pc-one1': 500 } } });
    const pc2 = new MemConfig({ xp: { total: 300, device: 'pc-two2', byDevice: { legacy: 300, 'pc-two2': 200 } } });
    const io = c => ({ get: k => c.get(k), set: p => c.set(p) });
    await syncNow(gh, io(pc1));
    await syncNow(gh, io(pc2));
    await syncNow(gh, io(pc1));
    assert.equal(pc1.get('xp').total, 1000);
    assert.equal(pc2.get('xp').total, 1000);
    assert.equal(pc1.get('xp').device, 'pc-one1', 'each PC keeps its own id');
    await syncNow(gh, io(pc2));
    await syncNow(gh, io(pc1));
    assert.equal(pc1.get('xp').total, 1000);
    // An older Shellby rewrote the gist with only a total: it's a floor, not extra.
    const id = pc1.get('syncGistId');
    const old = JSON.parse(mock.state.gists.get(id).files[FILE].content);
    mock.state.gists.get(id).files[FILE].content = JSON.stringify({ ...old, xp: { total: 1040, log: [] } });
    await syncNow(gh, io(pc1));
    assert.equal(pc1.get('xp').total, 1040);
  } finally { await mock.close(); }
});

test('sync: stickers meet too, and each PC keeps its own folders and badges', async () => {
  const mock = await startMockGitHub();
  try {
    const gh = new GitHubApi({ token: mock.state.token, api: mock.base });
    const A = 'aaaaaaaaaaaa', B = 'bbbbbbbbbbbb';
    const one = { firstShipAt: 1000, lastShipAt: 2000, ships: 3, name: 'crab', root: 'C:/pc1/crab', marks: ['live'] };
    const pc1 = new MemConfig({ stickers: { projects: { [A]: one }, layouts: { home: [{ id: A, slot: 0, z: 1 }] }, layoutsAt: 5, unseen: [A], card: 'off' } });
    const pc2 = new MemConfig({ stickers: { projects: { [A]: { ...one, ships: 7, root: 'D:/pc2/crab', marks: ['merged'] }, [B]: { firstShipAt: 500, ships: 1, name: 'reef' } } } });
    const io = c => ({ get: k => c.get(k), set: p => c.set(p) });
    await syncNow(gh, io(pc1));
    await syncNow(gh, io(pc2));
    await syncNow(gh, io(pc1));
    const s1 = pc1.get('stickers'), s2 = pc2.get('stickers');
    assert.deepEqual(Object.keys(s1.projects).sort(), [A, B]);
    assert.equal(s1.projects[A].ships, 7);
    assert.deepEqual(s1.projects[A].marks.sort(), ['live', 'merged']);
    assert.equal(s1.projects[A].root, 'C:/pc1/crab', 'pc1 keeps its folder');
    assert.equal(s2.projects[A].root, 'D:/pc2/crab', 'pc2 keeps its folder');
    assert.equal(s1.card, 'off', 'options stay on the PC that set them');
    assert.deepEqual(s1.unseen, [A]);
    assert.ok(s2.layouts.home?.length, 'the shell layout travelled');
    const gist = JSON.parse([...mock.state.gists.values()][0].files[FILE].content);
    assert.ok(!JSON.stringify(gist).includes('pc1'), 'no folders in the gist');
    const again = await syncNow(gh, io(pc1));
    assert.deepEqual([again.pulled, again.pushed], [false, false], 'settled: nothing new, nothing written');
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
    config.set({ github: { ...config.get('github'), features: { ...config.get('github').features, prBadge: true } } });
    again.signOut();
    assert.equal(normalizeState(config.get('github')).features.prBadge, false, 'the PR badge needs its confirmation again after sign-out');
    assert.equal(again.view().signedIn, false);
    assert.equal(normalizeState(config.get('github')).features.claude, false, 'Claude access is switched off on sign-out');
    assert.equal(fs.existsSync(path.join(dir, 'gh.bin')), false);
    svc.stop(); again.stop();
  } finally { await mock.close(); }
});

test('service: a sign-in GitHub turns down (401) offers Sign in again, and a new sign-in clears it', async () => {
  const dir = tmp();
  const store = new TokenStore(path.join(dir, 'gh.bin'), fakeCrypto);
  store.save({ token: 'gho_expired', scopes: ['gist', 'read:user'] });
  const status = 401;
  const fetchImpl = async () => ({ ok: false, status, text: async () => JSON.stringify({ message: 'Bad credentials' }), headers: { get: () => null } });
  const config = new MemConfig({ github: { features: { sync: true } } });
  const svc = new GitHubService({ config, store, api: 'https://api.example', fetchImpl });
  assert.equal(svc.view().authLost, false);
  const r = await svc.sync();
  assert.equal(r.ok, false);
  assert.match(r.error, /signed Shellby out/);
  assert.equal(svc.view().authLost, true, 'Settings shows Sign in again');
  // Any other call that finds out does the same; it's said once.
  await svc.gh().get('/user').catch(() => {});
  assert.equal(normalizeState(config.get('github')).authLost, true);
  svc.signOut();
  assert.equal(svc.view().authLost, false);
  svc.stop();
});

test('service: no network says so, not "fetch failed"', async () => {
  const store = new TokenStore(path.join(tmp(), 'gh.bin'), fakeCrypto);
  store.save({ token: 'gho_ok', scopes: ['gist', 'read:user'] });
  const fetchImpl = async () => { const e = new TypeError('fetch failed'); e.cause = { code: 'ENOTFOUND' }; throw e; };
  const svc = new GitHubService({ config: new MemConfig({ github: { features: { sync: true } } }), store, api: 'https://api.example', fetchImpl });
  const r = await svc.sync();
  assert.match(r.error, /Couldn't reach GitHub: this PC looks to be offline/);
  assert.equal(svc.view().authLost, false);
  svc.stop();
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

test('service: a sign-in that finishes after stop() starts no sync timer', async () => {
  const mock = await startMockGitHub();
  try {
    // A slow runner: the profile is still loading when the service is stopped.
    // The profile request waits on a gate the test opens only after stop(), so
    // the order is certain rather than left to a sleep.
    let openGate;
    const gate = new Promise(r => { openGate = r; });
    const fetchImpl = async (u, o) => { if (String(u).endsWith('/user')) await gate; return fetch(u, o); };
    const svc = new GitHubService({ config: new MemConfig({}), store: new TokenStore(path.join(tmp(), 'gh.bin'), fakeCrypto), web: mock.base, api: mock.base, fetchImpl });
    await svc.signIn(['sync']);
    mock.approve();
    assert.ok(await until(() => svc.view().signedIn));
    svc.stop();
    const profileSaved = new Promise(r => svc.once('change', r)); // refreshProfile's save, the last step before schedule()
    openGate();
    await profileSaved;
    await new Promise(r => setImmediate(r));
    assert.equal(svc.timer, null, 'no sync timer left to keep the process alive');
  } finally { await mock.close(); }
});

test('GitHubApi keeps what a 422 was about, not just "Validation Failed"', async () => {
  const { GitHubApi } = require('../src/main/github/api');
  const fetchImpl = async () => new Response(JSON.stringify({ message: 'Validation Failed', errors: [{ resource: 'PullRequest', code: 'custom', message: 'A pull request already exists for me:x.' }] }), { status: 422 });
  await assert.rejects(new GitHubApi({ token: 't', fetchImpl }).post('/repos/me/crab/pulls', {}), e => e.status === 422 && e.message === 'Validation Failed' && e.detail === 'A pull request already exists for me:x.');
});

// settings.json lost to a power cut, with the sign-in safe in its own file:
// Settings said "signed in" with no account, and every feature had to be
// approved again.
test('service: the features you turned on are kept beside the token, and come back when the settings are lost', async () => {
  const mock = await startMockGitHub();
  try {
    const dir = tmp();
    const store = new TokenStore(path.join(dir, 'gh.bin'), fakeCrypto);
    store.save({ token: 'gho_mocktoken123', scopes: ['gist', 'read:user', 'repo'] });
    const config = new MemConfig({ github: { login: 'crabfan', features: {} } });
    const svc = new GitHubService({ config, store, web: mock.base, api: mock.base });
    await svc.setFeature('sync', true);
    await svc.setFeature('claude', true);
    assert.deepEqual(store.load().features, { sync: true, claude: true });
    await svc.setFeature('claude', false);
    assert.deepEqual(store.load().features, { sync: true }, 'turning one off is kept too');
    svc.stop();

    const lost = new MemConfig({}); // no `github` at all
    const again = new GitHubService({ config: lost, store, web: mock.base, api: mock.base });
    again.restore();
    assert.equal(again.view().features.sync.on, true);
    assert.equal(again.view().features.claude.on, false);
    assert.ok(await until(() => again.view().login === 'crabfan'), 'and who you are is fetched again');
    again.stop();
  } finally { await mock.close(); }
});

test('service: signed in with nobody in Settings fetches the account again; features you set are left alone', async () => {
  const mock = await startMockGitHub();
  try {
    const store = new TokenStore(path.join(tmp(), 'gh.bin'), fakeCrypto);
    store.save({ token: 'gho_mocktoken123', scopes: ['gist', 'read:user'], features: { sync: true } });
    const config = new MemConfig({ github: { features: { sync: false } } });
    const svc = new GitHubService({ config, store, web: mock.base, api: mock.base });
    svc.restore();
    assert.equal(svc.view().features.sync.on, false, 'settings that are there win');
    assert.ok(await until(() => svc.view().login === 'crabfan'));
    svc.stop();
  } finally { await mock.close(); }
});

test('the token file written earlier, without features, still loads', () => {
  const file = path.join(tmp(), 'github.bin');
  fs.writeFileSync(file, fakeCrypto.encryptString(JSON.stringify({ token: 'gho_old', scopes: ['gist'] })));
  assert.deepEqual(new TokenStore(file, fakeCrypto).load(), { token: 'gho_old', scopes: ['gist'] });
});
