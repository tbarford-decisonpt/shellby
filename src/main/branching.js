// Branching a conversation (branch.js says what a branch is; this file makes
// one): "Try again from here" on any message, "Branch from here" on any reply.
// A new tab picks the conversation up at that point, in a copy of the
// repository with the files exactly as they were then, while the original
// carries on untouched. Two tries at the same thing, side by side.
//
// Then, once you've seen both: compare them file by file, and keep the one you
// like (it comes home; the other tries are thrown away).
//
// Every step that makes something (a copy, a History entry, a tab) is undone
// if a later one fails, so a branch either opens whole or not at all.
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const branch = require('./branch');
const worktrees = require('./worktrees');
const changes = require('./changes');

const isStr = s => typeof s === 'string' && s.length > 0 && s.length < 10000;
const snippet = t => {
  const s = String(t || '').replace(/\s+/g, ' ').trim();
  return s.length > 80 ? `${s.slice(0, 77)}…` : s;
};

/**
 * deps: { ipcMain, manager, history, MAX_TABS, ask(spec) -> button index | null,
 *   panel(), send(win, channel, payload), worktreeHome(), claudeConfigDir(),
 *   turnEnding(tabId), turnStart(tabId) -> { root, tree, head, turnId } | null,
 *   composePrompt(text, files), bringHome(tabId, opts), retire(tabId, w, opts),
 *   correctionFromTurns(tabId, kind, refs), noteCorrection(tabId, event),
 *   wake(), stat(event), log }
 */
