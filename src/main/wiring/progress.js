// What adds up: XP and levels (and the rooms they open), quests, dependency checkups,
// the flaky test detective and the week in review.
// Kept out of main.js, which only wires it up.
const os = require('os');
const path = require('path');
const changes = require('../changes');
const checkup = require('../checkup');
const flaky = require('../flaky');
const { projectOf } = require('../gitinfo');
const { readRepo } = require('../projects/local');
const quests = require('../quests');
const rooms = require('../rooms');
const routineTemplates = require('../routine-templates');
const shells = require('../shells');
const stickers = require('../stickers');
const streaks = require('../streaks');
const weekly = require('../weekly');
const { AWARDS, award, classifyCommand, levelFor, normalizeXp, unlocksBetween, xpSummary } = require('../xp');

/** d: what main shares (main.js `shared`). */
function wireProgress(d) {
  // ---- XP and levels

  function xpView() {
    return xpSummary(d.config.get('xp'), Date.now(), currentStreak());
  }

  const currentStreak = () => streaks.streakOf(d.config.get('streaks'), Date.now()).current;

  // What a level-up unlocked, in words: "the Reef Warden title and the Kelp badge".
  function unlockedText(list) {
    const names = list.filter(u => u.kind !== 'shell').map(u => (u.kind === 'title' ? `the ${u.name} title` : `the ${u.name}`));
    if (!names.length) return '';
    return `Unlocked ${names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0]}.`;
  }

  const LEVELUP_TEXT = {
    trick: m => `He wrote himself a new trick: ${m.label}.`,
    tests: m => `Tests passed${m.project ? ` in ${m.project}` : ''}.`,
    fixed: m => `Tests green again${m.project ? ` in ${m.project}` : ''}.`,
    ship: m => `Pushed code${m.project ? ` in ${m.project}` : ''}.`,
    deploy: m => `Deployed${m.project ? ` from ${m.project}` : ''}!`,
  };

  // XP kinds that also count toward a trophy (achievements.js), by the stat event they feed.
  const XP_STATS = {
    deploy: 'deployed', fixed: 'tests-fixed', flakefix: 'flake-fixed', issue: 'issue-shipped',
    deps: 'deps-clean', tidy: 'toolbox-tidied', fresh: 'started-fresh',
  };

  // Rooms (rooms.js): the screens a new user has opened so far. The scripted
  // screenshots always show every one.
  function roomsPanelView() {
    return rooms.roomsView(d.CAPTURE ? null : d.config.get('rooms'));
  }

  function setRooms(next) {
    if (next && !d.CAPTURE) d.config.set({ rooms: next });
    const v = roomsPanelView();
    d.send(d.panel, 'rooms', { view: v, opened: [] });
    return v;
  }

  // A task of his own finished: maybe a new room opens, and the panel says so.
  function roomTaskDone() {
    if (d.CAPTURE || !d.config) return;
    const r = rooms.taskDone(d.config.get('rooms'));
    if (!r.state || r.state.all) return; // every door already open: nothing to count
    d.config.set({ rooms: r.state });
    d.send(d.panel, 'rooms', { view: roomsPanelView(), opened: r.opened.map(({ id, name, text }) => ({ id, name, text })) });
  }

  // Quests (quests.js): the features worth finding, done the first time each
  // really succeeds. The scripted screenshots show a fresh line.
  function questsPanelView() {
    return quests.questsView(d.CAPTURE ? null : d.config.get('quests'));
  }

  function setQuests(next) {
    if (next && !d.CAPTURE) d.config.set({ quests: next });
    const v = questsPanelView();
    d.send(d.panel, 'quests', { view: v });
    return v;
  }

  // Called where each feature succeeds (a review sent, a branch made, a copy
  // merged home, work held for the reset). Only the first time counts.
  function questDone(id) {
    if (d.CAPTURE || !d.config) return;
    const r = quests.completeQuest(d.config.get('quests'), id, Date.now());
    if (!r.quest) return;
    d.config.set({ quests: r.state });
    const pick = q => q && { id: q.id, icon: q.icon, title: q.title, why: q.why, go: q.go };
    // The card first, so a level-up the XP brings lands after it.
    d.send(d.panel, 'quests', { view: questsPanelView(), done: pick(r.quest), next: pick(r.next), finished: r.finished });
    awardXp('quest', { label: r.quest.title });
    if (r.finished) awardXp('questline');
  }

  function awardXp(kind, meta = {}) {
    if (kind === 'ship') setTimeout(d.checkNudges, 3000); // a push means a fresh commit: update streak data
    if (d.CAPTURE || !d.config) return;
    const r = award(d.config.get('xp'), kind, new Date(), { ...meta, streak: currentStreak() });
    if (r.changed) d.config.set({ xp: r.state });
    // Trophies count the event even when repetition left it paying nothing. Streak
    // and level are reported every time, so the day's first award credits old progress.
    if (XP_STATS[r.kind]) d.stat(XP_STATS[r.kind]);
    d.stat('streak', { n: streaks.streakOf(d.config.get('streaks'), Date.now()).longest });
    d.stat('level', { n: r.after.level });
    // The week-in-review counts it even when repetition left it paying nothing.
    // Shipping is counted where the project is known (recordShipped).
    if (WEEK_XP_KINDS.has(r.kind)) noteWeek(r.kind);
    if (r.kind === 'fixed' && meta.project) noteFix(`t:${meta.project}`);
    if (!r.gained) { if (r.changed) d.send(d.panel, 'xp', xpView()); return; }
    d.send(d.critter, 'critter:xp', { amount: r.gained, kind: r.kind });
    for (const b of r.bounties) d.send(d.panel, 'xp:bounty', b);
    d.lastXp = { amount: r.gained, at: Date.now() };
    d.refreshStatusLine();
    setTimeout(d.refreshStatusLine, 15500); // let "+25 XP" fade from the status line
    d.send(d.panel, 'xp', xpView());
    if (!r.levelUp) return;
    d.levelUpAt = r.after.level;
    const text = (LEVELUP_TEXT[r.kind] || (() => `${AWARDS[r.kind].label}.`))(meta);
    // The new title is already the card's heading.
    const unlocked = unlockedText(unlocksBetween(r.before.level, r.after.level).filter(u => !(u.kind === 'title' && u.name === r.after.title)));
    const shell = molt(r.before.level, r.after.level);
    if (!shell) {
      d.flashState('levelup', 6500);
      d.send(d.critter, 'critter:burst', d.outfit().confetti);
    }
    d.send(d.panel, 'xp:levelup', { level: r.after.level, title: r.after.title, rank: r.after.rank, text, unlocked, shell: shell && { ...shells.renderShell(shell), name: shell.name, kind: 'home' } });
    if (!(d.panel?.isVisible() && d.panel.isFocused())) {
      const body = [shell ? `${r.after.title}. He outgrew his shell and moved into a ${shell.name}!` : `${r.after.title}. ${text}`, unlocked].filter(Boolean).join(' ');
      d.notify(`Level up! Shellby is level ${r.after.level}`, body, () => { d.showPanel({ focusInput: false }); d.send(d.panel, 'panel:view', shell ? 'wardrobe' : 'trophies'); }, { tone: 'celebrate', pet: true });
    }
  }

  // A level-up that unlocks a shell: he crawls out of the old one and moves into
  // the newest (see shells.js). Returns the new shell, or null when none unlocked.
  const MOLT_MS = 5200;
  function molt(before, after) {
    const fresh = shells.unlockedBetween(before, after);
    if (!fresh.length || d.CAPTURE) return null;
    const next = fresh[fresh.length - 1];
    const was = d.outfit();
    const from = was.home;
    const h = shells.normalizeHome(d.config.get('home'));
    // The old shell keeps its stickers; his favourites come with him (stickers.js).
    const carried = stickers.carryOnMolt(d.config.get('stickers'), d.shellIdOf(d.stickerService.wornShellObj()), next.id, d.stickerService.shellSpots(d.activeSkin(), next).slots.length, Date.now());
    d.config.set({ home: { ...h, worn: next.id }, stickers: carried });
    d.flashState('molting', MOLT_MS);
    d.send(d.critter, 'critter:molt', { from, to: shells.renderShell(next), ms: MOLT_MS, fromStickers: was.stickers, toStickers: d.shellStickers(d.activeSkin(), next) });
    setTimeout(() => {
      d.broadcastSkin();
      d.flashState('levelup', 4000);
      d.send(d.critter, 'critter:burst', d.outfit().confetti);
    }, MOLT_MS);
    d.send(d.panel, 'homes', d.homesView());
    d.send(d.panel, 'stickers', d.stickersView());
    return next;
  }

  // ---- dependency checkups (checkup.js)
  //
  // Claude ran `npm audit`, `cargo outdated` or the like. Each project's latest
  // result is kept for the Routines page; a clean audit pays XP (once a day per
  // project) and earns the project's sticker its 🧼 Fresh mark.

  async function checkedUp(dir, check, result) {
    if (d.CAPTURE || !d.config || !dir || path.resolve(dir) === path.resolve(os.homedir())) return;
    try {
      const project = await projectOf(dir);
      const key = project?.root || dir;
      const name = project?.name || path.basename(key);
      const r = checkup.recordCheckup(d.config.get('checkups'), key, name, check, result, Date.now());
      if (!r.entry) return;
      d.config.set({ checkups: r.state });
      d.send(d.panel, 'checkups', checkupsView());
      if (r.pays) awardXp('deps', { project: name, label: r.patched ? 'Patched the dependencies' : AWARDS.deps.label });
      if (r.clean && project) freshMark(project);
      else if (result.status === 'issues' && check.check === 'audit') {
        d.sayText(result.count ? `${name}: ${result.count} known ${result.count === 1 ? 'vulnerability' : 'vulnerabilities'}` : `${name} has vulnerable dependencies`, 'sticker', 7000);
      }
    } catch (e) {
      d.log.error('checkup', e);
    }
  }

  // The project's sticker gets 🧼 Fresh the first time an audit comes back clean.
  function freshMark(project) {
    const r = stickers.addMark(d.config.get('stickers'), project.id, 'deps');
    if (!r.added) return;
    d.config.set({ stickers: r.state });
    d.broadcastSkin();
    setTimeout(() => d.send(d.critter, 'critter:sticker-glint', { id: project.id }), 120);
    const mark = stickers.MARKS.find(m => m.id === 'deps');
    d.sayText(`${mark.icon} ${r.project.name} is fresh!`, 'sticker', 6000);
    d.send(d.panel, 'stickers:news', { id: project.id, name: r.project.name, tier: null, marks: [{ id: mark.id, name: mark.name, icon: mark.icon }], pressed: false });
    d.send(d.panel, 'stickers', d.stickersView());
  }

  function checkupsView() {
    return checkup.checkupsView(d.config.get('checkups'), Date.now());
  }

  // Folders the panel may open a tab in: ones Shellby itself has seen you work
  // in (streaks), ship from (a sticker's folder) or check up on. All of them
  // are written by main from git or Claude's own commands, never by the panel.
  function knownFolder(dir) {
    const want = path.resolve(dir).toLowerCase();
    const same = k => typeof k === 'string' && path.resolve(k).toLowerCase() === want;
    return Object.keys(streaks.normalize(d.config.get('streaks')).projects).some(same)
      || Object.values(d.stickerState().projects).some(p => same(p.root))
      || Object.keys(checkup.normalizeCheckups(d.config.get('checkups')).projects).some(same)
      || !!d.projects?.knowsRoot(dir); // a clone on the Projects page ("New conversation here")
  }

  // Check one project's dependencies now, in a tab of its own (from the Sticker
  // Book or the Routines page's dependency list).
  function runCheckup(dir) {
    if (d.config.get('crabOnly')) return { ok: false, error: 'Checkups need Claude Code: Shellby is in just-the-crab mode.' };
    if (!d.isStr(dir) || !d.isFolder(dir)) return { ok: false, error: "That project's folder isn't there any more." };
    d.showPanel();
    // A draft to press Enter on, like the streak nudge: nothing runs until you say so.
    d.send(d.panel, 'tab:new-in', { cwd: dir, draft: routineTemplates.checkupPrompt({ single: true }) });
    return { ok: true };
  }

  // ---- the flaky test detective (flaky.js)

  // One snapshot per repo at a time: Claude often runs two test commands back to back.
  const flakySnapshots = new Map();      // lower-cased folder -> promise of { root, tree } or null
  // What each command hash was, for the fix prompt. This run of Shellby only, never saved.
  const flakyCommands = new Map();       // cmdKey -> the command as Claude ran it
  const MAX_FLAKY_COMMANDS = 100;

  const flakyOn = () => !d.CAPTURE && !!d.config && d.config.get('flakyTests') !== false && !d.config.get('crabOnly');
  // issuable: filing it as a GitHub issue can work (the panel's button).
  const flakyView = () => {
    const issuable = !!d.github?.can('claude');
    return flaky.flakyView(d.config.get('flaky'), Date.now()).map(r => ({ ...r, issuable }));
  };

  /** The folder's git tree now, or null (not a repo, or slower than SNAPSHOT_WAIT_MS). */
  function snapshotWithin(dir) {
    let late = false;
    const taken = changes.snapshot(dir).catch(() => null).then(s => (late ? null : s));
    return Promise.race([taken, new Promise(r => setTimeout(() => { late = true; r(null); }, d.SNAPSHOT_WAIT_MS))]);
  }

  /** The code as it is now, for a test command about to run; null for anything else. */
  function flakyTree(command, dir) {
    if (!flakyOn() || classifyCommand(command) !== 'tests') return null;
    const key = path.resolve(dir).toLowerCase();
    if (flakySnapshots.has(key)) return flakySnapshots.get(key);
    const p = snapshotWithin(dir);
    flakySnapshots.set(key, p);
    p.finally(() => { if (flakySnapshots.get(key) === p) flakySnapshots.delete(key); });
    return p;
  }

  // A long result is its first 8,000 characters, "… (N more characters)" and,
  // separately, its last 8,000: when the two overlap, that's all of it.
  function testOutput(item, tail) {
    const text = String(item.text || '');
    if (!tail) return { output: text, complete: true };
    const m = text.match(/\n… \((\d+) more characters\)$/);
    const head = m ? text.slice(0, m.index) : text;
    const rest = m ? Number(m[1]) : Infinity;
    return rest <= tail.length ? { output: head + tail.slice(-rest), complete: true } : { output: `${head}\n${tail}`, complete: false };
  }

  /** A test command finished in one of Shellby's tabs: was it a flake? */
  async function noteTestRun(c, item, tail) {
    try {
      const snap = await c.tree;
      if (!snap || !flakyOn()) return;
      // The command was seen before it ran: an edit sent alongside it, or made
      // while it ran, means the code moved under it. Then it proves nothing.
      const end = await snapshotWithin(c.dir);
      if (!end || end.tree !== snap.tree) return;
      const { output, complete } = testOutput(item, tail);
      const run = flaky.readRun({ cmd: c.command, output, isError: item.isError, complete });
      if (!run) return;
      const project = await projectOf(snap.root);
      if (!project) return;
      flakyCommands.delete(run.cmd);
      flakyCommands.set(run.cmd, flaky.normalizeCmd(c.command));
      if (flakyCommands.size > MAX_FLAKY_COMMANDS) flakyCommands.delete(flakyCommands.keys().next().value);
      const now = Date.now();
      const r = flaky.recordRun(d.config.get('flaky'), { key: project.id, name: project.name, root: project.root }, { ...run, tree: snap.tree }, now);
      let state = r.state;
      r.fresh.forEach(() => noteWeek('flaky'));
      for (const id of r.fixed) {
        noteWeek('flakefix');
        awardXp('flakefix', { project: project.name, label: `Fixed ${flaky.labelOf(id)}` });
      }
      const due = flaky.due(state, now);
      if (due && d.sayText(flaky.sayLine(due), 'flaky', 9000)) state = flaky.markSaid(state, due.key, due.id, now);
      d.config.set({ flaky: state });
      if (r.flakes.length || r.fixed.length) d.send(d.panel, 'flaky', flakyView());
    } catch (e) {
      d.log.error('flaky', e);
    }
  }

  /** The panel, on the flaky list. */
  function showFlaky() {
    d.showPanel({ focusInput: false });
    d.send(d.panel, 'panel:view', 'routines');
    d.send(d.panel, 'flaky:focus');
  }

  const FLAKY_ACTIONS = {
    fix: { status: 'fixing', title: row => `Fix flaky ${row.label}`, prompt: flaky.fixPrompt },
    quarantine: { status: 'quarantined', title: row => `Quarantine ${row.label}`, prompt: flaky.quarantinePrompt },
    unquarantine: { status: 'watching', title: row => `Bring back ${row.label}`, prompt: flaky.unquarantinePrompt },
  };

  /** Fix, quarantine, un-quarantine (each a task in a copy of the repo) or dismiss one flaky test. */
  async function flakyAct(key, id, action) {
    const row = flaky.findTest(d.config.get('flaky'), key, id, Date.now());
    if (!row) return { ok: false, error: "Shellby doesn't know that test any more." };
    if (action === 'dismiss') {
      d.config.set({ flaky: flaky.setStatus(d.config.get('flaky'), key, id, 'dismissed', Date.now()) });
      d.send(d.panel, 'flaky', flakyView());
      return { ok: true };
    }
    if (action === 'issue') return fileFlakyIssue(key, id, row);
    const act = Object.hasOwn(FLAKY_ACTIONS, action) ? FLAKY_ACTIONS[action] : null;
    if (!act) return { ok: false, error: 'Unknown action.' };
    const root = flaky.normalizeFlaky(d.config.get('flaky')).projects[key]?.root;
    if (!root || !d.isFolder(root)) return { ok: false, error: "Shellby can't find that project's folder any more." };
    const latest = flaky.normalizeFlaky(d.config.get('flaky')).projects[key].tests[id]?.cmds[0];
    const cmd = latest ? flakyCommands.get(latest) || null : null;
    // The prompt carries text from the repository (a test's name): never act on it without asking.
    const mode = d.config.get('mode') === 'autonomous' ? 'acceptEdits' : null;
    const res = await d.startTaskInCopy(root, act.title(row), w => act.prompt(row, { branch: w.branch, base: w.base, cmd }), { mode });
    if (!res.ok) return res;
    d.config.set({ flaky: flaky.setStatus(d.config.get('flaky'), key, id, act.status, Date.now()) });
    d.send(d.panel, 'flaky', flakyView());
    d.showPanel({ focusInput: false, tabId: res.tabId });
    return res;
  }

  /**
   * File a flaky test as a GitHub issue, labelled shellby and assigned to you,
   * so the Issue helper workflow can offer to take it on (and anyone else on the
   * repository can see it). Asks first: an issue can be public.
   */
  async function fileFlakyIssue(key, id, row) {
    if (row.issue) return { ok: true, ...row.issue, existing: true };
    if (!d.github?.can('claude')) return { ok: false, error: 'Filing issues needs “Let Claude tasks push code and open pull requests” on in Settings → GitHub.' };
    const root = flaky.normalizeFlaky(d.config.get('flaky')).projects[key]?.root;
    // Its origin on github.com, read from the folder itself (Projects may not list it).
    const repo = root && d.isFolder(root) ? (await readRepo(root).catch(() => null))?.remote : null;
    if (!repo) return { ok: false, error: "This project isn't on GitHub, so there's nowhere to file it." };
    const latest = flaky.normalizeFlaky(d.config.get('flaky')).projects[key].tests[id]?.cmds[0];
    const cmd = latest ? flakyCommands.get(latest) || null : null;
    const draft = flaky.issueDraft(row, { cmd });
    const gh = d.github.gh();
    const info = await gh.get(`/repos/${repo}`).catch(() => null);
    const response = await d.askOnce({
      icon: '🐛',
      title: `File an issue on ${repo}?`,
      message: `“${draft.title}”, with what Shellby saw: the test's name, how often it flaked and how to go about fixing it.`,
      // The one line that came from a terminal: shown as it will be posted, so a secret the redaction missed can be caught.
      detail: (cmd ? `The command, as it will appear: ${flaky.redactCmd(cmd)}\n\n` : '')
        + 'It\'s labelled shellby and assigned to you, so the Issue helper workflow can offer to take a crack at it.',
      note: info?.private === false ? `${repo} is public: anyone can read the issue.` : 'Anyone who can see the repository can read the issue.',
      buttons: [{ label: 'File it', style: 'primary' }, { label: 'Cancel' }], defaultId: 0, cancelId: 1,
    });
    if (response == null) return { ok: false, error: 'Another question from Shellby is open. Answer that one first.' };
    if (response !== 0) return { ok: false, canceled: true };
    // Filed while the question was open (a second click elsewhere): that one stands.
    const filed = flaky.findTest(d.config.get('flaky'), key, id, Date.now())?.issue;
    if (filed) return { ok: true, ...filed, existing: true };
    let made;
    try {
      made = await gh.post(`/repos/${repo}/issues`, { ...draft, labels: ['shellby'], assignees: [d.github.view().login].filter(Boolean) });
    } catch (e) {
      d.log.warn('flaky issue', e.message);
      return { ok: false, error: `GitHub didn't take it: ${e.message}` };
    }
    const next = flaky.setIssue(d.config.get('flaky'), key, id, { number: made?.number, url: made?.html_url }, Date.now());
    const kept = next.projects[key]?.tests[id]?.issue;
    if (!kept) {
      d.log.warn('flaky issue', 'unexpected answer', JSON.stringify({ number: made?.number, url: made?.html_url }));
      return { ok: false, error: "GitHub's answer didn't say which issue it made. Check the repository's issues before trying again." };
    }
    d.config.set({ flaky: next });
    d.send(d.panel, 'flaky', flakyView());
    return { ok: true, number: kept.number, url: kept.url };
  }

  // ---- the week in review (weekly.js)

  // XP kinds the week-in-review counts (shipping comes from recordShipped instead).
  const WEEK_XP_KINDS = new Set(['fixed', 'tests', 'task', 'deps', 'focus', 'trick']);

  // n: how many at once (a rewind takes back several turns).
  function noteWeek(kind, project = null, n = 1) {
    if (d.CAPTURE || !d.config) return;
    d.config.set({ weekly: weekly.recordDay(d.config.get('weekly'), Date.now(), kind, project && { id: project.id, name: project.name }, n) });
  }

  // A routine run, or a held message, finished while you were away: the card's
  // "Routines worked 3h 10m while you were away".
  function noteAwayRun(ms, { held = false } = {}) {
    if (d.CAPTURE || !d.config) return;
    d.config.set({ weekly: weekly.recordAwayRun(d.config.get('weekly'), Date.now(), ms, { held }) });
  }

  // What the plan bought (the card's "What your plan bought you"): Claude's
  // working time, and each fix with the failures that would undo it.
  function noteWorkTime(ms) {
    if (d.CAPTURE || !d.config || !(ms > 0)) return;
    d.config.set({ weekly: weekly.recordTime(d.config.get('weekly'), Date.now(), ms) });
  }

  function noteFix(key) {
    if (d.CAPTURE || !d.config) return;
    d.config.set({ weekly: weekly.recordFix(d.config.get('weekly'), Date.now(), key) });
  }

  function noteRed(key) {
    if (d.CAPTURE || !d.config) return;
    d.config.set({ weekly: weekly.recordRed(d.config.get('weekly'), Date.now(), key) });
  }

  function weekView() {
    const now = Date.now();
    const xp = normalizeXp(d.config.get('xp'));
    return weekly.weekSummary(d.config.get('weekly'), now, {
      xp, stickers: d.stickerState(), streak: streaks.streakOf(d.config.get('streaks'), now), level: levelFor(xp.total),
      usage: d.config.get('lastUsage'),
    });
  }

  // Friday afternoon, a week with something shipped in it: he says so, and the
  // Trophies page has the card ready. Once a week, and never during focus.
  function checkWrapUp() {
    if (d.CAPTURE || !d.config || d.config.get('crabOnly')) return;
    const w = weekView();
    const key = weekly.wrapUpDue(d.config.get('weekly'), Date.now(), w);
    if (!key) return;
    if (!d.sayText(`What a week: ${w.headline.charAt(0).toLowerCase()}${w.headline.slice(1)}!`, 'sticker', 9000)) return;
    d.config.set({ weekly: weekly.markWrapped(d.config.get('weekly'), key) });
    d.send(d.panel, 'week:ready', w);
  }

  return {
    awardXp, checkWrapUp, checkedUp, checkupsView, flakyAct, flakyOn, flakyTree, flakyView,
    knownFolder, noteAwayRun, noteFix, noteRed, noteTestRun, noteWeek, noteWorkTime, questDone, questsPanelView,
    roomTaskDone, roomsPanelView, runCheckup, setQuests, setRooms, showFlaky, weekView, xpView,
  };
}

module.exports = { wireProgress };
