const test = require('node:test');
const assert = require('node:assert/strict');
const { ProfileCard, cleanSvg, rawUrl, workflowYaml, setupLinks, setupProgress, README_LINE, PROFILE_FILE, WORKFLOW_PATH } = require('../src/main/github/profile-card');

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="200"><rect width="10" height="10" fill="url(#bg)"/><text>Lv 3</text></svg>';
const GIST = 'abcdef0123456789abcdef0123456789';

class MemConfig {
  constructor(data = {}) { this.data = { ...data }; }
  get(k) { return this.data[k]; }
  set(p) { this.data = { ...this.data, ...p }; return this.data; }
}

// Just enough of the gist API for one signed-in user.
function fakeGist() {
  const gists = new Map();
  const calls = [];
  const notFound = () => Object.assign(new Error('Not Found'), { status: 404 });
  return {
    gists, calls,
    async get(path) {
      calls.push(['GET', path]);
      const m = /^\/gists\/([^/?]+)$/.exec(path);
      if (m) { if (!gists.has(m[1])) throw notFound(); return gists.get(m[1]); }
      return [...gists.values()];
    },
    async post(path, body) {
      calls.push(['POST', path]);
      const g = { id: GIST, public: body.public, files: body.files };
      gists.set(g.id, g);
      return g;
    },
    async patch(path, body) {
      calls.push(['PATCH', path]);
      const id = path.split('/').pop();
      gists.get(id).files = body.files;
      return gists.get(id);
    },
    async delete(path) { calls.push(['DELETE', path]); gists.delete(path.split('/').pop()); return null; },
  };
}

function setup({ on = true, now = 1_000_000 } = {}) {
  const gh = fakeGist();
  const clock = { t: now };
  const github = { signedIn: true, can: f => on && f === 'profileCard', gh: () => gh, view: () => ({ login: 'crab-fan' }) };
  const config = new MemConfig();
  return { gh, clock, config, card: new ProfileCard({ config, github, now: () => clock.t }) };
}

test('cleanSvg keeps a plain card and refuses anything active or external', () => {
  assert.equal(cleanSvg(SVG), SVG);
  assert.equal(cleanSvg(`  ${SVG}\n`), SVG);
  for (const bad of [
    '<svg width="1"></svg>', // no namespace
    SVG.replace('</svg>', '<script>alert(1)</script></svg>'),
    SVG.replace('<rect', '<rect onload="x()"'),
    SVG.replace('<rect', '<image href="https://evil.example/x.png"/><rect'),
    SVG.replace('url(#bg)', 'url(https://evil.example/t)'),
    SVG.replace('</svg>', '<foreignObject></foreignObject></svg>'),
    `<svg xmlns="http://www.w3.org/2000/svg">${'x'.repeat(300 * 1024)}</svg>`,
    null, 42,
  ]) assert.equal(cleanSvg(bad), null, String(bad).slice(0, 60));
});

test('the first publish creates a public gist holding only the card', async () => {
  const { gh, card, config } = setup();
  const r = await card.publish(SVG);
  assert.deepEqual(r, { ok: true, published: true });
  const g = gh.gists.get(GIST);
  assert.equal(g.public, true);
  assert.deepEqual(Object.keys(g.files), [PROFILE_FILE]);
  assert.equal(config.get('profileCard').gistId, GIST);
});

test('an unchanged card is not uploaded again until a day has passed', async () => {
  const { gh, card, clock } = setup();
  await card.publish(SVG);
  const before = gh.calls.length;
  assert.deepEqual(await card.publish(SVG), { ok: true, published: false });
  assert.equal(gh.calls.length, before);
  clock.t += 25 * 3600 * 1000;
  assert.equal((await card.publish(SVG)).published, true);
  assert.ok(gh.calls.some(c => c[0] === 'PATCH'));
});

