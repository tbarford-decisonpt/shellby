// Visiting crabs: friends' Shellbys drop by your desktop, leave a souvenir in
// the guestbook, and wave at each other. All of it rides on GitHub gists (see
// src/main/github/card.js and mail.js), so there's no Shellby server. Your
// calling card is public, which is why the whole thing is its own opt-in.
const { EventEmitter } = require('events');
const card = require('./github/card');
const mail = require('./github/mail');

const MAX_FRIENDS = 30;
const MAX_GUESTBOOK = 60;
const MAX_INBOX = 20;
const TICK_MS = 5 * 60 * 1000;
const REFRESH_MS = 15 * 60 * 1000;
const VISIT_MS = 3 * 60 * 1000;
const VISIT_GAP_MS = 40 * 60 * 1000;      // at most about one drop-in an hour...
const SAME_FRIEND_GAP_MS = 6 * 3600 * 1000; // ...and the same friend a few times a day
const VISIT_CHANCE = 0.35;                 // per tick, once the gap has passed
const FRESH_MS = 14 * 24 * 3600 * 1000;    // a card nobody touched in two weeks doesn't visit on its own

// Things the two crabs get up to while a friend is over. Each has a few lines
// for Shellby and an animation in critter.css (body.together-<id>).
const TOGETHER = Object.freeze([
  { id: 'dance', lines: ['dance party!', 'shake it!', 'look at us go'] },
  { id: 'party', lines: ['party time!', 'woo!', 'best visit ever'] },
  { id: 'highfive', lines: ['high five!', 'up top!', 'claw bump!'] },
  { id: 'sing', lines: ['la la la', 'crab duet!', 'sing it!'] },
]);
const TOGETHER_FIRST_MS = 9000;  // after the hello line has had its moment
const TOGETHER_EVERY_MS = 45000; // a few times in a three-minute visit
const TOGETHER_MS = 5200;        // how long one lasts

/** The next thing to do together: never the same twice in a row. */
function pickTogether(last, rand = Math.random) {
  const pool = TOGETHER.filter(t => t.id !== last);
  const t = pool[Math.floor(rand() * pool.length) % pool.length];
  return { id: t.id, line: t.lines[Math.floor(rand() * t.lines.length) % t.lines.length], ms: TOGETHER_MS };
}

// Little keepsakes a visitor leaves. Which one is decided by who visited and
// on which day, so every friend brings a mix over time.
const SOUVENIRS = Object.freeze([
  { id: 'sea-glass', name: 'Sea glass', palette: { a: '#7fd6c2', b: '#c8f3e8' }, pixels: ['.ab.', 'aaab', '.aa.'] },
  { id: 'sand-dollar', name: 'Sand dollar', palette: { a: '#f3e6cc', b: '#c9b38a' }, pixels: ['.aaa.', 'aabaa', 'abbba', 'aabaa', '.aaa.'] },
  { id: 'pebble', name: 'Smooth pebble', palette: { a: '#8d99ae', b: '#b8c2d1' }, pixels: ['.bb.', 'abba', '.aa.'] },
  { id: 'tiny-shell', name: 'Tiny shell', palette: { a: '#ff9f80', b: '#ffd2c2' }, pixels: ['..a..', '.aba.', 'ababa', 'aaaaa'] },
  { id: 'star', name: 'Starfish', palette: { a: '#ff7a5c', b: '#ffb199' }, pixels: ['..a..', 'aabaa', '.aba.', 'a...a'] },
  { id: 'pearl', name: 'Pearl', palette: { a: '#f8f4ff', b: '#cfc6e6' }, pixels: ['.aa.', 'aaab', '.bb.'] },
  { id: 'kelp', name: 'Bit of kelp', palette: { a: '#2a9d8f', b: '#57cc99' }, pixels: ['.a', 'ab', 'a.', 'ab', '.a'] },
  { id: 'bottle-cap', name: 'Bottle cap', palette: { a: '#e63946', b: '#ffd6d9' }, pixels: ['abab', 'aaaa'] },
]);

const hash = s => { let h = 2166136261; for (const ch of String(s)) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619) >>> 0; } return h; };
const dayOf = t => new Date(t).toISOString().slice(0, 10);
const souvenirFor = (login, at) => SOUVENIRS[hash(`${String(login).toLowerCase()}|${dayOf(at)}`) % SOUVENIRS.length];
const num = v => (Number.isFinite(v) && v > 0 ? v : 0);
const isLogin = v => typeof v === 'string' && card.LOGIN_RE.test(v);

