/* Shellby panel — chat, history, settings, onboarding. */
const api = window.shellby;
const md = window.ShellbyMarkdown;
const Sprite = window.ShellbySprite;

const $ = id => document.getElementById(id);
const els = {
  feed: $('feed'), empty: $('empty'), input: $('input'), form: $('form'), sendBtn: $('sendBtn'),
  status: $('status'), statusText: $('statusText'), attachments: $('attachments'),
  modeChip: $('modeChip'), modeLabel: $('modeLabel'), modeMenu: $('modeMenu'), modeHint: $('modeHint'),
  folderChip: $('folderChip'), folderLabel: $('folderLabel'), folderMenu: $('folderMenu'),
  usage: $('usage'), meter5h: $('meter5h'), meter7d: $('meter7d'), toast: $('toast'),
};

const MODES = [
  { id: 'ask', chip: 'Ask', title: 'Ask first', sub: 'Reads freely. Asks before editing files or running commands.', tag: 'Recommended' },
  { id: 'smart', chip: 'Smart', title: 'Smart', sub: "Claude Code's auto mode: a safety check approves routine steps and stops risky ones." },
  { id: 'acceptEdits', chip: 'Auto-edit', title: 'Auto-edit', sub: 'Edits files on its own. Still asks before running commands.' },
  { id: 'plan', chip: 'Plan', title: 'Plan only', sub: 'Looks around and proposes a plan. Nothing changes until you approve it.' },
  { id: 'autonomous', chip: 'Autonomous', title: 'Autonomous', sub: 'Never asks. Can change or delete anything your Windows account can.', tag: 'Risky', danger: true },
];
const MODE_HINTS = {
  ask: 'I\'ll ask before changing anything',
  smart: 'Auto mode: a safety check approves routine steps',
  acceptEdits: 'I edit files freely, ask before commands',
  plan: 'Plan only: I won\'t change anything',
  autonomous: '⚠ Autonomous: I won\'t ask before acting',
};
const SUGGESTIONS = [
  'Tidy my Downloads folder into subfolders by file type',
  "What's eating the most disk space on C:?",
  'Find every file I changed today and list them',
  'Summarize the documents on my Desktop',
  'Check my PC for leftover installers I can delete',
  'Make a folder of this week\'s screenshots',
];

const state = {
  settings: {}, status: {}, skins: [], skin: null, sessions: [], cwd: '', home: '',
  busy: false, attachments: [], view: 'chat', currentHistoryId: null,
  tools: new Map(), asks: new Map(), version: '', packaged: false,
};

// ------------------------------------------------------------------ helpers

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}

function tildify(p) {
  if (!p) return '~';
  return state.home && p.toLowerCase().startsWith(state.home.toLowerCase()) ? '~' + p.slice(state.home.length) : p;
}
// Keep the end of long paths visible: C:\…\projects\shellby
function shortPath(p, max = 34) {
  const t = tildify(p);
  if (t.length <= max) return t;
  const sep = '\\';
  const parts = t.split(/[\\/]/).filter(Boolean);
  const head = parts.shift();
  let tail = parts.pop();
  while (parts.length && parts[parts.length - 1].length + tail.length + head.length + 4 <= max) tail = parts.pop() + sep + tail;
  return [head, '…', tail].join(sep);
}
function basename(p) { return String(p).split(/[\\/]/).filter(Boolean).pop() || p; }
function relTime(t) {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 604800) return `${Math.floor(s / 86400)}d ago`;
  return new Date(t).toLocaleDateString();
}
function prettyAccel(a) { return String(a || '').replace(/Control/g, 'Ctrl').replace(/\+/g, ' + '); }

let toastTimer;
function toast(msg) {
  els.toast.textContent = msg;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, 2600);
}

function sprite(skin = state.skin) { return skin ? Sprite.build(skin) : document.createElement('span'); }

function renderCrabs() {
  for (const id of ['brandCrab', 'emptyCrab', 'helloCrab']) $(id).replaceChildren(sprite());
}

// ------------------------------------------------------------------ views

