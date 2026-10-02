/* Shellby panel — settings, history and onboarding views. */
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

  function renderSettings() {
    SB.renderModeCards($('modeCards'));
    $('autonomousConfirm').hidden = true;
    $('settingsFolder').textContent = state.cwd;
    $('settingsFolder').title = state.cwd;
    renderSkins();
    $('scaleSelect').value = String(state.settings.critterScale || 1);
    $('hotkeyBtn').textContent = SB.prettyAccel(state.settings.hotkey) || 'None';
    $('hotkeyMsg').textContent = '';
    $('modelSelect').value = state.settings.model || '';
    $('loginToggle').checked = !!state.settings.openAtLogin;
    $('loginToggle').disabled = !state.packaged;
    $('loginNote').hidden = state.packaged;
    $('notifyToggle').checked = !!state.settings.notifications;
    $('wanderToggle').checked = state.settings.wander !== false;
    $('chatterSelect').value = ['quiet', 'normal', 'chatty'].includes(state.settings.chatter) ? state.settings.chatter : 'normal';
    $('soundsToggle').checked = !!state.settings.sounds;
    const st = state.status || {};
    const facts = [
      ['Shellby', `v${state.version}`],
      ['Claude Code', st.version ? `v${st.version}` : 'not found'],
      ['Account', st.email || '—'],
      ['Plan', st.subscriptionType ? st.subscriptionType[0].toUpperCase() + st.subscriptionType.slice(1) : '—'],
      ['Billing', st.authMethod === 'claude.ai' ? 'Claude subscription ✓' : (st.authMethod || '—')],
    ];
    $('facts').replaceChildren(...facts.flatMap(([k, v]) => [h('dt', { text: k }), h('dd', { text: v, title: v })]));
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
  $('modelSelect').addEventListener('change', async e => { const r = await api.setSettings({ model: e.target.value }); state.settings = r.settings; SB.toast('Model applies to new conversations.'); });
  $('wanderToggle').addEventListener('change', async e => { const r = await api.setSettings({ wander: e.target.checked }); state.settings = r.settings; });
  $('chatterSelect').addEventListener('change', async e => { const r = await api.setSettings({ chatter: e.target.value }); state.settings = r.settings; });
  $('soundsToggle').addEventListener('change', async e => { const r = await api.setSettings({ sounds: e.target.checked }); state.settings = r.settings; });
  $('loginToggle').addEventListener('change', async e => { const r = await api.setSettings({ openAtLogin: e.target.checked }); state.settings = r.settings; });
  $('notifyToggle').addEventListener('change', async e => { const r = await api.setSettings({ notifications: e.target.checked }); state.settings = r.settings; });
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
      h('time', { text: SB.relTime(s.lastAt) }))));
  }
  $('externalToggle').addEventListener('change', async e => renderExternal(await api.setExternal(e.target.checked)));
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

  SB.views.settings = { render: () => { renderSettings(); api.getExternal().then(renderExternal); api.getStatusLine().then(renderStatusLine); api.getPlugin().then(renderPlugin); } };

  // ------------------------------------------------------------ history

  function renderHistory() {
    const q = $('historySearch').value.trim().toLowerCase();
    const list = state.sessions.filter(s => !q || s.title.toLowerCase().includes(q) || (s.cwd || '').toLowerCase().includes(q));
    const ul = $('historyList');
    if (!list.length) {
      ul.replaceChildren(h('li', { class: 'history-empty', text: q ? 'No matches.' : 'No conversations yet. Give Shellby a task!' }));
      return;
    }
    ul.replaceChildren(...list.map(s => h('li', { class: `history-item${state.tabs.has(s.id) ? ' current' : ''}` },
      h('button', { class: 'history-open', type: 'button', onclick: () => SB.openHistory(s.id) },
        h('div', { class: 'h-title' }, s.lastOutcome === 'error' ? h('span', { class: 'h-dot err', title: 'Ended with an error' }) : null, s.title),
        h('div', { class: 'h-meta' },
          h('span', { text: SB.relTime(s.updatedAt) }),
          h('span', { text: SB.shortPath(s.cwd, 30) }),
          state.tabs.has(s.id) ? h('span', { class: 'h-open', text: 'open' }) : null)),
      h('button', { class: 'history-del', type: 'button', title: 'Delete', 'aria-label': `Delete ${s.title}`, onclick: () => deleteHistory(s.id) }, '✕'))));
  }
  $('historySearch').addEventListener('input', renderHistory);

  SB.openHistory = async (id) => {
    if (state.tabs.has(id)) { SB.activate(id); return; }
    const r = await api.openSession(id);
    if (!r || r.error) return SB.toast(r?.error || "Couldn't open that conversation.");
    const tab = SB.ensureTab({ id: r.tabId, title: r.entry.title, cwd: r.entry.cwd, saved: true, routineId: r.entry.routineId });
    for (const item of r.items) tab.render(item, { replay: true });
    tab.cancelOpenAsks();
    for (const lane of tab.lanes.values()) if (lane.status === 'running') lane.finish({ ok: true });
    SB.activate(r.tabId);
    SB.toast('Picked up where you left off');
  };

  async function deleteHistory(id) {
    state.sessions = await api.deleteSession(id);
    const tab = state.tabs.get(id);
    if (tab) { tab.destroy(); state.tabs.delete(id); if (state.activeTab === id) { state.activeTab = null; await SB.newTab(); } SB.renderTabStrip(); }
    renderHistory();
  }

  SB.views.history = { render: async () => { state.sessions = await api.listSessions(); renderHistory(); } };

  // ------------------------------------------------------------ onboarding

  SB.needsOnboarding = () => {
    const s = state.status || {};
    if (!state.settings.onboarded) return true;
    return !state.settings.crabOnly && (!s.installed || !s.loggedIn);
  };

  function renderOnboarding() {
    const s = state.status || {};
    // Two paths: just the crab (no account), or the Claude Code setup steps.
    const path = SB.onboardPath || null;
    $('onboardPaths').querySelectorAll('.path').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.path === path)));
    $('claudeSetup').hidden = path !== 'claude';
    const step = (n, done, title, sub, actions) => h('li', { class: `step ${done ? 'done' : 'todo'}` },
      h('span', { class: 'step-badge', text: done ? '✓' : n }),
      h('div', {}, h('div', { class: 'step-title', text: title }), sub ? h('div', { class: 'step-sub' }, sub) : null, !done && actions ? h('div', { class: 'row' }, actions) : null));
    const recheck = () => h('button', { class: 'btn ghost', type: 'button', onclick: recheckStatus }, 'Check again');
    const installed = !!s.installed;
    const signedIn = installed && s.loggedIn;
    $('steps').replaceChildren(
      step(1, installed, 'Install Claude Code',
        installed ? `Found v${s.version || '?'}` : ['Run ', h('code', { text: 'npm install -g @anthropic-ai/claude-code' }), ' in a terminal, or use the native installer.'],
        [h('button', { class: 'btn', type: 'button', onclick: () => api.openExternal('https://docs.claude.com/en/docs/claude-code/setup') }, 'Install guide'), recheck()]),
      step(2, signedIn && !s.warning, 'Sign in with your Claude account',
        signedIn
          ? (s.warning ? h('span', { class: 'warn', text: s.warning }) : `${s.email || 'Signed in'} · ${s.subscriptionType ? s.subscriptionType.toUpperCase() + ' plan' : 'claude.ai'}`)
          : 'Shellby uses your Claude Pro or Max plan through Claude Code. There are no API keys and nothing is billed per token.',
        installed ? [h('button', { class: 'btn primary', type: 'button', onclick: async () => { await api.claudeLogin(); SB.toast('Finish signing in, then press Check again.'); } }, 'Sign in'), recheck()] : null),
    );
    const pick = async mode => {
      if (mode === 'autonomous') return SB.toast('You can turn on Autonomous later in Settings.');
      const r = await api.setSettings({ mode });
      state.settings = r.settings;
      SB.applyMode(mode);
      SB.renderModeCards($('onboardModeCards'), pick);
    };
    SB.renderModeCards($('onboardModeCards'), pick);
    $('letsGoBtn').disabled = !(installed && signedIn);
  }
  async function recheckStatus() {
    state.status = await api.claudeStatus();
    renderOnboarding();
    SB.toast(state.status.loggedIn ? 'All set!' : state.status.installed ? 'Not signed in yet.' : 'Claude Code not found yet.');
  }
  $('letsGoBtn').addEventListener('click', async () => {
    const r = await api.setSettings({ onboarded: true, crabOnly: false });
    state.settings = r.settings;
    SB.onboardPath = null;
    SB.applyCrabOnly();
    SB.setView('chat');
  });
  $('onboardPaths').addEventListener('click', e => {
    const b = e.target.closest('.path');
    if (!b) return;
    if (b.dataset.path === 'crab') return SB.chooseCrabOnly();
    SB.onboardPath = 'claude';
    renderOnboarding();
    $('claudeSetup').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  $('crabInsteadBtn').addEventListener('click', () => SB.chooseCrabOnly());

  SB.views.onboarding = { render: renderOnboarding };
})();
