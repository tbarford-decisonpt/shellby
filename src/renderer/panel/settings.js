/* Shellby panel — the settings view. History is history.js, onboarding onboarding.js. */
'use strict';
(function () {
  const { h, api, state, $ } = SB;

  // ------------------------------------------------------------ shared: mode cards

  SB.renderModeCards = (container, onPick = SB.chooseMode) => {
    container.replaceChildren(...SB.MODES.map(m => h('button', {
      type: 'button', role: 'radio', class: `mode-card${m.danger ? ' danger' : ''}`,
      'aria-checked': String(state.settings.mode === m.id), onclick: () => onPick(m.id),
    },
    h('span', { class: 'radio' }),
    h('span', { class: 'mc-title' }, m.title, m.tag ? h('span', { class: `tag${m.danger ? ' warn' : ''}`, text: m.tag }) : null),
    h('span', { class: 'mc-sub', text: m.sub }))));
  };

  // ------------------------------------------------------------ settings

  function renderSkins() {
    $('skinGrid').replaceChildren(...state.skins.map(s => h('button', {
      type: 'button', class: `skin${s.locked ? ' locked' : ''}`, role: 'radio', 'aria-checked': String(s.id === state.skin?.id),
      title: s.locked ? `${s.name}: ${s.locked.text}` : s.description || s.name,
      onclick: async () => {
        if (s.locked) return SB.toast(`${s.name} is a ${s.locked.text.toLowerCase()}`);
        const r = await api.setSettings({ skin: s.id });
        state.settings = r.settings;
      },
    }, SB.sprite(s, { plain: true }), h('span', {}, s.name), s.locked ? h('small', { text: '🔒 seasonal' }) : s.source === 'user' ? h('small', { text: 'custom' }) : null)));
  }
  SB.renderSkins = renderSkins;

  // Grouped by family, from the list main.js accepts (src/main/models.js). A
  // saved model that has since left the list still shows, rather than a blank.
  function renderModels() {
    const current = state.settings.model || '';
    const models = state.models || [];
    const groups = [...new Set(models.map(m => m.group))];
    const known = current === '' || models.some(m => m.id === current);
    $('modelSelect').replaceChildren(
      h('option', { value: '', text: 'Claude Code default' }),
      ...groups.map(g => h('optgroup', { label: g }, models.filter(m => m.group === g).map(m => h('option', { value: m.id, text: m.label })))),
      known ? null : h('option', { value: current, text: current }),
    );
    $('modelSelect').value = current;
  }

  // Claude Code's own styles plus any in an output-styles folder (src/main/outputstyles.js).
  async function renderStyles() {
    const styles = await api.listStyles().catch(() => []);
    const current = state.settings.outputStyle || '';
    const sel = $('styleSelect');
    const known = !current || styles.some(s => s.name === current);
    sel.replaceChildren(...styles.map(s => h('option', { value: s.name, text: s.source === 'built-in' ? s.title : `${s.title} (${s.source === 'user' ? 'yours' : 'this project'})`, title: s.description })),
      known ? null : h('option', { value: current, text: `${current} (not found)` }));
    sel.value = current;
    const chosen = styles.find(s => s.name === current);
    $('styleNote').textContent = `${chosen?.description ? `${chosen.description} ` : ''}Applies to new conversations.`;
  }

  function renderSettings() {
    SB.renderModeCards($('modeCards'));
    $('autonomousConfirm').hidden = true;
    $('settingsFolder').textContent = state.cwd;
    $('settingsFolder').title = state.cwd;
    renderSkins();
    $('scaleSelect').value = String(state.settings.critterScale || 1);
    $('hotkeyBtn').textContent = SB.prettyAccel(state.settings.hotkey) || 'None';
    $('hotkeyMsg').textContent = '';
    renderModels();
    renderStyles();
    $('loginToggle').checked = !!state.settings.openAtLogin;
    $('loginToggle').disabled = !state.packaged;
    $('loginNote').hidden = state.packaged;
    $('notifyToggle').checked = !!state.settings.notifications;
    $('recapToggle').checked = state.settings.recap !== false;
    $('forecastToggle').checked = state.settings.forecast !== false;
    $('spendGuardToggle').checked = state.settings.spendGuard !== false;
    $('spendReserveSelect').value = String(state.settings.spendReserve || 25);
    $('spendMaxSelect').value = String(state.settings.spendMaxMinutes || 60);
    $('spendGuardOptions').hidden = state.settings.spendGuard === false;
    $('holdBigToggle').checked = state.settings.holdBigTasks === true;
    $('leaveGuardToggle').checked = state.settings.leaveGuard !== false;
    $('flakyToggle').checked = state.settings.flakyTests !== false;
    $('checkEachTurnToggle').checked = state.settings.checkEachTurn === true;
    $('checkEachTurnOptions').hidden = state.settings.checkEachTurn !== true;
    $('checkTimeoutSelect').value = String([2, 5, 10, 20].includes(state.settings.checkTimeoutMin) ? state.settings.checkTimeoutMin : 5);
    $('turnShotsToggle').checked = state.settings.turnShots !== false;
    $('wanderToggle').checked = state.settings.wander !== false;
    $('onTopToggle').checked = state.settings.onTop === true;
    renderPerch();
    $('worktreeToggle').checked = !!state.settings.worktrees;
    $('clashToggle').checked = state.settings.clashWarnings !== false;
    renderBillingGuard();
    $('chatterSelect').value = ['quiet', 'work', 'normal', 'chatty'].includes(state.settings.chatter) ? state.settings.chatter : 'normal';
    $('workModeToggle').checked = !!SB.isWorkMode?.();
    $('soundsToggle').checked = !!state.settings.sounds;
    $('soundFxToggle').checked = !!state.settings.soundFx;
    $('ambientSelect').value = ['off', 'surf', 'tidepool'].includes(state.settings.ambient) ? state.settings.ambient : 'off';
    $('soundVolumeSelect').value = [25, 60, 100].includes(state.settings.soundVolume) ? String(state.settings.soundVolume) : '60';
    $('needsToggle').checked = state.settings.needsOn !== false;
    $('crashReportsRow').hidden = !state.settings.crashReportsAvailable;
    $('crashReportsSelect').value = ['ask', 'always', 'never'].includes(state.settings.crashReports) ? state.settings.crashReports : 'ask';
    // His temperament, picked once from your install and kept (src/main/voice.js).
    const t = state.life?.temperament;
    $('temperNote').hidden = !t;
    if (t) $('temperNote').textContent = `${t.emoji} Your crab is ${t.name.toLowerCase()}. ${t.blurb}`;
    $('pushToTalkToggle').checked = !!state.settings.pushToTalk;
    renderClaudeAccount();
    renderFacts();
  }

  // Off with an API key or provider set on this PC means per-token billing,
  // so that case gets the loudest look (see .billing-guard in panel.css).
  const BILLING_GUARD = {
    safe: { title: 'Billing: your Claude plan', pill: 'Protected' },
    off: { title: 'Billing: Claude Code decides', pill: 'Not protected' },
    risk: { title: 'Heads up: this may bill your API key', pill: 'Pay per token' },
  };
  function renderBillingGuard() {
    const on = !!state.settings.planOnly;
    const billing = state.status?.billingEnv || [];
    const key = on ? 'safe' : billing.length ? 'risk' : 'off';
    $('planOnlyToggle').checked = on;
    $('billingGuard').dataset.state = key;
    $('billingGuardTitle').textContent = BILLING_GUARD[key].title;
    $('billingGuardPill').textContent = BILLING_GUARD[key].pill;
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
    $('claudePlan').textContent = signedIn
      ? (st.subscriptionType ? `${st.subscriptionType[0].toUpperCase()}${st.subscriptionType.slice(1)} plan` : st.authMethod || 'claude.ai')
      : 'Sign in with your Claude account to give Shellby tasks.';
    $('claudeSwitch').hidden = !signedIn;
    $('claudeSignOut').hidden = !signedIn;
    $('claudeSignIn').hidden = signedIn;
    renderClaudeUpdate();
  }

  // Claude Code's own version, and what to do when there's a newer one
  // (src/main/claude-update.js). In About, under Shellby's own update; hidden
  // until Claude Code is found.
  function renderClaudeUpdate() {
    const u = state.claudeUpdate;
    const st = state.status || {};
    renderUpdateDots();
    const row = $('claudeUpdateRow');
    row.hidden = !u || !st.installed || SB.isCrabOnly?.();
    if (row.hidden) return;
    const installed = u.installed || st.version;
    $('claudeUpdateTitle').textContent = u.updating ? `Updating Claude Code v${installed || '?'}…`
      : u.available ? `Claude Code v${u.latest} is out` : `Claude Code v${installed || '?'}`;
    $('claudeUpdateNote').textContent = u.error ? u.error
      : u.updating ? 'Claude Code is fetching it. Conversations already running keep the old one.'
      : u.checking ? 'Asking the npm registry…'
      : u.available ? `You have v${installed}. ${u.mode === 'auto' ? 'He updates it once nothing is running.' : 'Update takes a minute; new conversations get it.'}`
      : u.mode === 'off' ? 'He never asks the registry. Update it yourself with claude update.'
      : u.lastCheckAt ? `The latest, checked ${SB.relTime(u.lastCheckAt)}. He looks once a day.`
      : 'He looks once a day.';
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

  // Climbing onto windows lives under strolling: with strolling off he stays
  // put, so the choice is shown but can't be changed. Same for the screen's edges.
  function renderPerch() {
    const s = state.settings;
    $('perchSelect').value = ['off', 'sometimes', 'often'].includes(s.perch) ? s.perch : 'sometimes';
    $('perchSelect').disabled = s.wander === false;
    $('climbSelect').value = ['off', 'sometimes', 'often'].includes(s.climb) ? s.climb : 'sometimes';
    $('climbSelect').disabled = s.wander === false;
    $('colonySelect').value = String(Number.isInteger(s.colony) ? s.colony : 0);
    renderMischief();
    const ignored = Array.isArray(s.perchIgnore) ? s.perchIgnore : [];
    $('perchIgnoreRow').hidden = !ignored.length;
    $('perchIgnoreList').replaceChildren(...ignored.map(exe => h('button', {
      type: 'button', class: 'perch-app', 'aria-label': `Let him climb onto ${exe} again`,
      onclick: async () => {
        const r = await api.setSettings({ perchIgnore: ignored.filter(x => x !== exe) });
        state.settings = r.settings;
        renderPerch();
      },
    }, exe.replace(/\.exe$/i, ''), h('span', { class: 'x', 'aria-hidden': 'true', text: '✕' }))));
  }

  // Mischief is off until you pick a level; the pranks list only shows once it's on.
  function renderMischief() {
    const s = state.settings;
    const level = ['off', 'cheeky', 'gremlin'].includes(s.mischief) ? s.mischief : 'off';
    $('mischiefSelect').value = level;
    $('mischiefPranks').hidden = level === 'off';
    $('mischiefNote').hidden = level === 'off';
    $('mischiefGroup').classList.toggle('on', level !== 'off');
    const pranks = s.mischiefPranks || {};
    for (const box of $('mischiefPranks').querySelectorAll('input[data-prank]')) box.checked = pranks[box.dataset.prank] !== false;
  }

  $('autonomousYes').addEventListener('click', async () => {
    const r = await api.setSettings({ autonomousAcknowledged: true, mode: 'autonomous' });
    state.settings = r.settings;
    SB.applyMode(state.settings.mode);
    renderSettings();
    SB.toast(state.settings.mode === 'autonomous' ? 'Autonomous mode on. Be careful out there.' : 'Autonomous mode stays off.');
  });
  $('autonomousNo').addEventListener('click', () => { $('autonomousConfirm').hidden = true; });
  $('changeFolderBtn').addEventListener('click', async () => { await SB.folderChanged(await api.pickFolder()); renderSettings(); });
  $('resetPosBtn').addEventListener('click', () => { api.resetCritterPosition(); SB.toast('Shellby is back in the bottom-right corner of your main screen.'); });
  $('scaleSelect').addEventListener('change', async e => { const r = await api.setSettings({ critterScale: Number(e.target.value) }); state.settings = r.settings; });
  $('styleSelect').addEventListener('change', async e => {
    const r = await api.setSettings({ outputStyle: e.target.value });
    state.settings = r.settings;
    renderStyles();
    SB.toast('Output style applies to new conversations.');
  });
  $('modelSelect').addEventListener('change', async e => { const r = await api.setSettings({ model: e.target.value }); state.settings = r.settings; SB.toast('Model applies to new conversations.'); });
  $('wanderToggle').addEventListener('change', async e => { const r = await api.setSettings({ wander: e.target.checked }); state.settings = r.settings; renderPerch(); });
  $('onTopToggle').addEventListener('change', async e => { const r = await api.setSettings({ onTop: e.target.checked }); state.settings = r.settings; });
  $('perchSelect').addEventListener('change', async e => { const r = await api.setSettings({ perch: e.target.value }); state.settings = r.settings; renderPerch(); });
  $('climbSelect').addEventListener('change', async e => { const r = await api.setSettings({ climb: e.target.value }); state.settings = r.settings; renderPerch(); });
  $('colonySelect').addEventListener('change', async e => {
    const r = await api.setSettings({ colony: Number(e.target.value) });
    state.settings = r.settings;
    renderPerch();
  });
  $('mischiefSelect').addEventListener('change', async e => {
    const r = await api.setSettings({ mischief: e.target.value });
    state.settings = r.settings;
    renderMischief();
    if (r.settings.mischief !== 'off') SB.toast('Mischief on. Right-click him and pick “Do something cheeky” to see it now.');
  });
  $('mischiefPranks').addEventListener('change', async () => {
    const pranks = Object.fromEntries([...$('mischiefPranks').querySelectorAll('input[data-prank]')].map(b => [b.dataset.prank, b.checked]));
    const r = await api.setSettings({ mischiefPranks: pranks });
    state.settings = r.settings;
    renderMischief();
  });
  $('worktreeToggle').addEventListener('change', async e => {
    const r = await api.setSettings({ worktrees: e.target.checked });
    state.settings = r.settings;
    SB.toast(e.target.checked ? 'New conversations in a git project will get their own copy.' : 'New conversations will work in your checkout again.');
  });
  $('clashToggle').addEventListener('change', async e => {
    const r = await api.setSettings({ clashWarnings: e.target.checked });
    state.settings = r.settings;
    SB.renderTabStrip();
    SB.toast(e.target.checked ? "He'll say when two copies change the same file." : 'No more clash warnings. Bring it home still stops on a real clash.');
  });
  $('planOnlyToggle').addEventListener('change', async e => {
    const r = await api.setSettings({ planOnly: e.target.checked });
    state.settings = r.settings;
    state.status = await api.claudeStatus(); // what Claude Code bills depends on it
    renderSettings();
    SB.toast(e.target.checked ? 'New conversations will use your Claude plan.' : 'New conversations will sign in however Claude Code is set up.');
  });
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
  $('claudeUpdateBtn').addEventListener('click', async () => {
    const r = await api.updateClaude();
    if (r?.cancelled) return;
    if (r?.ok && r.updated) SB.toast(`Claude Code is now v${r.to}. New conversations use it.`, { ms: 6000 });
    else if (r?.ok) SB.toast(`Claude Code says v${r.to || '?'} is the latest it can install.`, { ms: 5000 });
    else SB.toast(r?.error || "Claude Code didn't update. Try `claude update` in a terminal.", { ms: 6000 });
  });
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

  $('chatterSelect').addEventListener('change', async e => { const r = await api.setSettings({ chatter: e.target.value }); state.settings = r.settings; });
  $('crashReportsSelect').addEventListener('change', async e => { const r = await api.setSettings({ crashReports: e.target.value }); state.settings = r.settings; });
  $('soundsToggle').addEventListener('change', async e => { const r = await api.setSettings({ sounds: e.target.checked }); state.settings = r.settings; });
  $('soundFxToggle').addEventListener('change', async e => { const r = await api.setSettings({ soundFx: e.target.checked }); state.settings = r.settings; });
  $('ambientSelect').addEventListener('change', async e => { const r = await api.setSettings({ ambient: e.target.value }); state.settings = r.settings; });
  $('soundVolumeSelect').addEventListener('change', async e => { const r = await api.setSettings({ soundVolume: Number(e.target.value) }); state.settings = r.settings; });
  // His needs (src/main/needs.js). Back on, he comes back full; the Us page follows.
  $('needsToggle').addEventListener('change', async e => {
    const r = await api.setSettings({ needsOn: e.target.checked });
    state.settings = r.settings;
    api.getLife().then(v => SB.applyLife?.(v));
  });
  // Turning it on starts Windows' recognizer first, which can take a second or two.
  $('pushToTalkToggle').addEventListener('change', async e => {
    const box = e.target;
    box.disabled = true;
    const r = await api.setSettings({ pushToTalk: box.checked });
    box.disabled = false;
    state.settings = r.settings;
    box.checked = !!state.settings.pushToTalk;
    if (r.pushToTalkError) $('hotkeyMsg').textContent = r.pushToTalkError;
  });
  $('loginToggle').addEventListener('change', async e => { const r = await api.setSettings({ openAtLogin: e.target.checked }); state.settings = r.settings; });
  $('notifyToggle').addEventListener('change', async e => { const r = await api.setSettings({ notifications: e.target.checked }); state.settings = r.settings; });
  $('recapToggle').addEventListener('change', async e => { const r = await api.setSettings({ recap: e.target.checked }); state.settings = r.settings; });
  $('flakyToggle').addEventListener('change', async e => { const r = await api.setSettings({ flakyTests: e.target.checked }); state.settings = r.settings; SB.refreshFlaky?.(); });
  $('checkEachTurnToggle').addEventListener('change', async e => { const r = await api.setSettings({ checkEachTurn: e.target.checked }); state.settings = r.settings; $('checkEachTurnOptions').hidden = !state.settings.checkEachTurn; });
  $('checkTimeoutSelect').addEventListener('change', async e => { const r = await api.setSettings({ checkTimeoutMin: Number(e.target.value) }); state.settings = r.settings; });
  $('turnShotsToggle').addEventListener('change', async e => { const r = await api.setSettings({ turnShots: e.target.checked }); state.settings = r.settings; });
  $('forecastToggle').addEventListener('change', async e => { const r = await api.setSettings({ forecast: e.target.checked }); state.settings = r.settings; });
  $('spendGuardToggle').addEventListener('change', async e => { const r = await api.setSettings({ spendGuard: e.target.checked }); state.settings = r.settings; $('spendGuardOptions').hidden = !state.settings.spendGuard; });
  $('holdBigToggle').addEventListener('change', async e => { const r = await api.setSettings({ holdBigTasks: e.target.checked }); state.settings = r.settings; });
  $('spendReserveSelect').addEventListener('change', async e => { const r = await api.setSettings({ spendReserve: Number(e.target.value) }); state.settings = r.settings; });
  $('spendMaxSelect').addEventListener('change', async e => { const r = await api.setSettings({ spendMaxMinutes: Number(e.target.value) }); state.settings = r.settings; });
  $('leaveGuardToggle').addEventListener('change', async e => { const r = await api.setSettings({ leaveGuard: e.target.checked }); state.settings = r.settings; });
  $('openSkinsBtn').addEventListener('click', () => api.openSkinsFolder());
  $('reloadSkinsBtn').addEventListener('click', async () => { state.skins = await api.reloadSkins(); renderSkins(); SB.toast(`${state.skins.length} skins loaded`); });
  $('githubBtn').addEventListener('click', () => api.openExternal('https://github.com/x-salmon/shellby'));
  $('dataBtn').addEventListener('click', () => api.openDataFolder());

  // ------------------------------------------------------------ updates

  const UPDATE_STATUS = {
    checking: () => 'Looking for a new version…',
    downloading: u => `Downloading ${u.version ? `v${u.version}` : 'the update'}…`,
    ready: u => `Version ${u.version} is downloaded and ready.`,
    current: u => `You're on the latest version${u.checkedAt ? `, checked ${SB.relTime(u.checkedAt)}` : ''}.`,
    error: u => u.error || "Couldn't check for updates.",
    idle: () => 'Shellby updates himself from GitHub Releases.',
    off: () => 'Updates run in the installed app.',
    scoop: () => 'Scoop keeps Shellby up to date: run scoop update shellby.',
  };
  const UPDATE_BUTTON = { checking: () => 'Checking…', downloading: u => `${u.percent}%`, ready: () => 'Restart and update' };

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
    status.textContent = (UPDATE_STATUS[u.state] || UPDATE_STATUS.idle)(u);
    status.classList.toggle('bad', u.state === 'error');
    status.classList.toggle('ok', ready);
    const btn = $('updateBtn');
    // A dev run (npm start) has no updater at all, and Scoop does its own;
    // a button there would lie.
    btn.hidden = u.state === 'off' || u.state === 'scoop';
    btn.textContent = (UPDATE_BUTTON[u.state] || (() => 'Check for updates'))(u);
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

  // hotkey recorder
  const hotkeyBtn = $('hotkeyBtn');
  let recording = false;
  const stopRecording = () => { recording = false; hotkeyBtn.classList.remove('recording'); };
  hotkeyBtn.addEventListener('click', () => {
    recording = !recording;
    hotkeyBtn.classList.toggle('recording', recording);
    hotkeyBtn.textContent = recording ? 'Press keys…' : SB.prettyAccel(state.settings.hotkey);
    $('hotkeyMsg').textContent = recording ? 'Hold a modifier (Ctrl, Alt, Shift, Win) and press a key. Esc cancels, Backspace clears.' : '';
  });
  hotkeyBtn.addEventListener('blur', () => { if (recording) { stopRecording(); hotkeyBtn.textContent = SB.prettyAccel(state.settings.hotkey); $('hotkeyMsg').textContent = ''; } });
  hotkeyBtn.addEventListener('keydown', async e => {
    if (!recording) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') { stopRecording(); hotkeyBtn.textContent = SB.prettyAccel(state.settings.hotkey); $('hotkeyMsg').textContent = ''; return; }
    let accel = '';
    if (e.key !== 'Backspace') {
      if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;
      const mods = [e.ctrlKey && 'Control', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Super'].filter(Boolean);
      if (!mods.length) { $('hotkeyMsg').textContent = 'Add at least one modifier key.'; return; }
      const key = e.code === 'Space' ? 'Space' : /^Key[A-Z]$/.test(e.code) ? e.code.slice(3) : /^Digit\d$/.test(e.code) ? e.code.slice(5) : /^F\d{1,2}$/.test(e.key) ? e.key : null;
      if (!key) { $('hotkeyMsg').textContent = 'Use a letter, number, F-key or Space.'; return; }
      accel = [...mods, key].join('+');
    }
    stopRecording();
    const r = await api.setSettings({ hotkey: accel });
    state.settings = r.settings;
    hotkeyBtn.textContent = SB.prettyAccel(state.settings.hotkey) || 'None';
    $('hotkeyMsg').textContent = r.hotkeyError || (accel ? 'Saved.' : 'Shortcut cleared.');
    SB.refreshEmptyStates();
  });

  // ------------------------------------------------------------ Claude Code everywhere

  const STATE_TEXT = { working: 'working', asking: 'needs your OK', idle: 'idle' };
  function renderExternal(v) {
    if (!v) return;
    state.external = v;
    $('externalToggle').checked = !!v.enabled;
    const n = v.sessions?.length || 0;
    $('externalStatus').textContent = !v.enabled ? 'Off. Turn it on to see your other Claude Code sessions here.'
      : v.status === 'listening' ? (n ? `${n} session${n === 1 ? '' : 's'} connected.` : 'Listening. Start Claude Code anywhere with the plugin installed and it shows up here.')
      : v.status === 'busy' ? `Another app is using port ${v.port}, so outside sessions can't reach Shellby.`
      : 'Not listening right now.';
    $('externalStatus').className = `small ext-status ${v.enabled && v.status === 'listening' ? 'ok' : v.status === 'busy' ? 'warn' : ''}`;
    $('externalList').replaceChildren(...(v.enabled ? v.sessions || [] : []).map(s => h('li', { class: `ext-session ${s.state}` },
      h('span', { class: 'ext-dot', 'aria-hidden': 'true' }),
      h('b', { text: s.project }),
      h('span', { class: 'ext-state', text: s.state === 'working' && s.tool ? `working · ${s.tool}` : STATE_TEXT[s.state] || s.state }),
      s.helpers ? h('span', { class: 'ext-helpers', text: `${s.helpers} helper${s.helpers === 1 ? '' : 's'}` }) : null,
      h('time', { text: SB.relTime(s.lastAt) }),
      s.id && !SB.isCrabOnly() ? h('button', { class: 'btn ghost slim-btn ext-bring', type: 'button', 'aria-label': `Bring ${s.project} into Shellby`, onclick: () => bringIn(s) }, 'Bring it into Shellby') : null)));
    renderBackground(v.background || []);
  }

  // Two copies of one conversation trip over each other, so an open one asks
  // first: the toast's button is your word that it's closed there now.
  async function bringIn(s, force = false) {
    const r = await api.bringIntoShellby(s.id, force);
    if (r?.ok) return SB.toast('Brought into Shellby.');
    if (r?.confirm) return SB.toast(r.error, { action: "It's closed, bring it in", onAction: () => bringIn(s, true), ms: 8000 });
    SB.toast(r?.error || "Couldn't bring it in.", { ms: 5000 });
  }

  // Background commands a turn walked away from: what, where, and how long ago.
  function renderBackground(list) {
    $('bgLeft').hidden = !list.length;
    $('bgList').replaceChildren(...list.map(b => h('li', { class: 'bg-item' },
      h('span', { class: 'bg-dot', 'aria-hidden': 'true' }),
      h('b', { text: b.program }),
      h('span', { class: 'bg-where', text: b.project }),
      h('time', { text: SB.relTime(b.at) }))));
  }
  $('bgClear').addEventListener('click', async () => renderExternal(await api.clearBackground()));
  $('externalToggle').addEventListener('change', async e => {
    renderExternal(await api.setExternal(e.target.checked));
    renderCli(await api.getCli());
  });

  // ---------------------------------------------------------------- the shellby command
  function renderCli(v) {
    const on = !!v.installed;
    $('cliBtn').textContent = on ? 'Remove it' : 'Add to my PATH';
    $('cliBtn').classList.toggle('danger', on);
    $('cliBtn').disabled = !v.available;
    const ready = on && v.listening;
    $('cliStatus').textContent = !v.available ? 'Windows only for now.'
      : ready ? `Ready. Open a new terminal and try: shellby do "tidy my Downloads"`
        : on ? 'Turn on "React to Claude Code sessions outside Shellby" above; the command talks to him through it.'
          : '';
    $('cliStatus').className = `small ext-status ${ready ? 'ok' : ''}`;
  }
  $('cliBtn').addEventListener('click', async () => {
    const before = await api.getCli();
    $('cliBtn').disabled = true;
    const r = before.installed ? await api.removeCli() : await api.installCli();
    renderCli(r);
    if (r.ok === false) SB.toast(r.error || "That didn't work.");
    else if (!before.installed) SB.toast('Added. Open a new terminal for it to show up.');
  });

  // ---------------------------------------------------------------- telling you elsewhere
  let channels = null;
  // The subscribe link as pixel art: ink modules on sand, with the 4-module
  // quiet zone a phone camera needs to find the code.
  function drawQr(rows) {
    const canvas = $('chQrCanvas');
    const n = rows.length + 8;
    const scale = 4;
    canvas.width = canvas.height = n * scale;
    const g = canvas.getContext('2d');
    const css = getComputedStyle(document.documentElement);
    g.fillStyle = css.getPropertyValue('--sand').trim() || '#f3e6cc';
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.fillStyle = css.getPropertyValue('--ink').trim() || '#0c1719';
    rows.forEach((row, y) => [...row].forEach((bit, x) => {
      if (bit === '1') g.fillRect((x + 4) * scale, (y + 4) * scale, scale, scale);
    }));
  }
  function renderChannels(v) {
    channels = v;
    $('chEnabled').checked = !!v.enabled;
    $('chBody').hidden = !v.enabled;
    const provider = v.providers.find(p => p.name === v.provider) || v.providers[0];
    if ($('chProvider').children.length !== v.providers.length) {
      $('chProvider').replaceChildren(...v.providers.map(p => h('option', { value: p.name, text: p.label })));
    }
    $('chProvider').value = v.provider;
    $('chHint').textContent = provider.hint;
    $('chTargetLabel').textContent = provider.targetLabel;
    if (document.activeElement !== $('chTarget')) $('chTarget').value = v.target || '';
    $('chSecretField').hidden = provider.secret === 'no';
    $('chSecretLabel').textContent = provider.secretLabel || 'Token';
    $('chSecret').placeholder = v.hasSecret ? 'saved — type to replace' : '';
    $('chWhileFocused').checked = !!v.whileFocused;
    $('chRepliesRow').hidden = !v.canReply;
    $('chReplies').checked = !!v.replies;
    $('chRepliesHint').classList.toggle('warn', !!v.replyProblem);
    $('chRepliesHint').textContent = v.replyProblem || 'Anyone who can read these notifications can answer them, so keep the topic or bot to yourself. Only your own private chat with the bot counts. Questions, plans, "Always allow", long commands and anything the card would warn you about still wait for you at the desk.';
    $('chQr').hidden = !v.qr;
    if (v.qr && $('chQrCanvas').dataset.url !== v.subscribeUrl) { drawQr(v.qr); $('chQrCanvas').dataset.url = v.subscribeUrl; }
    $('chFindRow').hidden = !provider.findsTarget;
    $('chEvents').replaceChildren(...Object.entries(v.eventLabels).map(([key, label]) => h('label', { class: 'toggle' },
      h('input', { type: 'checkbox', 'data-event': key, ...(v.events[key] ? { checked: 'checked' } : {}) }),
      h('span', { class: 'switch' }),
      document.createTextNode(label))));
    $('chStatus').textContent = v.problem || '';
    $('chStatus').className = `small ext-status ${v.problem ? 'warn' : ''}`;
    $('chTest').disabled = !!v.problem;
    $('ptRow').hidden = !v.canReply;
    if (v.canReply) api.getPhoneTasks().then(renderPhoneTasks);
  }

  // Starting a task from the phone (phone-tasks.js). The switch only asks:
  // turning it on happens in the confirmation window, never here.
  function renderPhoneTasks(v) {
    if (!v) return;
    $('ptEnabled').checked = !!v.on;
    $('ptFolder').textContent = v.folder || 'nowhere yet';
    $('ptFolder').title = v.folder || '';
    $('ptNtfy').hidden = v.provider !== 'ntfy';
    $('ptTopic').textContent = v.tasksTopic || '';
    $('ptNewPass').hidden = !v.hasPassphrase;
    const pass = v.passphrase || null;
    $('ptPassBox').hidden = !pass;
    $('ptPass').textContent = pass || '';
    $('ptHint').textContent = v.provider === 'ntfy'
      ? `Post to the topic below and Shellby starts it, in Ask first. Anyone who knows an ntfy topic can post to it and read it, so a passphrase from Shellby has to start every message. At most ${v.perHour} an hour, ${v.atOnce} at once.`
      : `Message your bot and Shellby starts it, in Ask first: every edit and command still waits for your Allow. Only your private chat with the bot counts. At most ${v.perHour} an hour, ${v.atOnce} at once.`;
    const off = v.wanted && !v.on;
    const said = v.error || (v.on ? `On. ${v.provider === 'ntfy' ? 'Post your passphrase then /help' : 'Send /help to your bot'} for how.` : off ? v.problem || 'Off: where notifications go changed. Turn it on again.' : v.problem || '');
    $('ptStatus').textContent = v.cancelled ? 'Left off.' : said;
    $('ptStatus').className = `small ext-status ${v.error || (v.problem && v.wanted) ? 'warn' : v.on ? 'ok' : ''}`;
  }
  $('ptEnabled').addEventListener('change', async e => {
    e.target.disabled = true;
    renderPhoneTasks(await api.setPhoneTasks({ enabled: e.target.checked }));
    e.target.disabled = false;
  });
  $('ptFolderBtn').addEventListener('click', async () => renderPhoneTasks(await api.pickPhoneTasksFolder()));
  $('ptNewPass').addEventListener('click', async () => renderPhoneTasks(await api.setPhoneTasks({ newPassphrase: true })));
  $('ptCopyPass').addEventListener('click', () => {
    api.copyText($('ptPass').textContent);
    SB.toast('Copied. Paste it somewhere safe on your phone.');
  });
  $('chEnabled').addEventListener('change', async e => renderChannels(await api.setChannels({ enabled: e.target.checked })));
  $('chProvider').addEventListener('change', async e => renderChannels(await api.setChannels({ provider: e.target.value })));
  $('chTarget').addEventListener('change', async e => renderChannels(await api.setChannels({ target: e.target.value })));
  $('chWhileFocused').addEventListener('change', async e => renderChannels(await api.setChannels({ whileFocused: e.target.checked })));
  $('chReplies').addEventListener('change', async e => renderChannels(await api.setChannels({ replies: e.target.checked })));
  $('chSecret').addEventListener('change', async e => {
    const typed = e.target.value;
    e.target.value = '';
    if (!typed) return;
    renderChannels(await api.setChannelSecret(typed));
    // A fresh bot token and no chat yet: go and look, so pasting is the whole job.
    if (channels.providers.find(p => p.name === channels.provider)?.findsTarget && !channels.target) findChat();
  });
  async function findChat() {
    $('chFind').disabled = true;
    $('chFindStatus').textContent = 'Asking Telegram…';
    $('chFindStatus').className = 'small ext-status';
    const v = await api.findTelegramChat();
    renderChannels(v);
    const f = v.found || {};
    $('chFindStatus').textContent = f.chatId ? `Found ${f.name || 'your chat'}.` : f.error || "Couldn't find it.";
    $('chFindStatus').className = `small ext-status ${f.chatId ? 'ok' : 'warn'}`;
    $('chFind').disabled = false;
  }
  $('chFind').addEventListener('click', findChat);
  $('chEvents').addEventListener('change', async e => {
    const key = e.target.dataset?.event;
    if (key) renderChannels(await api.setChannels({ events: { ...channels.events, [key]: e.target.checked } }));
  });
  $('chTest').addEventListener('click', async () => {
    $('chTest').disabled = true;
    const r = await api.testChannel();
    $('chStatus').textContent = r.ok ? 'Sent. Check your phone.' : `Didn't go: ${r.error}`;
    $('chStatus').className = `small ext-status ${r.ok ? 'ok' : 'warn'}`;
    $('chTest').disabled = false;
  });

  // ---------------------------------------------------------------- on a stream
  function renderObs(v) {
    $('obsEnabled').checked = !!v.enabled;
    $('obsBody').hidden = !v.enabled;
    $('obsUrl').textContent = v.url || `http://127.0.0.1:${v.port}/`;
    const viewers = v.viewers || 0;
    $('obsStatus').textContent = v.status === 'listening'
      ? (viewers ? `${viewers} source${viewers === 1 ? '' : 's'} connected.` : 'Waiting for OBS to connect.')
      : v.status === 'busy' ? `Another app is using port ${v.port}.` : '';
    $('obsStatus').className = `small ext-status ${v.status === 'listening' ? 'ok' : v.status === 'busy' ? 'warn' : ''}`;
  }
  $('obsEnabled').addEventListener('change', async e => renderObs(await api.setObs({ enabled: e.target.checked })));

  // ---------------------------------------------------------------- desk lighting
  let rgbLast = null;
  function renderRgb(v) {
    rgbLast = v;
    $('rgbEnabled').checked = !!v.enabled;
    $('rgbBody').hidden = !v.enabled;
    const devices = v.devices || [];
    const busy = { installing: 'Installing OpenRGB… say yes if Windows asks.', starting: 'Starting OpenRGB…' }[v.setup];
    $('rgbStatus').textContent = busy || (v.error ? v.error : devices.length ? `${devices.length} device${devices.length === 1 ? '' : 's'}.` : '');
    $('rgbStatus').className = `small ext-status ${busy ? '' : v.error ? 'warn' : devices.length ? 'ok' : ''}`;
    // Not installed and nothing answering: installing is the only useful step.
    // (A portable copy running from elsewhere answers, so it counts as there.)
    const absent = !v.installed && !devices.length;
    $('rgbInstall').hidden = !absent;
    $('rgbTest').hidden = absent;
    $('rgbInstall').disabled = $('rgbTest').disabled = !!v.setup;
    $('rgbList').replaceChildren(...devices.map(d => h('li', { class: 'ext-session' },
      h('b', { text: d.name }),
      h('span', { class: 'ext-state', text: `${d.numLeds} LED${d.numLeds === 1 ? '' : 's'}` }))));
  }
  // Starting or installing OpenRGB takes a while. Main says which step it's on
  // (an install only begins once the confirm window says yes), so ask it
  // until the call comes back.
  const rgbBusy = async (setup, call) => {
    if (setup) renderRgb({ ...(rgbLast || {}), enabled: true, setup });
    let done = false;
    const poll = setInterval(() => {
      api.getRgb().then(v => { if (!done && v.setup) renderRgb(v); }).catch(() => { /* the final answer still comes */ });
    }, 1500);
    try {
      const v = await call();
      done = true;
      renderRgb(v);
      if (v.noWinget) {
        SB.toast("winget isn't on this PC, so here's OpenRGB's site to download it from.", { ms: 6000 });
        api.openExternal('https://openrgb.org/');
      }
    } catch {
      done = true;
      renderRgb({ ...(await api.getRgb().catch(() => rgbLast || {})), setup: null, error: "That didn't work. Try again?" });
    } finally {
      clearInterval(poll);
    }
  };
  $('rgbEnabled').addEventListener('change', e => (e.target.checked
    ? rgbBusy('starting', () => api.setRgb({ enabled: true }))
    // Off hides the status line, so a failed hand-back is said out loud.
    : api.setRgb({ enabled: false }).then(v => { renderRgb(v); if (v.error) SB.toast(v.error, { ms: 6000 }); })));
  $('rgbTest').addEventListener('click', () => rgbBusy('starting', api.testRgb));
  $('rgbInstall').addEventListener('click', () => rgbBusy(null, api.installOpenRgb));

  // ---------------------------------------------------------------- listening along
  function renderNowPlaying(v) {
    $('npEnabled').checked = !!v.enabled;
    $('npEnabled').disabled = !v.available;
    $('npBody').hidden = !v.enabled;
    $('npHeadphones').checked = v.headphones !== false;
    $('npRemarks').checked = v.remarks !== false;
    const t = v.track;
    $('npStatus').textContent = !v.available ? 'Windows only.'
      : v.status === 'unavailable' ? "Windows isn't answering about media here."
        : t ? `${t.playing ? '♪ ' : 'Paused: '}${[t.title, t.artist].filter(Boolean).join(' — ')}${t.app ? ` (${t.app})` : ''}`
          : 'Nothing playing.';
    $('npStatus').className = `small ext-status ${t?.playing ? 'ok' : ''}`;
  }
  const setNp = patch => api.setNowPlaying(patch).then(renderNowPlaying);
  $('npEnabled').addEventListener('change', e => setNp({ enabled: e.target.checked }));
  $('npHeadphones').addEventListener('change', e => setNp({ headphones: e.target.checked }));
  $('npRemarks').addEventListener('change', e => setNp({ remarks: e.target.checked }));
  api.onNowPlaying(v => { if (state.view === 'settings') renderNowPlaying(v); });

  // ---------------------------------------------------------------- typing along
  function renderTyping(v) {
    $('typingEnabled').checked = !!v.enabled;
    $('typingBody').hidden = !v.enabled;
    $('typingRemarks').checked = v.remarks !== false;
    $('typingStatus').textContent = !v.available ? "Windows isn't letting him hear the keyboard here."
      : v.best ? `Your fastest burst so far: ${v.best} words a minute.` : 'Type fast for a few seconds and see what he thinks.';
    $('typingStatus').className = `small ext-status ${v.available && v.best ? 'ok' : ''}`;
  }
  const setTyping = patch => api.setTyping(patch).then(renderTyping);
  $('typingEnabled').addEventListener('change', e => setTyping({ enabled: e.target.checked }));
  $('typingRemarks').addEventListener('change', e => setTyping({ remarks: e.target.checked }));

  // ---------------------------------------------------------------- the weather outside
  const minutesAgo = at => {
    const m = Math.round((Date.now() - at) / 60000);
    return m < 1 ? 'just now' : m === 1 ? 'a minute ago' : m < 90 ? `${m} minutes ago` : `${Math.round(m / 60)} hours ago`;
  };
  function renderWeather(v) {
    $('weatherEnabled').checked = !!v.enabled;
    $('weatherBody').hidden = !v.enabled;
    $('weatherRemarks').checked = v.remarks !== false;
    if (v.label && document.activeElement !== $('weatherQuery')) $('weatherQuery').value = v.place?.name || '';
    const status = $('weatherStatus');
    status.className = 'small ext-status';
    if (!v.place) status.textContent = 'Find your town to begin.';
    else if (v.reading) { status.textContent = `${v.summary} in ${v.label}, checked ${minutesAgo(v.reading.at)}.`; status.classList.add('ok'); }
    else if (v.error) status.textContent = `${v.label}: ${v.error[0].toUpperCase()}${v.error.slice(1)}. He'll try again shortly.`;
    else status.textContent = `Checking the weather in ${v.label}…`;
  }
  const setWeather = patch => api.setWeather(patch).then(renderWeather);
  $('weatherEnabled').addEventListener('change', e => setWeather({ enabled: e.target.checked }));
  $('weatherRemarks').addEventListener('change', e => setWeather({ remarks: e.target.checked }));

  function showPlaces(places) {
    const host = $('weatherPlaces');
    host.replaceChildren(...places.map(p => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn ghost slim-btn';
      b.textContent = [p.name, p.region, p.country].filter(Boolean).join(', ');
      b.addEventListener('click', () => {
        host.hidden = true;
        host.replaceChildren();
        setWeather({ place: p });
      });
      return b;
    }));
    host.hidden = !places.length;
    host.querySelector('button')?.focus();
  }
  $('weatherSearch').addEventListener('submit', async e => {
    e.preventDefault();
    const find = $('weatherFind');
    find.disabled = true;
    $('weatherStatus').textContent = 'Looking…';
    try {
      const r = await api.searchWeather($('weatherQuery').value);
      showPlaces(r.places || []);
      $('weatherStatus').textContent = r.error || (r.places.length === 1 ? 'Is this the one?' : 'Which one?');
    } catch {
      $('weatherStatus').textContent = "Couldn't search just now.";
    } finally {
      find.disabled = false;
    }
  });
  api.onWeather(v => { if (state.view === 'settings') renderWeather(v); });
  api.onObs(v => { if (state.view === 'settings') renderObs(v); });

  document.querySelectorAll('[data-copy]').forEach(b => b.addEventListener('click', () => {
    api.copyText($(b.dataset.copy).textContent);
    SB.toast('Copied. Paste it into Claude Code.');
  }));
  api.onExternal(v => { if (state.view === 'settings') renderExternal(v); else state.external = v; });

  // ------------------------------------------------------------ the plugin

  function renderPlugin(v) {
    if (!v) return;
    const text = {
      on: "Installed. Claude Code sessions in any terminal or editor on this PC show up here. (Sessions on other computers can't reach this Shellby.)",
      off: 'Installed but turned off. Turn it on in Claude Code with /plugin.',
      none: 'Not installed on this PC yet, so Claude Code in the terminal can\'t tell Shellby what it\'s doing.',
      unreadable: "Couldn't read your Claude Code settings.json.",
    }[v.state];
    $('pluginText').textContent = v.error || text;
    $('pluginBtn').hidden = v.state === 'on' || v.state === 'off';
    $('pluginBtn').disabled = false;
    $('pluginBtn').textContent = 'Install the plugin';
  }
  $('pluginBtn').addEventListener('click', async () => {
    $('pluginBtn').disabled = true;
    $('pluginBtn').textContent = 'Installing…';
    const v = await api.installPlugin();
    renderPlugin(v);
    if (v.installed) SB.toast('Plugin installed. Start a new Claude Code session and Shellby will follow along.', { ms: 5000 });
  });

  // ------------------------------------------------------------ status line

  function renderStatusLine(v) {
    if (!v) return;
    state.statusLine = v;
    $('slPreview').textContent = v.preview || '';
    const text = {
      ours: "Shellby is in your Claude Code status line. If it's empty, Shellby isn't running.",
      none: "Show Shellby's mood, level and XP under Claude Code's prompt, in the terminal and VS Code.",
      other: "You already have a status line. Adding Shellby's replaces it (yours is kept and comes back if you remove Shellby's).",
      unreadable: "Couldn't read your Claude Code settings.json, so Shellby won't touch it.",
    }[v.state];
    $('slText').textContent = v.error || text;
    $('slBtn').textContent = v.state === 'ours' ? 'Remove' : 'Add to Claude Code';
    $('slBtn').className = v.state === 'ours' ? 'btn ghost slim-btn' : 'btn primary slim-btn';
    $('slBtn').disabled = v.state === 'unreadable';
  }
  $('slBtn').addEventListener('click', async () => {
    const was = state.statusLine?.state;
    const v = await (was === 'ours' ? api.removeStatusLine() : api.installStatusLine());
    renderStatusLine(v);
    if (v.state === 'ours' && was !== 'ours') SB.toast('Shellby is in your status line. Start a new Claude Code session to see him.', { ms: 5000 });
    if (v.state !== 'ours' && was === 'ours') SB.toast('Removed from your status line.');
  });

  SB.views.settings = {
    render: () => {
      renderSettings(); renderUpdates();
      api.getExternal().then(renderExternal);
      api.getStatusLine().then(renderStatusLine);
      api.getPlugin().then(renderPlugin);
      api.getCli().then(renderCli);
      api.getChannels().then(renderChannels);
      api.getObs().then(renderObs);
      api.getRgb().then(renderRgb);
      api.getNowPlaying().then(renderNowPlaying);
      api.getTyping().then(renderTyping);
      api.getWeather().then(renderWeather);
    },
  };
})();