function setView(view) {
  state.view = view;
  document.body.dataset.view = view;
  $('historyBtn').classList.toggle('active', view === 'history');
  $('settingsBtn').classList.toggle('active', view === 'settings');
  closeMenus();
  if (view === 'history') renderHistory();
  if (view === 'settings') renderSettings();
  if (view === 'onboarding') renderOnboarding();
  if (view === 'chat') setTimeout(() => els.input.focus(), 30);
}
document.querySelectorAll('[data-back]').forEach(b => b.addEventListener('click', () => setView('chat')));
$('historyBtn').addEventListener('click', () => setView(state.view === 'history' ? 'chat' : 'history'));
$('settingsBtn').addEventListener('click', () => setView(state.view === 'settings' ? 'chat' : 'settings'));
$('closeBtn').addEventListener('click', () => api.hide());
$('minBtn').addEventListener('click', () => api.minimize());
$('newBtn').addEventListener('click', newConversation);

async function newConversation() {
  if (state.busy) return toast('Stop the current task first.');
  await api.newSession();
  resetFeed();
  setView('chat');
}

// ------------------------------------------------------------------ mode + folder chips

function applyMode(mode) {
  document.body.dataset.mode = mode;
  const m = MODES.find(x => x.id === mode) || MODES[0];
  els.modeLabel.textContent = m.chip;
  els.modeHint.textContent = MODE_HINTS[mode] || '';
  els.modeHint.classList.toggle('danger', mode === 'autonomous');
}

async function chooseMode(mode) {
  if (mode === 'autonomous' && !state.settings.autonomousAcknowledged) {
    setView('settings');
    $('autonomousConfirm').hidden = false;
    $('autonomousConfirm').scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }
  const r = await api.setSettings({ mode });
  state.settings = r.settings;
  applyMode(state.settings.mode);
  if (state.view === 'settings') renderModeCards($('modeCards'));
  toast(`Mode: ${MODES.find(x => x.id === state.settings.mode).title}`);
}

function openMenu(menu, anchor, build) {
  const wasOpen = !menu.hidden;
  closeMenus();
  if (wasOpen) return;
  menu.replaceChildren(...build());
  menu.hidden = false;
  const r = anchor.getBoundingClientRect();
  menu.style.top = `${r.bottom + 6}px`;
  menu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8))}px`;
  anchor.setAttribute('aria-expanded', 'true');
  menu.querySelector('button')?.focus();
}
function closeMenus() {
  for (const m of [els.modeMenu, els.folderMenu]) m.hidden = true;
  els.modeChip.setAttribute('aria-expanded', 'false');
  els.folderChip.setAttribute('aria-expanded', 'false');
}
document.addEventListener('mousedown', e => {
  if (!e.target.closest('.popover, .mode-chip, .folder-chip')) closeMenus();
});

els.modeChip.addEventListener('click', () => openMenu(els.modeMenu, els.modeChip, () => MODES.map(m =>
  h('button', { class: 'menu-item', role: 'menuitemradio', 'aria-checked': String(state.settings.mode === m.id), onclick: () => { closeMenus(); chooseMode(m.id); } },
    h('span', { class: 'mi-check', text: state.settings.mode === m.id ? '●' : '' }),
    h('span', {}, h('div', { class: 'mi-title', text: m.title }), h('div', { class: 'mi-sub', text: m.sub }))))));

els.folderChip.addEventListener('click', () => openMenu(els.folderMenu, els.folderChip, () => {
  const recents = (state.settings.recentFolders || []).filter(d => d.toLowerCase() !== (state.cwd || '').toLowerCase());
  return [
    h('div', { class: 'menu-label', text: 'Working in' }),
    h('div', { class: 'menu-item path', text: state.cwd }),
    h('div', { class: 'menu-sep' }),
    h('button', { class: 'menu-item', onclick: () => { closeMenus(); pickFolder(); } }, h('span', { class: 'mi-check', text: '+' }), h('span', { class: 'mi-title', text: 'Choose folder…' })),
    recents.length ? h('div', { class: 'menu-label', text: 'Recent' }) : null,
    ...recents.map(d => h('button', { class: 'menu-item path', title: d, onclick: () => { closeMenus(); setFolder(d); } }, tildify(d))),
    state.home && state.cwd !== state.home
      ? h('button', { class: 'menu-item path', onclick: () => { closeMenus(); setFolder(state.home); } }, '~ (home)') : null,
  ];
}));

function applyFolder(cwd) {
  state.cwd = cwd;
  els.folderLabel.textContent = shortPath(cwd);
  els.folderChip.title = `Working folder: ${cwd}`;
  $('emptyFolder').textContent = tildify(cwd);
  $('settingsFolder').textContent = cwd;
  $('settingsFolder').title = cwd;
}
async function pickFolder() {
  const r = await api.pickFolder();
  if (r) folderChanged(r);
}
async function setFolder(dir) {
  const r = await api.setFolder(dir);
  if (r) folderChanged(r);
}
function folderChanged(r) {
  if (r.error) return toast(r.error);
  state.settings = r.settings;
  applyFolder(r.cwd);
  resetFeed();
  toast(`Now working in ${basename(r.cwd)}`);
}

// ------------------------------------------------------------------ usage meter

function applyUsage(u) {
  if (!u || (!u.fiveHour && !u.sevenDay)) return;
  els.usage.hidden = false;
  const set = (el, win, name) => {
    if (!win) { el.hidden = true; return; }
    el.hidden = false;
    el.querySelector('.meter-fill').style.width = `${Math.min(100, win.pct)}%`;
    el.classList.toggle('warn', win.pct >= 70 && win.pct < 90);
    el.classList.toggle('hot', win.pct >= 90);
    const reset = win.resetsAt ? ` · resets ${new Date(win.resetsAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : '';
    el.title = `${name} usage: ${win.pct}%${reset}`;
  };
  set(els.meter5h, u.fiveHour, '5-hour');
  set(els.meter7d, u.sevenDay, 'Weekly');
}