function register(deps) {
  const { ipcMain, manager, history } = deps;
  const busyBranching = new Set();        // source tabs mid-branch: a double click is one branch
  const compared = new Map();             // `${tabId}>${otherId}` -> the last comparison, for its diffs

  // Only a copy in Shellby's own folder, with a record that checks out.
  const ours = w => {
    if (!w || worktrees.checkWorktree(w)) return false;
    const home = path.resolve(deps.worktreeHome()).toLowerCase() + path.sep;
    return path.resolve(w.path).toLowerCase().startsWith(home);
  };

  // ------------------------------------------------------------ making one

  ipcMain.handle('branch:run', async (_e, { tabId, turnId, at = 'before', send = false } = {}) => {
    if (!isStr(tabId) || !isStr(turnId)) return { ok: false, error: 'There is nothing to branch from there.' };
    if (busyBranching.has(tabId)) return { ok: false, error: 'Already making a branch of this one.' };
    if (manager.tabs.size >= deps.MAX_TABS) return { ok: false, error: `Shellby can run up to ${deps.MAX_TABS} conversations at once. Close one first, then branch.` };
    if (manager.tabs.get(tabId)?.rewinding) return { ok: false, error: 'Rewinding: try again in a moment.' };
    busyBranching.add(tabId);
    // Rewind (parity.js) waits while this reads the transcript it would cut.
    const source = manager.tabs.get(tabId);
    if (source) source.branching = true;
    try {
      const where = at === 'after' ? 'after' : 'before';
      // Trying a message again is a correction of what that turn did (corrections.js).
      const lesson = where === 'before' ? deps.correctionFromTurns?.(tabId, 'retry', { turnIds: [turnId] }) : null;
      const r = await makeBranch({ tabId, turnId, at: where, send: !!send });
      if (r?.ok && lesson) deps.noteCorrection?.(tabId, lesson);
      return r;
    } catch (err) {
      deps.log.info(`branch: ${err.message}`);
      return { ok: false, error: `Couldn't make the branch: ${err.message}` };
    } finally {
      busyBranching.delete(tabId);
      if (source) source.branching = false;
    }
  });

  async function makeBranch({ tabId, turnId, at, send }) {
    const entry = history.get(tabId);
    if (!entry) return { ok: false, error: 'Send it something first: there is nothing to branch yet.' };
    const tab = manager.tabs.get(tabId) || null;
    // The last turn's diff and checkpoint are noted just after it ends.
    await deps.turnEnding(tabId);

    const p = branch.plan(history.load(tabId), { turnId, at });
    if (!p.ok) return p;
    if (!p.conversation) return { ok: false, error: 'That part of the conversation is from before Shellby could branch it. Try a later message.' };

    // Claude's side: the session the anchor was written in, wherever it is kept.
    const configDir = deps.claudeConfigDir();
    const sourceCwd = tab?.session.cwd || entry.cwd;
    const sessionId = p.fresh ? null : p.sessionId || entry.claudeSessionId || null;
    const sessionFile = sessionId
      ? worktrees.findSession({ configDir, sessionId, prefer: [sourceCwd, entry.cwd, entry.worktree?.cwd] })
      : null;
    if (!p.fresh && !sessionFile) return { ok: false, error: "Claude Code's record of this conversation has gone, so it can't be picked up from there." };

    // The files: a copy of the repository as it was then.
    const made = await makeCopy({ entry, tab, p, turnId, at, sourceCwd });
    if (made.cancelled) return { ok: false, cancelled: true, error: 'Not branched.' };
    const { copy, shared, filesNow } = made;
    const cwd = copy ? copy.cwd : sourceCwd;
    // Claude Code's record, carried to where the copy's conversation is
    // resumed from. Put back as it was if the branch doesn't happen after all.
    const carried = sessionFile ? path.join(configDir, 'projects', worktrees.projectDirName(cwd), path.basename(sessionFile)) : null;
    const hadCarried = !!carried && fs.existsSync(carried);
    const undoCopy = async () => {
      if (carried && !hadCarried) { try { fs.rmSync(carried, { force: true }); } catch { /* best effort */ } }
      if (copy) await worktrees.remove(copy, { force: true });
    };

    if (sessionFile && !worktrees.copySession({ configDir, file: sessionFile, to: cwd })) {
      await undoCopy();
      return { ok: false, error: "Claude Code's record of this conversation couldn't be carried into the copy." };
    }

    // Its History entry and transcript. Its diffs point at its own copy, so
    // View diff, Undo and Rewind all work there and never on the original.
    const newId = randomUUID();
    const sourceTitle = tab?.title || entry.title;
    const copyRoot = copy ? (await changes.rootOf(copy.path)) || copy.path : null;
    const msg = p.text || (p.attachments.length ? `${p.attachments.length} attached file${p.attachments.length === 1 ? '' : 's'}` : '');
    const marker = {
      t: Date.now(), kind: 'branched', from: tabId, fromTitle: sourceTitle, at, turnId, text: snippet(msg),
      ...(copy ? { branch: copy.branch, base: copy.base } : {}),
      ...(shared ? { shared: true } : {}), ...(p.approx ? { approx: true } : {}), ...(filesNow ? { filesNow: true } : {}),
    };
    const items = [...branch.reroot(p.items, copyRoot), marker];
    const fence = copy
      ? branch.makeFence([entry.worktree?.path, entry.worktree?.root, made.repoRoot, ...(entry.fence?.paths || [])].filter(Boolean), copy.path,
        [entry.worktree?.branch, ...(entry.fence?.refs || [])])
      : null;
    try {
      history.create({ id: newId, title: branch.branchTitle(sourceTitle), cwd, mode: entry.mode, routineId: null });
      history.update(newId, {
        claudeSessionId: sessionId, resumeAt: p.fresh ? null : p.anchor, context: null,
        worktree: copy, fence,
        branchOf: { id: tabId, title: sourceTitle, turnId, at },
        preamble: preambleFor({ p, copy, shared, filesNow, sourceCwd, fence }),
      });
      if (!history.rewrite(newId, items)) throw new Error("couldn't save its conversation");
      deps.openTab({ tabId: newId, historyEntry: history.get(newId) });
    } catch (err) {
      manager.close(newId);
      history.remove(newId);
      await undoCopy();
      throw err;
    }

    // The original says where its branch went, so you can find it again.
    const off = { t: Date.now(), kind: 'branched-off', to: newId, title: branch.branchTitle(sourceTitle), at, turnId, text: snippet(msg), ...(copy ? { branch: copy.branch } : {}) };
    // Asked now, not when it began: the original may have closed while it was made.
    if (manager.tabs.has(tabId)) manager.note(tabId, off); else history.append(tabId, off);

    // "Run it again": the same message goes straight away, so two takes run side by side.
    let sent = false;
    if (send && at === 'before' && (p.text || p.attachments.length)) {
      try {
        manager.send(newId, deps.composePrompt(p.text, p.attachments), { kind: 'user', text: p.text, attachments: p.attachments });
        sent = true;
        deps.wake();
      } catch (err) {
        deps.log.info(`branch send: ${err.message}`);
      }
    }
    deps.send(deps.panel(), 'tab:opened', {
      tabId: newId, entry: history.get(newId), items: history.load(newId), background: false, busy: sent,
      ...(sent ? {} : { draft: p.text, attachments: p.attachments }),
    });
    deps.stat('branched');
    deps.log.info(`branch: ${copy ? copy.branch : 'same folder'} from a ${at} point`);
    return { ok: true, tabId: newId, sent, shared, approx: p.approx, filesNow, branch: copy?.branch || null, base: copy?.base || null };
  }

  /**
   * A copy of the repository at the branch point, asking first when it can't be
   * exact. -> { copy, shared, filesNow, repoRoot } | { cancelled: true }
   */
  async function makeCopy({ entry, tab, p, turnId, at, sourceCwd }) {
    const own = ours(entry.worktree) ? entry.worktree : null;
    const repoRoot = own ? own.root : await changes.rootOf(sourceCwd);
    // Not a git project (a chat in your home folder): the conversation branches,
    // and the two share the folder, which is how it worked before copies.
    if (!repoRoot) return { copy: null, shared: true, filesNow: false, repoRoot: null };
    const home = path.resolve(deps.worktreeHome()).toLowerCase() + path.sep;
    if ((path.resolve(repoRoot) + path.sep).toLowerCase().startsWith(home)) return { copy: null, shared: true, filesNow: false, repoRoot: null };

    // The turn that is running right now has no checkpoint yet; its start does.
    const live = at === 'before' ? deps.turnStart(entry.id) : null;
    let files = live && live.turnId === turnId ? { root: live.root, tree: live.tree, head: live.head } : p.files;
    let filesNow = false;
    const now = async () => {
      filesNow = true;
      const s = await changes.snapshot(sourceCwd);
      return s ? { root: s.root, tree: s.tree, head: s.head } : null;
    };
    if (!files) files = await now();

    const sourceTop = own ? own.path : repoRoot;
    const rel = path.relative(sourceTop, sourceCwd);
    const prefix = rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : '';
    const base = own?.base || await worktrees.branchOf(repoRoot);
    if (!base) {
      const r = await deps.ask({
        icon: '⑂', title: 'Branch in the same folder?',
        message: 'Your checkout is not on a branch (detached HEAD), so a copy would have nowhere to be brought home to.',
        detail: 'The branch can still start here, sharing this folder with the original: changes either one makes, the other sees.',
        buttons: [{ label: 'Share the folder', style: 'primary' }, { label: 'Cancel' }], defaultId: 0, cancelId: 1,
      });
      return r === 0 ? { copy: null, shared: true, filesNow: false, repoRoot } : { cancelled: true };
    }

    const attempt = async f => worktrees.createAt({
      repoRoot, base, tree: f?.tree,
      head: f?.head || await worktrees.startingPoint({ repoRoot, worktree: own }),
      prefix, home: deps.worktreeHome(), slug: branch.branchSlug({ ...entry, title: tab?.title || entry.title }),
      originalCwd: own?.originalCwd || sourceCwd,
    });
    let made = files ? await attempt(files) : { ok: false, error: "Couldn't take a look at the folder." };
    if (!made.ok && made.gone && !filesNow) {
      const r = await deps.ask({
        icon: '⑂', title: 'Branch with the files as they are now?',
        message: 'git has tidied away the files from that point since, so the copy can\'t start exactly there.',
        detail: 'The conversation still goes back to that point. The copy would start with the files as they are now in the original instead.',
        buttons: [{ label: 'Use the files as they are now', style: 'primary' }, { label: 'Cancel' }], defaultId: 0, cancelId: 1,
      });
      if (r !== 0) return { cancelled: true };
      made = await attempt(await now());
    }
    if (made.ok) return { copy: made.worktree, shared: false, filesNow, repoRoot };
    const r = await deps.ask({
      icon: '⑂', title: 'Branch in the same folder?',
      message: `Shellby couldn't make a copy of the repository: ${made.error}`,
      detail: 'The branch can still start, sharing this folder with the original: changes either one makes, the other sees.',
      buttons: [{ label: 'Share the folder', style: 'primary' }, { label: 'Cancel' }], defaultId: 0, cancelId: 1,
    });
    return r === 0 ? { copy: null, shared: true, filesNow: false, repoRoot } : { cancelled: true };
  }

  // What Claude is told before the branch's first message: where it is now.
  // Its own memory says the original's folder, so it must hear otherwise.
  function preambleFor({ p, copy, shared, filesNow, sourceCwd, fence }) {
    if (p.fresh && !copy) return null;
    if (copy) {
      const was = fence?.paths?.length ? fence.paths.join(', ') : sourceCwd;
      return `Shellby has branched this conversation into a new tab, to try again from this point. You are now working in a separate copy of the repository at ${copy.path}, `
        + `on branch ${copy.branch}, with the files ${filesNow ? 'as they are in the original right now' : 'exactly as they were at this point of the conversation'}. `
        + `The original conversation carries on by itself in ${was}: anything it did after this point isn't here, and its folder is off limits. `
        + `Use paths under ${copy.path} from now on. Ignored files (node_modules, build output) aren't in the copy; install or build again if you need them.`;
    }
    if (shared) {
      return `Shellby has branched this conversation into a second tab, to try again from this point. Both share the folder ${sourceCwd}, `
        + 'so its files may have changed since this point of the conversation: look before relying on what you remember of them.';
    }
    return null;
  }

  // ------------------------------------------------------------ the family

  // Every try at the same thing: the original and its branches, open or not.
  ipcMain.handle('branch:family', (_e, tabId) => {
    if (!isStr(tabId)) return [];
    return branch.family(history.list(), tabId).map(e => {
      const open = manager.tabs.get(e.id);
      const w = open ? open.worktree : e.worktree;
      return {
        id: e.id, title: open?.title || e.title, depth: e.depth, open: !!open, busy: !!open?.session.busy,
        current: e.id === tabId, at: e.branchOf?.at || null, tries: !!e.branchOf?.tries,
        copy: ours(w) ? { branch: w.branch, base: w.base } : null,
      };
    });
  });

  // ------------------------------------------------------------ comparing two tries

  const folderOf = id => {
    const open = manager.tabs.get(id);
    if (open) return open.session.cwd;
    return history.get(id)?.cwd || null;
  };
  const related = (a, b) => branch.family(history.list(), a).some(e => e.id === b);

  // What this try has that the other doesn't, file by file, as of right now.
  ipcMain.handle('branch:compare', async (_e, { tabId, otherId } = {}) => {
    if (!isStr(tabId) || !isStr(otherId) || tabId === otherId) return { ok: false, error: 'Pick another try to compare with.' };
    if (!related(tabId, otherId)) return { ok: false, error: 'Those two are not tries at the same thing.' };
    const [mine, theirs] = [folderOf(tabId), folderOf(otherId)];
    if (!mine || !theirs) return { ok: false, error: 'One of them has no folder any more.' };
    if (!(await changes.sameRepo(mine, theirs))) return { ok: false, error: 'Those two are not in the same repository, so there is nothing to compare.' };
    const [a, b] = await Promise.all([changes.snapshot(theirs), changes.snapshot(mine)]);
    if (!a || !b) return { ok: false, error: "Couldn't take a look at both folders." };
    const s = await changes.summarize({ root: a.root, tree: a.tree }, { root: a.root, tree: b.tree });
    const key = `${tabId}>${otherId}`;
    if (!s) { compared.delete(key); return { ok: true, same: true }; }
    compared.set(key, { root: s.root, before: s.before, after: s.after, files: new Set(s.files.map(f => f.path)) });
    if (compared.size > 20) compared.delete(compared.keys().next().value);
    return { ok: true, same: false, files: s.files, more: s.more, added: s.added, removed: s.removed };
  });

  // One file's diff from the last comparison: only ever trees main worked out itself.
  ipcMain.handle('branch:compare-diff', async (_e, { tabId, otherId, file } = {}) => {
    const c = isStr(tabId) && isStr(otherId) ? compared.get(`${tabId}>${otherId}`) : null;
    if (!c) return { error: 'Compare them again: that comparison has gone.' };
    if (!isStr(file) || !c.files.has(file)) return { error: 'Not a file in this comparison.' };
    return changes.patchFor({ root: c.root, before: c.before, after: c.after, file });
  });

  // ------------------------------------------------------------ keeping one

  // This try comes home; every other try with a copy of its own is thrown
  // away. Asked in the confirm window first, listing exactly what goes.
  ipcMain.handle('branch:keep', async (_e, tabId) => {
    const tab = isStr(tabId) ? manager.tabs.get(tabId) : null;
    if (!tab) return { ok: false, error: 'That conversation is closed.' };
    if (tab.session.busy) return { ok: false, error: 'Let him finish first.' };
    const othersNow = () => branch.family(history.list(), tabId)
      .filter(e => e.id !== tabId)
      .map(e => ({ id: e.id, title: manager.tabs.get(e.id)?.title || e.title, w: manager.tabs.get(e.id)?.worktree || e.worktree, busy: !!manager.tabs.get(e.id)?.session.busy }))
      .filter(o => ours(o.w));
    const others = othersNow();
    const working = others.find(o => o.busy);
    if (working) return { ok: false, error: `"${working.title}" is still working. Let it finish (or stop it) first.` };
    const mine = ours(tab.worktree) ? tab.worktree : null;
    if (!mine && !others.length) return { ok: false, error: 'There are no other tries with copies to throw away.' };

    // What each would lose, so "thrown away" is never a surprise.
    const lose = async w => {
      const s = await worktrees.status(w);
      if (!s.ok) return '';
      const bits = [s.ahead ? `${s.ahead} commit${s.ahead === 1 ? '' : 's'}` : null, s.uncommitted ? `${s.uncommitted} uncommitted file${s.uncommitted === 1 ? '' : 's'}` : null].filter(Boolean);
      return bits.length ? `: ${bits.join(', ')}` : ': nothing new';
    };
    const list = (await Promise.all(others.map(async o => `• ${o.title} (${o.w.branch})${await lose(o.w)}`))).join('\n');
    const r = await deps.ask({
      icon: '⑂', title: 'Keep this one?',
      message: mine
        ? `"${tab.title}" comes home into ${mine.base}${others.length ? `, and ${others.length === 1 ? 'the other try is' : `the ${others.length} other tries are`} thrown away` : ''}.`
        : `This one already works in your checkout. ${others.length === 1 ? 'The other try is' : `The ${others.length} other tries are`} thrown away.`,
      detail: others.length ? `Thrown away, copies and branches deleted without merging:\n${list}\n\nTheir conversations stay in History.` : 'Its copy is tidied away after, and the conversation moves to Done in History.',
      buttons: [{ label: 'Keep this one', style: 'primary' }, { label: 'Cancel' }], defaultId: 0, cancelId: 1,
    });
    if (r !== 0) return { ok: false, cancelled: true };
    // Anything could have happened while the question was open: a try that
    // started working, or one that appeared, is never thrown away unasked.
    const now = othersNow();
    const changed = now.find(o => o.busy) || now.find(o => !others.some(x => x.id === o.id));
    if (changed || tab.session.busy || !manager.tabs.has(tabId)) {
      return { ok: false, error: changed ? `"${changed.title}" changed while you were deciding, so nothing was done. Try again.` : 'This one started working while you were deciding, so nothing was done.' };
    }

    // Home first: if it clashes, nothing has been thrown away.
    let home = null;
    if (mine) {
      home = await deps.bringHome(tabId, { finish: true });
      if (!home.ok) return { ...home, discarded: 0 };
    }
    let discarded = 0;
    const failed = [];
    for (const o of others) {
      const out = await deps.retire(o.id, o.w, { force: true });
      if (out?.ok) discarded++; else failed.push(o.title);
    }
    deps.stat('branch-kept');
    return { ok: true, home, discarded, failed, base: mine?.base || null, closed: !!home?.tidied };
  });
}

module.exports = { register };
