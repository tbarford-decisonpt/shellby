/* Shellby panel — onboarding: the first-run screens. */
'use strict';
(function () {
  const { h, api, state, $ } = SB;

  // ------------------------------------------------------------ onboarding

  SB.needsOnboarding = () => {
    const s = state.status || {};
    if (!state.settings.onboarded) return true;
    // Claude Code only on another computer: this PC never needs it (the remote path below).
    return !state.settings.crabOnly && !state.settings.claudeElsewhere && (!s.installed || !s.loggedIn);
  };

  // The remote path lends Settings' Other computers section to this screen,
  // and gives it back on the way out (core.js setView calls leave).
  let lentFrom = null;
  function lendRemote(on) {
    const group = $('remoteGroup');
    if (on && !lentFrom) {
      lentFrom = document.createComment('remoteGroup');
      group.before(lentFrom);
      $('onboardRemote').append(group);
      SB.remoteRefresh?.();
    } else if (!on && lentFrom) {
      lentFrom.replaceWith(group);
      lentFrom = null;
    }
  }

  // Where the remote path stands, and whether Let's go can go.
  function renderRemote() {
    const L = window.ShellbyRemoteLogic;
    const computers = SB.remoteNow?.()?.computers || [];
    const anchor = L.readyFolder(computers);
    const place = anchor ? computers.flatMap(c => c.folders).find(f => f.anchor === anchor)?.label : null;
    $('onboardRemoteHint').textContent = place
      ? `Ready. Conversations start in ${place}.`
      : computers.some(L.ready)
        ? 'Claude Code is signed in there. Now add a folder there to work in.'
        : 'Add the computer you ssh to. Shellby walks you through the rest: signing in, then Claude Code installed and signed in over there.';
    $('letsGoBtn').disabled = !anchor;
  }
  SB.remoteChanged = () => { if (state.view === 'onboarding' && SB.onboardPath === 'remote') renderRemote(); };

  function renderOnboarding() {
    const s = state.status || {};
    // Three paths: just the crab (no account), or the Claude Code setup steps,
    // with a lively crab or Work mode's quiet one (workmode.js).
    const path = SB.onboardPath || null;
    $('onboardPaths').querySelectorAll('.path').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.path === path)));
    $('claudeSetup').hidden = !['claude', 'work', 'remote'].includes(path);
    const remote = path === 'remote';
    $('steps').hidden = remote;
    $('onboardRemote').hidden = !remote;
    lendRemote(remote);
    const step = (n, done, title, sub, actions) => h('li', { class: `step ${done ? 'done' : 'todo'}` },
      h('span', { class: 'step-badge', text: done ? '✓' : n }),
      h('div', {}, h('div', { class: 'step-title', text: title }), sub ? h('div', { class: 'step-sub' }, sub) : null, !done && actions ? h('div', { class: 'row' }, actions) : null));
    const recheck = () => h('button', { class: 'btn ghost', type: 'button', onclick: recheckStatus }, 'Check again');
    const installed = !!s.installed;
    const signedIn = installed && s.loggedIn;
    $('steps').replaceChildren(
      step(1, installed, 'Install Claude Code',
        installed
          ? `Found v${s.version || '?'}${s.picked ? ' where you pointed' : ''}`
          : ['Run ', h('code', { text: 'npm install -g @anthropic-ai/claude-code' }), ' in a terminal, or use the native installer.'],
        [h('button', { class: 'btn', type: 'button', onclick: () => api.openExternal('https://docs.claude.com/en/docs/claude-code/setup') }, 'Install guide'),
         recheck(),
         // Already installed somewhere Shellby can't guess (portable copy,
         // another drive, a locked-down company image)? Point at it.
         h('button', { class: 'btn ghost', type: 'button', title: 'If it is already installed somewhere unusual', onclick: locateClaude }, 'Find it myself…')]),
      step(2, signedIn && !s.warning, 'Sign in with your Claude account',
        signedIn
          ? (s.warning ? h('span', { class: 'warn', text: s.warning }) : `${s.email || 'Signed in'} · ${s.subscriptionType ? s.subscriptionType.toUpperCase() + ' plan' : 'claude.ai'}`)
          : 'Shellby uses your Claude Pro or Max plan through Claude Code. There are no API keys and nothing is billed per token.',
        installed ? [h('button', { class: 'btn primary', type: 'button', onclick: async () => { await api.claudeLogin(); SB.toast('Finish signing in in the window that opened. Shellby notices when you’re done.', { ms: 6000 }); } }, 'Sign in'), recheck()] : null),
    );
    const pick = async mode => {
      if (mode === 'autonomous') return SB.toast('You can turn on Autonomous later in Settings.');
      const r = await api.setSettings({ mode });
      state.settings = r.settings;
      SB.applyMode(mode);
      SB.renderModeCards($('onboardModeCards'), pick);
    };
    SB.renderModeCards($('onboardModeCards'), pick);
    if (remote) renderRemote();
    else $('letsGoBtn').disabled = !(installed && signedIn);
  }
  async function recheckStatus() {
    state.status = await api.claudeStatus();
    renderOnboarding();
    SB.toast(state.status.loggedIn ? 'All set!' : state.status.installed ? 'Not signed in yet.' : 'Claude Code not found yet.');
  }
  // The file picker runs the chosen program once to check it really is Claude
  // Code, so the answer to a wrong pick arrives immediately.
  async function locateClaude() {
    const r = await api.locateClaude();
    if (r.cancelled) return;
    if (r.status) state.status = r.status;
    renderOnboarding();
    SB.toast(r.ok ? `Found Claude Code v${r.status?.version || '?'}.` : r.error || "That isn't Claude Code.", { ms: r.ok ? 3000 : 6000 });
  }
  $('letsGoBtn').addEventListener('click', async () => {
    if (SB.onboardPath === 'work') return SB.chooseWorkMode();
    if (SB.onboardPath === 'remote') return chooseRemote();
    // firstTour: the first New task offers Show me around (feed.js), once.
    const r = await api.setSettings({ onboarded: true, firstTour: true, crabOnly: false, workMode: false });
    state.settings = r.settings;
    SB.onboardPath = null;
    SB.applyCrabOnly();
    SB.refreshEmptyStates();
    SB.setView('chat');
  });
  // Done with Claude Code over there: start in its folder, and never ask for it here.
  async function chooseRemote() {
    const anchor = window.ShellbyRemoteLogic.readyFolder(SB.remoteNow?.()?.computers);
    if (!anchor) return;
    const r = await api.setSettings({ onboarded: true, firstTour: true, crabOnly: false, workMode: false, claudeElsewhere: true });
    state.settings = r.settings;
    SB.onboardPath = null;
    SB.applyCrabOnly();
    SB.refreshEmptyStates();
    SB.setView('chat');
    await SB.folderChanged(await api.remoteWorkHere(anchor));
  }
  $('onboardPaths').addEventListener('click', e => {
    const b = e.target.closest('.path');
    if (!b) return;
    if (b.dataset.path === 'crab') return SB.chooseCrabOnly();
    SB.onboardPath = ['work', 'remote'].includes(b.dataset.path) ? b.dataset.path : 'claude';
    renderOnboarding();
    $('claudeSetup').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  $('crabInsteadBtn').addEventListener('click', () => SB.chooseCrabOnly());

  SB.views.onboarding = { render: renderOnboarding, leave: () => lendRemote(false) };
})();