// ------------------------------------------------------------------ feed rendering

function resetFeed() {
  state.tools.clear();
  state.asks.clear();
  state.currentHistoryId = null;
  [...els.feed.children].forEach(c => { if (c !== els.empty) c.remove(); });
  els.empty.hidden = false;
  renderSuggestions();
}

function append(el) {
  els.empty.hidden = true;
  const nearBottom = els.feed.scrollHeight - els.feed.scrollTop - els.feed.clientHeight < 120;
  els.feed.append(el);
  if (nearBottom) els.feed.scrollTop = els.feed.scrollHeight;
  return el;
}

function attachmentChips(files, removable) {
  return files.map((f, i) => h('span', { class: 'att', title: f },
    h('span', { text: basename(f) }),
    removable ? h('button', { type: 'button', 'aria-label': `Remove ${basename(f)}`, onclick: () => { state.attachments.splice(i, 1); renderAttachments(); } }, '×') : null));
}

function renderItem(item, { replay = false } = {}) {
  switch (item.kind) {
    case 'user':
      append(h('div', { class: 'msg user' }, item.text || '',
        item.attachments?.length ? h('div', { class: 'att-list' }, attachmentChips(item.attachments, false)) : null));
      break;
    case 'text': {
      const el = h('div', { class: `msg assistant${item.sub ? ' sub' : ''}` });
      el.innerHTML = md.render(item.text); // md escapes all input; see shared/markdown.js
      append(el);
      break;
    }
    case 'thinking':
      if (!replay) setStatus('Thinking…');
      break;
    case 'tool': {
      const el = h('details', { class: `tool pending${item.sub ? ' sub' : ''}` },
        h('summary', {},
          h('span', { class: 't-state' }),
          h('span', { class: 't-label', text: item.label }),
          h('span', { class: 't-detail', text: item.detail, title: item.detail })));
      state.tools.set(item.id, el);
      append(el);
      if (!replay) setStatus(`${item.label} ${item.detail}`.trim());
      break;
    }
    case 'tool_result': {
      const el = state.tools.get(item.id);
      if (!el) break;
      el.classList.remove('pending');
      el.classList.add(item.isError ? (/declined|denied|interrupted/i.test(item.text) ? 'denied' : 'err') : 'ok');
      if (item.text?.trim()) el.append(h('pre', { class: 't-result', text: item.text }));
      break;
    }
    case 'permission':
      renderAsk(item, replay);
      break;
    case 'decision':
      markDecision(item);
      break;
    case 'result': {
      for (const el of state.tools.values()) if (el.classList.contains('pending')) el.classList.replace('pending', item.ok ? 'ok' : 'err');
      const secs = item.durationMs != null ? `${(item.durationMs / 1000).toFixed(1)}s` : null;
      const label = item.interrupted ? 'stopped' : item.ok ? 'done' : 'ended with an error';
      append(h('div', { class: `meta${item.ok || item.interrupted ? '' : ' bad'}`, text: [label, secs, item.turns ? `${item.turns} turns` : null].filter(Boolean).join(' · ') }));
      if (!item.ok && !item.interrupted && item.error) append(h('div', { class: 'error-block', text: item.error }));
      break;
    }
    case 'error':
      append(h('div', { class: 'error-block', text: item.text }));
      break;
    case 'usage':
      applyUsage(item);
      break;
    case 'log':
      break;
  }
}

