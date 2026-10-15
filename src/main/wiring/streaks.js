// Streaks and nudges (progression/streaks.js): the days you've worked, the repos you
// worked in with their newest commit, and now and then a nudge back to one
// that's gone quiet.
// Kept out of main.js, which only wires it up.
const { app } = require('electron');
const focus = require('../focus');
const { repoOf, lastCommitAt } = require('../gitinfo');
const levels = require('../progression/levels');
const streaks = require('../progression/streaks');
const weekly = require('../weekly');
const { normalizeXp } = require('../progression/xp');

/** d: what main shares (main.js `shared`). */
function wireStreaks(d) {
  // Dev/e2e only: run the nudge check on demand, ignoring quiet hours (nudges only fire 9:00-21:00).
  const NUDGE_TEST = !app.isPackaged && process.env.SHELLBY_NUDGE_TEST === '1';

  // Tide-outs a week: two once the tide-out-plus perk is his (progression/levels.js).
  const streakOpts = () => ({ perWeek: levels.perksFor(levels.everLevel(normalizeXp(d.config.get('xp')))).has('tide-out-plus') ? 2 : streaks.TIDE_OUTS_PER_WEEK });

  function streaksView() {
    const s = streaks.normalize(d.config.get('streaks'));
    const now = Date.now();
    return {
      ...streaks.streakOf(s, now, streakOpts()), nudges: s.nudges, afterDays: s.afterDays,
      projects: Object.entries(s.projects).sort((a, b) => b[1].lastSeen - a[1].lastSeen).map(([key, p]) => ({
        key, name: p.name, muted: p.muted, lastSeen: p.lastSeen, lastCommitAt: p.lastCommitAt,
        quietDays: p.lastCommitAt ? streaks.daysSince(p.lastCommitAt, now) : null,
      })),
    };
  }

  function saveStreaks(next) {
    d.config.set({ streaks: next });
    d.send(d.panel, 'streaks', streaksView());
    d.refreshStatusLine();
  }

  // The tide-outs the streak has leaned on, written down (progression/streaks.js settleTideOuts)
  // so the panel shows 🌊 on them. Said once, kindly: a day off is allowed.
  function settleTideOuts() {
    if (d.CAPTURE || !d.config) return;
    const r = streaks.settleTideOuts(d.config.get('streaks'), Date.now(), streakOpts());
    if (!r.added.length) return;
    saveStreaks(r.state);
    const left = streaks.streakOf(r.state, Date.now(), streakOpts());
    if (left.current > 1) d.sayText?.(`🌊 Tide-out day: your ${left.current}-day streak is safe`, 'sticker', 7000);
  }

  // A task finished somewhere (dir: its working folder). Keeps the streak, and
  // remembers the git repo it ran in with its newest commit time. A merge home
  // (task: false) keeps the streak but isn't another task for the week's count.
  async function recordWork(dir, { task = true } = {}) {
    if (d.CAPTURE || !d.config) return;
    const { config } = d;
    d.timeTracker?.touch(dir);
    d.checkLeavingSoon();
    saveStreaks(streaks.recordWorkDay(config.get('streaks'), Date.now()));
    settleTideOuts();
    const repo = await repoOf(dir);
    if (!repo) return;
    if (task) config.set({ weekly: weekly.recordWork(config.get('weekly'), Date.now(), repo.name) }); // the week's top project
    const at = await lastCommitAt(repo.root);
    // Read after git answers, so nothing saved while it was asked is written over.
    let s = streaks.recordProject(config.get('streaks'), repo.key, repo.name, Date.now());
    if (at) s = streaks.recordCommit(s, repo.key, at);
    saveStreaks(s);
  }

  // Hourly: refresh every known project's last commit, then maybe nudge once.
  async function checkNudges() {
    if (d.CAPTURE || !d.config) return;
    const { config } = d;
    const found = [];
    for (const key of Object.keys(streaks.normalize(config.get('streaks')).projects)) {
      const at = await lastCommitAt(key);
      if (at) found.push([key, at]);
    }
    // Asking git about each project takes a while: a task finished or a project
    // muted meanwhile is in the settings now, so the times go onto those.
    let s = streaks.normalize(config.get('streaks'));
    for (const [key, at] of found) s = streaks.recordCommit(s, key, at);
    saveStreaks(s);
    settleTideOuts();
    if (config.get('crabOnly') || focus.guarding(config.get('focus'), Date.now())) return;
    const n = streaks.dueNudge(s, Date.now(), NUDGE_TEST ? 12 : undefined);
    if (!n) return;
    saveStreaks(streaks.markNudged(config.get('streaks'), n.key, Date.now()));
    d.flashState('asking', 4000);
    const open = () => { d.showPanel(); d.send(d.panel, 'tab:new-in', { cwd: n.key, draft: d.journal.draftFor(n.key, n.name) }); };
    if (NUDGE_TEST || (d.panel?.isVisible() && d.panel.isFocused())) d.send(d.panel, 'nudge', { ...n, text: streaks.nudgeText(n) });
    else d.notify(streaks.nudgeText(n), 'Click to pick up where you left off.', open);
  }

  return { NUDGE_TEST, checkNudges, recordWork, saveStreaks, settleTideOuts, streaksView };
}

module.exports = { wireStreaks };
