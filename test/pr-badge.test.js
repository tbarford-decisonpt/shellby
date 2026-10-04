const test = require('node:test');
const assert = require('node:assert/strict');
const { PrBadge, REPO, START, END, isPrCreate, prFromOutput, pictureUrl, badgeBlock, withBadge } = require('../src/main/github/pr-badge');

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="64"><rect width="4" height="4" fill="#ff7a5c"/></svg>';
const SVG2 = SVG.replace('#ff7a5c', '#ffc15e');
const SHA = 'a'.repeat(40);
const LOGIN = 'crab-fan';

class MemConfig {
  constructor(data = {}) { this.data = { ...data }; }
  get(k) { return this.data[k]; }
  set(p) { this.data = { ...this.data, ...p }; return this.data; }
}

const notFound = () => Object.assign(new Error('Not Found'), { status: 404 });

// Just enough of GitHub for one signed-in user: their repos, one file each, and pull requests.
function fakeGitHub({ prs = {}, existingRepo = null } = {}) {
  const repos = new Map(existingRepo ? [[`${LOGIN}/${REPO}`, existingRepo]] : []);
  const files = new Map();
  const made = new Set(); // commit shas in the badge repo
  const calls = [];
  let commits = 0;
  return {
    repos, files, prs, calls, made,
    async get(path) {
      calls.push(['GET', path]);
      let m = /^\/repos\/[^/]+\/[^/]+\/commits\/([0-9a-f]{40})$/.exec(path);
      if (m) { if (!made.has(m[1])) throw notFound(); return { sha: m[1] }; }
      m = /^\/repos\/([^/]+\/[^/]+)$/.exec(path);
      if (m) { if (!repos.has(m[1])) throw notFound(); return repos.get(m[1]); }
      m = /^\/repos\/[^/]+\/[^/]+\/contents\/(.+)$/.exec(path);
      if (m) { if (!files.has(m[1])) throw notFound(); return files.get(m[1]); }
      m = /^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/.exec(path);
      if (m) { const pr = prs[`${m[1]}#${m[2]}`]; if (!pr) throw notFound(); return pr; }
      throw notFound();
    },
    async post(path, body) {
      calls.push(['POST', path, body]);
      const r = { name: body.name, private: body.private };
      repos.set(`${LOGIN}/${body.name}`, r);
      return r;
    },
    async put(path, body) {
      calls.push(['PUT', path, body]);
      const name = path.split('/contents/')[1];
      if (files.has(name) && body.sha !== files.get(name).sha) throw Object.assign(new Error('sha mismatch'), { status: 409 });
      commits += 1;
      const sha = String(commits).padStart(40, '0');
      made.add(sha);
      files.set(name, { sha: `blob${commits}`, content: body.content });
      return { content: { sha: `blob${commits}` }, commit: { sha } };
    },
    async patch(path, body) {
      calls.push(['PATCH', path, body]);
      const m = /^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/.exec(path);
      prs[`${m[1]}#${m[2]}`].body = body.body;
      return prs[`${m[1]}#${m[2]}`];
    },
  };
}

function setup({ on = true, level = 12, ...gh } = {}) {
  const fake = fakeGitHub(gh);
  const github = { signedIn: true, can: f => on && f === 'prBadge', gh: () => fake, view: () => ({ login: LOGIN }) };
  const config = new MemConfig();
  return { gh: fake, config, badge: new PrBadge({ config, github, level: () => level }) };
}

const pr = (body, login = LOGIN) => ({ body, user: { login } });

test('isPrCreate spots gh pr create, but not rehearsals or the browser form', () => {
  assert.equal(isPrCreate('gh pr create --title "Fix" --body "x"'), true);
  assert.equal(isPrCreate('git push -u origin HEAD && gh pr create --fill'), true);
  assert.equal(isPrCreate('gh pr create --dry-run --fill'), false);
  assert.equal(isPrCreate('gh pr create --web'), false);
  assert.equal(isPrCreate('gh pr view 12'), false);
  assert.equal(isPrCreate(null), false);
});