function suggestionLabel(s) {
  if (s?.type === 'setMode') return s.mode === 'acceptEdits' ? 'Allow all edits' : `Switch to ${s.mode}`;
  if (s?.type === 'addRules' && s.rules?.[0]) {
    const r = s.rules[0];
    return r.ruleContent ? `Always allow ${r.toolName}(${r.ruleContent.length > 24 ? r.ruleContent.slice(0, 22) + '…' : r.ruleContent})` : `Always allow ${r.toolName}`;
  }
  if (s?.type === 'addDirectories') return 'Always allow this folder';
  return 'Always allow';
}

function renderAsk(item, replay) {
  const isPlan = item.toolName === 'ExitPlanMode';
  const always = item.suggestions?.[0];
  const persistent = always && always.destination && always.destination !== 'session';

  const decide = async (decision, message) => {
    const ok = await api.answerPermission(item.requestId, decision, message);
    if (!ok) toast('That request already expired.');
    if (ok && isPlan && decision !== 'deny') {
      const next = item.suggestions?.find(s => s.type === 'setMode')?.mode;
      const uiMode = next === 'acceptEdits' ? 'acceptEdits' : next === 'bypassPermissions' ? null : 'ask';
      if (uiMode) { const r = await api.setSettings({ mode: uiMode }); state.settings = r.settings; applyMode(uiMode); }
    }
  };

  const body = isPlan
    ? h('div', { class: 'ask-body' }, (() => { const d = h('div', { class: 'ask-plan msg assistant' }); d.innerHTML = md.render(item.plan || 'No plan text.'); return d; })())
    : h('div', { class: 'ask-body' },
        h('code', { class: 'ask-cmd', text: item.detail || item.toolName }),
        item.description && item.description !== item.detail ? h('p', { class: 'ask-desc', text: item.description }) : null);

  const actions = isPlan
    ? [h('button', { class: 'btn allow', type: 'button', onclick: () => decide(always ? 'always' : 'allow') }, 'Approve plan'),
       h('button', { class: 'btn deny', type: 'button', onclick: () => decide('deny', 'Keep planning: the user wants to refine the plan before anything changes.') }, 'Keep planning')]
    : [h('button', { class: 'btn allow', type: 'button', 'data-key': 'y', onclick: () => decide('allow') }, 'Allow'),
       always ? h('button', { class: 'btn', type: 'button', 'data-key': 'a', title: persistent ? "Saves this rule to Claude Code's settings" : 'For the rest of this conversation', onclick: () => decide('always') }, suggestionLabel(always)) : null,
       h('button', { class: 'btn deny', type: 'button', 'data-key': 'n', onclick: () => decide('deny') }, 'Deny')];

  const card = h('div', { class: 'ask', role: 'group', 'aria-label': `Permission request: ${item.label}` },
    h('div', { class: 'ask-head' },
      h('span', { class: 'ask-crab' }, sprite()),
      h('div', {},
        h('div', { class: 'ask-title', text: isPlan ? "Here's my plan" : 'Can I do this?' }),
        h('div', { class: 'ask-sub', text: isPlan ? 'Nothing changes until you approve.' : `${item.label} · ${item.toolName}` }))),
    body,
    h('div', { class: 'ask-actions' }, actions),
    isPlan ? null : h('div', { class: 'ask-keys' }, 'Keys: ', h('kbd', {}, 'Y'), ' allow · ', always ? [h('kbd', {}, 'A'), ' always · '] : null, h('kbd', {}, 'N'), ' deny'));
  state.asks.set(item.requestId, card);
  append(card);
  if (!replay) {
    setStatus('Waiting for your OK…');
    card.querySelector('.btn.allow')?.focus({ preventScroll: true });
    card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

function markDecision(item) {
  const card = state.asks.get(item.requestId);
  if (!card || card.classList.contains('decided')) return;
  card.classList.add('decided');
  const words = { allow: 'Allowed', always: 'Always allowed', deny: 'Denied', cancelled: 'Cancelled' };
  card.append(h('div', { class: `ask-verdict ${item.decision === 'deny' || item.decision === 'cancelled' ? 'deny' : 'allow'}`, text: `→ ${words[item.decision] || item.decision}` }));
  if (state.busy) setStatus('Working…');
}

// Keyboard shortcuts for the newest open permission card.
document.addEventListener('keydown', e => {
  if (e.target.closest('textarea, input, select') || e.ctrlKey || e.metaKey || e.altKey) return;
  const open = [...state.asks.values()].reverse().find(c => !c.classList.contains('decided'));
  if (!open) return;
  const btn = open.querySelector(`[data-key="${e.key.toLowerCase()}"]`);
  if (btn) { e.preventDefault(); btn.click(); }
});

function setStatus(text) { els.statusText.textContent = text; }

function setBusy(busy) {
  state.busy = busy;
  document.body.classList.toggle('busy', busy);
  els.status.hidden = !busy;
  els.sendBtn.disabled = busy;
  if (busy) setStatus('Working…');
  else {
    for (const [requestId, card] of state.asks) if (!card.classList.contains('decided')) markDecision({ requestId, decision: 'cancelled' });
  }
}

// ------------------------------------------------------------------ composer

function autosize() {
  els.input.style.height = 'auto';
  els.input.style.height = `${Math.min(els.input.scrollHeight, 180)}px`;
}
els.input.addEventListener('input', autosize);

function renderAttachments() {
  els.attachments.hidden = !state.attachments.length;
  els.attachments.replaceChildren(...attachmentChips(state.attachments, true));
}
function addAttachments(files) {
  for (const f of files) if (!state.attachments.includes(f)) state.attachments.push(f);
  renderAttachments();
  els.input.focus();
}

async function send(text) {
  text = (text ?? els.input.value).trim();
  if ((!text && !state.attachments.length) || state.busy) return;
  const attachments = [...state.attachments];
  const r = await api.sendTask(text, attachments);
  if (!r.ok) return toast(r.error);
  renderItem({ kind: 'user', text, attachments });
  els.input.value = '';
  state.attachments = [];
  renderAttachments();
  autosize();
  setView('chat');
}

els.form.addEventListener('submit', e => { e.preventDefault(); send(); });
els.input.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
});
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (!els.modeMenu.hidden || !els.folderMenu.hidden) return closeMenus();
  if (state.busy) { api.stopTask(); setStatus('Stopping…'); return; }
  if (state.view !== 'chat' && state.view !== 'onboarding') return setView('chat');
  api.hide();
});
$('stopBtn').addEventListener('click', () => { api.stopTask(); setStatus('Stopping…'); });

