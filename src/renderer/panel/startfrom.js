/* Shellby panel — start a task from where the work already is
   (src/main/startfrom.js): "Fix this build" and "Address the review" on your
   pull requests (Settings → GitHub, a project's Health card, the red build's
   notification). Loose ends are on Next up now (backlog.js).

   The pull request ones open a sheet with the exact prompt main wrote, like a
   crashed server's card: only its Send button sends, and it carries that
   prompt's hash, so main sends exactly what you read or nothing. When the
   pull request changes Claude Code's own files (CLAUDE.md, .claude/, .mcp.json)
   or holds someone else's commits, the sheet names them and Send waits for
   "I've looked at these", which main checks too. */
'use strict';
(function () {
  const { h, api, state, $ } = SB;

  const TITLES = { build: 'Fix this build', review: 'Address the review' };

  let open = null;    // { kind, key, from } while the sheet is up
  let shown = null;   // { hash, note, risk }: the draft on screen, the only one Send may send
  let pending = false; // a draft is on its way (the note changed): Send waits for it
  let seq = 0;
  let noteTimer = null;

  const modeTitle = () => SB.MODES.find(m => m.id === state.settings.mode)?.title || 'your current mode';
  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

  // ------------------------------------------------------------------ the sheet

  function openSheet(kind, key) {
    if (SB.isCrabOnly()) return SB.claudeUpsell('fix');
    open = { kind, key, from: document.activeElement };
    shown = null;
    $('sfTitle').textContent = TITLES[kind];
    $('sfNote').value = '';
    $('sfAck').checked = false;
    $('sfRisk').hidden = true;
    $('sfSheet').hidden = false;
    $('sfClose').focus();
    refresh({ fresh: true });
  }

  function closeSheet() {
    clearTimeout(noteTimer);
    $('sfSheet').hidden = true;
    const from = open?.from;
    open = null;
    shown = null;
    if (from?.isConnected) from.focus();
  }

  function lede(d) {
    if (d.kind === 'build') {
      const job = `“${d.job}”${d.step ? `, at “${d.step}”` : ''}`;
      return d.logShown
        ? `This is exactly what will be sent: the failing part of the log from ${job} (secrets blanked out) and what to do about it.`
        : `Shellby couldn't read the log of ${job}: ${d.why}. So its name and link go instead, and Claude is asked to read the log itself.`;
    }
    return `This is exactly what will be sent: ${plural(d.comments, d.resolvedKnown ? 'unresolved review comment' : 'review comment')}, quoted, and what to do with them.${d.resolvedKnown ? '' : ' GitHub didn\'t say which are resolved, so some here may be done already.'}`;
  }

  // Send is off while a draft is on its way, only ever for the one on screen,
  // and, when it names things to look at, only once you've ticked that you did.
  function syncSend() {
    $('sfSend').disabled = !shown || pending || (!!shown.risk && !$('sfAck').checked);
  }

  // What could change what Claude Code runs in the copy (startfrom.prRisks): named, plainly.
  function renderRisk(risk, prev) {
    $('sfRisk').hidden = !risk;
    if (!risk) return;
    // A different list is a different question: the tick doesn't carry over.
    if (JSON.stringify(risk) !== JSON.stringify(prev)) $('sfAck').checked = false;
    const list = items => h('ul', { class: 'sf-risk-list' }, items.map(t => h('li', {}, h('code', { text: t }))));
    $('sfRiskBody').replaceChildren(
      risk.files.length ? h('p', { text: `It changes ${risk.files.length + risk.moreFiles === 1 ? 'a file' : 'files'} Claude Code reads for its instructions, hooks or MCP servers, so they'd apply in the copy:` }) : null,
      risk.files.length ? list(risk.moreFiles ? [...risk.files, `and ${risk.moreFiles} more`] : risk.files) : null,
      risk.authors.length ? h('p', { text: 'It has commits from someone other than you:' }) : null,
      risk.authors.length ? list(risk.authors) : null,
      risk.unknown.length ? h('p', { text: `GitHub didn't tell Shellby ${risk.unknown.join(' or ')}, so he can't say it's only your work.` }) : null);
  }

  async function refresh({ fresh = false } = {}) {
    if (!open) return;
    const mine = ++seq;
    const { kind, key } = open;
    pending = true;
    syncSend();
    if (!shown) {
      $('sfLede').textContent = kind === 'build' ? 'Getting the failing log from GitHub…' : 'Getting the review comments from GitHub…';
      $('sfPrompt').hidden = $('sfNote').hidden = $('sfWhere').hidden = true;
    }
    const note = $('sfNote').value;
    const d = await api.startFromDraft({ kind, key, note, fresh }).catch(() => null);
    if (mine !== seq || !open) return;
    if (!d?.ok) {
      shown = null;
      pending = false;
      $('sfLede').textContent = d?.error || 'Couldn\'t get that from GitHub.';
      $('sfPrompt').hidden = $('sfNote').hidden = $('sfWhere').hidden = $('sfRisk').hidden = true;
      return;
    }
    $('sfLede').textContent = lede(d);
    $('sfPrompt').textContent = d.prompt;
    $('sfWhere').replaceChildren(
      `Claude will work in a copy of ${SB.shortPath(d.where, 40)} started from ${d.branch}, in ${modeTitle()} mode. `,
      h('button', { type: 'button', class: 'link-btn', text: 'Change the mode', onclick: () => { closeSheet(); SB.setView('settings'); } }));
    $('sfPrompt').hidden = $('sfNote').hidden = $('sfWhere').hidden = false;
    renderRisk(d.risk, shown?.risk);
    shown = { hash: d.hash, note, risk: d.risk || null };
    // Typed into while this was on its way: the next draft (already due) turns Send back on.
    pending = note !== $('sfNote').value;
    syncSend();
  }

  async function send() {
    if (!open || !shown) return;
    $('sfSend').disabled = true;
    const r = await api.startFromSend({ kind: open.kind, key: open.key, note: shown.note, hash: shown.hash, ack: $('sfAck').checked }).catch(() => null);
    if (!r?.ok) {
      if (r?.needsClaude) { closeSheet(); return SB.claudeUpsell('fix'); }
      SB.toast(r?.error || 'Couldn\'t open a conversation.', { ms: 6000 });
      // Changed since you read it: show the new text and let you look again.
      if (r?.stale) refresh(); else syncSend();
      return;
    }
    closeSheet();
    // The tab opened itself (boot.js onTabOpened); go and watch it work.
    SB.setView('chat');
    if (state.tabs.has(r.tabId)) SB.activate(r.tabId);
  }

  // Enter in the note is a new line, never "send".
  $('sfNote').addEventListener('input', () => {
    pending = true;
    syncSend();
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => refresh(), 250);
  });
  $('sfAck').addEventListener('change', syncSend);
  $('sfSend').addEventListener('click', send);
  $('sfCancel').addEventListener('click', closeSheet);
  $('sfClose').addEventListener('click', closeSheet);
  $('sfGitHub').addEventListener('click', () => { if (open) api.openPr(open.key); });
  $('sfSheet').addEventListener('click', e => { if (e.target === $('sfSheet')) closeSheet(); });
  $('sfSheet').addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); closeSheet(); } });
  api.onStartFromOpen(o => { if (o && TITLES[o.kind]) openSheet(o.kind, o.key); });

  SB.startFrom = { open: openSheet };
})();
