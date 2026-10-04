/* Shellby panel — "Run it when my limit resets": heavy tasks queued on the
   Routines page for a fresh 5-hour window. Main holds, runs and reports them
   (src/main/held.js tasks, main.js releaseTask); the queue itself arrives
   with the outlook (outlook.js). */
'use strict';
(function () {
  const { h, api, state, $ } = SB;
  const form = $('resetQueueForm');
  const text = $('resetQueueText');
  const MODE_NAME = { ask: 'Ask first', smart: 'Smart', acceptEdits: 'Auto-edit', plan: 'Plan only', autonomous: 'Autonomous' };
  let folder = null; // null: the current folder, whatever that is when you press Queue it
  let phone = null;  // channels:get, for the line about where results go
  let adding = false;

  const tasks = () => (state.outlook?.held || []).filter(x => x.kind === 'task');
  const folderNow = () => folder || state.cwd;

  function note(msg, { err = false, action = null } = {}) {
    const p = $('resetQueueNote');
    p.classList.toggle('err', err);
    p.replaceChildren(...[msg, action ? ' ' : null, action].filter(Boolean));
  }

  // ------------------------------------------------------------ the list

  function when(t, i) {
    if (t.running) return h('span', { class: 'r-pill running' }, 'running now');
    if (t.resuming) return h('span', { class: 'r-pill warn', title: 'It ran out of usage partway (or Shellby closed), and carries on in its conversation.' }, `carries on · ${t.atText}`);
    return h('span', { class: 'r-pill' }, i === 0 ? t.atText : `then · #${i + 1}`);
  }

  function row(t, i) {
    const meta = [t.folder, MODE_NAME[t.mode] || 'Default mode'].filter(Boolean).join(' · ');
    return h('li', { class: `rq-item${t.running ? ' running' : ''}` },
      h('span', { class: 'rq-num', 'aria-hidden': 'true', text: String(i + 1) }),
      h('div', { class: 'rq-main' },
        h('div', { class: 'rq-name' },
          t.running || t.resuming
            ? h('span', { class: 'rq-title', title: t.prompt, text: t.name })
            : h('button', { class: 'rq-title', type: 'button', title: 'Edit (takes it out of the queue and back into the box)', onclick: () => edit(t) }, t.name),
          when(t, i)),
        h('div', { class: 'rq-meta', text: meta, title: t.cwd || '' })),
      h('div', { class: 'rq-actions' },
        t.tabId ? h('button', { class: 'btn ghost slim-btn', type: 'button', onclick: () => openTab(t) }, 'Open') : null,
        h('button', { class: 'icon-btn danger-hover', type: 'button',
          title: t.running ? 'Stop it and take it out of the queue' : 'Take it out of the queue',
          'aria-label': `${t.running ? 'Stop' : 'Remove'} ${t.name}`, onclick: () => cancel(t) },
          SB.icon('M4.5 4.5l7 7M11.5 4.5l-7 7', { width: 1.5 }))));
  }

  function openTab(t) {
    if (!state.tabs.has(t.tabId)) return SB.toast('Its conversation is in History.');
    SB.setView('chat');
    SB.activate(t.tabId);
  }

  async function cancel(t) {
    const r = await api.cancelHeld(t.id);
    if (r.ok) SB.toast(t.running ? `Stopped "${t.name}". Its conversation stays open.` : `"${t.name}" won't run after the reset.`);
  }

  // Back into the box to change, out of the queue until it's queued again.
  async function edit(t) {
    if (text.value.trim()) return SB.toast('Queue or clear what\'s in the box first.');
    const r = await api.cancelHeld(t.id);
    if (!r.ok) return;
    text.value = r.item.prompt;
    folder = r.item.cwd || null;
    $('resetQueueMode').value = r.item.mode || 'smart';
    renderFolder();
    text.focus();
    note('Out of the queue while you edit it. Press Queue it to put it back (at the end).');
  }

  // ------------------------------------------------------------ the rest

  function renderFolder() {
    const b = $('resetQueueFolder');
    b.textContent = `📁 ${SB.tildify(folderNow()) || 'Current folder'}`;
    b.title = `Runs in ${folderNow() || 'the current folder'}. Click to change.`;
  }

  function renderWhen() {
    const o = state.outlook;
    $('resetQueueWhen').textContent = o?.limit ? `at your limit · resets ${o.limit.at}`
      : o?.resetAt ? `next reset ${o.resetText}` : '';
  }

  // Where results go: your phone, if it's set up and wants these.
  function renderPhone() {
    const p = $('resetQueuePhone');
    const go = (label, fn) => h('button', { class: 'link-btn inline', type: 'button', onclick: fn }, label);
    if (!phone) return p.replaceChildren();
    if (!phone.enabled || phone.problem) {
      return p.replaceChildren('Results land in their tabs and a notification. ', go('Send them to your phone', () => {
        SB.setView('settings');
        SB.showSettingsTab('connect');
        $('channelsGroup').scrollIntoView({ behavior: 'smooth', block: 'start' });
      }));
    }
    if (!phone.events?.queue) {
      return p.replaceChildren('Your phone isn\'t told about these. ', go('Tell it', async () => {
        phone = await api.setChannels({ events: { ...phone.events, queue: true } });
        renderPhone();
      }));
    }
    p.replaceChildren('🌙 Each result goes to your phone, and you can open its tab in the morning.');
  }

  function render() {
    const list = tasks();
    $('resetQueue').hidden = !!SB.isCrabOnly?.();
    $('resetQueueList').replaceChildren(...list.map(row));
    $('resetQueueAwake').checked = state.outlook?.keepAwake !== false;
    // Nothing waiting: nothing to keep the PC awake for, and no results to send anywhere.
    $('resetQueue').querySelector('.rq-foot').hidden = !list.length;
    renderWhen();
    renderFolder();
    renderPhone();
  }
  SB.renderResetQueue = () => {
    render();
    api.getChannels().then(v => { phone = v; renderPhone(); }).catch(() => {});
  };

  form.addEventListener('submit', async e => {
    e.preventDefault();
    if (adding) return;
    const prompt = text.value.trim();
    if (!prompt) { note('Say what Shellby should do.', { err: true }); text.focus(); return; }
    adding = true;
    $('resetQueueAdd').disabled = true;
    try {
      const r = await api.holdForReset({ kind: 'task', prompt, cwd: folderNow(), mode: $('resetQueueMode').value });
      if (r.cancelled) return note('');
      if (!r.ok) {
        // No window running: there's nothing to wait for, so offer the chat box instead.
        const action = r.idle ? h('button', { class: 'link-btn inline', type: 'button', onclick: () => {
          SB.setView('chat');
          $('input').value = prompt;
          $('input').dispatchEvent(new Event('input'));
          $('input').focus();
        } }, 'Put it in the chat box') : null;
        return note(r.error, { err: true, action });
      }
      text.value = '';
      const n = tasks().length + (r.added ? 1 : 0);
      note(n > 1 ? `Queued as #${n}. The queue starts at ${r.atText}.` : `Queued. It starts at ${r.atText}, once your usage resets.`);
    } finally {
      adding = false;
      $('resetQueueAdd').disabled = false;
    }
  });

  // Ctrl+Enter queues it, like sending.
  text.addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.ctrlKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); }
  });

  $('resetQueueFolder').addEventListener('click', async () => {
    const dir = await api.pickAnyFolder();
    if (dir) { folder = dir; renderFolder(); }
  });

  $('resetQueueMode').addEventListener('change', e => {
    if (e.target.value === 'autonomous') note('Autonomous acts without asking. Shellby checks with you once more when you queue it.');
    else note('');
  });

  $('resetQueueAwake').addEventListener('change', async e => {
    await api.setQueueKeepAwake(e.target.checked);
    SB.toast(e.target.checked ? 'The PC stays awake while tasks wait or run.' : 'The PC may sleep. Queued tasks then run when it wakes.');
  });

  note('');
})();