els.feed.addEventListener('click', e => {
  const a = e.target.closest('a[data-href]');
  if (a) { e.preventDefault(); api.openExternal(a.dataset.href); }
});

// drag files onto the panel too
let dragDepth = 0;
window.addEventListener('dragenter', e => { e.preventDefault(); if (dragDepth++ === 0) document.body.classList.add('dropping'); });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dropping'); } });
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dropping');
  const paths = api.pathsForFiles(e.dataTransfer.files);
  if (paths.length) { setView('chat'); addAttachments(paths); }
});

function renderSuggestions() {
  const picks = [...SUGGESTIONS].sort(() => Math.random() - 0.5).slice(0, 3);
  $('suggestions').replaceChildren(...picks.map(s =>
    h('button', { class: 'suggestion', type: 'button', onclick: () => send(s) }, h('span', { class: 'glyph', text: '›' }), s)));
}

// ------------------------------------------------------------------ history

function renderHistory() {
  const q = $('historySearch').value.trim().toLowerCase();
  const list = state.sessions.filter(s => !q || s.title.toLowerCase().includes(q) || (s.cwd || '').toLowerCase().includes(q));
  const ul = $('historyList');
  if (!list.length) {
    ul.replaceChildren(h('li', { class: 'history-empty', text: q ? 'No matches.' : 'No conversations yet. Give Shellby a task!' }));
    return;
  }
  ul.replaceChildren(...list.map(s => h('li', { class: `history-item${s.id === state.currentHistoryId ? ' current' : ''}` },
    h('button', { class: 'history-open', type: 'button', onclick: () => openHistory(s.id) },
      h('div', { class: 'h-title', text: s.title }),
      h('div', { class: 'h-meta' }, h('span', { text: relTime(s.updatedAt) }), h('span', { text: tildify(s.cwd) }))),
    h('button', { class: 'history-del', type: 'button', title: 'Delete', 'aria-label': `Delete ${s.title}`, onclick: () => deleteHistory(s.id) }, '✕'))));
}
$('historySearch').addEventListener('input', renderHistory);

