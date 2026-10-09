// Crit hits and small surprises (surprises.js): what Shellby saw, turned into
// the odd fanfare. Kept out of main.js, which only wires it up.
//
// Two kinds of evidence come in for each tab: test runs (Shellby's own checks,
// wiring/checks.js, and the test commands Claude runs, wiring/progress.js),
// each stamped with the git tree it ran on, and turns (wiring/sessions.js),
// with the trees they started and ended on. A turn is judged once, as soon as
// the evidence for it is in, which can be a while later: the checks before a
// copy comes home can be the green that proves the turn before them.
const changes = require('../changes');
const checks = require('../checks');
const flaky = require('../flaky');
const focus = require('../focus');
const surprises = require('../surprises');

const MAX_RUNS = 12;   // per tab: a turn's worth, and the run just before it
const MAX_TABS = 50;

/** d: what main shares (main.js `shared`). */
function wireSurprises(d) {
  const runs = new Map();   // tabId -> [{ via, cmd, tree, ok, failing, at }]
  const turns = new Map();  // tabId -> its last turn that changed files: { root, before, after, files, judged }

  const on = () => !d.CAPTURE && !!d.config && d.config.get('surprises') !== false && !d.config.get('crabOnly');
  // Not a routine's or a workflow's run: nobody's at the desk to be surprised.
  const forYou = tab => !!tab && !tab.routineId && !tab.workflowRunId;

  function keep(map, tabId, value) {
    map.delete(tabId);
    map.set(tabId, value);
    while (map.size > MAX_TABS) map.delete(map.keys().next().value);
  }

  /** A test run in a tab, on a tree. run: { via, cmd?, tree, ok, failing }. Never throws. */
  function noteRun(tabId, run) {
    try {
      if (!on() || typeof tabId !== 'string' || !run?.tree) return;
      const list = [...(runs.get(tabId) || []), { ...run, at: Date.now() }].slice(-MAX_RUNS);
      keep(runs, tabId, list);
      judge(tabId);
    } catch (err) {
      d.log.info(`surprises: ${err.message}`);
    }
  }

  /**
   * Shellby's own checks finished (wiring/checks.js). Only named failing tests
   * are red: a timeout, a check that wouldn't start or a broken typecheck or
   * build proves nothing about the suite.
   */
  function noteChecks(tabId, verdict) {
    if (verdict?.status !== 'pass' && verdict?.status !== 'fail') return;
    const names = verdict.status === 'fail' ? checks.failingOf(verdict).names : [];
    noteRun(tabId, { via: 'checks', tree: verdict.tree, ok: verdict.status === 'pass', failing: names.length, names });
  }

  /** A turn that changed files has ended (wiring/sessions.js). */
  function noteTurn(tabId, summary) {
    try {
      if (!on() || !summary?.before || !summary?.after) return;
      const prev = turns.get(tabId) || null;
      keep(turns, tabId, {
        root: summary.root, before: summary.before, after: summary.after, files: summary.files || [], judged: false,
        prev: prev && { before: prev.before, after: prev.after }, since: prev?.endedAt || 0, endedAt: Date.now(),
      });
      judge(tabId);
    } catch (err) {
      d.log.info(`surprises: ${err.message}`);
    }
  }

  // Tests the flaky detective knows flake (and you haven't said aren't): their
  // going green is luck, not a fix.
  function flakyNow() {
    const rows = flaky.flakyView(d.config.get('flaky'), Date.now()).filter(r => r.status !== 'dismissed' && r.status !== 'fixed');
    const ids = new Set(rows.map(r => r.id));
    return name => ids.has(flaky.cleanId(name));
  }

  // Did the tab's last turn take its suite from red to green? Once per turn.
  function judge(tabId) {
    const turn = turns.get(tabId);
    if (!turn || turn.judged) return;
    const crit = surprises.critOf({ turn, runs: runs.get(tabId), prev: turn.prev, since: turn.since, flaky: flakyNow() });
    if (!crit) return;
    turn.judged = true;
    if (!forYou(d.manager?.tabs.get(tabId))) return;
    honest(turn)
      .then(ok => { if (ok) maybe('crit', tabId, { failing: crit.failing }); })
      .catch(err => d.log.info(`surprises: ${err.message}`));
  }

  // Green by fixing things, not by deleting or skipping tests (surprises.shortcutIn).
  // A diff that can't be read, or only in part, can't vouch for that: no crit.
  async function honest(turn) {
    const read = await changes.patchFor({ root: turn.root, before: turn.before, after: turn.after, ...(turn.scoped ? { paths: turn.files.map(f => f.path) } : {}) }).catch(() => null);
    if (!read || read.error || read.truncated) { d.log.info('surprises: no crit, the turn\'s diff could not be read in full'); return false; }
    const why = surprises.shortcutIn({ files: turn.files, patch: read.patch });
    if (why) d.log.info(`surprises: no crit, the turn ${why}`);
    return !why;
  }

  // He's guarding your focus or you're on a call: a surprise now would be one
  // nobody sees, so it doesn't roll at all (the first of each kind included).
  const hushed = () => focus.guarding(d.config.get('focus'), Date.now()) || !!d.life?.hushed();

  /**
   * Before a copy is merged (ipc/repo.js): is it coming home green on the
   * first try? Asked before the merge notes "Brought home", which would count
   * against it.
   */
  function firstLanding(tabId, verdict) {
    if (!on() || verdict?.status !== 'pass') return false;
    const tab = d.manager?.tabs.get(tabId);
    if (tab && !forYou(tab)) return false;
    try {
      return surprises.firstTry(verdict, d.history?.load(tabId) || []);
    } catch (err) {
      d.log.info(`surprises: ${err.message}`);
      return false;
    }
  }

  /** Copies that firstLanding said yes to are home. facts: { branch, base, copies }. */
  function landed(tabId, facts) {
    if (!on()) return null;
    return maybe('landing', tabId, facts);
  }

  // A qualifying outcome rolls for its surprise; a hit plays it.
  function maybe(kind, tabId, facts) {
    if (hushed()) return null;
    const now = Date.now();
    const r = surprises.roll(d.config.get('crits'), kind, { now, rng: Math.random, failing: facts.failing });
    if (!r.hit) {
      if (!r.reason) d.config.set({ crits: r.state }); // a miss: a little more luck next time
      return null;
    }
    const f = surprises.fanfare(kind, facts, { rng: Math.random, state: r.state });
    d.config.set({ crits: f.state });
    play(tabId, f);
    return f;
  }

  // The fanfare: his line and a sound, the burst and the banner over him, and
  // a note in the conversation that stays. The XP is the surprise's own (and
  // awardXp counts it for the week and the trophies).
  function play(tabId, f) {
    if (d.manager?.tabs.has(tabId)) d.manager.note(tabId, { kind: 'surprise', what: f.kind, title: f.title, text: f.note, at: Date.now() });
    d.awardXp(f.kind, { label: f.title });
    // Held back while he guards your focus or you're on a call, like anything he says.
    if (!d.sayText(f.line, f.kind, 7000)) return;
    d.send(d.critter, 'critter:surprise', { kind: f.kind, big: f.big, badge: f.badge });
    d.send(d.critter, 'critter:burst', d.outfit().confetti);
    d.floor?.event('success'); // his pals cheer
  }

  return { surprisesOn: on, noteRun, noteChecks, noteTurn, firstLanding, landed };
}

module.exports = { wireSurprises };
