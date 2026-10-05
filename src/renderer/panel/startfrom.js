/* Shellby panel — start a task from where the work already is
   (src/main/startfrom.js): "Fix this build" and "Address the review" on your
   pull requests (Settings → GitHub, a project's Health card, the red build's
   notification), and the Loose ends card on a project's page.

   The pull request ones open a sheet with the exact prompt main wrote, like a
   crashed server's card: only its Send button sends, and it carries that
   prompt's hash, so main sends exactly what you read or nothing. A loose end
   goes in the box of a new conversation, for you to send. */
'use strict';
(function () {
  const { h, api, state, $ } = SB;

  const TITLES = { build: 'Fix this build', review: 'Address the review' };
  const LOOSE_SHOWN = 5;

  let open = null;    // { kind, key, from } while the sheet is up
  let shown = null;   // { hash, note }: the draft on screen, the only one Send may send
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

  // Send is off while a draft is on its way, and only ever for the one on screen.
  async function refresh({ fresh = false } = {}) {
    if (!open) return;
    const mine = ++seq;
    const { kind, key } = open;
    $('sfSend').disabled = true;
    if (!shown) {
      $('sfLede').textContent = kind === 'build' ? 'Getting the failing log from GitHub…' : 'Getting the review comments from GitHub…';
      $('sfPrompt').hidden = $('sfNote').hidden = $('sfWhere').hidden = true;
    }
    const note = $('sfNote').value;
    const d = await api.startFromDraft({ kind, key, note, fresh }).catch(() => null);
    if (mine !== seq || !open) return;
    if (!d?.ok) {
      shown = null;
      $('sfLede').textContent = d?.error || 'Couldn\'t get that from GitHub.';
      $('sfPrompt').hidden = $('sfNote').hidden = $('sfWhere').hidden = true;
      return;
    }
    $('sfLede').textContent = lede(d);
    $('sfPrompt').textContent = d.prompt;
    $('sfWhere').replaceChildren(
      `Claude will work in a copy of ${SB.shortPath(d.where, 40)} started from ${d.branch}, in ${modeTitle()} mode. `,
      h('button', { type: 'button', class: 'link-btn', text: 'Change the mode', onclick: () => { closeSheet(); SB.setView('settings'); } }));
    $('sfPrompt').hidden = $('sfNote').hidden = $('sfWhere').hidden = false;
    shown = { hash: d.hash, note };
    // Typed into while this was on its way: the next draft (already due) turns Send back on.
    $('sfSend').disabled = note !== $('sfNote').value;
  }

  async function send() {
    if (!open || !shown) return;
    $('sfSend').disabled = true;
    const r = await api.startFromSend({ kind: open.kind, key: open.key, note: shown.note, hash: shown.hash }).catch(() => null);
    if (!r?.ok) {
      if (r?.needsClaude) { closeSheet(); return SB.claudeUpsell('fix'); }
      SB.toast(r?.error || 'Couldn\'t open a conversation.', { ms: 6000 });
      // Changed since you read it: show the new text and let you look again.
      if (r?.stale) refresh(); else $('sfSend').disabled = false;
      return;
    }
    closeSheet();
    // The tab opened itself (boot.js onTabOpened); go and watch it work.
    SB.setView('chat');
    if (state.tabs.has(r.tabId)) SB.activate(r.tabId);
  }

  // Enter in the note is a new line, never "send".
  $('sfNote').addEventListener('input', () => {
    $('sfSend').disabled = true;
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => refresh(), 250);
  });
  $('sfSend').addEventListener('click', send);
  $('sfCancel').addEventListener('click', closeSheet);
  $('sfClose').addEventListener('click', closeSheet);
  $('sfGitHub').addEventListener('click', () => { if (open) api.openPr(open.key); });
  $('sfSheet').addEventListener('click', e => { if (e.target === $('sfSheet')) closeSheet(); });
  $('sfSheet').addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); closeSheet(); } });
  api.onStartFromOpen(o => { if (o && TITLES[o.kind]) openSheet(o.kind, o.key); });

  // ------------------------------------------------------------------ loose ends

  const scans = new Map();      // root -> { items, more } from main, so a redraw doesn't flicker
  const expanded = new Set();   // roots showing every loose end

  /** The Loose ends card for a clone: TODO, FIXME and HACK comments, each with "Do this". */
  function looseEndsCard(root, name) {
    const box = h('section', { class: 'pj-panel sf-loose', 'aria-label': 'Loose ends' }, h('p', { class: 'row-label', text: 'Loose ends' }));
    const body = h('div', {});
    box.append(body);
    const draw = r => {
      if (!r?.ok) return body.replaceChildren(h('p', { class: 'muted small pj-calm', text: r?.error || 'Couldn\'t look through it.' }));
      if (!r.items.length) return body.replaceChildren(h('p', { class: 'muted small pj-calm', text: 'No TODO, FIXME or HACK comments in the tracked files. Tidy. 🐚' }));
      const all = expanded.has(root);
      const list = all ? r.items : r.items.slice(0, LOOSE_SHOWN);
      const hidden = r.items.length - list.length + (r.more || 0);
      body.replaceChildren(
        h('ul', { class: 'pj-h-list' }, list.map(t => h('li', { class: 'pj-h-row sf-loose-row' },
          h('span', { class: `sf-tag ${t.tag.toLowerCase()}`, text: t.tag }),
          h('span', { class: 'pj-h-text' },
            h('b', { text: t.text || '(no note)', title: t.text }),
            h('code', { class: 'muted small', text: `${t.file}:${t.line}`, title: `${t.file}:${t.line}` })),
          h('span', { class: 'pj-h-acts' },
            h('button', { type: 'button', class: 'btn slim-btn', text: 'Do this', 'aria-label': `Do this: ${t.file} line ${t.line}`, onclick: e => doThis(root, t, e.currentTarget) }))))),
        h('div', { class: 'row wrap sf-loose-foot' },
          hidden > 0 && !all && h('button', { type: 'button', class: 'link-btn small', text: `Show ${r.more ? `the first ${r.items.length}` : `all ${r.items.length}`}`, onclick: () => { expanded.add(root); draw(r); } }),
          r.more > 0 && h('span', { class: 'muted small', text: `${r.more} more past those.` }),
          h('button', { type: 'button', class: 'link-btn small', text: 'Look again', onclick: () => load(true) })));
    };
    const load = async fresh => {
      const r = await api.looseEnds({ root, fresh }).catch(() => null);
      if (r?.ok) scans.set(root, r);
      draw(r);
    };
    if (scans.has(root)) draw(scans.get(root));
    else body.replaceChildren(h('p', { class: 'muted small pj-calm', text: `Looking through ${name} for TODOs…` }));
    load(false);
    return box;
  }

  // Into the box of a new conversation in the project: you read it, you send it.
  async function doThis(root, t, btn) {
    if (SB.isCrabOnly()) return SB.claudeUpsell('loose');
    btn.disabled = true;
    const r = await api.looseEndDraft({ root, file: t.file, line: t.line }).catch(() => null);
    btn.disabled = false;
    if (!r?.ok) return SB.toast(r?.error || 'Couldn\'t read that file.');
    SB.setView('chat');
    SB.newTabIn({ cwd: r.cwd, draft: r.draft });
  }

  SB.startFrom = { open: openSheet, looseEndsCard };
})();
