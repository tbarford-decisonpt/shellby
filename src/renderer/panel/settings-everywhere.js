/* Shellby panel — Settings: Claude Code outside Shellby. Sessions in other
   terminals, background commands they left running, the shellby command, the
   plugin and the status line. */
'use strict';
(function () {
  const { h, api, state, $ } = SB;
  const T = window.ShellbySettingsText;

  // ------------------------------------------------------------ Claude Code everywhere

  function renderExternal(v) {
    if (!v) return;
    state.external = v;
    $('externalToggle').checked = !!v.enabled;
    const said = T.externalStatus(v);
    $('externalStatus').textContent = said.text;
    $('externalStatus').className = `small ext-status ${said.tone}`;
    $('externalList').replaceChildren(...(v.enabled ? v.sessions || [] : []).map(s => h('li', { class: `ext-session ${s.state}` },
      h('span', { class: 'ext-dot', 'aria-hidden': 'true' }),
      h('b', { text: s.project }),
      h('span', { class: 'ext-state', text: T.sessionState(s) }),
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
  // Claude Code's background sessions (wiring/bg-sessions.js): main checks every
  // id against its own listing and asks before stopping or removing anything.
  function renderBgSessions(v) {
    const list = v?.sessions || [];
    $('bgsBox').hidden = !list.length;
    $('bgsList').replaceChildren(...list.map(s => {
      const act = (label, fn, cls = 'ghost') => h('button', { type: 'button', class: `btn ${cls} slim-btn`, 'aria-label': `${label}: ${s.name}`, onclick: () => fn(s) }, label);
      return h('li', { class: `bgs-item ${s.state}` },
        h('span', { class: 'ext-dot', 'aria-hidden': 'true' }),
        h('b', { text: s.name }),
        h('span', { class: 'ext-state', text: s.needs ? `${s.label}: ${s.needs}` : s.label }),
        s.startedAt ? h('time', { text: SB.relTime(s.startedAt) }) : null,
        h('span', { class: 'bgs-acts' },
          s.sessionId && !SB.isCrabOnly() ? act('Open', bgOpen, '') : null,
          act('Logs', bgLogs),
          s.running ? act('Stop', s2 => bgDo(api.bgStop, s2, 'Stopped. Its conversation is kept.')) : null,
          act('Respawn', s2 => bgDo(api.bgRespawn, s2, 'Restarted on the current Claude Code.')),
          act('Remove', s2 => bgDo(api.bgRemove, s2, 'Removed.'))));
    }));
  }
  async function bgDo(fn, s, said) {
    const r = await fn(s.id);
    if (r?.cancelled) return;
    SB.toast(r?.ok ? said : r?.error || "Claude Code didn't do it.", { ms: 5000 });
  }
  async function bgOpen(s) {
    const r = await api.bgOpen(s.id);
    if (r?.cancelled) return;
    if (r?.ok) return SB.toast('Opened in Shellby.');
    SB.toast(r?.error || "Couldn't open it.", { ms: 5000 });
  }
  async function bgLogs(s) {
    const r = await api.bgLogs(s.id);
    if (!r?.ok) return SB.toast(r?.error || 'No logs.', { ms: 5000 });
    $('bgsLogsTitle').textContent = `Logs: ${r.name}`;
    $('bgsLogsText').textContent = r.text.trim() || 'Nothing yet.';
    $('bgsLogs').hidden = false;
  }
  $('bgsLogsClose').addEventListener('click', () => { $('bgsLogs').hidden = true; });
  $('bgsRefresh').addEventListener('click', async () => renderBgSessions(await api.bgSessions()));
  api.onBgSessions(renderBgSessions);
  api.bgSessions().then(renderBgSessions).catch(() => {});

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
    const said = T.cliStatus(v);
    $('cliStatus').textContent = said.text;
    $('cliStatus').className = `small ext-status ${said.tone}`;
  }
  $('cliBtn').addEventListener('click', async () => {
    const before = await api.getCli();
    $('cliBtn').disabled = true;
    const r = before.installed ? await api.removeCli() : await api.installCli();
    renderCli(r);
    if (r.ok === false) SB.toast(r.error || "That didn't work.");
    else if (!before.installed) SB.toast('Added. Open a new terminal for it to show up.');
  });

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
    const old = v.outdated
      ? `Installed, but it's version ${v.outdated.from} and this Shellby needs ${v.outdated.to}. Until it's updated, Claude and your mods can't make him react.`
      : '';
    state.pluginOutdated = !!v.outdated;
    $('pluginText').textContent = v.error || old || text;
    $('pluginBtn').hidden = (v.state === 'on' && !v.outdated) || v.state === 'off';
    $('pluginBtn').disabled = false;
    $('pluginBtn').textContent = v.outdated ? 'Update the plugin' : 'Install the plugin';
  }
  $('pluginBtn').addEventListener('click', async () => {
    const isUpdate = state.pluginOutdated;
    $('pluginBtn').disabled = true;
    $('pluginBtn').textContent = isUpdate ? 'Updating…' : 'Installing…';
    const v = await (isUpdate ? api.updatePlugin() : api.installPlugin());
    renderPlugin(v);
    if (v.installed) SB.toast('Plugin installed. Start a new Claude Code session and Shellby will follow along.', { ms: 5000 });
    if (v.updated) SB.toast('Plugin updated. Restart any Claude Code sessions that are open to pick it up.', { ms: 5000 });
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

  SB.onSettingsOpen(() => {
    api.getExternal().then(renderExternal);
    api.getStatusLine().then(renderStatusLine);
    api.getPlugin().then(renderPlugin);
    api.getCli().then(renderCli);
  });
})();