/** Tolerate anything read from disk. */
function normalize(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const seen = new Set();
  const list = (Array.isArray(r.list) ? r.list : []).filter(f => {
    if (!isLogin(f?.login) || seen.has(f.login.toLowerCase())) return false;
    seen.add(f.login.toLowerCase());
    return true;
  }).slice(0, MAX_FRIENDS).map(f => ({
    login: f.login,
    cardId: typeof f.cardId === 'string' && /^[A-Za-z0-9]{1,64}$/.test(f.cardId) ? f.cardId : null,
    card: f.card ? card.cleanCard(f.card) : null,
    checkedAt: num(f.checkedAt),
    visitedAt: num(f.visitedAt),
  }));
  const byId = new Set(SOUVENIRS.map(s => s.id));
  return {
    list,
    cardId: typeof r.cardId === 'string' && /^[A-Za-z0-9]{1,64}$/.test(r.cardId) ? r.cardId : null,
    publishedLook: typeof r.publishedLook === 'string' ? r.publishedLook.slice(0, 2000) : null,
    mailCursor: { page: num(r.mailCursor?.page) || 1, ...(Number.isSafeInteger(r.mailCursor?.seenId) ? { seenId: r.mailCursor.seenId } : {}) },
    guestbook: (Array.isArray(r.guestbook) ? r.guestbook : [])
      .filter(g => isLogin(g?.login) && num(g.at) && byId.has(g.souvenir))
      .map(g => ({ login: g.login, at: g.at, souvenir: g.souvenir })).slice(0, MAX_GUESTBOOK),
    inbox: (Array.isArray(r.inbox) ? r.inbox : [])
      .filter(m => isLogin(m?.from) && mail.isWave(m.wave) && num(m.at))
      .map(m => ({ from: m.from, wave: m.wave, at: m.at })).slice(0, MAX_INBOX),
    publishedAt: num(r.publishedAt),
    lastVisitAt: num(r.lastVisitAt),
    lastRefreshAt: num(r.lastRefreshAt),
    error: typeof r.error === 'string' ? r.error.slice(0, 200) : null,
  };
}

/** Friends who could drop in on their own right now. */
function eligible(state, now) {
  return state.list.filter(f => f.card && now - f.card.updatedAt < FRESH_MS && now - f.visitedAt > SAME_FRIEND_GAP_MS);
}

/** Should someone drop in on this tick? Returns the friend, or null. */
function pickVisitor(state, now, rand = Math.random) {
  if (now - state.lastVisitAt < VISIT_GAP_MS) return null;
  const pool = eligible(state, now);
  if (!pool.length || rand() >= VISIT_CHANCE) return null;
  return pool[Math.floor(rand() * pool.length) % pool.length];
}

class Friends extends EventEmitter {
  /**
   * config: Shellby's Config. github: the GitHubService (can/gh/view).
   * myCard(): your look as a card. canVisit(): is he free for company (idle,
   * not guarding your focus)? Emits 'change' (view), 'visit' ({ login, card,
   * until } or null when they leave), 'together' ({ id, line, ms }: do something
   * together, only while he's free), 'wave' ({ from, wave, text }), 'record' (stat event).
   */
  constructor({ config, github, myCard, canVisit = () => true, now = () => Date.now(), rand = Math.random }) {
    super();
    Object.assign(this, { config, github, myCard, canVisit, now, rand });
    this.timer = null;
    this.leaveTimer = null;
    this.togetherTimers = [];
    this.visiting = null;
    this.refreshing = null;
  }

  get state() { return normalize(this.config.get('friends')); }
  save(patch) { this.config.set({ friends: { ...this.state, ...patch } }); this.emit('change', this.view()); }
  get enabled() { return this.github.can('friends'); }
  me() { return this.github.view().login; }

  view() {
    const s = this.state;
    return {
      enabled: this.enabled,
      me: this.enabled ? this.me() : null,
      cardUrl: s.cardId ? `https://gist.github.com/${s.cardId}` : null,
      refreshing: !!this.refreshing,
      error: s.error,
      visiting: this.visiting ? { login: this.visiting.login, until: this.visiting.until } : null,
      friends: s.list.map(f => ({ login: f.login, card: f.card, checkedAt: f.checkedAt, visitedAt: f.visitedAt })),
      guestbook: s.guestbook,
      inbox: s.inbox.map(m => ({ ...m, text: mail.WAVES[m.wave] })),
      souvenirs: SOUVENIRS.map(x => ({ ...x, count: s.guestbook.filter(g => g.souvenir === x.id).length })),
      waves: Object.entries(mail.WAVES).map(([id, text]) => ({ id, text })),
    };
  }

  start() {
    clearInterval(this.timer);
    this.timer = null;
    if (!this.enabled) return;
    this.timer = setInterval(() => this.tick().catch(() => {}), TICK_MS);
    if (this.now() - this.state.lastRefreshAt > REFRESH_MS) this.refresh().catch(() => {});
  }

  stop() { clearInterval(this.timer); this.timer = null; this.leave(); }

