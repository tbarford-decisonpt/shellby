// "New comments" on your pull requests (github/comments.js), and the CI
// watcher carrying them: newer than your own last word and your last look,
// bots on the conversation ignored, read again only when the PR moves.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { entries, summarize } = require('../src/main/github/comments');
const { CiWatcher, normalizeSeen } = require('../src/main/github/ci');

const t = h => `2026-10-0${Math.floor(h / 24) + 1}T${String(h % 24).padStart(2, '0')}:00:00Z`;
const ms = h => Date.parse(t(h));
const user = (login, type = 'User') => ({ login, type });

test('entries merges the three lists oldest first and drops bot chatter on the conversation', () => {
  const list = entries({
    comments: [{ user: user('alice'), created_at: t(3) }, { user: user('vercel[bot]', 'Bot'), created_at: t(4) }],
    lineComments: [{ user: user('copilot[bot]', 'Bot'), created_at: t(2) }],
    reviews: [
      { user: user('bob'), submitted_at: t(5), state: 'CHANGES_REQUESTED', body: 'Needs work' },
      { user: user('bob'), submitted_at: t(1), state: 'PENDING', body: '' },
    ],
  });
  assert.deepEqual(list.map(e => [e.by, e.kind]), [['copilot[bot]', 'line'], ['alice', 'comment'], ['bob', 'review']]);
});

test('entries rejects odd logins and dates rather than trusting them', () => {
  const list = entries({ comments: [{ user: user('a b'), created_at: t(1) }, { user: user('ok'), created_at: 'yesterday' }, null] });
  assert.deepEqual(list, []);
});

test('summarize: only what others said since you last spoke or looked', () => {
  const list = entries({
    comments: [
      { user: user('alice'), created_at: t(1) },
      { user: user('Me'), created_at: t(2) },
      { user: user('alice'), created_at: t(3) },
      { user: user('bob'), created_at: t(4) },
    ],
  });
  const s = summarize(list, 'me');
  assert.equal(s.unread, 2, 'your own reply (any case) clears what came before it');
  assert.deepEqual(s.people, ['bob', 'alice'], 'newest first');
  assert.equal(s.lastAt, ms(4));
  assert.equal(summarize(list, 'me', ms(3)).unread, 1, 'a look in Shellby clears what was there then');
  assert.equal(summarize(list, 'me', ms(5)).unread, 0);
});

test('summarize: a review wrapper is not news, its line comments are; the latest verdict is kept', () => {
  const list = entries({
    lineComments: [{ user: user('bob'), created_at: t(2) }],
    reviews: [
      { user: user('bob'), submitted_at: t(1), state: 'APPROVED', body: '' },
      { user: user('bob'), submitted_at: t(2), state: 'COMMENTED', body: '' },
      { user: user('carol'), submitted_at: t(3), state: 'CHANGES_REQUESTED', body: 'Hmm' },
    ],
  });
  const s = summarize(list, 'me');
  assert.equal(s.unread, 3, 'approval, line comment and the change request; not the empty wrapper');
  assert.equal(s.verdict, 'changes');
});

test('normalizeSeen keeps only PR keys with times', () => {
  assert.deepEqual(normalizeSeen({ 'a/b#1': 5, 'nope': 3, 'a/b#2': 'x', 'a/b#3': -1 }), { 'a/b#1': 5 });
  assert.deepEqual(normalizeSeen(null), {});
});

// A GitHub with one PR of yours whose conversation you can add to.
function fakeGitHub() {
  const api = 'https://api.github.com';
  const sha = 'e'.repeat(40);
  const gh = {
    comments: [],
    updated: t(1),
    calls: 0,
    asked: [{ number: 9, title: 'Their PR', repository_url: `${api}/repos/them/x`, user: user('them'), updated_at: t(2), draft: true }],
    get: async p => {
      if (p.startsWith('/search/issues') && p.includes('author')) return { items: [{ number: 4, title: 'Mine', repository_url: `${api}/repos/me/crab`, user: user('me') }] };
      if (p.startsWith('/search/issues')) return { total_count: 14, items: gh.asked };
      if (p === '/repos/me/crab/pulls/4') return { head: { sha }, updated_at: gh.updated, comments: gh.comments.length };
      if (p.startsWith('/repos/me/crab/issues/4/comments')) { gh.calls++; return gh.comments; }
      if (p.startsWith('/repos/me/crab/pulls/4/reviews')) return [];
      if (p.includes('/check-runs')) return { check_runs: [] };
      if (p.endsWith('/status')) return { statuses: [] };
      return null;
    },
  };
  return { gh, api };
}

