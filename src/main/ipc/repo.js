// A conversation's copy of the repository (worktrees.js): bringing it home or
// throwing it away, pushing the checkout with a secret scan first, and
// branching a conversation from any turn (branching.js).
// Kept out of main.js, which only wires it up.
const path = require('path');
const branching = require('../branching');
const changes = require('../changes');
const checks = require('../checks');
const confirm = require('../confirm');
const { createHomeLine } = require('../home-line');
const secretscan = require('../secretscan');
const { MAX_TABS } = require('../sessions');
const worktrees = require('../worktrees');

/**
 * @param {Pick<import('electron').IpcMain, 'handle' | 'on'>} ipcMain  main's, behind ipc-guard.js
 * @param d  what main shares with its IPC (main.js ipcDeps)
 */
function registerRepoIpc(ipcMain, d) {
  // ---- a copy of the repo per tab
  // Only a copy in Shellby's own folder: a History entry edited by hand can't
  // point "Throw it away" at some other worktree of yours.
  const worktreeOf = tabId => {
    const w = d.isStr(tabId) ? d.manager.tabs.get(tabId)?.worktree : null;
    const home = path.resolve(d.worktreeHome()).toLowerCase() + path.sep;
    return w && typeof w.path === 'string' && path.resolve(w.path).toLowerCase().startsWith(home) ? w : null;
  };
  const retiring = new Set(); // tabs mid bring-home or throw-away: a double click is one
  // Merges into one checkout take turns, and clashes are sorted out in turn (home-line.js).
  const line = createHomeLine({
    isOpen: id => d.manager.tabs.has(id),
    isBusy: id => d.manager.isBusy(id),
    send: (id, prompt) => {
      const turnId = d.manager.send(id, prompt, { kind: 'user', text: prompt });
      d.send(d.tabWindow?.(id) || d.panel, 'tab:sent', { tabId: id, item: { kind: 'user', text: prompt, attachments: [], turnId } });
    },
    bringHome: (id, opts) => bringTabHome(id, opts),
    caughtUp: w => worktrees.caughtUp(w),
    tell: e => d.send(d.panel, 'home:line', e),
    log: d.log,
  });
  d.homeTurnEnded = tabId => line.turnEnded(tabId); // wiring/timetrack.js onResult
  d.manager.on?.('tabs', summary => line.prune(new Set(summary.map(t => t.id))));
  // Another copy is merging into (or pushing from) this checkout: say why this one waits.
  const waitNote = (tabId, w) => { if (line.busy(w.root) && d.manager.tabs.has(tabId)) d.manager.note(tabId, { kind: 'home-wait', base: w.base }); };
  ipcMain.handle('worktree:status', (_e, tabId) => {
    const w = worktreeOf(tabId);
    return w ? worktrees.status(w) : { ok: false, error: 'That conversation has no copy of its own.' };
  });
  // Bringing it home merges and keeps the conversation going in its copy, so
  // you can carry on and bring it home again. finish: also tidy the copy away
  // (the tab closes; the conversation stays in History).
  ipcMain.handle('worktree:home', (_e, tabId, opts) => bringTabHome(tabId, opts));
  // Red checks: nothing merged, and what failed, for the panel to offer "anyway" or "fix them".
  const redResult = (gate, w) => ({
    ok: false, red: true, checks: gate.checks, fix: gate.fix, base: w.base, branch: w.branch,
    error: `${checks.redHeadline(gate.checks)} on this branch, so it stayed in its copy.`,
  });
  async function bringTabHome(tabId, opts) {
    const w = worktreeOf(tabId);
    if (!w) return { ok: false, error: 'That conversation has no copy of its own.' };
    if (d.manager.isBusy(tabId)) return { ok: false, error: 'Let him finish first.' };
    if (retiring.has(tabId)) return { ok: false, error: 'Already on it.' };
    retiring.add(tabId);
    try {
      // The tests first, when you've asked for that (wiring/checks.js): red stops here, unless forced.
      const gate = await d.gateHome(tabId, w, { check: typeof opts?.check === 'boolean' ? opts.check : undefined, force: opts?.force === true });
      if (!gate.ok) return gate.red ? redResult(gate, w) : gate;
      if (d.manager.isBusy(tabId)) return { ok: false, error: 'He started on something new. Bring it home once he has finished.' };
      const green = gate.verdict?.status === 'pass' ? { green: true } : {};
      // Asked before "Brought home" goes in the conversation, which would count against it.
      const firstTry = !!d.surprises?.firstLanding(tabId, gate.verdict);
      waitNote(tabId, w);
      const landed = await line.turn(w.root, () => mergeTabHome(tabId, w, { green, firstTry, push: !!opts?.push }));
      // A push that fails leaves the merge where it is: the copy stays, so the
      // push can be tried again from the folder menu.
      if (!landed.ok || !opts?.finish || (landed.push && !landed.push.ok)) return landed;
      const removed = await d.retireWorktree(tabId, w, { force: false });
      // Home and the copy tidied away: that conversation's work is finished, so
      // History ticks it off. Throw away doesn't (discarded isn't done), and
      // giving it more work later puts it back (sessions.js).
      d.history.setDone(tabId, true);
      return { ...landed, kept: false, tidied: removed.ok };
    } finally {
      retiring.delete(tabId);
    }
  }
  // The merge and the push, on this checkout's turn (home-line.js).
  async function mergeTabHome(tabId, w, { green, firstTry, push }) {
    // It waited its turn: he may have started on something since.
    if (d.manager.isBusy(tabId)) return { ok: false, error: 'He started on something new. Bring it home once he has finished.' };
    const merged = { ...await worktrees.bringHome(w, { message: worktrees.workMessage(w.branch, d.manager.tabs.get(tabId)?.title), trailer: d.crabTrailer() }), ...green };
    d.bugdex?.homeResult(tabId, w, merged); // a clash is a Two-Headed Crab; home at last, it's caught
    if (!merged.ok) {
      // What git said goes in the conversation, where it can be read in full.
      if (merged.detail) d.manager.note(tabId, { kind: 'error', text: `${merged.error}\n\n${merged.detail}` });
      return { ...merged, base: w.base };
    }
    d.recordWork(w.originalCwd, { task: false });
    if (merged.merged) {
      d.manager.note(tabId, { kind: 'home', base: w.base, commits: merged.commits });
      d.noteWeek('home'); // the weekly card's "brought N branches home"
      d.questDone?.('home');
      d.backlogHome?.(tabId); // a Next up task's work came home: offer to tick it off (wiring/backlog.js)
      if (firstTry) d.surprises.landed(tabId, { branch: w.branch, base: w.base });
    }
    d.refreshClashes?.(w.root); // its work is in the base now, so it clashes with nothing
    // And on to GitHub, still on this checkout's turn.
    const pushed = push ? await pushHome(w.root, { base: w.base, tabId }) : null;
    return { ...merged, base: w.base, kept: true, push: pushed };
  }

  // A copy that clashed with its base: line it up to sort that out and come
  // home, after the copies ahead of it (home-line.js). opts: what Bring it home was asked for.
  ipcMain.handle('worktree:sort-out', (_e, tabId, opts) => {
    const w = worktreeOf(tabId);
    if (!w) return { ok: false, error: 'That conversation has no copy of its own.' };
    return line.sortOut(tabId, w, d.manager.tabs.get(tabId)?.title, { push: opts?.push === true, check: typeof opts?.check === 'boolean' ? opts.check : undefined });
  });
  // Several at once (Bring all home's clashes), in the order given.
  ipcMain.handle('repo:sort-out', (_e, tabIds, opts) => {
    if (!Array.isArray(tabIds)) return { ok: false, error: 'Nothing to sort out.' };
    const lined = tabIds.slice(0, MAX_TABS).map(id => {
      const w = worktreeOf(id);
      return w ? line.sortOut(id, w, d.manager.tabs.get(id)?.title, { push: opts?.push === true }) : null;
    }).filter(r => r?.ok);
    return { ok: lined.length > 0, lined: lined.length, error: lined.length ? undefined : 'None of them is open.' };
  });

  // ---- the repository as a whole: push it, and bring every copy home
  //
  // Both act on your checkout, so neither runs while a conversation is
  // working in it (a merge from the remote would land under its feet).
  const sameDir = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  const repoOf = async tabId => {
    const tab = d.isStr(tabId) ? d.manager.tabs.get(tabId) : null;
    if (tab?.worktree) return worktreeOf(tabId)?.root || null;
    const root = await changes.rootOf(tab?.session?.cwd || d.config.get('cwd'));
    const home = path.resolve(d.worktreeHome()).toLowerCase() + path.sep;
    return root && !(path.resolve(root) + path.sep).toLowerCase().startsWith(home) ? root : null;
  };
  const busyInCheckout = root => [...d.manager.tabs.values()].some(t => !t.worktree && t.session?.busy && t.session.cwd
    && (path.resolve(t.session.cwd) + path.sep).toLowerCase().startsWith(path.resolve(root).toLowerCase() + path.sep));
  // Every copy of this repository with a record Shellby trusts: open tabs (not
  // mid-turn, not mid bring-home) and conversations in History that still have one.
  const copiesOf = root => {
    const home = path.resolve(d.worktreeHome()).toLowerCase() + path.sep;
    const ours = w => w && typeof w.path === 'string' && typeof w.root === 'string'
      && path.resolve(w.path).toLowerCase().startsWith(home) && sameDir(w.root, root) && !worktrees.checkWorktree(w);
    const open = [...d.manager.tabs.entries()].filter(([, t]) => ours(t.worktree)).map(([id, t]) => ({ id, w: t.worktree, title: t.title, busy: !!t.session?.busy || retiring.has(id) }));
    const shut = d.history.list().filter(e => !d.manager.tabs.has(e.id) && ours(e.worktree)).map(e => ({ id: e.id, w: e.worktree, title: e.title, busy: false }));
    const seen = new Set();
    return [...open, ...shut].filter(c => !seen.has(c.w.branch) && seen.add(c.w.branch));
  };
  let repoBusy = false;
  // Before anything leaves the PC: what looks like a secret in the commits
  // this push would send (secretscan.js). Nothing found: null, push on. Found:
  // ask, with "Push anyway", "Ask Claude to take them out" (a draft in a new
  // tab, for you to send) and "Don't push" as the safe default.
  async function secretGate(root) {
    const scan = await secretscan.outgoing(root);
    if (!scan.ok) { d.log.warn('secret scan: git could not list what this push sends'); return null; }
    if (!scan.findings.length) return null;
    const list = scan.findings.map(secretscan.describe);
    const more = scan.more ? `\n…and ${scan.more} more` : '';
    const canFix = !d.config.get('crabOnly');
    const buttons = [{ label: 'Push anyway', style: 'danger' }, ...(canFix ? [{ label: 'Ask Claude to take them out' }] : []), { label: "Don't push" }];
    const cancelId = buttons.length - 1;
    const n = scan.findings.length + scan.more;
    const response = await confirm.ask(d.panel, {
      ...d.dialogLook(), icon: '🔑', danger: true,
      title: n === 1 ? 'This push has something that looks like a secret' : `This push has ${n} things that look like secrets`,
      message: `Once it's on ${path.basename(root)}'s remote, anyone who can see the repository can copy it, and deleting it later doesn't take it back out of history.`,
      detail: list.join('\n') + more,
      note: scan.partial ? 'The changes were too big to check all of it, so there may be more.' : 'Shellby only shows where it is, never the value. A real key that has been pushed should be rotated.',
      buttons, defaultId: cancelId, cancelId,
    });
    if (response === 0) { d.log.info(`push: sent anyway past ${n} possible secret(s)`); d.bugdex?.secretIgnored(root); return null; }
    if (canFix && response === 1) {
      d.bugdex?.secretSpotted(root, scan.findings.map(f => f.kind)); // a Leaky Clam, caught when the next push goes out clean
      d.showPanel();
      d.send(d.panel, 'tab:new-in', { cwd: root, draft: `Before I push: Shellby found what look like secrets in commits that haven't been pushed yet: ${list.join('; ')}. Take them out of the code (an environment variable, or a .env file that .gitignore covers), and since they're in commits that haven't left this PC, rewrite those commits so the secret isn't in the history either. Don't push. Ask me before anything destructive, and tell me which keys I should rotate.` });
    }
    return { ok: false, cancelled: true, secrets: n, error: 'Not pushed: it had something that looks like a secret.' };
  }

  /**
   * @param {string} root  the checkout to push
   * @param {{ base?: string, tabId?: string }} [opts]  the branch to push, and the tab to note it in
   */
  async function pushHome(root, { base, tabId } = {}) {
    if (busyInCheckout(root)) return { ok: false, error: 'A conversation is working in your checkout. Let it finish first.' };
    const stopped = await secretGate(root);
    if (stopped) return stopped;
    const r = await worktrees.pushBase(root, { base });
    if (r.ok && r.pushed) {
      d.bugdex?.pushedClean(root);
      d.awardXp('ship', { project: path.basename(root) });
      d.shipped(root, 'ship');
      if (tabId) d.manager.note(tabId, { kind: 'pushed', branch: r.branch, remote: r.remote, commits: r.pushed, pulled: r.pulled });
    }
    if (!r.ok) {
      d.log.info(`push: ${r.error}`);
      // What a pre-push hook said goes in the conversation, where it can be read in full.
      if (r.detail && tabId) d.manager.note(tabId, { kind: 'error', text: `${r.error}

${r.detail}` });
    }
    return r;
  }

  ipcMain.handle('repo:status', async (_e, tabId, opts) => {
    const root = await repoOf(tabId);
    if (!root) return { ok: false, error: 'Not a git repository.' };
    const [s, copies] = await Promise.all([
      worktrees.remoteStatus(root, { fetch: !!opts?.fetch }),
      Promise.all(copiesOf(root).map(async c => ({ ...c, s: await worktrees.status(c.w) }))),
    ]);
    const waiting = copies.filter(c => c.s.ok && (c.s.ahead || c.s.uncommitted));
    return { ...s, root, name: path.basename(root), copies: waiting.length, copiesBusy: waiting.filter(c => c.busy).length };
  });
  ipcMain.handle('repo:push', async (_e, tabId) => {
    const root = await repoOf(tabId);
    if (!root) return { ok: false, error: 'Not a git repository.' };
    if (repoBusy) return { ok: false, error: 'Already on it.' };
    repoBusy = true;
    try { return await line.turn(root, () => pushHome(root, { tabId })); } finally { repoBusy = false; }
  });
  // Every copy with something to bring home gets its checks first, one at a
  // time (wiring/checks.js). Any red: nothing is merged, and the panel hears
  // which. -> { green: copies that passed, red: the result to return, or null }
  async function gateAll(list, opts) {
    const check = typeof opts?.check === 'boolean' ? opts.check : undefined;
    if (opts?.force === true || !(check ?? d.checksOn())) return { green: 0, red: null, firstTries: new Set() };
    const reds = [];
    const firstTries = new Set(); // copies green on their first try, asked before any of them is home
    let green = 0;
    for (const c of list) {
      const s = await worktrees.status(c.w);
      if (!s.ok || !(s.ahead || s.uncommitted)) continue;
      const gate = await d.gateHome(c.id, c.w, { check, force: false });
      // Started on something new while its tests ran: what was checked isn't what would merge.
      if (d.manager.isBusy(c.id)) return { green, red: { ok: false, error: `"${c.title || c.w.branch}" started on something new while its tests ran, so nothing was merged. Try again once it's finished.` } };
      if (gate.red) reds.push({ tabId: d.manager.tabs.has(c.id) ? c.id : null, title: c.title, branch: c.w.branch, checks: gate.checks, fix: gate.fix });
      else if (!gate.ok) return { green, red: { ok: false, error: gate.error } };
      else if (gate.verdict?.status === 'pass') {
        green++;
        if (d.surprises?.firstLanding(c.id, gate.verdict)) firstTries.add(c.w.branch);
      }
    }
    if (!reds.length) return { green, red: null, checked: true, firstTries };
    const first = reds[0];
    const error = reds.length === 1
      ? `${checks.redHeadline(first.checks)} on "${first.title || first.branch}", so nothing was merged.`
      : `The checks failed on ${reds.length} copies, so nothing was merged.`;
    return { green, red: { ok: false, red: true, reds, error } };
  }

  ipcMain.handle('repo:home-all', async (_e, tabId, opts) => {
    const root = await repoOf(tabId);
    if (!root) return { ok: false, error: 'Not a git repository.' };
    if (repoBusy) return { ok: false, error: 'Already on it.' };
    if (busyInCheckout(root)) return { ok: false, error: 'A conversation is working in your checkout. Let it finish first.' };
    const list = copiesOf(root).filter(c => !c.busy);
    const busy = copiesOf(root).length - list.length;
    repoBusy = true;
    for (const c of list) retiring.add(c.id);
    try {
      const gated = await gateAll(list, opts);
      if (gated.red) return gated.red;
      // ...or one checked earlier started on something while the others' tests ran.
      const moved = gated.checked && list.find(c => d.manager.isBusy(c.id));
      if (moved) return { ok: false, error: `"${moved.title || moved.w.branch}" started on something new while the tests ran, so nothing was merged. Try again once it's finished.` };
      return await line.turn(root, () => homeAll(root, list, busy, gated, opts, tabId));
    } finally {
      for (const c of list) retiring.delete(c.id);
      repoBusy = false;
    }
  });
  // The merges and the push, on this checkout's turn (home-line.js).
  async function homeAll(root, list, busy, gated, opts, tabId) {
    const titles = new Map(list.map(c => [c.w.branch, c.title]));
    const r = await worktrees.bringAllHome(list.map(c => c.w), { messageFor: w => worktrees.workMessage(w.branch, titles.get(w.branch)), trailer: d.crabTrailer() });
    for (const x of r.results) {
      const c = list.find(l => l.w.branch === x.branch);
      if (x.ok && x.merged && c && d.manager.tabs.has(c.id)) d.manager.note(c.id, { kind: 'home', base: c.w.base, commits: x.commits });
    }
    const merged = r.results.filter(x => x.ok && x.merged);
    if (merged.length) {
      d.recordWork(root, { task: false });
      d.noteWeek('home', null, merged.length);
      d.questDone?.('home');
      d.refreshClashes?.(root);
    }
    // One fanfare for the lot, in the first of them that's open.
    const clean = merged.map(x => list.find(c => c.w.branch === x.branch)).filter(c => c && gated.firstTries?.has(c.w.branch));
    if (clean.length) {
      const where = clean.find(c => d.manager.tabs.has(c.id)) || clean[0];
      d.surprises.landed(where.id, { branch: where.w.branch, base: where.w.base, copies: clean.length });
    }
    const clash = r.stopped ? list.find(c => c.w.branch === r.stopped) : null;
    const last = r.results.at(-1);
    const clashTab = clash && d.manager.tabs.has(clash.id) ? clash.id : null;
    if (clashTab && last.detail) d.manager.note(clashTab, { kind: 'error', text: `${last.error}\n\n${last.detail}` });
    // The ones that clashed were passed over: the panel offers to line them up to sort it out.
    const clashed = (r.clashed || []).map(b => list.find(c => c.w.branch === b)).filter(Boolean)
      .map(c => ({ branch: c.w.branch, title: c.title, base: c.w.base, tabId: d.manager.tabs.has(c.id) ? c.id : null }));
    const out = {
      ok: r.ok, root, busy,
      merged: merged.length, commits: merged.reduce((n, x) => n + x.commits, 0),
      skipped: r.results.filter(x => x.skipped).length,
      clashed,
      stopped: clash ? { branch: clash.w.branch, title: clash.title, tabId: clashTab, base: clash.w.base, error: last.error, conflict: !!last.conflict, fixable: !!last.fixable, root: last.root, detail: last.detail } : null,
      green: gated.green,
    };
    if (r.ok && opts?.push) out.push = await pushHome(root, { tabId });
    return out;
  }
  // Copies that changed the same files (wiring/clashes.js): what the panel shows on load.
  ipcMain.handle('clashes:list', () => d.clashesView());
  ipcMain.handle('worktree:discard', async (_e, tabId) => {
    const w = worktreeOf(tabId);
    if (!w) return { ok: false, error: 'That conversation has no copy of its own.' };
    if (retiring.has(tabId)) return { ok: false, error: 'Already on it.' };
    retiring.add(tabId);
    try { return await d.retireWorktree(tabId, w, { force: true }); } finally { retiring.delete(tabId); }
  });

  // ---- branching a conversation from any turn (branching.js)
  let branchAsking = false; // one question at a time, so a flood of them can't be clicked through
  branching.register({
    ipcMain, manager: d.manager, history: d.history, MAX_TABS, log: d.log, stat: d.stat, wake: d.wake, composePrompt: d.composePrompt, openTab: d.openTab, send: d.send,
    panel: () => d.panel, worktreeHome: d.worktreeHome, claudeConfigDir: d.claudeConfigDir,
    turnEnding: tabId => d.turnEnds.get(tabId) || Promise.resolve(),
    turnStart: tabId => d.turnStarts.get(tabId) || null,
    correctionFromTurns: d.correctionFromTurns, noteCorrection: d.noteCorrection, questDone: id => d.questDone?.(id),
    ask: async spec => {
      if (branchAsking) return null;
      branchAsking = true;
      try { return await confirm.ask(d.panel, { ...d.dialogLook(), ...spec }); } finally { branchAsking = false; }
    },
    bringHome: bringTabHome,
    retire: async (id, w, opts) => {
      if (retiring.has(id)) return { ok: false, error: 'Already on it.' };
      retiring.add(id);
      try { return await d.retireWorktree(id, w, opts); } finally { retiring.delete(id); }
    },
  });
}

module.exports = { registerRepoIpc };