async function openHistory(id) {
  if (state.busy) return toast('Stop the current task first.');
  const r = await api.openSession(id);
  if (!r) return toast("Couldn't open that conversation.");
  resetFeed();
  state.currentHistoryId = id;
  applyFolder(r.entry.cwd);
  for (const item of r.items) renderItem(item, { replay: true });
  for (const [requestId, card] of state.asks) if (!card.classList.contains('decided')) markDecision({ requestId, decision: 'cancelled' });
  setView('chat');
  els.feed.scrollTop = els.feed.scrollHeight;
  toast('Picked up where you left off');
}
async function deleteHistory(id) {
  state.sessions = await api.deleteSession(id);
  if (id === state.currentHistoryId) resetFeed();
  renderHistory();
}

// ------------------------------------------------------------------ settings

function renderModeCards(container, onPick = chooseMode) {
  container.replaceChildren(...MODES.map(m => h('button', {
    type: 'button', role: 'radio', class: `mode-card${m.danger ? ' danger' : ''}`,
    'aria-checked': String(state.settings.mode === m.id), onclick: () => onPick(m.id),
  },
  h('span', { class: 'radio' }),
  h('span', { class: 'mc-title' }, m.title, m.tag ? h('span', { class: `tag${m.danger ? ' warn' : ''}`, text: m.tag }) : null),
  h('span', { class: 'mc-sub', text: m.sub }))));
}

function renderSkins() {
  $('skinGrid').replaceChildren(...state.skins.map(s => h('button', {
    type: 'button', class: 'skin', role: 'radio', 'aria-checked': String(s.id === state.skin?.id), title: s.description || s.name,
    onclick: async () => { const r = await api.setSettings({ skin: s.id }); state.settings = r.settings; },
  }, sprite(s), h('span', {}, s.name), s.source === 'user' ? h('small', { text: 'custom' }) : null)));
}