  async tick() {
    if (!this.enabled) return;
    if (this.now() - this.state.lastRefreshAt >= REFRESH_MS) await this.refresh().catch(() => {});
    if (this.visiting || !this.canVisit()) return;
    const f = pickVisitor(this.state, this.now(), this.rand);
    if (f) this.arrive(f);
  }

  // ---------------------------------------------------------------- the gists

  /** Publish your card if it changed, fetch friends' cards, pick up waves. */
  refresh() {
    if (!this.enabled) return Promise.resolve({ ok: false, error: 'Visiting crabs is off.' });
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      this.emit('change', this.view());
      const gh = this.github.gh();
      try {
        const s = this.state;
        const mine = { ...this.myCard(), login: this.me(), updatedAt: this.now() };
        let cardId = s.cardId;
        // Republished on a look change, and once a day so friends can tell you're around.
        if (!this.enabled) return { ok: false, error: 'Visiting crabs is off.' }; // turned off while we waited
        if (!cardId || s.publishedLook !== card.lookOf(mine) || this.now() - s.publishedAt > 24 * 3600 * 1000) {
          cardId = await card.publishCard(gh, mine, cardId);
          this.save({ cardId, publishedLook: card.lookOf(mine), publishedAt: this.now() });
        }
        const list = [];
        for (const f of this.state.list) {
          try {
            const hit = await card.findCard(gh, f.login, f.cardId);
            list.push({ login: f.login, cardId: hit?.id || null, card: hit?.card || null, checkedAt: this.now() });
          } catch (e) {
            if (e.status === 401) throw e; // one friend's hiccup shouldn't drop the others
          }
        }
        this.mergeList(list);
        await this.collectWaves(gh, cardId);
        this.save({ lastRefreshAt: this.now(), error: null });
        return { ok: true };
      } catch (e) {
        const error = e.status === 401 ? 'GitHub signed Shellby out. Sign in again for visits.' : `Couldn't reach GitHub: ${String(e.message).slice(0, 150)}`;
        this.save({ error, lastRefreshAt: this.now() });
        return { ok: false, error };
      } finally {
        this.refreshing = null;
        this.emit('change', this.view());
      }
    })();
    return this.refreshing;
  }

  // Only what was fetched is laid over the current list: friends added or
  // removed, and visits that happened, while the refresh was out stay that way.
  mergeList(fetched) {
    this.save({ list: this.state.list.map(f => {
      const x = fetched.find(y => card.sameLogin(y.login, f.login));
      return x ? { ...f, cardId: x.cardId, card: x.card, checkedAt: x.checkedAt } : f;
    }) });
  }

  async collectWaves(gh, cardId) {
    const s = this.state;
    const r = await mail.checkWaves(gh, cardId, { cursor: s.mailCursor, friends: s.list.map(f => f.login), me: this.me() });
    const fresh = r.waves.map(w => ({ from: w.from, wave: w.wave, at: w.at || this.now() }));
    this.save({ mailCursor: r.cursor, inbox: [...[...fresh].reverse(), ...s.inbox].slice(0, MAX_INBOX) });
    for (const w of fresh) this.emit('wave', { ...w, text: `@${w.from} ${mail.WAVES[w.wave]}` });
  }

  async add(loginIn) {
    const login = String(loginIn || '').trim().replace(/^@/, '').replace(/^https:\/\/github\.com\//i, '').replace(/\/+$/, '');
    if (!card.LOGIN_RE.test(login)) return { ok: false, error: "That doesn't look like a GitHub username." };
    if (!this.enabled) return { ok: false, error: 'Turn on Visiting crabs first.' };
    if (card.sameLogin(login, this.me())) return { ok: false, error: "That's you! Your crab is already home." };
    const s = this.state;
    if (s.list.some(f => card.sameLogin(f.login, login))) return { ok: false, error: `@${login} is already a friend.` };
    if (s.list.length >= MAX_FRIENDS) return { ok: false, error: `That's ${MAX_FRIENDS} friends already. Remove one first.` };
    let hit;
    try { hit = await card.findCard(this.github.gh(), login, null); } catch (e) {
      if (e.status === 404) return { ok: false, error: `GitHub has no user called @${login}.` };
      return { ok: false, error: `Couldn't reach GitHub: ${String(e.message).slice(0, 150)}` };
    }
    // Add the latest list, not the one from before the lookup.
    const friend = { login: hit?.card.login || login, cardId: hit?.id || null, card: hit?.card || null, checkedAt: this.now(), visitedAt: 0 };
    this.save({ list: [...this.state.list, friend] });
    return { ok: true, hasCard: !!hit };
  }

  remove(login) {
    this.save({ list: this.state.list.filter(f => !card.sameLogin(f.login, login)) });
    if (this.visiting && card.sameLogin(this.visiting.login, login)) this.leave();
    return { ok: true };
  }

  async wave(login, waveKey) {
    if (!this.enabled) return { ok: false, error: 'Turn on Visiting crabs first.' };
    if (!mail.isWave(waveKey)) return { ok: false, error: 'Unknown wave.' };
    const f = this.state.list.find(x => card.sameLogin(x.login, login));
    if (!f) return { ok: false, error: 'Add them as a friend first.' };
    if (!f.cardId) return { ok: false, error: `@${f.login} hasn't turned on Visiting crabs yet, so there's nowhere to send it.` };
    try {
      await mail.sendWave(this.github.gh(), f.cardId, waveKey, this.me());
    } catch (e) {
      return { ok: false, error: e.status === 404 ? `@${f.login}'s card is gone. They may have turned visits off.` : `Couldn't send it: ${String(e.message).slice(0, 150)}` };
    }
    this.emit('record', 'wave-sent');
    return { ok: true };
  }

  // ---------------------------------------------------------------- visits

  /** Have a friend over now (the Invite button). */
  invite(login) {
    if (!this.enabled) return { ok: false, error: 'Turn on Visiting crabs first.' };
    const f = this.state.list.find(x => card.sameLogin(x.login, login));
    if (!f?.card) return { ok: false, error: `@${login} has no calling card yet. Ask them to turn on Visiting crabs.` };
    if (!this.canVisit()) return { ok: false, error: "He's busy or guarding your focus. Try again in a bit." };
    this.leave();
    this.arrive(f);
    return { ok: true };
  }

  arrive(f) {
    const at = this.now();
    const souvenir = souvenirFor(f.login, at);
    const s = this.state;
    // Inviting the same friend over and over is fine, but it's one guestbook
    // entry (and one souvenir) per visit window, not one per click.
    const signs = at - (s.list.find(x => card.sameLogin(x.login, f.login))?.visitedAt || 0) >= SAME_FRIEND_GAP_MS;
    if (signs) this.save({
      lastVisitAt: at,
      list: s.list.map(x => (card.sameLogin(x.login, f.login) ? { ...x, visitedAt: at } : x)),
      guestbook: [{ login: f.login, at, souvenir: souvenir.id }, ...s.guestbook].slice(0, MAX_GUESTBOOK),
    });
    else this.save({ lastVisitAt: at });
    // `signed`: the first visit in its window, the one that may leave a sticker swap (main.js).
    this.visiting = { login: f.login, card: f.card, until: at + VISIT_MS, souvenir, signed: signs };
    clearTimeout(this.leaveTimer);
    this.leaveTimer = setTimeout(() => this.leave(), VISIT_MS);
    this.planTogether();
    // Counted first: a trophy it unlocks has a line of its own, and the visitor's goes last.
    if (signs) this.emit('record', 'visitor-hosted');
    this.emit('visit', this.visiting);
    this.emit('change', this.view());
  }

  // A few shared moments spread over the visit. Each one checks he's still free
  // when its time comes: a task that started meanwhile, or focus, skips it.
  planTogether() {
    this.togetherTimers.forEach(clearTimeout);
    let last = null;
    this.togetherTimers = [];
    for (let at = TOGETHER_FIRST_MS; at < VISIT_MS - TOGETHER_MS; at += TOGETHER_EVERY_MS) {
      this.togetherTimers.push(setTimeout(() => {
        if (!this.visiting || !this.canVisit()) return;
        const t = pickTogether(last, this.rand);
        last = t.id;
        this.emit('together', t);
      }, at));
    }
  }

  leave() {
    clearTimeout(this.leaveTimer);
    this.leaveTimer = null;
    this.togetherTimers.forEach(clearTimeout);
    this.togetherTimers = [];
    if (!this.visiting) return;
    this.visiting = null;
    this.emit('visit', null);
    this.emit('change', this.view());
  }

  /** Visiting crabs turned off: take the card down so it isn't public any more. */
  async takeDown() {
    this.stop();
    // A refresh still out could publish the card after we delete it: let it land first.
    await this.refreshing?.catch(() => {});
    if (!this.github.signedIn) return { ok: true };
    try {
      await card.deleteCard(this.github.gh(), this.state.cardId);
    } catch (e) {
      // cardId stays, so the next try (or sign-out) finds it again.
      return { ok: false, error: `Couldn't delete your calling card gist: ${String(e.message).slice(0, 150)}. You can delete it on gist.github.com.` };
    }
    // A new card later starts with a fresh mail cursor: the old one points into the deleted gist's comments.
    this.save({ cardId: null, publishedLook: null, publishedAt: 0, mailCursor: {} });
    return { ok: true };
  }
}

module.exports = { Friends, normalize, pickVisitor, pickTogether, TOGETHER, TOGETHER_FIRST_MS, eligible, souvenirFor, SOUVENIRS, VISIT_MS, VISIT_GAP_MS, SAME_FRIEND_GAP_MS, FRESH_MS };
