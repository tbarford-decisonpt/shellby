// The Bugdex, wired up: where Shellby sees a bug (a failed command in one of
// his tabs, a crashed dev server, a red build, a clash bringing a copy home, a
// secret stopped at the push), and where he sees it fixed. The rules are the
// pure modules (bugdex.js, bugdex/*.js); this holds the snapshots, the git
// checks, the moment he jars it and the rewards. See docs/plans/bugdex.md.
//
// Nothing a command printed is kept: detect.js reads it and hands back a
// species id and a short hash. A catch needs the code to have changed (or a
// remedy to have run) and the change to be a fix (cheats.js), so a false
// catch is rarer than a missed one.
const crypto = require('crypto');
const path = require('path');
const changes = require('../changes');
const worktrees = require('../worktrees');
const bugdex = require('../bugdex');
const detect = require('../bugdex/detect');
const lifecycle = require('../bugdex/lifecycle');
const { judge } = require('../bugdex/cheats');
const battle = require('../bugdex/battle');
const { speciesById } = require('../bugdex/species');
const { cmdKey } = require('../flaky/ids');
const { projectOf } = require('../gitinfo');
const { activeSeasons } = require('../wardrobe/seasons');
const { normalizeXp } = require('../xp');
const events = require('../events');
const boards = require('../board');
const { makeBattles } = require('./bugdex-battles');
const { makeReward, LIVE } = require('./bugdex-reward');
const { ciSpecies, markersLeft } = require('./bugdex-checks');

// Everything that can be seen: the book's live species, and the hidden one.
const RARITY_ORDER = { common: 0, uncommon: 1, rare: 2, legendary: 3, special: 4 };
const PROJECT_TTL_MS = 60 * 1000;
const MAX_TREES = 30;              // per project: trees seen, for "that's just a revert"
const MAX_REMEDIES = 20;
const STAY_UP_MS = 60 * 1000;      // a fixed dev server has to stay up this long
const SERVER_FIX_WINDOW_MS = 30 * 60 * 1000;
const GIT_MS = 5000;
// Tools that scout rather than change anything: a 'scout' move in a battle.
const SCOUT_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead', 'WebFetch', 'WebSearch']);
// A tide event's bug comes along after the catch that brought it, as a moment of its own.
const EVENT_BUG_AFTER_MS = 4500;