function renderSettings() {
  renderModeCards($('modeCards'));
  $('autonomousConfirm').hidden = true;
  $('settingsFolder').textContent = state.cwd;
  renderSkins();
  $('scaleSelect').value = String(state.settings.critterScale || 1);
  $('hotkeyBtn').textContent = prettyAccel(state.settings.hotkey) || 'None';
  $('hotkeyMsg').textContent = '';
  $('modelSelect').value = state.settings.model || '';
  $('loginToggle').checked = !!state.settings.openAtLogin;
  $('loginToggle').disabled = !state.packaged;
  $('loginNote').hidden = state.packaged;
  $('notifyToggle').checked = !!state.settings.notifications;
  const st = state.status || {};
  const facts = [
    ['Shellby', `v${state.version}`],
    ['Claude Code', st.version ? `v${st.version}` : 'not found'],
    ['Account', st.email ? `${st.email}` : '—'],
    ['Plan', st.subscriptionType ? st.subscriptionType[0].toUpperCase() + st.subscriptionType.slice(1) : '—'],
    ['Billing', st.authMethod === 'claude.ai' ? 'Claude subscription ✓' : (st.authMethod || '—')],
  ];
  $('facts').replaceChildren(...facts.flatMap(([k, v]) => [h('dt', { text: k }), h('dd', { text: v, title: v })]));
}

$('autonomousYes').addEventListener('click', async () => {
  const r = await api.setSettings({ autonomousAcknowledged: true, mode: 'autonomous' });
  state.settings = r.settings;
  applyMode(state.settings.mode);
  renderSettings();
  toast('Autonomous mode on. Be careful out there.');
});
$('autonomousNo').addEventListener('click', () => { $('autonomousConfirm').hidden = true; });
$('changeFolderBtn').addEventListener('click', pickFolder);
$('scaleSelect').addEventListener('change', async e => { const r = await api.setSettings({ critterScale: Number(e.target.value) }); state.settings = r.settings; });
$('modelSelect').addEventListener('change', async e => { const r = await api.setSettings({ model: e.target.value }); state.settings = r.settings; toast('Model applies to your next conversation.'); });
$('loginToggle').addEventListener('change', async e => { const r = await api.setSettings({ openAtLogin: e.target.checked }); state.settings = r.settings; });
$('notifyToggle').addEventListener('change', async e => { const r = await api.setSettings({ notifications: e.target.checked }); state.settings = r.settings; });
$('openSkinsBtn').addEventListener('click', () => api.openSkinsFolder());
$('reloadSkinsBtn').addEventListener('click', async () => { state.skins = await api.reloadSkins(); renderSkins(); toast(`${state.skins.length} skins loaded`); });
$('githubBtn').addEventListener('click', () => api.openExternal('https://github.com/x-salmon/shellby'));
$('dataBtn').addEventListener('click', () => api.openDataFolder());

// hotkey recorder
const hotkeyBtn = $('hotkeyBtn');
let recording = false;
hotkeyBtn.addEventListener('click', () => {
  recording = !recording;
  hotkeyBtn.classList.toggle('recording', recording);
  hotkeyBtn.textContent = recording ? 'Press keys…' : prettyAccel(state.settings.hotkey);
  $('hotkeyMsg').textContent = recording ? 'Hold a modifier (Ctrl, Alt, Shift, Win) and press a key. Esc cancels, Backspace clears.' : '';
});
hotkeyBtn.addEventListener('keydown', async e => {
  if (!recording) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.key === 'Escape') { recording = false; hotkeyBtn.classList.remove('recording'); hotkeyBtn.textContent = prettyAccel(state.settings.hotkey); $('hotkeyMsg').textContent = ''; return; }
  let accel = '';
  if (e.key === 'Backspace') accel = '';
  else {
    if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;
    const mods = [e.ctrlKey && 'Control', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Super'].filter(Boolean);
    if (!mods.length) { $('hotkeyMsg').textContent = 'Add at least one modifier key.'; return; }
    const key = e.code === 'Space' ? 'Space' : /^Key[A-Z]$/.test(e.code) ? e.code.slice(3) : /^Digit\d$/.test(e.code) ? e.code.slice(5) : /^F\d{1,2}$/.test(e.key) ? e.key : null;
    if (!key) { $('hotkeyMsg').textContent = 'Use a letter, number, F-key or Space.'; return; }
    accel = [...mods, key].join('+');
  }
  recording = false;
  hotkeyBtn.classList.remove('recording');
  const r = await api.setSettings({ hotkey: accel });
  state.settings = r.settings;
  hotkeyBtn.textContent = prettyAccel(state.settings.hotkey) || 'None';
  $('hotkeyMsg').textContent = r.hotkeyError || (accel ? 'Saved.' : 'Shortcut cleared.');
  $('hotkeyHint').textContent = prettyAccel(state.settings.hotkey) || 'The tray icon';
});

