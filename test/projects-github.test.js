// Your GitHub repositories for the Projects page (src/main/projects/github.js):
// only checked fields kept, paging, and a cache in front of the API.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseRepos, listRepos, RepoCache } = require('../src/main/projects/github');

const repo = (full_name, extra = {}) => ({ full_name, private: false, html_url: `https://github.com/${full_name}`, description: 'd', pushed_at: '2026-10-01T00:00:00Z', archived: false, fork: false, ...extra });

test('only checked fields are kept, and the URL is built rather than trusted', () => {
  const [r] = parseRepos([repo('me/site', { html_url: 'https://evil.example/', description: 'hi\u0007there', owner: { token: 'x' } })]);
  assert.deepEqual(r, { repo: 'me/site', private: false, url: 'https://github.com/me/site', description: 'hi there', pushedAt: Date.parse('2026-10-01T00:00:00Z'), archived: false, fork: false });
  assert.deepEqual(parseRepos([repo('../bad'), { full_name: 7 }, null]), []);
  assert.deepEqual(parseRepos({ message: 'Bad credentials' }), []);
});

test('pages until a short page, at most three', async () => {
  const asked = [];
  const pages = { 1: Array.from({ length: 100 }, (_, i) => repo(`me/r${i}`)), 2: [repo('me/last')] };
  const all = await listRepos({ get: async p => { asked.push(p); return pages[new URL(`https://x${p}`).searchParams.get('page')] || []; } });
  assert.equal(all.length, 101);
  assert.equal(asked.length, 2);
  assert.match(asked[0], /^\/user\/repos\?affiliation=owner,collaborator,organization_member&sort=pushed&per_page=100&page=1$/);
  const many = await listRepos({ get: async p => Array.from({ length: 100 }, (_, i) => repo(`me/p${p.slice(-1)}x${i}`)) });
  assert.equal(many.length, 300);
});

test('the cache answers for 15 minutes, starts over for another account, and keeps the last list on an error', async () => {
  let now = 0;
  let calls = 0;
  let fail = false;
  const gh = { get: async () => { calls++; if (fail) throw new Error('offline'); return [repo('me/a')]; } };
  const c = new RepoCache({ now: () => now });
  assert.equal((await c.get(gh, 'me')).length, 1);
  await c.get(gh, 'me');
  assert.equal(calls, 1);
  now += 16 * 60 * 1000;
  fail = true;
  assert.equal((await c.get(gh, 'me')).length, 1, 'the last list, not nothing');
  assert.equal(c.error, 'offline');
  fail = false;
  await c.get(gh, 'someone-else');
  assert.equal(calls, 3);
});
