/* Shellby panel — the message box: what's attached, sending, the busy line
   under it with its clock, Stop, and dropping or pasting files in. The queue
   behind a running turn is tab-queue.js, the slash menu slash-menu.js. */
'use strict';
(function () {
  const { api, state, $ } = SB;
  const L = window.ShellbyTabLogic;
  const input = $('input');
  // Theirs, reached when they're called (the files load after this one).
  const renderQueue = () => SB.renderQueue();
  const syncSteers = tab => SB.syncSteers(tab);
  const queueItem = (text, attachments) => SB.queueItem(text, attachments);
  const editQueued = (tab, i) => SB.editQueued(tab, i);
  const updateSlash = () => SB.updateSlash();
  const slashKeydown = e => SB.slashKeydown(e);

  // ------------------------------------------------------------ busy / status

  function syncBusyUi() {
    const tab = SB.activeTab();
    const busy = !!tab?.busy;
    $('status').hidden = !busy;
    // While Shellby works you can keep typing: Enter queues the message, and
    // Claude reads it at his next step (or when he finishes, if there's none).
    $('sendBtn').title = busy ? 'Queue: Claude reads it at his next step' : 'Send · right-click to try it 2, 3 or 4 ways';
    $('sendBtn').classList.toggle('queueing', busy);
    $('sendHint').textContent = busy ? 'Enter to queue for his next step · Shift+Enter new line' : 'Enter to send · Shift+Enter new line';
    if (tab) $('statusText').textContent = busy ? tab.statusText + (tab.queue.length ? ` · ${tab.queue.length} queued` : '') : '';
    if (tab) syncSteers(tab);
    SB.renderModStatus?.(tab);
    tickClock();
    renderQueue();
  }

  // How long the current prompt has been running and the tokens it's used so far,
  // like Claude Code's "(12s · ↓ 4.2k tokens · esc to interrupt)". One timer,
  // alive only while the tab on screen is working; main's tab summaries bring
  // the tokens (sessions.js turnTokens) and re-render it between ticks.
  let clockTimer = null;
  function tickClock() {
    const tab = SB.activeTab();
    const since = tab?.busy && tab.busySince;
    const tokens = since && tab.turnTokens ? `${SB.compact(tab.turnTokens)} tokens` : '';
    $('statusTime').textContent = since ? [SB.clock(Date.now() - since), tokens].filter(Boolean).join(' · ') : '';
    if (since && !clockTimer) clockTimer = setInterval(tickClock, 1000);
    if (!since && clockTimer) { clearInterval(clockTimer); clockTimer = null; }
  }
  SB.syncBusyUi = syncBusyUi;

  // ------------------------------------------------------------ composer

  function autosize() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
  }
  input.addEventListener('input', () => { autosize(); updateSlash(); SB.composerInput?.(); });
  SB.autosize = autosize;

  function renderAttachments() {
    const tab = SB.activeTab();
    const files = tab ? tab.attachments : [];
    $('attachments').hidden = !files.length;
    $('attachments').replaceChildren(...SB.attachmentChips(files, i => { files.splice(i, 1); renderAttachments(); }));
  }
  SB.addAttachments = files => {
    const tab = SB.activeTab();
    if (!tab) return;
    for (const f of files) if (!tab.attachments.includes(f)) tab.attachments.push(f);
    renderAttachments();
    input.focus();
  };

  // Send to any tab: the active one, or a background tab draining its queue.
  async function sendNow(tab, text, attachments) {
    const r = await api.sendTask(tab.id, text, attachments);
    if (!r.ok) {
      // Out in a terminal: the way back is one click from the refusal. Not set
      // up (or signed out): the toast takes you to the fix.
      const label = { setup: 'Set up Claude Code', 'sign-in': 'Sign in again' }[r.action];
      if (tab.inTerminal) SB.toast(r.error, { action: 'Pick it up here', onAction: () => SB.pickUpHere(tab.id), ms: 6000 });
      else SB.toast(r.error, label ? { action: label, ms: 9000, onAction: () => SB.troubleAction(r.action, tab) } : undefined);
      return false;
    }
    // !! is how a message that starts with ! reaches Claude; it shows (and is sent) with one.
    markSent(tab, text.startsWith('!!') ? text.slice(1) : text, attachments, r.turnId);
    SB.notePrompt?.(text);
    return true;
  }
  SB.sendNow = sendNow;

  // A message has gone to Claude: from the box, the queue, or held for the
  // usage reset and sent by main (boot.js onTabSent).
  function markSent(tab, text, attachments, turnId) {
    tab.render({ kind: 'user', text, attachments, turnId });
    tab.busy = true;
    tab.busySince = Date.now();
    tab.turnTokens = 0;
    tab.turnId = turnId; // what's queued behind it is steered into this turn
    syncSteers(tab);
    tab.saved = true;
    tab.statusText = 'Working…';
    if (tab.title === L.NEW_TITLE && !tab.named) tab.title = L.firstTitle(text, attachments);
    if (tab.isActive) syncBusyUi();
    SB.renderTabStrip();
  }
  SB.markSent = markSent;

  function clearComposer(tab) {
    input.value = '';
    tab.attachments = [];
    renderAttachments();
    autosize();
    SB.composerInput?.();
    SB.resetEstimate?.(); // what it usually costs was about what's just gone (outlook.js)
  }
  SB.clearComposer = clearComposer;
  SB.renderAttachments = renderAttachments;

  // -> true once it has gone (or is queued, or held for the reset), false if it
  // stayed where it was. force: send even if it would be held as a big task.
  SB.send = async (text, { force = false } = {}) => {
    const tab = SB.activeTab();
    if (!tab) return false;
    text = (text ?? input.value).trim();
    if (!text && !tab.attachments.length) return false;
    const attachments = [...tab.attachments];
    let snippet = null; // its name, counted as a use once the prompt has gone
    // /export, /rewind, ! commands and friends happen here, not in Claude (composer.js).
    if (SB.runLocal?.(text, tab, attachments)) { clearComposer(tab); return true; }
    // /review and the rest of your snippets: Claude gets the prompt they stand for,
    // filled in before it can be queued, so editing the snippet can't change it later.
    if (SB.isSnippetCall?.(text)) {
      // A second Enter while main fills it in would send it twice.
      if (tab.expanding) return false;
      tab.expanding = true;
      let r;
      try { r = await api.expandSnippet(text, tab.id); } finally { tab.expanding = false; }
      if (r && !r.ok) { SB.toast(r.error); return false; }
      if (r?.newTab && !tab.isEmpty) return sendInNewTab(tab, text, r, attachments);
      if (r) { snippet = r.name; text = r.prompt; }
    }
    // "Hold big tasks for the reset" (Settings): one that usually takes more than
    // the window has left waits for the reset instead (outlook.js).
    if (!force && state.settings.holdBigTasks) {
      // A second Enter while main looks it up would send (or hold) it twice.
      if (tab.holdChecking) return false;
      tab.holdChecking = true;
      let held;
      try { held = await SB.holdIfBig?.(tab, text, attachments); } finally { tab.holdChecking = false; }
      if (held) {
        clearComposer(tab);
        if (snippet) api.snippetUsed(snippet);
        return true;
      }
    }
    if (tab.busy) {
      tab.queue.push(queueItem(text, attachments));
      clearComposer(tab);
      syncBusyUi();
      if (snippet) api.snippetUsed(snippet);
      return true;
    }
    if (!(await sendNow(tab, text, attachments))) return false;
    clearComposer(tab);
    SB.setView('chat');
    if (snippet) api.snippetUsed(snippet);
    return true;
  };

  // A message that skips the box (a held one you chose to send now): queued
  // behind the turn in progress, or sent at once. -> true once it's on its way.
  SB.sendDirect = async (tab, text, attachments = []) => {
    if (tab.busy) {
      tab.queue.push({ text, attachments });
      syncBusyUi();
      return true;
    }
    return sendNow(tab, text, attachments);
  };

  // Try again after something went wrong: the same words again, leaving
  // whatever's in the box alone (queued if a turn is running by then). A
  // message shown with one ! went to Claude as !!, so it does again.
  SB.resend = (tab, text) => {
    const words = text.startsWith('!') ? `!${text}` : text;
    if (!tab.busy) return sendNow(tab, words, []);
    tab.queue.push(queueItem(words, []));
    syncBusyUi();
    return true;
  };

  // A snippet set to start a conversation of its own: the one you're in is left
  // as it was. If the new one can't open, what you typed stays in the box; if it
  // opens but can't start, the prompt waits in its box.
  async function sendInNewTab(from, typed, { name, prompt }, attachments) {
    clearComposer(from);
    const fresh = await SB.newTab();
    if (!fresh) {
      from.attachments = attachments;
      renderAttachments();
      SB.prefill(typed);
      return false;
    }
    if (await sendNow(fresh, prompt, attachments)) { SB.setView('chat'); api.snippetUsed(name); return true; }
    SB.prefill(prompt);
    return false;
  }

  $('form').addEventListener('submit', e => { e.preventDefault(); SB.send(); });
  input.addEventListener('keydown', e => {
    if (SB.pickKeydown?.(e)) return;
    if (slashKeydown(e)) return;
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); SB.send(); }
    if (e.key === 'Tab' && e.shiftKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); SB.cycleMode(); return; }
    // Up in an empty box pulls back the last queued message, like Claude Code.
    const tab = SB.activeTab();
    if (e.key === 'ArrowUp' && !input.value && tab?.queue.length) { e.preventDefault(); editQueued(tab, tab.queue.length - 1); return; }
    // Otherwise Up and Down walk back through what you've sent before.
    SB.historyKeydown?.(e);
  });
  $('stopBtn').addEventListener('click', stop);
  function stop() {
    const tab = SB.activeTab();
    if (!tab?.busy) return;
    api.stopTask(tab.id);
    tab.setStatus('Stopping…');
  }

  SB.stopTask = stop;

  // drag files onto the panel too
  let dragDepth = 0;
  // Only files: dragging a sticker onto his shell (stickers.js) is not an attachment.
  const carriesFiles = e => !!e.dataTransfer?.types?.includes('Files');
  window.addEventListener('dragenter', e => { if (!carriesFiles(e)) return; e.preventDefault(); if (dragDepth++ === 0) document.body.classList.add('dropping'); });
  window.addEventListener('dragleave', e => { if (!carriesFiles(e)) return; if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dropping'); } });
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => {
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('dropping');
    if (e.dataTransfer.files.length) attachFrom(e.dataTransfer.files);
  });

  // A picture with no file behind it (a snip, an image out of a browser) is saved
  // by main first, so everything attached ends up as a path.
  async function attachFrom(files) {
    const { paths, error } = await api.attachFiles([...files]); // a FileList doesn't cross the bridge; an array of Files does
    if (error) SB.toast(error);
    if (paths.length) { SB.setView('chat'); SB.addAttachments(paths); }
  }

  // Ctrl+V a Win+Shift+S snip (or files copied in Explorer) straight into the
  // composer. Anything that also carries text (a cell out of Excel brings a
  // picture of itself along) pastes as text, the way it always did.
  input.addEventListener('paste', e => {
    const data = e.clipboardData;
    if (!data?.files.length || data.getData('text/plain')) return;
    e.preventDefault();
    attachFrom(data.files);
  });

  $('attachBtn').addEventListener('click', async () => {
    const paths = await api.pickFiles();
    if (paths.length) SB.addAttachments(paths);
    else input.focus();
  });

  // Put text in the box (not sent) with the caret at the end, ready to add to.
  SB.prefill = (text) => {
    SB.setView('chat');
    input.value = text;
    autosize();
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  };

  // A prompt Shellby wrote for you to look over (a "let Claude set it up"
  // button): in a conversation of its own, not on the end of the one you're in.
  // A blank, idle tab with nothing typed is used as is.
  SB.prefillNew = (text) => {
    const cur = SB.activeTab();
    if (SB.isBlankTab(cur) && !input.value.trim()) return SB.prefill(text);
    return SB.newTabIn({ draft: text });
  };

  SB.useTool = (t) => {
    if (t.kind === 'snippet') return SB.runSnippet(t.name);
    const prefix = t.kind === 'agent' ? `Use the ${t.name} agent to ` : `/${t.name} `;
    SB.prefill(prefix + input.value.replace(/^\/\S*\s*/, ''));
  };
})();