test('prFromOutput reads the pull request gh printed', () => {
  const out = 'Creating pull request for shellby/x into main in owner/repo\n\nhttps://github.com/owner/repo.js/pull/42\n';
  assert.deepEqual(prFromOutput(out), { repo: 'owner/repo.js', number: 42 });
  assert.deepEqual(prFromOutput('http://localhost:9/o/r/pull/7', 'http://localhost:9'), { repo: 'o/r', number: 7 });
  assert.equal(prFromOutput('https://github.com/owner/repo/issues/42'), null);
  assert.equal(prFromOutput('https://evil.example/owner/repo/pull/42'), null);
  assert.equal(prFromOutput(undefined), null);
});

test('prFromOutput trusts only the last URL on a line of its own, not one mentioned in passing', () => {
  const out = [
    'hook: see https://github.com/me/old/pull/1 for context',
    'https://github.com/me/other/pull/2',
    'https://github.com/me/repo/pull/3',
  ].join('\n');
  assert.deepEqual(prFromOutput(out), { repo: 'me/repo', number: 3 });
  assert.equal(prFromOutput('Opened https://github.com/me/repo/pull/3 for you'), null);
  assert.equal(prFromOutput('https://github.com/../../pull/3'), null, 'no dot segments in the API path');
});

test('pictureUrl pins the commit, and refuses anything that is not a login and a sha', () => {
  assert.equal(pictureUrl(LOGIN, SHA), `https://raw.githubusercontent.com/${LOGIN}/${REPO}/${SHA}/crab.svg`);
  assert.equal(pictureUrl(LOGIN, SHA, 'http://localhost:9'), `http://localhost:9/${LOGIN}/${REPO}/raw/${SHA}/crab.svg`);
  assert.equal(pictureUrl('bad/login', SHA), null);
  assert.equal(pictureUrl(LOGIN, 'main'), null);
});

test('badgeBlock links to Shellby with the level, between markers', () => {
  const b = badgeBlock({ login: LOGIN, commit: SHA, level: 12 });
  assert.ok(b.startsWith(START) && b.endsWith(END));
  assert.match(b, /Lv 12/);
  assert.match(b, /href="https:\/\/github\.com\/x-salmon\/shellby"/);
  assert.match(b, new RegExp(`raw\\.githubusercontent\\.com/${LOGIN}/${REPO}/${SHA}/crab\\.svg`));
  assert.match(badgeBlock({ login: LOGIN, commit: SHA, level: 500 }), /Lv 99/);
});

test('withBadge appends once and replaces an old badge instead of stacking', () => {
  const b1 = badgeBlock({ login: LOGIN, commit: SHA, level: 3 });
  const b2 = badgeBlock({ login: LOGIN, commit: SHA, level: 4 });
  const once = withBadge('Fixes the thing.\n', b1);
  assert.equal(once, `Fixes the thing.\n\n${b1}`);
  const again = withBadge(once, b2);
  assert.equal(again, `Fixes the thing.\n\n${b2}`);
  assert.equal(withBadge('', b1), b1);
  assert.equal(withBadge(null, b1), b1);
  const huge = 'x'.repeat(59990);
  assert.equal(withBadge(huge, b1), huge, 'no room: left alone');
});

test('the first badge makes a public repo, commits the picture and edits the pull request', async () => {
  const { gh, badge, config } = setup({ prs: { 'o/r#5': pr('My change') } });
  badge.setSvg(SVG);
  const r = await badge.addTo({ repo: 'o/r', number: 5 });
  assert.deepEqual(r, { ok: true, added: true });
  const made = gh.calls.find(c => c[0] === 'POST');
  assert.equal(made[1], '/user/repos');
  assert.equal(made[2].name, REPO);
  assert.equal(made[2].private, false);
  assert.equal(Buffer.from(gh.files.get('crab.svg').content, 'base64').toString('utf8'), SVG);
  const commit = config.get('prBadge').commit;
  assert.match(gh.prs['o/r#5'].body, /^My change\n\n<!-- shellby-badge -->/);
  assert.ok(gh.prs['o/r#5'].body.includes(`/${commit}/crab.svg`));
  assert.match(gh.prs['o/r#5'].body, /Lv 12/);
});

test('the same look is not uploaded twice; a new look is a new commit', async () => {
  const { gh, badge, config } = setup();
  badge.setSvg(SVG);
  await badge.block();
  const first = config.get('prBadge').commit;
  await badge.block();
  assert.equal(gh.calls.filter(c => c[0] === 'PUT').length, 1);
  badge.setSvg(SVG2);
  await badge.block();
  const second = config.get('prBadge').commit;
  assert.notEqual(second, first);
  assert.equal(gh.calls.filter(c => c[0] === 'PUT').length, 2);
  assert.equal(gh.calls.at(-1)[2].sha, 'blob1', 'updates the file it found');
});

