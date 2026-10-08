/* Shellby panel — Settings: telling you elsewhere. Notifications on your
   phone (ntfy, Telegram and friends), answering them, and starting a task
   from the phone. */
'use strict';
(function () {
  const { h, api, $ } = SB;
  const T = window.ShellbySettingsText;

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
    // What's missing, what the bot's listener ran into, or the last send that didn't go.
    const status = T.phoneStatus(v);
    $('chStatus').textContent = status.text;
    $('chStatus').className = `small ext-status ${status.tone}`;
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

  SB.onSettingsOpen(() => api.getChannels().then(renderChannels));
})();