test('a changed card, or Update now, publishes straight away', async () => {
  const { card } = setup();
  await card.publish(SVG);
  assert.equal((await card.publish(SVG.replace('Lv 3', 'Lv 4'))).published, true);
  assert.equal((await card.publish(SVG.replace('Lv 3', 'Lv 4'), { force: true })).published, true);
});

test('nothing is published while the feature is off or the SVG is unsafe', async () => {
  const off = setup({ on: false });
  assert.equal((await off.card.publish(SVG)).ok, false);
  assert.equal(off.gh.calls.length, 0);
  const on = setup();
  assert.equal((await on.card.publish('<svg><script/></svg>')).ok, false);
  assert.equal(on.gh.calls.length, 0);
});

test('a GitHub failure is saved for the panel and leaves the old card alone', async () => {
  const { gh, card, config } = setup();
  gh.post = async () => { throw Object.assign(new Error('Server Error'), { status: 500 }); };
  const r = await card.publish(SVG);
  assert.equal(r.ok, false);
  assert.match(config.get('profileCard').error, /Server Error/);
  assert.equal(card.view().gistId, null);
});

test('takeDown deletes the gist and forgets it', async () => {
  const { gh, card } = setup();
  await card.publish(SVG);
  assert.deepEqual(await card.takeDown(), { ok: true });
  assert.equal(gh.gists.size, 0);
  assert.equal(card.view().gistId, null);
});

test('the view hands out the Action and README line once the gist exists', async () => {
  const { card } = setup();
  assert.equal(card.view().workflow, null);
  await card.publish(SVG);
  const v = card.view();
  assert.equal(v.profileRepo, 'https://github.com/crab-fan/crab-fan');
  assert.ok(v.workflow.includes(`https://gist.githubusercontent.com/crab-fan/${GIST}/raw/${PROFILE_FILE}`));
  assert.equal(v.readme, README_LINE);
});

test('rawUrl and workflowYaml refuse a login or gist id that could break out of the YAML', () => {
  assert.equal(rawUrl('crab-fan"; rm -rf /', GIST), null);
  assert.equal(rawUrl('crab-fan', '../../etc'), null);
  assert.equal(workflowYaml('crab-fan', 'nope'), null);
  assert.match(workflowYaml('crab-fan', GIST), /permissions:\n {2}contents: write/);
});

test('a publish that arrives while the card is being taken down is refused', async () => {
  const { gh, card } = setup();
  await card.publish(SVG);
  let release;
  gh.delete = path => new Promise(r => { release = () => { gh.gists.delete(path.split('/').pop()); r(null); }; });
  const down = card.takeDown();
  await new Promise(r => setImmediate(r));
  assert.equal((await card.publish(SVG.replace('Lv 3', 'Lv 9'))).ok, false);
  release();
  assert.deepEqual(await down, { ok: true });
  assert.equal(gh.gists.size, 0);
  assert.equal(card.isUp, false);
});

// A profile repository as the REST API sees it: files maps path -> text.
function fakeRepo({ exists = true, isPrivate = false, branch = 'main', files = {} } = {}) {
  const calls = [];
  const notFound = () => Object.assign(new Error('Not Found'), { status: 404 });
  return {
    calls,
    async get(path) {
      calls.push(path);
      if (!exists) throw notFound();
      if (path === '/repos/crab-fan/crab-fan') return { private: isPrivate, default_branch: branch };
      if (path === '/repos/crab-fan/crab-fan/readme') {
        if (!('README.md' in files)) throw notFound();
        return { path: 'README.md', content: Buffer.from(files['README.md']).toString('base64') };
      }
      const m = /^\/repos\/crab-fan\/crab-fan\/contents\/(.+)$/.exec(path);
      const file = m && decodeURIComponent(m[1]);
      if (file && file in files) return { path: file };
      throw notFound();
    },
  };
}