test('a pull request that already has the badge, or is somebody else\'s, is left alone', async () => {
  const { gh, badge } = setup({ prs: { 'o/r#1': pr(`Done\n\n${START}\nold\n${END}`), 'o/r#2': pr('Theirs', 'someone-else') } });
  badge.setSvg(SVG);
  assert.deepEqual(await badge.addTo({ repo: 'o/r', number: 1 }), { ok: true, added: false });
  assert.deepEqual(await badge.addTo({ repo: 'o/r', number: 2 }), { ok: true, added: false });
  assert.equal(gh.calls.filter(c => c[0] === 'PATCH').length, 0);
  assert.equal(gh.calls.filter(c => c[0] === 'POST' || c[0] === 'PUT').length, 0, 'nothing uploaded for them');
});

test('a deleted shellby-badge repo is made again rather than linking a picture that is gone', async () => {
  const { gh, badge, config } = setup({ prs: { 'o/r#1': pr('One'), 'o/r#2': pr('Two') } });
  badge.setSvg(SVG);
  await badge.addTo({ repo: 'o/r', number: 1 });
  const first = config.get('prBadge').commit;
  gh.repos.clear(); gh.files.clear(); gh.made.clear(); // you deleted it on GitHub
  await badge.addTo({ repo: 'o/r', number: 2 });
  const second = config.get('prBadge').commit;
  assert.notEqual(second, first);
  assert.ok(gh.prs['o/r#2'].body.includes(`/${second}/crab.svg`));
  assert.equal(gh.calls.filter(c => c[0] === 'POST').length, 2);
});

test('before the panel draws him, his last look is used while it is still up', async () => {
  const { gh, badge, config } = setup();
  badge.setSvg(SVG);
  await badge.block();
  const commit = config.get('prBadge').commit;
  badge.svg = null; // Shellby restarted; the panel hasn't drawn yet
  assert.ok((await badge.block()).includes(`/${commit}/crab.svg`));
  assert.equal(gh.calls.filter(c => c[0] === 'PUT').length, 1);
});

test('turned off while the picture was going up, the pull request is not edited', async () => {
  const { gh, badge } = setup({ prs: { 'o/r#1': pr('Mine') } });
  let on = true;
  badge.github.can = f => on && f === 'prBadge';
  const put = gh.put;
  gh.put = async (...a) => { on = false; return put(...a); };
  badge.setSvg(SVG);
  assert.deepEqual(await badge.addTo({ repo: 'o/r', number: 1 }), { ok: true, added: false });
  assert.equal(gh.prs['o/r#1'].body, 'Mine');
});

test('a private shellby-badge repo is refused, since GitHub would not show the picture', async () => {
  const { badge, config } = setup({ existingRepo: { name: REPO, private: true } });
  badge.setSvg(SVG);
  assert.equal(await badge.block(), null);
  assert.match(config.get('prBadge').error, /private/);
});

test('off, or before the panel drew him, nothing is uploaded', async () => {
  const off = setup({ on: false });
  off.badge.setSvg(SVG);
  assert.equal(await off.badge.block(), null);
  assert.deepEqual(await off.badge.addTo({ repo: 'o/r', number: 1 }), { ok: false, error: 'The pull request badge is off.' });
  assert.equal(off.gh.calls.length, 0);

  const early = setup();
  assert.equal(await early.badge.block(), null);
  assert.match(early.config.get('prBadge').error, /hasn't drawn/);
  assert.equal(early.gh.calls.length, 0);
});

test('setSvg refuses an SVG with anything active in it', () => {
  const { badge } = setup();
  assert.equal(badge.setSvg(SVG.replace('</svg>', '<script>x()</script></svg>')), false);
  assert.equal(badge.svg, null);
  assert.equal(badge.setSvg(SVG), true);
});

test('a failed edit is reported, not thrown', async () => {
  const { badge, config } = setup();
  badge.setSvg(SVG);
  const r = await badge.addTo({ repo: 'o/r', number: 404 });
  assert.equal(r.ok, false);
  assert.match(r.error, /o\/r#404/);
  assert.equal(config.get('prBadge').error, r.error);
});
