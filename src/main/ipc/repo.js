// A conversation's copy of the repository (worktrees.js): bringing it home or
// throwing it away, pushing the checkout with a secret scan first, and
// branching a conversation from any turn (branching.js).
// Kept out of main.js, which only wires it up.
const path = require('path');
const branching = require('../branching');
const changes = require('../changes');
const checks = require('../checks');
const confirm = require('../confirm');
const secretscan = require('../secretscan');
const { MAX_TABS } = require('../sessions');
const worktrees = require('../worktrees');

/** d: what main shares with its IPC (main.js ipcDeps). */
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
      const merged = { ...await worktrees.bringHome(w, { message: `Shellby: ${d.manager.tabs.get(tabId)?.title || 'work from a tab'}` }), ...green };
      if (!merged.ok) {
        // What git said goes in the conversation, where it can be read in full.
        if (merged.detail) d.manager.note(tabId, { kind: 'error', text: `${merged.error}\n\n${merged.detail}` });
        return { ...merged, base: w.base };
      }
      d.recordWork(w.originalCwd, { task: false });
      if (merged.merged) d.manager.note(tabId, { kind: 'home', base: w.base, commits: merged.commits });
      // And on to GitHub. A push that fails leaves the merge where it is: the
      // copy stays, so the push can be tried again from the folder menu.
      const pushed = opts?.push ? await pushHome(w.root, { base: w.base, tabId }) : null;
      if (pushed && !pushed.ok) return { ...merged, base: w.base, kept: true, push: pushed };
      if (!opts?.finish) return { ...merged, base: w.base, kept: true, push: pushed };
      const removed = await d.retireWorktree(tabId, w, { force: false });
      // Home and the copy tidied away: that conversation's work is finished, so
      // History ticks it off. Throw away doesn't (discarded isn't done), and
      // giving it more work later puts it back (sessions.js).
      d.history.setDone(tabId, true);
      return { ...merged, base: w.base, tidied: removed.ok, push: pushed };
    } finally {
      retiring.delete(tabId);
    }
  }

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
    if (response === 0) { d.log.info(`push: sent anyway past ${n} possible secret(s)`); return null; }
    if (canFix && response === 1) {
      d.showPanel();
      d.send(d.panel, 'tab:new-in', { cwd: root, draft: `Before I push: Shellby found what look like secrets in commits that haven't been pushed yet: ${list.join('; ')}. Take them out of the code (an environment variable, or a .env file that .gitignore covers), and since they're in commits that haven't left this PC, rewrite those commits so the secret isn't in the history either. Don't push. Ask me before anything destructive, and tell me which keys I should rotate.` });
    }
    return { ok: false, cancelled: true, secrets: n, error: 'Not pushed: it had something that looks like a secret.' };
  }

  async function pushHome(root, { base, tabId } = {}) {
    if (busyInCheckout(root)) return { ok: false, error: 'A conversation is working in your checkout. Let it finish first.' };
    const stopped = await secretGate(root);
    if (stopped) return stopped;
    const r = await worktrees.pushBase(root, { base });
    if (r.ok && r.pushed) {
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
    try { return await pushHome(root, { tabId }); } finally { repoBusy = false; }
  });
  // Every copy with something to bring home gets its checks first, one at a
  // time (wiring/checks.js). Any red: nothing is merged, and the panel hears
  // which. -> { green: copies that passed, red: the result to return, or null }
  async function gateAll(list, opts) {
    const check = typeof opts?.check === 'boolean' ? opts.check : undefined;
    if (opts?.force === true || !(check ?? d.checksOn())) return { green: 0, red: null };
    const reds = [];
    let green = 0;
    for (const c of list) {
      const s = await worktrees.status(c.w);
      if (!s.ok || !(s.ahead || s.uncommitted)) continue;
      const gate = await d.gateHome(c.id, c.w, { check, force: false });
      if (gate.red) reds.push({ tabId: d.manager.tabs.has(c.id) ? c.id : null, title: c.title, branch: c.w.branch, checks: gate.checks, fix: gate.fix });
      else if (!gate.ok) return { green, red: { ok: false, error: gate.error } };
      else if (gate.verdict?.status === 'pass') green++;
    }
    if (!reds.length) return { green, red: null };
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
      const titles = new Map(list.map(c => [c.w.branch, c.title]));
      const r = await worktrees.bringAllHome(list.map(c => c.w), { messageFor: w => `Shellby: ${titles.get(w.branch) || 'work from a tab'}` });
      for (const x of r.results) {
        const c = list.find(l => l.w.branch === x.branch);
        if (x.ok && x.merged && c && d.manager.tabs.has(c.id)) d.manager.note(c.id, { kind: 'home', base: c.w.base, commits: x.commits });
      }
      const merged = r.results.filter(x => x.ok && x.merged);
      if (merged.length) d.recordWork(root, { task: false });
      const clash = r.stopped ? list.find(c => c.w.branch === r.stopped) : null;
      const last = r.results.at(-1);
      const clashTab = clash && d.manager.tabs.has(clash.id) ? clash.id : null;
      if (clashTab && last.detail) d.manager.note(clashTab, { kind: 'error', text: `${last.error}\n\n${last.detail}` });
      const out = {
        ok: r.ok, root, busy,
        merged: merged.length, commits: merged.reduce((n, x) => n + x.commits, 0),
        skipped: r.results.filter(x => x.skipped).length,
        stopped: clash ? { branch: clash.w.branch, title: clash.title, tabId: clashTab, base: clash.w.base, error: last.error, conflict: !!last.conflict, fixable: !!last.fixable, root: last.root, detail: last.detail } : null,
        green: gated.green,
      };
      if (r.ok && opts?.push) out.push = await pushHome(root, { tabId });
      return out;
    } finally {
      for (const c of list) retiring.delete(c.id);
      repoBusy = false;
    }
  });
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
