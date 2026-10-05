/* Shellby panel — the conversation's repository, from the folder chip's menu:
   push it, bring every copy home, and its own copy (worktrees.js). tabs.js
   draws the menu; this fills in its repository items (SB.repoItems). */
'use strict';
(function () {
  const { h, api, state, $ } = SB;

  // ------------------------------------------------------------ the repository: push it, bring every copy home

  const { plural } = SB;

  // Filled in as the status comes back: first as of the last fetch, then
  // again once the remote has been asked.
  function repoItems(tab) {
    const sep = h('div', { class: 'menu-sep', hidden: true });
    const label = h('div', { class: 'menu-label', text: 'This repository', hidden: true });
    const pushTitle = h('div', { class: 'mi-title', text: 'Push' });
    const pushSub = h('div', { class: 'mi-sub' });
    const pushBtn = h('button', { class: 'menu-item', hidden: true, disabled: true, onclick: () => { SB.closeMenus(); pushRepo(tab); } },
      h('span', { class: 'mi-check', text: '⇡' }), h('span', {}, pushTitle, pushSub));
    const homeSub = h('div', { class: 'mi-sub' });
    const homeBtn = h('button', { class: 'menu-item', hidden: true, onclick: () => { SB.closeMenus(); bringAll(tab); } },
      h('span', { class: 'mi-check', text: '↩' }), h('span', {}, h('div', { class: 'mi-title', text: 'Bring all home' }), homeSub));
    const bothSub = h('div', { class: 'mi-sub' });
    const bothBtn = h('button', { class: 'menu-item', hidden: true, onclick: () => { SB.closeMenus(); bringAll(tab, { push: true }); } },
      h('span', { class: 'mi-check', text: '⇈' }), h('span', {}, h('div', { class: 'mi-title', text: 'Bring all home and push' }), bothSub));

    const show = s => {
      if (!s?.ok) return; // not a repository, or not on a branch: nothing to offer
      sep.hidden = label.hidden = pushBtn.hidden = false;
      pushTitle.textContent = `Push ${s.branch}`;
      const checking = s.fetched || !s.remote ? '' : ' (checking…)';
      const bits = [];
      if (s.ahead) bits.push(`${plural(s.ahead, 'commit')} to push`);
      if (s.behind) bits.push(`${s.behind} to take in from ${s.remote} first`);
      pushSub.textContent = !s.remote ? 'No remote to push to.' : bits.length ? `${bits.join(' · ')}${checking}` : `Up to date with ${s.upstream}${checking}`;
      pushBtn.disabled = !s.remote || (!s.ahead && !s.behind);

      homeBtn.hidden = bothBtn.hidden = !s.copies;
      const ready = s.copies - s.copiesBusy;
      const busy = s.copiesBusy ? `; ${s.copiesBusy} still working, left for later` : '';
      homeSub.textContent = `${plural(s.copies, 'copy', 'copies')} with work not in ${s.branch} yet${busy}. Merged one at a time`;
      bothSub.textContent = s.remote ? `Then push ${s.branch} to ${s.remote}` : 'No remote to push to.';
      homeBtn.disabled = !ready;
      bothBtn.disabled = !ready || !s.remote;
    };
    api.repoStatus(tab?.id).then(s => {
      show(s);
      if (s?.ok && s.remote) api.repoStatus(tab?.id, { fetch: true }).then(f => show(f?.ok ? f : { ...s, fetched: true }));
    });
    return [sep, label, pushBtn, homeBtn, bothBtn];
  }

  function pushNews(r) {
    if (r.pushed) return `Pushed ${plural(r.pushed, 'commit')} to ${r.remote}/${r.branch}${r.pulled ? `, after taking in ${r.pulled} from ${r.remote}` : ''}.`;
    if (r.pulled) return `Took in ${plural(r.pulled, 'commit')} from ${r.remote}; nothing of yours to push.`;
    return `${r.branch} is already up to date with ${r.remote}.`;
  }

  // A push that fails: a clash can be handed to Claude; a hook's refusal is
  // written into the conversation by main, in full.
  function pushTrouble(tab, r) {
    if (r?.conflict && tab) {
      SB.toast(r.error, { ms: 12000, action: 'Ask him to sort it out', onAction: () => {
        SB.activate(tab.id);
        SB.send(`Run git fetch, then merge ${r.upstream} into this branch (git merge ${r.upstream}), resolve the conflicts so both sides' intent survives, run the tests if there are any, and commit. Then tell me it's ready${tab.worktree ? ' to bring home and push' : ' to push'}.`);
      } });
      return;
    }
    SB.toast(`${r?.error || "Couldn't push."}${r?.detail ? ' What git said is in the conversation.' : ''}`, { ms: 10000 });
  }

  async function pushRepo(tab) {
    SB.toast('Pushing…', { ms: 30000 });
    const r = await api.pushRepo(tab?.id);
    if (r?.ok) return SB.toast(pushNews(r), { ms: 6000 });
    pushTrouble(tab, r);
  }

  // A merge git refused for some other reason than a clash (files in your
  // checkout in the way, a lock, a broken index): the copy's Claude can be
  // asked to find out why and fix it. What git said is already in the conversation.
  function offerFix(tab, r, base, { ms = 12000, text = r.error } = {}) {
    SB.toast(text, { ms, action: 'Ask him to find out why', onAction: () => {
      SB.activate(tab.id);
      SB.send(`Bringing this copy home into ${base} failed: ${r.error}${r.detail ? `\n\nWhat git said:\n${r.detail}` : ''}\n\nThe merge runs in my checkout at ${r.root}. Find out why and fix it. Don't throw away or overwrite anything uncommitted there: if my own files are in the way, tell me which and ask before committing, stashing or moving them. Then tell me it's ready to bring home.`);
    } });
  }

  async function bringAll(tab, { push = false } = {}) {
    SB.toast(push ? 'Bringing them all home, then pushing…' : 'Bringing them all home…', { ms: 30000 });
    const r = await api.bringAllHome(tab?.id, { push });
    if (!r || (r.error && !r.results && !r.stopped && r.merged === undefined)) return SB.toast(r?.error || "Couldn't bring them home.", { ms: 8000 });
    const bits = [r.merged ? `Merged ${plural(r.merged, 'copy', 'copies')} (${plural(r.commits, 'commit')}).` : 'Nothing new to merge.'];
    if (r.skipped) bits.push(`${r.skipped} started from another branch and ${r.skipped === 1 ? 'was' : 'were'} left alone.`);
    if (r.busy) bits.push(`${r.busy} still working, left for later.`);
    const s = r.stopped;
    if (s) {
      const open = s.tabId && state.tabs.get(s.tabId);
      bits.push(s.conflict ? `"${s.title || s.branch}" clashes with ${s.base}, so it stopped there.` : `Stopped at "${s.title || s.branch}": ${s.error}`);
      if (s.conflict && open) {
        return SB.toast(bits.join(' '), { ms: 14000, action: 'Ask him to sort it out', onAction: () => {
          SB.activate(open.id);
          SB.send(`Merge ${s.base} into this branch (git merge ${s.base}), resolve the conflicts so both sides' intent survives, run the tests if there are any, and commit. Then tell me it's ready to bring home.`);
        } });
      }
      if (s.fixable && open) return offerFix(open, s, s.base, { ms: 14000, text: bits.join(' ') });
      if (s.conflict || s.fixable) bits.push('Open it from History to sort it out.');
      return SB.toast(bits.join(' '), { ms: 14000 });
    }
    if (r.push && !r.push.ok) { SB.toast(bits.join(' '), { ms: 5000 }); return pushTrouble(tab, r.push); }
    if (r.push) bits.push(pushNews(r.push));
    SB.toast(bits.join(' '), { ms: 8000 });
  }

  // ------------------------------------------------------------ its own copy (worktrees.js)

  $('branchChip').addEventListener('click', async () => {
    const tab = SB.activeTab();
    const w = tab?.worktree;
    if (!w) return;
    // Other tries at the same thing (branching.js): compare with them, or keep this one.
    const family = $('branchMenu').hidden ? await api.branchFamily(tab.id).catch(() => []) : [];
    const others = family.filter(f => !f.current);
    const status = h('span', { class: 'mi-sub', text: 'Looking at the copy…' });
    api.worktreeStatus(tab.id).then(s => {
      if (!s?.ok) { status.textContent = s?.error || ''; return; }
      const bits = [];
      if (s.ahead) bits.push(`${s.ahead} commit${s.ahead === 1 ? '' : 's'}`);
      if (s.uncommitted) bits.push(`${s.uncommitted} uncommitted file${s.uncommitted === 1 ? '' : 's'}`);
      status.textContent = (bits.length ? `${bits.join(' and ')} not in ${w.base} yet.` : 'Nothing new in it yet.')
        + (s.ignored?.length ? ` Ignored files (${s.ignored.slice(0, 3).join(', ')}${s.ignored.length > 3 ? '…' : ''}) go with the copy.` : '');
    });
    SB.openMenu($('branchMenu'), $('branchChip'), () => [
      h('div', { class: 'menu-label', text: 'This conversation works in its own copy' }),
      h('div', { class: 'menu-item branch-info' },
        h('span', { class: 'mi-check', 'aria-hidden': 'true' }),
        h('span', {}, h('div', { class: 'mi-branch', text: w.branch }), h('div', { class: 'mi-sub', text: `from ${w.base}` }), status)),
      h('div', { class: 'menu-sep' }),
      h('button', { class: 'menu-item', onclick: () => { SB.closeMenus(); bringHome(tab); } },
        h('span', { class: 'mi-check', text: '↩' }),
        h('span', {}, h('div', { class: 'mi-title', text: 'Bring it home' }), h('div', { class: 'mi-sub', text: `Commit what's left and merge into ${w.base}. The conversation carries on` }))),
      h('button', { class: 'menu-item', onclick: () => { SB.closeMenus(); bringHome(tab, { push: true }); } },
        h('span', { class: 'mi-check', text: '⇡' }),
        h('span', {}, h('div', { class: 'mi-title', text: 'Bring it home and push' }), h('div', { class: 'mi-sub', text: `Merge into ${w.base}, then push ${w.base} to its remote. The conversation carries on` }))),
      h('button', { class: 'menu-item', onclick: () => { SB.closeMenus(); bringHome(tab, { finish: true }); } },
        h('span', { class: 'mi-check', text: '✓' }),
        h('span', {}, h('div', { class: 'mi-title', text: 'Bring it home and finish' }), h('div', { class: 'mi-sub', text: 'Merge, then tidy the copy away. The conversation and its diffs move to Done in History' }))),
      h('button', { class: 'menu-item', onclick: () => { SB.closeMenus(); throwAway(tab); } },
        h('span', { class: 'mi-check', text: '✕' }),
        h('span', {}, h('div', { class: 'mi-title', text: 'Throw it away' }), h('div', { class: 'mi-sub', text: 'Delete the copy and its branch, without merging' }))),
      ...(others.length ? [
        h('div', { class: 'menu-sep' }),
        h('div', { class: 'menu-label', text: `Other tries at this (${others.length})` }),
        ...others.slice(0, 7).map(o => h('button', { class: 'menu-item branch-family', onclick: () => { SB.closeMenus(); compareWith(tab, o); } },
          h('span', { class: 'mi-check', text: '⇄' }),
          h('span', {}, h('div', { class: 'mi-title', text: `Compare with "${o.title}"` }),
            h('div', { class: 'mi-sub', text: [o.depth === 0 ? 'the original' : o.at === 'after' ? 'branched after a reply' : 'branched before a message', o.copy ? o.copy.branch : 'in your checkout', o.busy ? 'working' : o.open ? 'open' : 'in History'].join(' · ') })))),
        others.some(o => o.copy)
          ? h('button', { class: 'menu-item', onclick: () => { SB.closeMenus(); keepThisOne(tab); } },
            h('span', { class: 'mi-check', text: '★' }),
            h('span', {}, h('div', { class: 'mi-title', text: 'Keep this one' }), h('div', { class: 'mi-sub', text: `Bring it home into ${w.base}, and throw away the other tries' copies` })))
          : null,
      ] : []),
    ]);
  });

  // What this try has that the other doesn't, file by file, into the feed.
  async function compareWith(tab, other) {
    SB.toast(`Comparing with "${other.title}"…`, { ms: 8000 });
    const r = await api.compareBranches(tab.id, other.id);
    if (!r?.ok) return SB.toast(r?.error || "Couldn't compare them.", { ms: 8000 });
    SB.toast(r.same ? 'Exactly the same files.' : `${plural(r.files.length + (r.more || 0), 'file')} differ: see below.`);
    tab.renderCompare(other, r);
  }

  async function keepThisOne(tab) {
    if (tab.busy) return SB.toast('Let him finish first.');
    const r = await api.keepBranch(tab.id);
    if (r?.cancelled) return;
    if (!r?.ok) {
      if (r?.conflict) {
        return SB.toast(`${r.error} Nothing was thrown away.`, { ms: 12000, action: 'Ask him to sort it out', onAction: () => {
          SB.activate(tab.id);
          SB.send(`Merge ${tab.worktree.base} into this branch (git merge ${tab.worktree.base}), resolve the conflicts so both sides' intent survives, run the tests if there are any, and commit. Then tell me it's ready to bring home.`);
        } });
      }
      if (r?.fixable) return offerFix(tab, r, tab.worktree.base, { text: `${r.error} Nothing was thrown away.` });
      return SB.toast(r?.error || "Couldn't keep it.", { ms: 8000 });
    }
    const home = r.home ? (r.home.merged ? `Merged ${plural(r.home.commits, 'commit')} into ${r.base}.` : `${r.base} already had all of it.`) : '';
    const gone = r.discarded ? ` Threw away ${plural(r.discarded, 'other try', 'other tries')}.` : '';
    const failed = r.failed?.length ? ` Couldn't remove ${r.failed.join(', ')}.` : '';
    if (r.home?.tidied) await SB.closeTab(tab.id);
    // Coming home ticks this one off (the thrown-away tries aren't done, just gone).
    if (!r.home) return SB.toast(`${home}${gone}${failed} The conversations stay in History.`.trim(), { ms: 8000 });
    SB.toast(`${home}${gone}${failed} This one is marked done: it's under Done in History.`.trim(), { ms: 10000, action: 'Show me', onAction: SB.showDoneHistory });
  }

  async function bringHome(tab, { finish = false, push = false } = {}) {
    if (tab.busy) return SB.toast('Let him finish first.');
    SB.toast(push ? 'Bringing it home, then pushing…' : 'Bringing it home…', { ms: push ? 30000 : 8000 });
    const r = await api.bringWorktreeHome(tab.id, { finish, push });
    const merged = `Merged ${r?.commits} commit${r?.commits === 1 ? '' : 's'} into ${r?.base}.`;
    if (r?.ok && r.push) {
      if (r.push.ok) return SB.toast(`${r.merged ? `${merged} ` : ''}${pushNews(r.push)}`, { ms: 7000 });
      if (r.merged) SB.toast(`${merged} The push didn't go through, so it's only on this computer for now.`, { ms: 5000 });
      return pushTrouble(tab, r.push);
    }
    if (r?.ok && r.kept) {
      SB.toast(r.merged ? `${merged} Carry on here and bring it home again any time.` : `Nothing new to merge; ${r.base} already has all of it.`, { ms: 6000 });
      return;
    }
    if (r?.ok) {
      // Finishing ticks the conversation off either way (main.js), and History
      // hides done ones by default, so say where it went.
      await SB.closeTab(tab.id);
      SB.toast(`${r.merged ? merged : 'Nothing new to merge, so the copy was just tidied away.'} Marked done: it's under Done in History.`, { ms: 8000, action: 'Show me', onAction: SB.showDoneHistory });
      return;
    }
    if (r?.conflict) {
      // Nothing was merged; the copy's own branch is the safe place to sort it out.
      SB.toast(r.error, { ms: 12000, action: 'Ask him to sort it out', onAction: () => {
        SB.activate(tab.id);
        SB.send(`Merge ${tab.worktree.base} into this branch (git merge ${tab.worktree.base}), resolve the conflicts so both sides' intent survives, run the tests if there are any, and commit. Then tell me it's ready to bring home.`);
      } });
      return;
    }
    if (r?.fixable) return offerFix(tab, r, tab.worktree.base);
    SB.toast(r?.error || "Couldn't bring it home.", { ms: 8000 });
  }

  let discardArmed = null;
  async function throwAway(tab) {
    if (discardArmed !== tab.id) {
      discardArmed = tab.id;
      setTimeout(() => { if (discardArmed === tab.id) discardArmed = null; }, 6000);
      SB.toast('Throw away everything this copy did? Its branch is deleted too.', { ms: 6000, action: 'Throw it away', onAction: () => throwAway(tab) });
      return;
    }
    discardArmed = null;
    const r = await api.discardWorktree(tab.id);
    if (!r?.ok) return SB.toast(r?.error || "Couldn't remove the copy.", { ms: 8000 });
    await SB.closeTab(tab.id);
    SB.toast('Thrown away. The conversation is still in History.');
  }

  SB.repoItems = repoItems;
})();