test('the watcher reports new comments once, reads them only when the PR moved, and forgets on a look', async () => {
  const { gh, api } = fakeGitHub();
  let saved = null;
  let now = ms(10);
  const w = new CiWatcher({ gh: () => gh, login: () => 'me', api, now: () => now, seen: { load: () => null, save: v => { saved = v; } } });
  const events = [];
  w.on('event', e => events.push(e));

  gh.comments = [{ user: user('alice'), created_at: t(1) }];
  let v = await w.poll();
  assert.equal(v.prs[0].talk.unread, 1, 'what was already there shows in the inbox');
  assert.deepEqual(events, [], '...but the first poll makes no noise');
  assert.equal(v.reviews[0].author, 'them');
  assert.equal(v.reviews[0].draft, true);
  assert.equal(v.reviewsTotal, 14);

  await w.poll();
  assert.equal(gh.calls, 1, 'nothing moved, nothing read again');

  gh.comments = [...gh.comments, { user: user('bob'), created_at: t(5) }];
  gh.updated = t(5);
  v = await w.poll();
  assert.equal(v.prs[0].talk.unread, 2);
  assert.equal(v.unread, 1);
  assert.deepEqual(events.map(e => [e.type, e.key]), [['comment', 'me/crab#4']]);

  now = ms(11);
  assert.equal(w.markSeen('me/crab#4'), true);
  assert.equal(w.view().prs[0].talk.unread, 0);
  assert.deepEqual(saved, { 'me/crab#4': ms(11) });
  assert.equal(w.markSeen('someone/else#1'), false, 'only a PR it listed');
});

test('a Mark read while a poll is out is not undone by it, and makes no notification', async () => {
  const { gh, api } = fakeGitHub();
  let now = ms(10);
  const w = new CiWatcher({ gh: () => gh, login: () => 'me', api, now: () => now });
  const events = [];
  w.on('event', e => events.push(e));
  gh.comments = [{ user: user('alice'), created_at: t(1) }];
  await w.poll();
  // The next poll finds a new comment on #4, works out #4's talk, and is held up
  // on a second PR (#5) while you mark #4 read.
  gh.comments = [...gh.comments, { user: user('bob'), created_at: t(5) }];
  gh.updated = t(5);
  let release;
  const gate = new Promise(r => { release = r; });
  let talkDone;
  const fourDone = new Promise(r => { talkDone = r; });
  const get = gh.get;
  gh.get = async p => {
    if (p.startsWith('/search/issues') && p.includes('author')) {
      return { items: [4, 5].map(n => ({ number: n, title: `PR ${n}`, repository_url: `${api}/repos/me/crab`, user: user('me') })) };
    }
    if (p.startsWith('/repos/me/crab/pulls/4/reviews')) talkDone();
    if (p === '/repos/me/crab/pulls/5') return { head: { sha: 'f'.repeat(40) }, updated_at: t(6) };
    if (p.startsWith('/repos/me/crab/pulls/5/reviews')) { await gate; return []; }
    return get(p);
  };
  const out = w.poll();
  await fourDone;
  await new Promise(r => setTimeout(r, 20));
  now = ms(11);
  w.markSeen('me/crab#4');
  release();
  const v = await out;
  assert.equal(v.prs.find(p => p.key === 'me/crab#4').talk.unread, 0, 'still read');
  assert.deepEqual(events, [], 'and no "New on" for what you just read');
});

test("Mark read goes by GitHub's newest comment when this PC's clock is behind", () => {
  const { gh, api } = fakeGitHub();
  const w = new CiWatcher({ gh: () => gh, login: () => 'me', api, now: () => ms(1) });
  w.state = { ...w.state, prs: [{ key: 'me/crab#4', talk: { unread: 1 } }] };
  w.talk.set('me/crab#4', { updatedAt: t(5), list: entries({ comments: [{ user: user('bob'), created_at: t(5) }] }) });
  w.markSeen('me/crab#4');
  assert.equal(w.seen['me/crab#4'], ms(5));
  assert.equal(w.view().prs[0].talk.unread, 0);
});
