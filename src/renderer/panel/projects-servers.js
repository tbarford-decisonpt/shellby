/* Shellby panel — Projects: the dev servers in a clone. Each script's row or
   its running server's card, the log, and the approval sheet that is the only
   way a crashed server's error goes to Claude. projects.js draws the rest. */
'use strict';
(function () {
  const { h, api, state } = SB;
  const L = window.ShellbyProjectsLogic;
  const P = SB.pj;
  const { isLive } = L;
  const { keptDetails, serversIn } = P;
  const renderAll = () => P.renderAll();
  const statusText = s => L.statusText(s, SB.relTime);

  const openCards = new Set(); // server ids whose log is open
  const logs = new Map();     // id -> { lines, errors }
  const notes = new Map();    // id -> what you typed for Claude
  const drafts = new Map();   // id -> the prompt as main built it
  const modeTitle = () => SB.MODES.find(m => m.id === state.settings.mode)?.title || 'your current mode';

  // ------------------------------------------------------------------ servers in a clone

  function serversSection(c) {
    const running = serversIn(c.root);
    const install = running.find(s => s.kind === 'install');
    const box = h('div', { class: 'pj-servers' }, h('p', { class: 'row-label', text: 'Servers' }));
    if (!c.scripts.length) {
      box.append(h('p', { class: 'muted small', text: c.manager === null ? 'No package.json here, so nothing to run yet.' : 'No scripts in package.json.' }));
      return box;
    }
    if (install) box.append(serverCard(install, c));
    else if (c.installed === false) {
      box.append(h('div', { class: 'pj-install' },
        h('span', { class: 'small', text: `Install dependencies first (${c.manager} install).` }),
        h('button', { type: 'button', class: 'btn slim-btn', text: 'Install', onclick: () => doInstall(c) })));
    }
    const likely = c.scripts.filter(s => s.likely);
    const rest = c.scripts.filter(s => !s.likely);
    const rowsFor = list => list.map(sc => {
      const s = running.find(x => x.kind === 'server' && x.script === sc.name);
      return s ? serverCard(s, c) : scriptRow(sc, c);
    });
    box.append(h('ul', { class: 'pj-scripts' }, rowsFor(likely.length ? likely : rest.slice(0, 3))));
    const more = likely.length ? rest : rest.slice(3);
    if (more.length) box.append(keptDetails(`scripts:${c.root}`, `More scripts (${more.length})`, h('ul', { class: 'pj-scripts' }, rowsFor(more))));
    return box;
  }

  function scriptRow(sc, c) {
    return h('li', { class: 'pj-script' },
      h('span', { class: 'pj-dot off', 'aria-hidden': 'true' }),
      h('span', { class: 'pj-script-name' }, h('code', { text: `${c.manager} run ${sc.name}` }), sc.framework && h('span', { class: 'pj-tag', text: sc.framework })),
      h('button', { type: 'button', class: `btn slim-btn${sc.name === c.lastScript ? ' primary' : ''}`, text: 'Start', onclick: e => startScript(e.target, c, sc.name) }));
  }

  async function startScript(btn, c, script) {
    btn.disabled = true;
    const r = await api.startServer({ root: c.root, script });
    btn.disabled = false;
    if (!r?.ok) return SB.toast(r?.error || "Couldn't start it.");
    await P.reloadServers();
  }

  async function doInstall(c) {
    const r = await api.installProject(c.root);
    if (!r?.ok) return SB.toast(r?.error || "Couldn't start the install.");
    await P.reloadServers();
  }

  function serverCard(s, c) {
    const crashed = s.status === 'crashed' || s.status === 'failed';
    const fixed = crashed && s.fixedAt > 0; // a boolean: h() would draw a bare 0
    const open = openCards.has(s.id) || crashed;
    const name = s.kind === 'install' ? `${c.manager} install` : `${s.manager} run ${s.script}`;
    const act = (text, fn, cls = 'btn ghost slim-btn') => h('button', { type: 'button', class: cls, text, onclick: fn });
    const buttons = [
      fixed && act('Restart', () => serverAction('restartServer', s.id), 'btn primary slim-btn'),
      s.status === 'up' && s.url && act('Open', () => api.openServer(s.id), 'btn slim-btn'),
      isLive(s) && s.kind === 'server' && act('Restart', () => serverAction('restartServer', s.id)),
      isLive(s) && act('Stop', () => serverAction('stopServer', s.id)),
      crashed && !fixed && s.kind === 'server' && act('Restart', () => serverAction('restartServer', s.id)),
      crashed && act('Dismiss', () => serverAction('dismissServer', s.id)),
      act(open ? 'Hide log' : 'Log', () => toggleLog(s.id)),
    ].filter(Boolean);
    const card = h('li', { class: `pj-card ${s.status}`, id: `srv-card-${s.id}` },
      h('div', { class: 'pj-card-head' },
        h('span', { class: `pj-dot ${s.status}`, 'aria-hidden': 'true' }),
        h('span', { class: 'pj-script-name' }, h('code', { text: name }), s.framework && h('span', { class: 'pj-tag', text: s.framework })),
        h('span', { class: 'pj-status', role: 'status', text: statusText(s) })),
      fixed && h('p', { class: 'pj-fixed', text: "Claude's done. Restart the server?" }),
      h('div', { class: 'row wrap pj-card-actions' }, buttons),
      open && logBox(s),
      crashed && !fixed && s.canFix && approvalSheet(s));
    if (crashed && !s.seen) api.serverSeen(s.id);
    return card;
  }

  async function serverAction(method, id) {
    const r = await api[method](id);
    if (r && r.ok === false && r.error) SB.toast(r.error);
    if (method !== 'stopServer') openCards.delete(id);
    logs.delete(id);
    drafts.delete(id);
    await P.reloadServers();
  }

  function toggleLog(id) {
    if (openCards.has(id)) openCards.delete(id); else openCards.add(id);
    renderAll();
  }

  // The log, redacted by main. Error lines are marked so the cause stands out.
  function logBox(s) {
    const box = h('div', { class: 'pj-log-wrap' });
    const draw = l => {
      const errors = new Set(l.errors);
      const pre = h('pre', { class: 'pj-log', tabindex: '0', 'aria-label': `Output of ${s.script || 'the install'}` },
        l.lines.length ? l.lines.map((line, i) => h('span', { class: errors.has(i) ? 'err' : null, text: `${line}\n` })) : h('span', { class: 'muted', text: 'Nothing printed yet.' }));
      box.replaceChildren(pre, h('button', { type: 'button', class: 'link-btn small', text: 'Open the log file', onclick: () => api.openServerLog(s.id) }));
      pre.scrollTop = pre.scrollHeight;
    };
    if (logs.has(s.id) && !isLive(s)) draw(logs.get(s.id));
    else api.serverLog(s.id).then(l => { if (l) { logs.set(s.id, l); draw(l); } });
    return box;
  }

  // ------------------------------------------------------------------ the approval sheet

  function approvalSheet(s) {
    const prompt = h('pre', { class: 'pj-prompt', tabindex: '0', 'aria-label': 'What will be sent to Claude' });
    const note = h('textarea', { class: 'field pj-note', rows: '2', maxlength: '500', placeholder: 'Anything to add? (optional)', 'aria-label': 'A note for Claude' });
    note.value = notes.get(s.id) || '';
    let t = null;
    let seq = 0;
    // Send is only ever for the draft on screen: off while it's being fetched,
    // and it carries that draft's hash so main sends exactly this text or nothing.
    let shown = null; // { hash, note }
    const refresh = async () => {
      const mine = ++seq;
      send.disabled = true;
      const d = await api.serverFixDraft({ id: s.id, note: note.value });
      if (mine !== seq) return;
      if (!d) { prompt.textContent = 'This server is running again.'; return; }
      drafts.set(s.id, d.prompt);
      prompt.textContent = d.prompt;
      shown = { hash: d.hash, note: note.value };
      send.disabled = false;
    };
    note.addEventListener('input', () => { notes.set(s.id, note.value); send.disabled = true; clearTimeout(t); t = setTimeout(refresh, 250); });
    // Enter in the note is a new line, never "send".
    const send = h('button', { type: 'button', class: 'btn primary slim-btn', text: 'Send to Claude', disabled: true, onclick: () => shown && sendFix(s, shown, send, refresh) });
    if (drafts.has(s.id)) prompt.textContent = drafts.get(s.id); else prompt.textContent = 'Getting the error…';
    refresh();
    return h('section', { class: 'pj-approve', 'aria-label': 'Ask Claude to fix it' },
      h('p', { class: 'pj-approve-title', text: 'Ask Claude to fix it?' }),
      h('p', { class: 'muted small', text: 'This is exactly what will be sent: the last lines it printed (secrets blanked out) and what to do with them.' }),
      prompt,
      note,
      h('p', { class: 'muted small pj-where' },
        `Claude will work in ${SB.shortPath(s.root, 40)}, in ${modeTitle()} mode. `,
        h('button', { type: 'button', class: 'link-btn', text: 'Change the mode', onclick: () => { SB.setView('settings'); } })),
      h('div', { class: 'row wrap' },
        send,
        h('button', { type: 'button', class: 'btn ghost slim-btn', text: 'Not now', onclick: () => { openCards.delete(s.id); renderAll(); } })));
  }

  async function sendFix(s, shown, btn, refresh) {
    btn.disabled = true;
    const r = await api.sendServerFix({ id: s.id, note: shown.note, hash: shown.hash });
    if (!r?.ok) {
      SB.toast(r?.error || "Couldn't open a conversation.");
      // Changed since you read it: show the new text and let you look again.
      if (r?.stale) refresh(); else btn.disabled = false;
      return;
    }
    notes.delete(s.id);
    drafts.delete(s.id);
    // The tab opened itself (boot.js onTabOpened); go and watch it work.
    SB.setView('chat');
    if (state.tabs.has(r.tabId)) SB.activate(r.tabId);
  }

  Object.assign(P, {
    serversSection,
    openCard: id => openCards.add(id),
    forgetLog: id => logs.delete(id),
  });
})();