/** d: what main shares (main.js `shared`). */
function wireBugdex(d) {
  const on = () => !d.CAPTURE && !!d.config && d.config.get('catchBugs') !== false && !d.config.get('crabOnly');
  const device = () => normalizeXp(d.config.get('xp')).device || 'local';
  // Always a whole book, even before the first bug (config starts it as null).
  const state = () => {
    const dev = device();
    // Catches from before this PC had its id move onto it.
    return dev !== 'local' ? bugdex.withDevice(d.config.get('bugdex'), dev) : bugdex.normalize(d.config.get('bugdex'));
  };
  const save = s => d.config.set({ bugdex: s });
  const today = () => (d.today ? d.today() : new Date()); // the app's one calendar (today.js)
  const seasons = () => { try { return activeSeasons(today(), d.seasonsWhere?.() || {}).map(x => x.id); } catch { return []; } };

  // ---- memory: never saved

  const projects = new Map();        // lower-cased folder -> { at, p: promise of projectOf }
  const names = new Map();           // project id -> name
  const trees = new Map();           // project id -> [{ tree, at }]
  const remedies = new Map();        // project id -> [{ kind, at }]
  const conflicts = new Map();       // encounter id -> { files } (the files git named)
  const stayUp = new Map();          // dev server id -> timer
  const fixTurns = new Map();        // dev server id -> when its fix turn ended

  function project(dir) {
    if (!dir) return Promise.resolve(null);
    const key = path.resolve(dir).toLowerCase();
    const hit = projects.get(key);
    if (hit && Date.now() - hit.at < PROJECT_TTL_MS) return hit.p;
    const p = projectOf(dir).catch(() => null).then(x => { if (x) { names.set(x.id, x.name); bound(names); } return x; });
    projects.set(key, { at: Date.now(), p });
    if (projects.size > 200) projects.delete(projects.keys().next().value);
    return p;
  }

  /** The folder's git tree now, or null (not a repo, or slower than SNAPSHOT_WAIT_MS). */
  function snapshotWithin(dir) {
    let late = false;
    let timer = null;
    const taken = changes.snapshot(dir).catch(() => null).then(s => (late ? null : s));
    const slow = new Promise(r => { timer = setTimeout(() => { late = true; r(null); }, d.SNAPSHOT_WAIT_MS); });
    return Promise.race([taken, slow]).finally(() => clearTimeout(timer));
  }

  const ringPush = (map, id, row, max) => { map.set(id, [...(map.get(id) || []), row].slice(-max)); bound(map); };
  // None of these may grow for as long as Shellby runs.
  const MAX_KEYS = 200;
  const bound = map => { while (map.size > MAX_KEYS) map.delete(map.keys().next().value); };
  // The first time a tree was seen is what counts: seeing it again after a
  // failure must not make an undo look new.
  const rememberTree = (projectId, tree, at = Date.now()) => {
    if (projectId && tree && !(trees.get(projectId) || []).some(t => t.tree === tree)) ringPush(trees, projectId, { tree, at }, MAX_TREES);
  };
  /** Was this tree the code before the bug turned up (an undo, not a fix)? */
  const wasBefore = (projectId, tree, firstAt) => (trees.get(projectId) || []).some(t => t.tree === tree && t.at < firstAt);
  const remediesSince = (projectId, at) => (remedies.get(projectId) || []).filter(r => r.at >= at).map(r => r.kind);

  // ---- the panel

  function nameMap() {
    const out = {};
    try { for (const p of Object.values(d.stickerState?.()?.projects || {})) if (p?.id && p.name) out[p.id] = p.name; } catch { /* no stickers yet */ }
    for (const [id, name] of names) out[id] = name;
    return out;
  }

  // Friends whose cards share their Bugdex (github/card.js): their reports, on your page.
  const friendBooks = () => (d.config.get('friends')?.list || []).filter(f => f?.card?.bugdex).map(f => ({ login: f.login, bugdex: f.card.bugdex }));

  // The tide event going on (events.js), and when each one is next on, for the book's event bugs.
  function eventInfo() {
    const where = d.seasonsWhere?.() || {};
    const day = today();
    const a = d.activeEvent?.();
    const back = {};
    for (const ev of events.EVENTS) { const at = events.backOn(ev.id, day, where); if (at) back[ev.id] = at.getTime(); }
    return { on: a ? a.ev.id : null, back };
  }

  function view() {
    const tabs = new Set(d.manager ? [...d.manager.tabs.keys()] : []);
    return { ...bugdex.view(state(), Date.now(), { names: nameMap(), tabs, friends: friendBooks(), event: eventInfo() }), board: board() };
  }

  // The friends' board (board.js): only when you share your Bugdex, and someone else does too.
  function board() {
    if (!d.config.get('shareBugdex')) return null;
    const friends = friendBooks();
    if (!friends.length) return null;
    const now = Date.now();
    const b = boards.board({ me: { login: d.github?.view?.().login || null, month: bugdex.shared(state(), now).month }, friends, key: bugdex.monthKey(now) });
    const r = boards.settle(d.config.get('boardLast'), b);
    if (JSON.stringify(r.state) !== JSON.stringify(d.config.get('boardLast'))) d.config.set({ boardLast: r.state });
    if (r.ended) monthOver(r.ended);
    return b;
  }

  // A month on the board is over: where you finished goes in the journal, and first is a trophy.
  function monthOver(e) {
    d.log.info(`board: ${e.month} over, ${e.place} of ${e.of}`);
    d.life?.remember?.('board-month', { place: `${boards.ordinal(e.place)} of ${e.of}`, month: e.month });
    if (e.place === 1) {
      d.stat('board-won');
      d.send(d.panel, 'life:moment', { eyebrow: 'The friends\' board', icon: '🥇', title: `Top crab in ${e.month}`, text: `More bugs fixed than any of your ${e.of - 1} friends on the board.` });
    }
  }

  // His favourite catch follows him round the desk (critter.js #buddy): its art, or null.
  let buddySent = null;
  function buddy() {
    const baby = d.babyBuddy?.();
    if (baby && d.config.get('bugFollower') !== false) return baby;
    if (!on() || d.config.get('bugFollower') === false) return null;
    const s = state();
    const id = bugdex.favourite(s);
    if (!id) return null;
    const sp = speciesById(id);
    const a = bugdex.artFor(sp, s.species[id]); // its portrait, as in the book: critter.js shrinks it to fit beside him
    return { id, name: sp.name, ghost: sp.habitat === 'wreck', pixels: a.pixels, palette: a.palette };
  }
  function sendBuddy({ force = true } = {}) {
    const b = buddy();
    const key = JSON.stringify(b);
    if (!force && key === buddySent) return;
    buddySent = key;
    if (d.critter) d.send(d.critter, 'critter:buddy', b);
  }

  const push = () => {
    if (d.panel) d.send(d.panel, 'bugdex', view());
    sendBuddy({ force: false }); // a new favourite (or its next stage) goes straight to the desk
  };

  /** Change the book, then tell the panel. */
  function update(fn) {
    const before = bugdex.prune(state(), Date.now());
    const next = fn(before);
    // Every file Claude writes engages what's open: most of the time that's already so.
    if (JSON.stringify(next) === JSON.stringify(before)) return before;
    save(next);
    push();
    return next;
  }

  /** An entry point main calls without waiting: a failure is logged, never a snag. */
  const guarded = fn => (...args) => {
    try {
      const out = fn(...args);
      return out && typeof out.catch === 'function' ? out.catch(e => d.log.error('bugdex', e)) : out;
    } catch (e) {
      d.log.error('bugdex', e);
      return undefined;
    }
  };

  const { battles, battleOf, fight, fightAll, battleList, cue, endBattle } = makeBattles({ d, on, state, names });
  const reward = makeReward({ d, view: () => view(), names, openPage: id => openPage(id) });

  // ---- seeing

  /**
   * Open an encounter, or refresh one that failed again.
   *   again: { kind (detect.js commandKind), failed } — what failed again, for its battle
   */
  async function spot(enc, again = null) {
    const now = Date.now();
    const r = bugdex.spot(state(), enc, now, { device: device() });
    save(r.state);
    push();
    if (r.isNew) d.log.info(`bugdex: spotted ${enc.species}`);
    if (r.escaped) d.log.info(`bugdex: ${enc.species} got away`);
    const e = r.state.open.find(x => lifecycle.encId(x) === lifecycle.encId(enc));
    if (e && r.isNew) battleOf(e, now, again?.failed ?? null);
    else if (e) fight(e, b => battle.act(b, { move: again?.kind || 'run', failed: again?.failed ?? null, at: now }));
    return r;
  }

  /**
   * A failed command showed a bug: open its encounter.
   *   r: detect.read()'s reading; at: { dir, tabId, bugTree }
   */
  async function observe(r, at) {
    const hit = r.hit;
    if (!hit) return;
    const p = await project(at.dir);
    if (!p) return;
    const snap = await snapshotWithin(at.dir);
    if (snap) rememberTree(p.id, snap.tree);
    const conflict = hit.species === 'two-headed-crab';
    // No picture of the code (not a repo, or too slow): nothing could ever prove
    // it fixed, so it's only seen, not left on the loose for a day saying "waiting".
    if (!snap && !conflict) {
      save(bugdex.recordSeen(state(), { species: hit.species, fp: hit.fp, project: p.id }, Date.now(), { device: device() }).state);
      push();
      return;
    }
    const enc = {
      species: hit.species, fp: hit.fp, project: p.id, name: p.name, source: 'bash',
      // A conflict is caught by settling it, not by the same command passing.
      keys: conflict ? [] : r.keys, kind: r.kind,
      failTree: snap?.tree || null, tabId: at.tabId || null, lang: hit.lang, passed: r.passed,
    };
    if (conflict) { conflicts.set(lifecycle.encId(enc), { files: r.conflictFiles }); bound(conflicts); }
    await spot(enc, { kind: r.kind, failed: Number.isInteger(r.failed) ? r.failed : null });
  }

  // ---- catching

  /**
   * Jar it: the book, the rewards and the moment.
   *   e: the encounter (or { species, fp, project, name, firstAt })
   */
  function catchIt(e, { remedy = false, quiet = false, move = null } = {}) {
    const now = Date.now();
    const sp = speciesById(e.species);
    const boosts = d.eventBoosts?.() || null;
    // Who helped, read before the battle ends: a helper in the fight brings Pen Pal Week's bug.
    const party = e.source ? (battles.get(lifecycle.encId(e))?.party?.length || 0) : 0;
    const r = bugdex.recordCatch(state(), {
      species: e.species, fp: e.fp, project: e.project, name: e.name || names.get(e.project) || '',
      firstAt: e.firstAt, firstTry: e.reruns === 0, remedy, lang: e.lang, device: device(), seasons: seasons(), rand: Math.random,
      shinyBoost: boosts ? boosts.shinyFor(sp?.habitat) : 1,
    }, now);
    const next = e.source ? bugdex.closeEncounter(r.state, lifecycle.encId(e)) : r.state;
    save(next);
    if (e.source) endBattle(e, r, now, remedy ? 'remedy' : move);
    if (!r.counted) { push(); return r; }
    d.log.info(`bugdex: caught ${e.species}${r.isNew ? ' (new)' : ''}`);
    reward(e, r, { quiet, boosts });
    push();
    if (sp && !sp.event) maybeEventBug(e, r, { party, now });
    return r;
  }

  /**
   * A tide event's own bug comes along with a real catch made its way
   * (events.js bugComesAlong): after nine at The Haunting, with a helper in
   * Pen Pal Week, a fix that deletes more than it adds in Spring Clean...
   */
  function maybeEventBug(e, r, { party, now }) {
    const a = d.activeEvent?.();
    if (!a) return;
    const sp = speciesById(e.species);
    const ctx = { hour: new Date(now).getHours(), habitat: sp.habitat, forms: r.forms, party, trimmed: e.trimmed === true, todayCount: r.state.today };
    if (!events.bugComesAlong(a.ev.id, ctx)) return;
    // Its own fingerprint, from the catch that brought it: the same fix can't bring it twice.
    const fp = crypto.createHash('sha1').update(`event:${a.ev.id}:${e.fp}`).digest('hex').slice(0, 12);
    setTimeout(() => {
      try {
        const got = catchIt({ species: a.ev.bug, fp, project: e.project, name: e.name, firstAt: now });
        if (got.counted) d.log.info(`bugdex: ${a.ev.bug} came along (${a.ev.id})`);
      } catch (err) { d.log.warn('event bug failed', err.message); }
    }, EVENT_BUG_AFTER_MS);
  }

  function openPage(id = null) {
    d.showPanel({ focusInput: false });
    d.send(d.panel, 'panel:view', 'bugdex');
    if (id) d.send(d.panel, 'bugdex:focus', { id });
  }

  /** A passing command: does it catch anything open for it? */
  async function tryCatch(r, at) {
    const p = await project(at.dir);
    if (!p || !r.key) return;
    const cands = lifecycle.candidates(state().open, { project: p.id, key: r.key });
    if (!cands.length) return;
    // The code as it was when the command started and as it ended: if it moved
    // while it ran, the pass proves nothing.
    const start = await at.bugTree;
    const end = await snapshotWithin(at.dir);
    if (!start || !end || start.tree !== end.tree) return;
    rememberTree(p.id, end.tree);
    const caught = [];
    for (const e of cands) {
      if (!e.failTree || r.fps.includes(e.fp)) continue;
      const sp = speciesById(e.species);
      const same = e.failTree === end.tree;
      // A fix that isn't code: the species' own remedies, or a cleared cache, which
      // makes whatever it was a Cache Ghoul (reveal).
      const ran = same ? remediesSince(p.id, e.firstAt) : [];
      const remedy = ran.some(k => sp.remedies?.includes(k)) || ran.includes('cache');
      let files = [], patch = '';
      if (!same) {
        const sum = await changes.summarize({ root: end.root, tree: e.failTree }, end).catch(() => null);
        files = sum?.files || [];
        if (files.length) patch = (await changes.patchFor({ root: end.root, before: e.failTree, after: end.tree }).catch(() => null))?.patch || '';
      }
      const verdict = judge({
        files, patch, species: e.species, remedy, revert: !same && wasBefore(p.id, end.tree, e.firstAt),
        passFlags: r.passFlags, counts: { before: e.passed, after: r.passed },
      });
      if (!verdict.ok) {
        update(s => bugdex.refuse(s, lifecycle.encId(e), verdict.reason));
        fight(e, b => battle.resist(b, { at: Date.now(), reason: verdict.reason }));
        d.log.info(`bugdex: no catch (${verdict.reason})`);
        continue;
      }
      // Spring Clean's bug wants a fix that took code away (events.js).
      const lines = patch.split('\n');
      const added = lines.filter(l => l.startsWith('+') && !l.startsWith('+++')).length;
      const removed = lines.filter(l => l.startsWith('-') && !l.startsWith('---')).length;
      caught.push({ e: { ...e, trimmed: removed > added }, remedy });
    }
    // One pass, one moment: the rarest is the catch, the rest come along quietly.
    caught.sort((a, b) => RARITY_ORDER[speciesById(b.e.species).rarity] - RARITY_ORDER[speciesById(a.e.species).rarity]);
    caught.forEach(({ e, remedy }, i) => catchIt(reveal(e, remedy), { remedy, quiet: i > 0, move: r.kind }));
  }

  // A squatter or a stuck file fixed by killing a leftover process was a
  // zombie all along; anything cured by clearing a cache was a cache ghoul.
  function reveal(e, remedy) {
    if (!remedy) return e;
    const kinds = remediesSince(e.project, e.firstAt);
    const own = kinds.filter(k => speciesById(e.species).remedies?.includes(k));
    if ((e.species === 'port-squatter' || e.species === 'clingy-barnacle') && own.includes('kill')) return { ...e, species: 'zombie-process' };
    // Only when nothing of its own fixed it: a cleared cache did.
    if (!own.length && kinds.includes('cache')) return { ...e, species: 'cache-ghoul' };
    return e;
  }

  /** Remedies, walking away from a merge, settling one, pushes and commits. */
  async function sideEffects(r, at) {
    const p = await project(at.dir);
    if (!p) return;
    if (r.remedy) ringPush(remedies, p.id, { kind: r.remedy, at: Date.now() }, MAX_REMEDIES);
    const open = state().open.filter(e => e.project === p.id && e.source === 'bash');
    if (r.remedy) fightAll(open, b => battle.act(b, { move: 'remedy', at: Date.now() }));
    if (r.flee) {
      const fled = open.filter(e => e.species === 'two-headed-crab');
      if (fled.length) update(s => fled.reduce((acc, e) => bugdex.closeEncounter(acc, lifecycle.encId(e)), s));
      return;
    }
    if (r.resolve) await settleConflicts(p, at.dir, open.filter(e => e.species === 'two-headed-crab'));
    // Read again: settling a conflict took a while, and caught what it caught.
    const now = state().open.filter(e => e.project === p.id && e.source === 'bash');
    if (r.fairPush) {
      for (const e of now.filter(x => x.species === 'bounced-bottle')) catchIt(e, { move: 'git' });
      engageCi(p.id);
    }
    if (r.hookedCommit) for (const e of now.filter(x => x.species === 'gatekeeper-goby' && x.engaged)) catchIt(e, { move: 'git' });
  }

  /** A merge was committed: caught, if git agrees nothing is left unmerged and no markers are left. */
  async function settleConflicts(p, dir, list) {
    if (!list.length) return;
    const root = await changes.rootOf(dir).catch(() => null);
    if (!root) return;
    const unmerged = await worktrees.git(root, ['ls-files', '-u'], { timeout: GIT_MS });
    if (!unmerged.ok || unmerged.out.trim()) return;
    for (const e of list) {
      const files = conflicts.get(lifecycle.encId(e))?.files || [];
      if (files.some(f => markersLeft(root, f))) continue;
      conflicts.delete(lifecycle.encId(e));
      catchIt(e, { move: 'git' });
    }
  }

  // ---- Bash and PowerShell in a tab (wiring/sessions.js)

  /** A command is about to run: the code as it is, if an open bug could be caught by it. */
  function commandStart({ command, dir }) {
    if (!on() || !dir) return null;
    const key = cmdKey(command);
    if (!key || !state()?.open?.some(e => e.source === 'bash' && e.keys.includes(key))) return null;
    return snapshotWithin(dir);
  }

  /** Claude wrote a file in a tab: whatever is open in that project is being worked on. */
  async function wrote(tabId) {
    if (!on() || !state()?.open?.length) return;
    const dir = d.manager?.tabs.get(tabId)?.session?.cwd;
    const p = await project(dir);
    if (p) update(s => bugdex.engage(s, p.id, Date.now()));
  }

  /**
   * What a tab can be fighting, or []: in the project it works in, and spotted
   * in that tab (or in none, like a red build). Another conversation's bug is
   * its own fight.
   */
  async function openInTab(tabId) {
    if (!state()?.open?.length) return [];
    const p = await project(d.manager?.tabs.get(tabId)?.session?.cwd);
    return p ? state().open.filter(e => e.project === p.id && (!e.tabId || e.tabId === tabId)) : [];
  }

  /**
   * Any tool Claude used in a tab: an edit engages what's loose (and is a
   * Patch), reading round is a Scout. A helper's own tools are its assist.
   */
  async function tool(tabId, item) {
    if (!on() || !item?.name) return;
    if (item.filePath) await wrote(tabId);
    if (item.sub || item.parent) return;
    const move = item.filePath ? 'patch' : SCOUT_TOOLS.has(item.name) ? 'scout' : null;
    if (!move) return;
    const at = Date.now();
    fightAll(await openInTab(tabId), b => battle.act(b, { move, at }));
  }

  /** A helper Claude sent out came back (wiring/crew.js): its crew member jumps into the battles there. */
  async function assist(tabId, type) {
    if (!on() || !type) return;
    const m = d.crewRoster?.member?.(type);
    if (!m) return;
    const at = Date.now();
    for (const e of await openInTab(tabId)) {
      const special = !!m.specialty && m.specialty === speciesById(e.species)?.type;
      fight(e, b => battle.act(b, { move: 'assist', at, by: { type: m.type, name: m.name, hue: m.hue, level: m.level, special } }));
    }
  }

  /**
   * What one finished command amounts to, wherever it ran.
   *   r: detect.read()'s reading (no output in it); at: { dir, tabId, bugTree }
   */
  async function handle(r, at) {
    try {
      if (!on() || !r || !at.dir) return;
      if (r.outcome === 'fail') return await observe(r, at);
      await sideEffects(r, at);
      await tryCatch(r, at);
    } catch (e) {
      d.log.error('bugdex', e);
    }
  }

  /** A command finished in a tab. c: the pending entry from sessions.js. */
  function commandResult(c, item, tail) {
    if (!on() || !c.dir || c.background) return Promise.resolve();
    const { output, complete } = detect.fullOutput(item, tail);
    const r = detect.read({ cmd: c.command, output, isError: item.isError, complete, live: LIVE });
    return handle(r, { dir: c.dir, tabId: c.tabId, bugTree: c.bugTree });
  }

  // ---- Claude Code outside Shellby (external.js): the same, from the plugin's hooks

  const outsideStarts = new Map();   // tool_use_id -> promise of the tree when it started
  const MAX_OUTSIDE = 50;

  /** A command is starting in a session outside Shellby: its tree, if it could catch something. */
  function outsideStart({ toolUseId, key, cwd }) {
    if (!on() || !toolUseId || !key || !cwd) return;
    if (!state()?.open?.some(e => e.source === 'bash' && e.keys.includes(key))) return;
    outsideStarts.set(toolUseId, snapshotWithin(cwd));
    if (outsideStarts.size > MAX_OUTSIDE) outsideStarts.delete(outsideStarts.keys().next().value);
  }

  /** ...and finished: external.js has already read it down to a reading. */
  function outsideResult({ toolUseId, reading, cwd }) {
    const bugTree = outsideStarts.get(toolUseId) || null;
    outsideStarts.delete(toolUseId);
    return handle(reading, { dir: cwd, tabId: null, bugTree });
  }

  /** Claude wrote a file in a session outside Shellby. */
  async function outsideWrote({ cwd }) {
    if (!on() || !state()?.open?.length) return;
    const p = await project(cwd);
    if (p) update(s => bugdex.engage(s, p.id, Date.now()));
  }

  // ---- turns (wiring/sessions.js, timetrack.js)

  /** A turn started or ended with the code at this tree: remembered, for the revert check. */
  async function treeSeen(root, tree) {
    if (!on()) return;
    const p = await project(root);
    if (p) rememberTree(p.id, tree);
  }

  /** A turn changed files in this folder: Claude's on whatever is open there. */
  async function changed(root) {
    if (!on() || !state()?.open?.length) return;
    const p = await project(root);
    if (p) update(s => bugdex.engage(s, p.id, Date.now()));
  }

  /** A turn ended in a tab: a copy's clash or a dev server's fix is being seen to. */
  function turnEnded(tabId, item) {
    if (!on() || item?.interrupted) return;
    // A catch made mid-turn waits for him to be free: he usually is a moment after.
    setTimeout(() => d.life?.jarIfFree?.(), 1500);
    const open = state()?.open || [];
    if (open.some(e => e.source === 'home' && e.tabId === tabId)) update(s => ({ ...s, open: s.open.map(e => (e.source === 'home' && e.tabId === tabId ? { ...e, engaged: true } : e)) }));
    if (!item?.ok) return;
    for (const s of d.devServers?.view?.().servers || []) {
      if (s.fixTabId !== tabId) continue;
      fixTurns.set(s.id, Date.now());
      bound(fixTurns);
      update(st => bugdex.engageKey(st, 'server', s.id));
    }
  }

  // ---- dev servers (wiring/projects.js)

  async function serverCrashed(v) {
    if (!on() || !v?.id) return;
    clearTimeout(stayUp.get(v.id));
    stayUp.delete(v.id);
    const lines = d.devServers?.fixDraft?.(v.id)?.lines || [];
    const hit = detect.classify(lines.join('\n'), { source: 'server', live: LIVE });
    const p = await project(v.root);
    if (!hit || !p) return;
    const existing = lifecycle.byKey(state().open, 'server', v.id)[0];
    // A crash after the fix began: it failed again, so the same encounter goes on.
    await spot({ species: existing?.species || hit.species, fp: existing?.fp || hit.fp, project: p.id, name: p.name, source: 'server', key: v.id, lang: hit.lang });
  }

  function serverUp(v) {
    if (!on() || !v?.id) return;
    const e = lifecycle.byKey(state().open, 'server', v.id)[0];
    const fixedAt = fixTurns.get(v.id) || 0;
    if (!e || !e.engaged || Date.now() - fixedAt > SERVER_FIX_WINDOW_MS) return;
    clearTimeout(stayUp.get(v.id));
    stayUp.set(v.id, setTimeout(() => {
      stayUp.delete(v.id);
      const now = (d.devServers?.view?.().servers || []).find(s => s.id === v.id);
      const still = lifecycle.byKey(state().open, 'server', v.id)[0];
      if (now?.status === 'up' && still) { fixTurns.delete(v.id); catchIt(still); }
    }, STAY_UP_MS));
  }

  // ---- CI (wiring/github.js, wiring/startfrom.js)

  async function ciProject(pr) {
    if (pr.forge === 'gitlab') {
      const root = await d.gitlabCloneOf?.(pr.host, pr.repo);
      return root ? project(root) : null;
    }
    const want = String(pr.repo || '').toLowerCase();
    const repos = d.projects ? await d.projects.localRepos().catch(() => []) : [];
    const root = repos.find(r => r.remote && r.remote.toLowerCase() === want)?.root;
    return root ? project(root) : null;
  }

  async function ciFailed(pr) {
    if (!on() || !pr?.key) return;
    const p = await ciProject(pr);
    if (!p) return;
    const species = ciSpecies(pr);
    await spot({ species, fp: detect.fingerprint(species, `ci:${pr.key}`), project: p.id, name: p.name, source: 'ci', key: String(pr.key).slice(0, 200), lang: 'ci' });
  }

  async function ciFixed(pr) {
    if (!on() || !pr?.key) return;
    const e = lifecycle.byKey(state().open, 'ci', String(pr.key).slice(0, 200))[0];
    // Only when Shellby took part: "Fix this build", or a push from here since it went red.
    if (e?.engaged) catchIt(e, { move: 'tests' });
    else if (e) update(s => bugdex.closeEncounter(s, lifecycle.encId(e)));
  }

  const ciEngaged = key => { if (on() && key) update(s => bugdex.engageKey(s, 'ci', String(key).slice(0, 200))); };
  function engageCi(projectId) {
    if (!state()?.open?.some(e => e.source === 'ci' && e.project === projectId)) return;
    update(s => ({ ...s, open: s.open.map(e => (e.source === 'ci' && e.project === projectId ? { ...e, engaged: true } : e)) }));
  }

  // ---- bringing a copy home, and pushing (ipc/repo.js)

  const homeKey = w => `${w.root}|${w.branch}`.toLowerCase().slice(0, 200);

  async function homeResult(tabId, w, merged) {
    if (!on() || !w?.root) return;
    const key = homeKey(w);
    if (merged?.conflict) {
      const p = await project(w.root);
      if (p) await spot({ species: 'two-headed-crab', fp: detect.fingerprint('two-headed-crab', `home:${w.branch}`), project: p.id, name: p.name, source: 'home', key, tabId, lang: 'git' });
      return;
    }
    if (!merged?.ok || !merged.merged) return;
    for (const e of lifecycle.byKey(state().open, 'home', key)) if (e.engaged) catchIt(e, { move: 'git' });
  }

  async function secretSpotted(root, kinds = []) {
    if (!on() || !root) return;
    const p = await project(root);
    if (!p) return;
    // Only the kinds of secret (an AWS key, a GitHub token): never where, never what.
    const what = [...new Set(kinds.map(k => String(k).slice(0, 60)))].sort().join(',');
    await spot({ species: 'leaky-clam', fp: detect.fingerprint('leaky-clam', what), project: p.id, name: p.name, source: 'push', key: path.resolve(root).toLowerCase().slice(0, 200), lang: null });
  }

  function secretIgnored(root) {
    if (!on() || !root) return;
    const key = path.resolve(root).toLowerCase().slice(0, 200);
    if (state()?.open?.some(e => e.source === 'push' && e.key === key)) update(s => ({ ...s, open: lifecycle.closeKey(s.open, 'push', key).list }));
  }

  async function pushedClean(root) {
    if (!on() || !root) return;
    const key = path.resolve(root).toLowerCase().slice(0, 200);
    for (const e of lifecycle.byKey(state().open, 'push', key)) if (e.engaged) catchIt(e, { move: 'git' });
    const p = await project(root);
    if (p) engageCi(p.id);
  }

  // ---- the flaky detective and dependency checkups (wiring/progress.js)

  const flakyFp = id => detect.fingerprint('flaky-phantom', `flaky:${id}`);

  /** A test flaked: the ghost is seen (and if it was caught lately, it got away). */
  function flakySeen(p, testId) {
    if (!on() || !p?.id) return;
    names.set(p.id, p.name);
    const s = state();
    const r = bugdex.recordSeen(s, { species: 'flaky-phantom', fp: flakyFp(testId), project: p.id }, Date.now(), { device: device() });
    save(r.state);
    push();
  }

  /** A flaky test fixed for good (20 clean runs over 3 new versions of the code): that's the proof. */
  function flakyFixed(p, testId, flakes = []) {
    if (!on() || !p?.id) return;
    names.set(p.id, p.name);
    const days = new Set(flakes.filter(Number.isFinite).map(t => new Date(t).toDateString()));
    const species = flakes.length >= 5 && days.size >= 3 ? 'heisenbug' : 'flaky-phantom';
    catchIt({ species, fp: detect.fingerprint(species, `flaky:${testId}`), project: p.id, name: p.name, firstAt: Math.min(...flakes.filter(Number.isFinite), Date.now()), reruns: 1 });
  }

  function auditIssues(p) {
    if (!on() || !p?.id) return;
    names.set(p.id, p.name);
    save(bugdex.recordSeen(state(), { species: 'barnacled-anchor', fp: detect.fingerprint('barnacled-anchor', 'audit'), project: p.id }, Date.now(), { device: device() }).state);
    push();
  }

  function auditPatched(p) {
    if (!on() || !p?.id) return;
    names.set(p.id, p.name);
    catchIt({ species: 'barnacled-anchor', fp: detect.fingerprint('barnacled-anchor', 'audit'), project: p.id, name: p.name, firstAt: 0, reruns: 1 });
  }

  // ---- the page (ipc/progress.js)

  function seen() {
    if (!d.config) return;
    save(bugdex.markSeen(state()));
    push();
  }

  function setFavourite(id) {
    if (id != null && (typeof id !== 'string' || !speciesById(id))) return view();
    save(bugdex.setFavourite(state(), id));
    const v = view();
    push();
    return v;
  }

  /** A friend who shares their Bugdex dropped by: they leave a jar (one a day each). */
  function friendVisited(login, theirs) {
    if (!on()) return;
    const species = bugdex.giftFor(state(), login, theirs, Date.now());
    if (!species) return;
    save(bugdex.addGift(state(), { species, from: login }, Date.now()));
    push();
    const sp = speciesById(species);
    d.sayText?.(`@${login} brought a jar: ${sp.name}!`.slice(0, 60), 'visit', 5000);
    d.send(d.panel, 'bugdex:gift', { id: species, name: sp.name, from: login });
  }

  function openTab(tabId) {
    if (typeof tabId !== 'string' || !view().loose.some(l => l.tabId === tabId)) return;
    d.showPanel({ focusInput: false, tabId });
  }

  async function forget() {
    const response = await d.askOnce({
      icon: '🫙', title: 'Start the Bugdex over?',
      message: 'Every bug you\'ve caught, seen and evolved goes, on every PC that syncs with this one. XP and trophies you\'ve earned stay.',
      buttons: [{ label: 'Start over', style: 'danger' }, { label: 'Keep it' }], defaultId: 1, cancelId: 1,
    });
    if (response !== 0) return { ok: false, canceled: true };
    // A reset marker, not nothing: sync carries it, so other PCs start over too
    // instead of handing the old counts back (bugdex.js merge).
    save(bugdex.normalize({ resetAt: Date.now() }));
    push();
    return { ok: true };
  }

  // Main calls these from its own events and never waits: each one logs its
  // own failure instead of letting it reach main's "snag" handler.
  const hooks = Object.fromEntries(Object.entries({
    commandStart, commandResult, wrote, tool, assist, friendVisited, treeSeen, changed, turnEnded, outsideStart, outsideResult, outsideWrote,
    serverCrashed, serverUp, ciFailed, ciFixed, ciEngaged, homeResult, secretSpotted, secretIgnored, pushedClean,
    flakySeen, flakyFixed, auditIssues, auditPatched,
  }).map(([k, fn]) => [k, guarded(fn)]));

  return {
    on, view, push, openPage, seen, setFavourite, openTab, forget, battles: battleList, cue, buddy, sendBuddy,
    ...hooks,
    // For the tests: the species a red build would be.
    ciSpecies,
  };
}

module.exports = { wireBugdex };
