/* Shellby panel — Settings: Other computers. Claude Code on a server or a PC
   that stays on, over ssh: adding one, the steps to get it working (each
   with its button), its folders, and the box ssh asks for a passphrase in.
   remote-logic.js decides what each step says. */
'use strict';
(function () {
  const { h, api, $ } = SB;
  const L = window.ShellbyRemoteLogic;

  let view = null;
  let browsing = null;          // { alias, dir, here, folders, error, loading }
  const working = new Map();    // alias -> what's running ("Installing…")
  const removing = new Set();   // aliases whose Remove was pressed once

  async function refresh() {
    view = await api.remoteView().catch(() => null);
    render();
  }

  // ---------------------------------------------------------------- actions

  // Runs one step's action for a computer, then shows how it went.
  async function act(alias, action) {
    if (working.has(alias)) return;
    const say = {
      check: 'Connecting…',
      install: "Installing Claude Code there. It takes a minute or two…",
      'setup-key': 'Setting up a key: ssh asks for your password once…',
      'agent-on': 'Windows asks for permission…',
      unlock: 'Unlocking…',
      'sign-in': 'Opening a terminal there…',
    }[action.id] || 'Working…';
    working.set(alias, say);
    render();
    let r = null;
    try {
      if (action.id === 'check') r = await api.remoteCheck(alias);
      else if (action.id === 'install') r = await api.remoteInstall(alias);
      else if (action.id === 'setup-key') r = await api.remoteSetupKey(alias);
      else if (action.id === 'agent-on') r = await api.remoteAgentOn();
      else if (action.id === 'unlock') r = await api.remoteUnlock(action.key);
      else if (action.id === 'sign-in') r = await api.remoteSignIn(alias);
    } finally {
      working.delete(alias);
    }
    if (r && !r.ok && r.error) SB.toast(r.error, { ms: 6000 });
    else if (action.id === 'sign-in' && r?.ok) SB.toast("Sign in in the terminal that opened, then press Check again here.", { ms: 7000 });
    else if (action.id === 'setup-key' && r?.ok) SB.toast(`${r.created ? 'Made a key and put' : 'Put your key'} on ${alias}: no more password.`, { ms: 6000 });
    else if (action.id === 'agent-on' && r?.ok) SB.toast("Windows' ssh agent is on. Unlock your key once and ssh stops asking.", { ms: 6000 });
    else if (action.id === 'unlock' && r?.ok) SB.toast(`${action.key} is unlocked, and stays that way.`);
    // Fixing sign-in: straight on to seeing whether it worked.
    if ((action.id === 'agent-on' || action.id === 'unlock') && r?.ok && alias) return act(alias, { id: 'check' });
    refresh();
  }

  async function removeComputer(alias) {
    if (!removing.has(alias)) { removing.add(alias); render(); return; }
    removing.delete(alias);
    const r = await api.remoteRemove(alias);
    if (!r?.ok) SB.toast(r?.error || "Couldn't remove it.");
    refresh();
  }

  async function workHere(anchor) {
    const r = await api.remoteWorkHere(anchor);
    await SB.folderChanged(r);
  }

  async function removeFolder(anchor) {
    const r = await api.remoteRemoveFolder(anchor);
    if (!r?.ok) SB.toast(r?.error || "Couldn't remove it.");
    refresh();
  }

  // ---------------------------------------------------------------- the folder browser

  async function browse(alias, dir) {
    browsing = { alias, dir, here: null, folders: [], error: null, loading: true };
    render();
    const r = await api.remoteBrowse(alias, dir);
    if (browsing?.alias !== alias) return;
    browsing = r?.ok ? { alias, dir: r.dir, here: r.here, folders: r.folders, error: null, loading: false } : { ...browsing, error: r?.error || "Couldn't look there.", loading: false };
    render();
  }

  async function addFolder(alias, dir) {
    browsing = { ...browsing, loading: true };
    render();
    const r = await api.remoteAddFolder(alias, dir);
    if (!r?.ok) { browsing = { ...browsing, loading: false, error: r?.error || "Couldn't add it." }; render(); return; }
    browsing = null;
    await refresh();
    SB.toast(`Added ${r.label}`, { action: 'Work there', onAction: () => workHere(r.anchor), ms: 8000 });
  }

  function browser(alias) {
    const b = browsing;
    const input = h('input', { type: 'text', class: 'field', value: b.dir, spellcheck: 'false', autocomplete: 'off', 'aria-label': `A folder on ${alias}` });
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); browse(alias, input.value.trim() || '~'); } });
    const up = L.parentDir(b.dir);
    const rows = [
      up ? h('li', {}, h('button', { type: 'button', class: 'link-btn', text: '.. (up one)', onclick: () => browse(alias, up) })) : null,
      ...b.folders.map(f => h('li', {},
        h('button', { type: 'button', class: 'link-btn', text: `${f.name}/`, onclick: () => browse(alias, L.joinDir(b.dir, f.name)) }),
        f.git ? h('span', { class: 'pj-tag', text: 'git' }) : null)),
    ];
    return h('div', { class: 'rc-browse' },
      h('div', { class: 'row wrap' }, input, h('button', { type: 'button', class: 'btn ghost slim-btn', text: 'Go', onclick: () => browse(alias, input.value.trim() || '~') })),
      b.loading ? h('p', { class: 'small muted', text: 'Looking…' }) : null,
      b.error ? h('p', { class: 'small warn', role: 'alert', text: b.error }) : null,
      !b.loading && !b.error ? h('ul', { class: 'rc-dirs' }, ...rows) : null,
      h('div', { class: 'row wrap end' },
        h('button', { type: 'button', class: 'btn ghost slim-btn', text: 'Cancel', onclick: () => { browsing = null; render(); } }),
        h('button', { type: 'button', class: 'btn primary slim-btn', text: 'Work in this folder', disabled: b.loading || !!b.error, onclick: () => addFolder(alias, b.dir) })));
  }

  // ---------------------------------------------------------------- drawing

  const MARK = { ok: '✓', todo: '○', bad: '!', busy: '…' };

  function card(c) {
    const busy = working.get(c.alias);
    const stepRows = L.steps({ ...c, busy: c.busy || !!busy }, { agent: view.agent, keys: view.keys }).map(s => h('li', { class: `rc-step ${s.state}` },
      h('span', { class: 'rc-mark', 'aria-hidden': 'true', text: MARK[s.state] || '' }),
      h('span', { class: 'rc-text', text: s.state === 'busy' && busy ? busy : s.text }),
      ...s.actions.map(a => h('button', { type: 'button', class: `btn slim-btn${a.id === 'check' ? ' ghost' : ''}`, text: a.label, disabled: !!busy, onclick: () => act(c.alias, a) }))));
    const ready = L.ready(c);
    const folders = ready || c.folders.length ? h('div', { class: 'rc-folders' },
      h('p', { class: 'field-label', text: 'Folders there' }),
      c.folders.length ? h('ul', { class: 'rc-folder-list' }, ...c.folders.map(f => h('li', {},
        h('code', { class: 'path', text: f.dir }),
        h('button', { type: 'button', class: 'btn slim-btn', text: 'Work here', onclick: () => workHere(f.anchor) }),
        h('button', { type: 'button', class: 'btn ghost slim-btn', text: 'Remove', 'aria-label': `Remove ${f.dir}`, onclick: () => removeFolder(f.anchor) })))) : null,
      browsing?.alias === c.alias ? browser(c.alias)
        : ready ? h('button', { type: 'button', class: 'btn ghost slim-btn', text: 'Add a folder there…', onclick: () => browse(c.alias, '~') }) : null) : null;
    const where = L.whereLine(c.where);
    return h('div', { class: 'sl-card rc-card' },
      h('div', { class: 'sl-head' },
        h('span', {}, h('b', { text: c.alias }), where && where !== c.alias ? h('span', { class: 'small muted', text: `  ${where}` }) : null),
        h('button', { type: 'button', class: 'btn ghost slim-btn', text: removing.has(c.alias) ? 'Remove it?' : 'Remove', onclick: () => removeComputer(c.alias) })),
      h('ul', { class: 'rc-steps' }, ...stepRows),
      folders);
  }

  function render() {
    if (!view) return;
    $('rcNoSsh').hidden = view.sshFound !== false;
    $('rcList').replaceChildren(...view.computers.map(card));
    const pick = $('rcPick');
    pick.replaceChildren(...(view.available.length
      ? view.available.map(a => h('option', { value: a.alias, text: a.jump ? `${a.alias} (through ${a.jump})` : a.alias }))
      : [h('option', { value: '', text: 'No other computers in your ssh settings' })]));
    pick.disabled = $('rcAdd').disabled = !view.available.length;
    const jump = $('rcJump');
    const chosen = jump.value;
    jump.replaceChildren(h('option', { value: '', text: 'Nothing: reach it directly' }), ...view.jumps.map(a => h('option', { value: a, text: a })));
    jump.value = view.jumps.includes(chosen) ? chosen : '';
    const ag = L.agentLine(view.agent, view.keys);
    $('rcAgent').hidden = !view.keys.length && !view.computers.length;
    $('rcAgentText').textContent = ag.text;
    $('rcAgentBtn').hidden = !ag.action;
    if (ag.action) {
      $('rcAgentBtn').textContent = ag.action.label;
      $('rcAgentBtn').onclick = () => act(null, ag.action);
    }
    SB.remoteChanged?.(view); // first run's remote path (onboarding.js)
  }

  // First run borrows this section: it fills it, and reads what's ready.
  SB.remoteRefresh = refresh;
  SB.remoteNow = () => view;

  // ---------------------------------------------------------------- adding one

  $('rcAdd').addEventListener('click', async () => {
    const alias = $('rcPick').value;
    if (!alias) return;
    const r = await api.remoteAdd(alias);
    if (!r?.ok) return SB.toast(r?.error || "Couldn't add it.");
    await refresh();
    act(r.alias, { id: 'check' });
  });

  $('rcNew').addEventListener('click', () => {
    $('rcForm').hidden = false;
    $('rcAddRow').hidden = true;
    $('rcFormError').hidden = true;
    $('rcAlias').focus();
  });
  const closeForm = () => { $('rcForm').hidden = true; $('rcAddRow').hidden = false; $('rcForm').reset(); };
  $('rcFormCancel').addEventListener('click', closeForm);
  $('rcForm').addEventListener('submit', async e => {
    e.preventDefault();
    const form = { alias: $('rcAlias').value.trim(), address: $('rcAddress').value.trim(), user: $('rcUser').value.trim(), port: $('rcPort').value.trim(), jump: $('rcJump').value };
    const problem = L.formProblem(form);
    const err = $('rcFormError');
    if (problem) { err.textContent = problem; err.hidden = false; return; }
    const r = await api.remoteCreate(form);
    if (!r?.ok) { err.textContent = r?.error || "Couldn't add it."; err.hidden = false; return; }
    closeForm();
    await refresh();
    act(r.alias, { id: 'check' });
  });

  // ---------------------------------------------------------------- ssh asking

  const queue = [];
  let asking = null;

  function showNext() {
    if (asking || !queue.length) return;
    asking = queue.shift();
    const t = L.askText(asking);
    $('rcAskTitle').textContent = t.title;
    $('rcAskLede').textContent = t.lede;
    $('rcAskOk').textContent = t.button;
    const input = $('rcAskInput');
    input.hidden = !!t.confirm;
    input.type = t.secret ? 'password' : 'text';
    input.value = '';
    $('rcAskSheet').hidden = false;
    (t.confirm ? $('rcAskOk') : input).focus();
  }

  function finish(answer) {
    if (!asking) return;
    const { id } = asking;
    asking = null;
    $('rcAskInput').value = '';
    $('rcAskSheet').hidden = true;
    api.remoteAnswer(id, answer);
    showNext();
  }

  api.onRemoteAsk(q => { queue.push(q); showNext(); });
  // It stopped waiting (ssh gave up, or five minutes went by).
  api.onRemoteAsked(({ id }) => {
    const i = queue.findIndex(q => q.id === id);
    if (i >= 0) queue.splice(i, 1);
    if (asking?.id === id) { asking = null; $('rcAskSheet').hidden = true; $('rcAskInput').value = ''; showNext(); }
  });
  $('rcAskForm').addEventListener('submit', e => {
    e.preventDefault();
    finish(L.askText(asking).confirm ? 'yes' : $('rcAskInput').value);
  });
  $('rcAskCancel').addEventListener('click', () => finish(null));
  $('rcAskSheet').addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); finish(null); } });

  SB.onSettingsOpen(refresh);
})();
