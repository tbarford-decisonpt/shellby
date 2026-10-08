/* Shellby panel — Settings: Claude Code's account (who's signed in, billing,
   signing out and in), Claude Code's updates, Shellby's own, and the facts in
   About. settings.js draws the rest. */
'use strict';
(function () {
  const { h, api, state, $ } = SB;
  const T = window.ShellbySettingsText;
  const renderSettings = () => SB.renderSettings();

  // ------------------------------------------------------------ Claude Code's account

  // Plan only, or Claude Code deciding, and whether this PC is set up to bill an API key.
  function renderBillingGuard() {
    const on = !!state.settings.planOnly;
    const billing = state.status?.billingEnv || [];
    const key = T.billingState(on, billing);
    $('planOnlyToggle').checked = on;
    $('billingGuard').dataset.state = key;
    $('billingGuardTitle').textContent = T.BILLING_GUARD[key].title;
    $('billingGuardPill').textContent = T.BILLING_GUARD[key].pill;
    $('billingEnvNote').hidden = !billing.length;
    $('billingEnvNote').textContent = billing.length ? `Set on this PC right now: ${billing.join(', ')}. Turn this on to keep them out.` : '';
  }

  // Who Claude Code is signed in as, with sign out and switch beside it.
  // Hidden in just-the-crab mode and when Claude Code isn't installed: then
  // there's nothing to sign in to, and the button above sets it up.
  function renderClaudeAccount() {
    const st = state.status || {};
    $('claudeAccount').hidden = !st.installed || SB.isCrabOnly?.();
    const signedIn = !!st.loggedIn;
    $('claudeWho').textContent = signedIn ? st.email || 'Signed in' : 'Not signed in';
    $('claudePlan').textContent = T.planLabel(st);
    $('claudeSwitch').hidden = !signedIn;
    $('claudeSignOut').hidden = !signedIn;
    $('claudeSignIn').hidden = signedIn;
    renderClaudeUpdate();
  }

  // Claude Code's own version, and what to do when there's a newer one
  // (src/main/claude/update.js). In About, under Shellby's own update; hidden
  // until Claude Code is found.
  function renderClaudeUpdate() {
    const u = state.claudeUpdate;
    const st = state.status || {};
    renderUpdateDots();
    const row = $('claudeUpdateRow');
    row.hidden = !u || !st.installed || SB.isCrabOnly?.();
    // The Claude tab only mentions it when there's something to do; the
    // choices live in About.
    const hint = $('claudeUpdateHint');
    hint.hidden = row.hidden || (!u.available && !u.updating);
    if (row.hidden) return;
    const installed = u.installed || st.version;
    $('claudeUpdateHintText').textContent = u.updating ? 'Updating Claude Code…' : `Claude Code v${u.latest} is out.`;
    $('claudeUpdateHintBtn').disabled = !!u.updating;
    $('claudeUpdateHintBtn').textContent = u.updating ? 'Updating…' : 'Update';
    $('claudeUpdateTitle').textContent = T.claudeUpdateTitle(u, installed);
    $('claudeUpdateNote').textContent = T.claudeUpdateNote(u, installed, SB.relTime);
    $('claudeUpdateMode').value = ['tell', 'auto', 'off'].includes(u.mode) ? u.mode : 'tell';
    $('claudeUpdateMode').disabled = !!u.updating;
    $('claudeUpdateCheck').hidden = u.mode === 'off' || !!u.available;
    $('claudeUpdateCheck').disabled = !!u.checking || !!u.updating;
    $('claudeUpdateCheck').textContent = u.checking ? 'Checking…' : 'Check now';
    $('claudeUpdateBtn').hidden = !u.available && !u.updating;
    $('claudeUpdateBtn').disabled = !!u.updating;
    $('claudeUpdateBtn').textContent = u.updating ? 'Updating…' : 'Update';
  }
  SB.renderClaudeUpdate = renderClaudeUpdate;

  function renderFacts() {
    const st = state.status || {};
    const u = state.claudeUpdate;
    const facts = [
      ['Shellby', `v${state.version}`],
      ['Claude Code', st.version ? `v${st.version}${u?.available ? ` (v${u.latest} is out)` : ''}` : 'not found'],
      ['Account', st.email || '—'],
      ['Plan', st.subscriptionType ? st.subscriptionType[0].toUpperCase() + st.subscriptionType.slice(1) : '—'],
      ['Billing', st.authMethod === 'claude.ai' ? 'Claude subscription ✓' : (st.authMethod || '—')],
    ];
    $('facts').replaceChildren(...facts.flatMap(([k, v]) => [h('dt', { text: k }), h('dd', { text: v, title: v })]));
  }

  SB.renderClaudeAccount = renderClaudeAccount;
  const accountBusy = on => ['claudeSwitch', 'claudeSignOut', 'claudeSignIn'].forEach(id => { $(id).disabled = on; });
  async function claudeSignOut(thenSignIn) {
    accountBusy(true);
    try {
      const r = await api.claudeLogout({ thenSignIn });
      if (r.status) state.status = r.status;
      renderSettings();
      if (r.cancelled) return;
      if (!r.ok) return SB.toast(r.error || "Couldn't sign out.", { ms: 6000 });
      SB.toast(thenSignIn ? 'Signed out. Sign in with the other account in the window that opened.' : 'Signed out of Claude Code.', { ms: thenSignIn ? 6000 : 3000 });
    } finally { accountBusy(false); }
  }
  $('claudeSignOut').addEventListener('click', () => claudeSignOut(false));
  $('claudeSwitch').addEventListener('click', () => claudeSignOut(true));
  $('claudeSignIn').addEventListener('click', async () => {
    if (await api.claudeLogin()) SB.toast('Finish signing in in the window that opened. Shellby notices when you’re done.', { ms: 6000 });
    else SB.toast('Claude Code not found.');
  });
  $('claudeUpdateMode').addEventListener('change', async e => {
    const v = await api.setClaudeUpdateMode(e.target.value);
    if (v) state.claudeUpdate = v;
    renderClaudeUpdate();
    if (v?.mode === 'auto') SB.toast('He updates Claude Code himself, once a day at most, and only while nothing is running.', { ms: 6000 });
  });
  $('claudeUpdateCheck').addEventListener('click', async () => {
    state.claudeUpdate = { ...(state.claudeUpdate || {}), checking: true, error: null };
    renderClaudeUpdate();
    const v = await api.checkClaudeUpdate();
    if (v) state.claudeUpdate = v;
    renderClaudeUpdate();
    if (v?.error) SB.toast(`Couldn't check: ${v.error}`, { ms: 5000 });
    else if (v && !v.available) SB.toast(`Claude Code v${v.installed || '?'} is the latest.`);
  });
  // Update in About and the Claude tab's notice do the same thing.
  async function updateClaude() {
    const r = await api.updateClaude();
    if (r?.cancelled) return;
    if (r?.ok && r.updated) SB.toast(`Claude Code is now v${r.to}. New conversations use it.`, { ms: 6000 });
    else if (r?.ok) SB.toast(`Claude Code says v${r.to || '?'} is the latest it can install.`, { ms: 5000 });
    else SB.toast(r?.error || "Claude Code didn't update. Try `claude update` in a terminal.", { ms: 6000 });
  }
  $('claudeUpdateBtn').addEventListener('click', updateClaude);
  $('claudeUpdateHintBtn').addEventListener('click', updateClaude);
  $('claudeUpdateHintMore').addEventListener('click', () => SB.jumpToSettingByName('About'));
  // Pushed as the daily check or an update moves along: follow it wherever it shows.
  api.onClaudeUpdate(view => {
    state.claudeUpdate = view;
    renderClaudeUpdate(); // the gear's dot, from any screen
    if (state.view === 'settings') renderFacts();
  });
  // Pushed after the sign-in window closes, or a sign-out: follow it wherever it shows.
  api.onClaudeStatus(status => {
    const was = state.status || {};
    state.status = status;
    renderUpdateDots(); // a newer Claude Code only counts once it's found
    if (state.view === 'settings') renderSettings();
    if (state.view === 'onboarding') SB.views.onboarding.render();
    if (status?.loggedIn && (!was.loggedIn || was.email !== status.email)) SB.toast(`Signed in${status.email ? ` as ${status.email}` : ''}.`);
  });

  // ------------------------------------------------------------ updates

  // The gear carries the news from any screen, so this runs even when Settings
  // is nowhere in sight: Shellby's update ready to install, or a newer Claude Code.
  function renderUpdateDots() {
    const u = state.updates;
    const ready = u?.state === 'ready';
    const cu = state.claudeUpdate;
    const claude = !!cu?.available && !!state.status?.installed && !SB.isCrabOnly?.();
    $('updateDot').hidden = !ready && !claude;
    $('updateTabDot').hidden = !ready && !claude;
    $('settingsBtn').title = ready ? `Settings — update ${u.version} is ready`
      : claude ? `Settings — Claude Code ${cu.latest} is out` : 'Settings';
  }

  function renderUpdates() {
    const u = state.updates;
    const ready = u?.state === 'ready';
    renderUpdateDots();
    const row = $('updateRow');
    row.hidden = !u;
    if (!u) return;
    row.classList.toggle('ready', ready);
    const status = $('updateStatus');
    status.textContent = T.updateStatus(u, SB.relTime);
    status.classList.toggle('bad', u.state === 'error');
    status.classList.toggle('ok', ready);
    const btn = $('updateBtn');
    // A dev run (npm start) has no updater at all, and Scoop does its own;
    // a button there would lie.
    btn.hidden = u.state === 'off' || u.state === 'scoop';
    btn.textContent = T.updateButton(u);
    btn.classList.toggle('primary', ready);
    btn.classList.toggle('ghost', !ready);
    btn.disabled = !!u.busy;
    $('updateBar').hidden = u.state !== 'downloading';
    $('updateBar').firstElementChild.style.width = `${u.percent}%`;
  }
  SB.renderUpdates = renderUpdates;

  $('updateBtn').addEventListener('click', async () => {
    const u = state.updates || {};
    if (u.state === 'ready') return void api.installUpdate();
    // Optimistic, so the button reacts before the network does; the live
    // 'updates' events in boot.js correct it either way.
    state.updates = { ...u, state: 'checking', error: null, busy: true };
    renderUpdates();
    const after = await api.checkUpdates();
    if (after.state === 'current') SB.toast(`v${after.current} is the latest version.`);
    if (after.state === 'error') SB.toast(`Couldn't check for updates: ${after.error}`, { ms: 5000 });
  });

  SB.renderBillingGuard = renderBillingGuard;
  SB.renderFacts = renderFacts;
  SB.onSettingsOpen(renderUpdates);
})();