// ------------------------------------------------------------------ onboarding

function needsOnboarding() {
  const s = state.status || {};
  return !state.settings.onboarded || !s.installed || !s.loggedIn;
}

function renderOnboarding() {
  const s = state.status || {};
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
      installed ? [h('button', { class: 'btn primary', type: 'button', onclick: async () => { await api.claudeLogin(); toast('Finish signing in, then press Check again.'); } }, 'Sign in'), recheck()] : null),
  );
  const pickOnboardMode = async mode => {
    if (mode === 'autonomous') return toast('You can turn on Autonomous later in Settings.');
    const r = await api.setSettings({ mode });
    state.settings = r.settings;
    applyMode(mode);
    renderModeCards($('onboardModeCards'), pickOnboardMode);
  };
  renderModeCards($('onboardModeCards'), pickOnboardMode);
  $('letsGoBtn').disabled = !(installed && signedIn);
}
async function recheckStatus() {
  state.status = await api.claudeStatus();
  renderOnboarding();
  toast(state.status.loggedIn ? 'All set!' : state.status.installed ? 'Not signed in yet.' : 'Claude Code not found yet.');
}
$('letsGoBtn').addEventListener('click', async () => {
  const r = await api.setSettings({ onboarded: true });
  state.settings = r.settings;
  setView('chat');
});

// ------------------------------------------------------------------ events from main

api.onItem(item => {
  renderItem(item);
  if (item.kind === 'result') api.listSessions().then(s => { state.sessions = s; });
});
api.onBusy(setBusy);
api.onReset(() => { resetFeed(); setView('chat'); });
api.onSessions(s => {
  state.sessions = s;
  if (!state.currentHistoryId && s[0]) state.currentHistoryId = s[0].id;
});
api.onAttach(files => { if (state.view !== 'onboarding') setView('chat'); addAttachments(files); });
api.onFocusInput(() => { if (state.view === 'chat') els.input.focus(); });
api.onView(v => setView(v));
api.onSkin(skin => {
  state.skin = skin;
  renderCrabs();
  if (state.view === 'settings') renderSkins();
});
api.onUpdateReady(v => toast(`Update ${v} will install when you quit.`));
api.onDemo(({ items, usage, attachments, view }) => {
  setBusy(false);
  resetFeed();
  for (const it of items) renderItem(it, { replay: it.kind !== 'permission' });
  if (usage) applyUsage(usage);
  if (attachments) addAttachments(attachments);
  setView(view || 'chat');
  if (items.some(i => i.kind === 'tool' && !items.some(r => r.kind === 'tool_result' && r.id === i.id))) setBusy(true);
});

// ------------------------------------------------------------------ boot

(async function init() {
  const b = await api.bootstrap();
  Object.assign(state, {
    settings: b.settings, status: b.status, skins: b.skins, skin: b.skin, sessions: b.sessions,
    home: b.home, version: b.version, packaged: b.packaged,
  });
  applyFolder(b.cwd);
  applyMode(state.settings.mode);
  applyUsage(state.settings.lastUsage);
  $('hotkeyHint').textContent = prettyAccel(state.settings.hotkey) || 'The tray icon';
  renderCrabs();
  renderSuggestions();
  setBusy(b.busy);
  setView(needsOnboarding() ? 'onboarding' : 'chat');
})();