test('setupProgress: no profile repository yet means nothing is done', async () => {
  const p = await setupProgress(fakeRepo({ exists: false }), 'crab-fan');
  assert.deepEqual(p, { repo: false, isPublic: false, branch: null, action: false, card: false, readme: false, readmePath: null });
});

test('setupProgress ticks off each step it finds in the repository', async () => {
  const half = await setupProgress(fakeRepo({ files: { [WORKFLOW_PATH]: 'yaml', 'README.md': '# Hi' } }), 'crab-fan');
  assert.equal(half.repo, true);
  assert.equal(half.isPublic, true);
  assert.equal(half.action, true);
  assert.equal(half.card, false);
  assert.equal(half.readme, false, 'a README without the card line');
  assert.equal(half.readmePath, 'README.md');
  const all = await setupProgress(fakeRepo({ branch: 'trunk', files: { [WORKFLOW_PATH]: 'yaml', [PROFILE_FILE]: '<svg/>', 'README.md': `# Hi\n${README_LINE}\n` } }), 'crab-fan');
  assert.deepEqual({ ...all, readmePath: undefined }, { repo: true, isPublic: true, branch: 'trunk', action: true, card: true, readme: true, readmePath: undefined });
});

test('setupProgress notices a private profile repository and passes on errors that are not 404', async () => {
  assert.equal((await setupProgress(fakeRepo({ isPrivate: true }), 'crab-fan')).isPublic, false);
  const down = { get: async () => { throw Object.assign(new Error('rate limited'), { status: 403 }); } };
  await assert.rejects(setupProgress(down, 'crab-fan'), /rate limited/);
  assert.equal(await setupProgress(down, 'crab-fan"; x'), null);
});

test('setupLinks prefill the Action and README on the right branch', () => {
  const l = setupLinks('crab-fan', GIST, { branch: 'trunk' });
  assert.equal(l.createRepo, 'https://github.com/new?name=crab-fan&visibility=public&description=My%20GitHub%20profile');
  const add = new URL(l.addAction);
  assert.equal(add.pathname, '/crab-fan/crab-fan/new/trunk');
  assert.equal(add.searchParams.get('filename'), WORKFLOW_PATH);
  assert.equal(add.searchParams.get('value'), workflowYaml('crab-fan', GIST));
  assert.equal(new URL(l.readme).searchParams.get('value'), `${README_LINE}\n`, 'no README yet: a new one with the line in it');
  assert.equal(setupLinks('crab-fan', GIST, { branch: 'main', readmePath: 'README.md' }).readme, 'https://github.com/crab-fan/crab-fan/edit/main/README.md');
  assert.equal(setupLinks('crab-fan', null).addAction, null, 'no gist, no Action');
  assert.equal(setupLinks('../x', GIST), null);
});

test('ProfileCard.setup reports progress, and a friendly error when GitHub fails', async () => {
  const { card } = setup();
  await card.publish(SVG);
  card.github.gh = () => fakeRepo({ files: { [WORKFLOW_PATH]: 'yaml' } });
  const r = await card.setup();
  assert.equal(r.ok, true);
  assert.equal(r.progress.action, true);
  assert.ok(r.links.addAction.includes(GIST));
  card.github.gh = () => ({ get: async () => { throw Object.assign(new Error('Bad credentials'), { status: 401 }); } });
  const bad = await card.setup();
  assert.equal(bad.ok, false);
  assert.match(bad.error, /Sign in again/);
  assert.ok(bad.links.createRepo, 'links still there to try by hand');
});

test('a card the panel really drew (fixture) passes cleanSvg', () => {
  const svg = require('fs').readFileSync(require('path').join(__dirname, 'fixtures', 'profile-card.svg'), 'utf8');
  assert.notEqual(cleanSvg(svg), null);
  assert.doesNotMatch(svg, /[^\x00-\x7f]/, 'all ASCII, emoji as entities');
  assert.doesNotMatch(svg, /data-sticker/, 'no project ids');
});
