/* Shellby panel — the settings view: the general settings and the switches
   that only save themselves. Claude Code's account and both updates are in
   settings-account.js, Claude Code outside Shellby in settings-everywhere.js,
   notifications elsewhere in settings-channels.js, and the stream, lights,
   music, typing and weather in settings-desk.js. History is history.js,
   onboarding onboarding.js. */
'use strict';
(function () {
  const { h, api, state, $ } = SB;
  const T = window.ShellbySettingsText;
  // Theirs, reached when they're called (the files load after this one).
  const renderBillingGuard = () => SB.renderBillingGuard();
  const renderClaudeAccount = () => SB.renderClaudeAccount();
  const renderFacts = () => SB.renderFacts();

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
    $('settingsFolder').textContent = SB.remotePlace(state.cwd) || state.cwd;
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
    $('claudeTricksToggle').checked = state.settings.claudeTricks !== false;
    $('justSawToggle').checked = state.settings.attachWhatISaw === true;
    $('forecastToggle').checked = state.settings.forecast !== false;
    $('spendGuardToggle').checked = state.settings.spendGuard !== false;
    $('spendReserveSelect').value = String(state.settings.spendReserve || 25);
    $('spendMaxSelect').value = String(state.settings.spendMaxMinutes || 60);
    $('spendGuardOptions').hidden = state.settings.spendGuard === false;
    $('holdBigToggle').checked = state.settings.holdBigTasks === true;
    $('leaveGuardToggle').checked = state.settings.leaveGuard !== false;
    $('flakyToggle').checked = state.settings.flakyTests !== false;
    $('surprisesToggle').checked = state.settings.surprises !== false;
    $('tideEventsToggle').checked = state.settings.tideEvents !== false;
    $('catchBugsToggle').checked = state.settings.catchBugs !== false;
    $('bugBattlesToggle').checked = state.settings.bugBattles !== false;
    $('bugFollowerToggle').checked = state.settings.bugFollower !== false;
    $('shareBugdexToggle').checked = state.settings.shareBugdex === true;
    $('bugdexOptions').hidden = state.settings.catchBugs === false;
    $('checkEachTurnToggle').checked = state.settings.checkEachTurn === true;
    $('checkEachTurnOptions').hidden = state.settings.checkEachTurn !== true;
    $('checkTimeoutSelect').value = String([2, 5, 10, 20].includes(state.settings.checkTimeoutMin) ? state.settings.checkTimeoutMin : 5);
    $('turnShotsToggle').checked = state.settings.turnShots !== false;
    // Windows' animation effects off: the default stays put (main's motion.js wanders), so it shows off.
    const stillByDefault = !state.settings.wanderChosen && matchMedia('(prefers-reduced-motion: reduce)').matches;
    $('wanderToggle').checked = state.settings.wander !== false && !stillByDefault;
    $('onTopToggle').checked = state.settings.onTop === true;
    renderPerch();
    $('worktreeToggle').checked = !!state.settings.worktrees;
    $('signCommitsToggle').checked = state.settings.signCommits === true;
    $('clashToggle').checked = state.settings.clashWarnings !== false;
    renderEditor();
    renderBillingGuard();
    $('chatterSelect').value = ['quiet', 'work', 'normal', 'chatty'].includes(state.settings.chatter) ? state.settings.chatter : 'normal';
    $('workModeToggle').checked = !!SB.isWorkMode?.();
    $('soundsToggle').checked = !!state.settings.sounds;
    $('selfAwareToggle').checked = state.settings.selfAware !== false;
    $('suggestToggle').checked = state.settings.suggestions !== false;
    $('plainCardsToggle').checked = state.settings.plainCards !== false;
    $('suggestToggle').disabled = state.settings.selfAware === false;
    const muted = state.settings.mutedSuggestions || [];
    $('mutedSuggestRow').hidden = !muted.length;
    $('mutedSuggestText').textContent = `${muted.length} ${muted.length === 1 ? 'feature' : 'features'} Claude won't offer.`;
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
  SB.renderSettings = renderSettings;

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
  // Changed on another PC, and brought over by a sync.
  api.onSettings(s => {
    state.settings = s;
    SB.applyMode(s.mode);
    SB.syncJustSaw?.();
    SB.refreshUsage?.(); // a computer checked again may now be on another account
    if (state.view === 'settings') renderSettings();
  });
  // Where file links open. Editors that aren't installed say so rather than vanish.
  async function renderEditor() {
    const ed = await SB.loadEditors();
    const sel = $('editorSelect');
    sel.value = ed.choice || 'auto';
    for (const o of sel.options) {
      o.textContent = o.dataset.label + (o.value === 'auto' ? ` (${ed.using || 'default app'})` : o.value !== 'system' && !ed.installed.includes(o.value) ? ' (not installed)' : '');
    }
    $('editorNote').textContent = ed.using
      ? `File paths in a conversation open in ${ed.using}, at the line. Shift+click shows a file in its folder instead.`
      : "No VS Code, Cursor or Windsurf found, so file links open in Windows' default app. Anything that would run (a script, an .exe) is shown in its folder instead.";
  }
  $('editorSelect').addEventListener('change', async e => {
    const r = await api.setSettings({ editor: e.target.value });
    state.settings = r.settings;
    renderEditor();
  });
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

  $('chatterSelect').addEventListener('change', async e => { const r = await api.setSettings({ chatter: e.target.value }); state.settings = r.settings; });
  $('crashReportsSelect').addEventListener('change', async e => { const r = await api.setSettings({ crashReports: e.target.value }); state.settings = r.settings; });
  $('soundsToggle').addEventListener('change', async e => { const r = await api.setSettings({ sounds: e.target.checked }); state.settings = r.settings; });
  $('soundFxToggle').addEventListener('change', async e => { const r = await api.setSettings({ soundFx: e.target.checked }); state.settings = r.settings; });
  $('surprisesToggle').addEventListener('change', async e => { const r = await api.setSettings({ surprises: e.target.checked }); state.settings = r.settings; });
  $('signCommitsToggle').addEventListener('change', async e => { const r = await api.setSettings({ signCommits: e.target.checked }); state.settings = r.settings; });
  $('tideEventsToggle').addEventListener('change', async e => { const r = await api.setSettings({ tideEvents: e.target.checked }); state.settings = r.settings; SB.tide?.refresh(); });
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
  $('selfAwareToggle').addEventListener('change', async e => { const r = await api.setSettings({ selfAware: e.target.checked }); state.settings = r.settings; renderSettings(); });
  $('plainCardsToggle').addEventListener('change', async e => { const r = await api.setSettings({ plainCards: e.target.checked }); state.settings = r.settings; });
  $('suggestToggle').addEventListener('change', async e => { const r = await api.setSettings({ suggestions: e.target.checked }); state.settings = r.settings; });
  $('unmuteSuggestBtn').addEventListener('click', async () => { state.settings.mutedSuggestions = await api.muteSuggestion(null); renderSettings(); });
  $('loginToggle').addEventListener('change', async e => { const r = await api.setSettings({ openAtLogin: e.target.checked }); state.settings = r.settings; });
  $('notifyToggle').addEventListener('change', async e => { const r = await api.setSettings({ notifications: e.target.checked }); state.settings = r.settings; });
  $('recapToggle').addEventListener('change', async e => { const r = await api.setSettings({ recap: e.target.checked }); state.settings = r.settings; });
  $('claudeTricksToggle').addEventListener('change', async e => { const r = await api.setSettings({ claudeTricks: e.target.checked }); state.settings = r.settings; });
  $('justSawToggle').addEventListener('change', async e => { const r = await api.setSettings({ attachWhatISaw: e.target.checked }); state.settings = r.settings; SB.syncJustSaw?.(); });
  $('flakyToggle').addEventListener('change', async e => { const r = await api.setSettings({ flakyTests: e.target.checked }); state.settings = r.settings; SB.refreshFlaky?.(); });
  $('catchBugsToggle').addEventListener('change', async e => { const r = await api.setSettings({ catchBugs: e.target.checked }); state.settings = r.settings; $('bugdexOptions').hidden = !e.target.checked; });
  for (const [id, key] of [['bugBattlesToggle', 'bugBattles'], ['bugFollowerToggle', 'bugFollower'], ['shareBugdexToggle', 'shareBugdex']]) {
    $(id).addEventListener('change', async e => { const r = await api.setSettings({ [key]: e.target.checked }); state.settings = r.settings; SB.bugdexSettingsChanged?.(); });
  }
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
    const got = T.accelerator(e);
    if (!got) return; // a modifier on its own: wait for the key
    if (got.error) { $('hotkeyMsg').textContent = got.error; return; }
    const { accel } = got;
    stopRecording();
    const r = await api.setSettings({ hotkey: accel });
    state.settings = r.settings;
    hotkeyBtn.textContent = SB.prettyAccel(state.settings.hotkey) || 'None';
    $('hotkeyMsg').textContent = r.hotkeyError || (accel ? 'Saved.' : 'Shortcut cleared.');
    SB.refreshEmptyStates();
  });

  // Each part of the screen asks main for what it shows as Settings opens
  // (settings-account.js and the rest register here, in load order).
  const opening = [];
  SB.onSettingsOpen = fn => { opening.push(fn); };
  // Ctrl+/ is the list, and where each shortcut gets your own keys (nav.js).
  $('panelKeysBtn').addEventListener('click', () => SB.openShortcuts({ edit: true }));

  SB.views.settings = {
    render: () => {
      renderSettings();
      for (const fn of opening) fn();
    },
  };
})();
