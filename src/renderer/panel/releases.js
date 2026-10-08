/* Shellby panel — Releases, a card on a project's page: "14 commits since
   v0.70.2" grouped by kind, the version they call for, a CHANGELOG draft and
   Cut release (src/main/projects/release-git.js does the work).

   Nothing leaves this PC unless "Push it" is ticked or Push is pressed, and a
   clone that moved since the draft was read isn't released. "Write it with
   Claude" only fills a new conversation's box: you read it and send it. */
'use strict';
(function () {
  const { h, api, plural } = SB;

  const SHOWN = 5;                 // commits shown per group before "N more"
  const seen = new Map();          // root -> the last releases:get, so a redraw doesn't flicker
  const drafts = new Map();        // root -> { head, version, title, notes, push, ack }
  const done = new Map();          // root -> what the last cut or push said
  const expanded = new Set();      // `${root}:${group}` showing every commit

  const ago = t => (t ? SB.relTime(t) : '');
  const act = (text, onclick, cls = 'btn ghost slim-btn', extra = {}) => h('button', { type: 'button', class: cls, text, onclick, ...extra });

  /** The Releases card for a clone. */
  function releasesCard(root, name) {
    const box = h('section', { class: 'pj-panel rl-card', 'aria-label': 'Releases' }, h('p', { class: 'row-label', text: 'Releases' }));
    const body = h('div', { class: 'rl-body' });
    box.append(body);
    const ctx = { root, name, body, load: fresh => load(ctx, fresh) };
    if (seen.has(root)) draw(ctx, seen.get(root));
    else body.replaceChildren(h('p', { class: 'muted small pj-calm', text: `Reading ${name}'s history since its last release…` }));
    load(ctx);
    return box;
  }

  async function load(ctx, fresh = false) {
    const r = await api.getRelease({ root: ctx.root }).catch(() => null);
    const before = seen.get(ctx.root);
    if (r?.ok) seen.set(ctx.root, r);
    // While you're writing a draft, a reload that found nothing new leaves it alone.
    const d = drafts.get(ctx.root);
    if (!fresh && before && r?.ok && JSON.stringify(before) === JSON.stringify(r)) return;
    if (!fresh && d && r?.ok && d.head === r.head && ctx.body.querySelector('.rl-draft')) return;
    draw(ctx, r);
  }

  // ------------------------------------------------------------------ the card

  function draw(ctx, r) {
    const { root, body } = ctx;
    if (!r?.ok) return body.replaceChildren(h('p', { class: 'muted small pj-calm', text: r?.error || 'Couldn\'t read its history.' }));
    const d = drafts.get(root);
    if (d && d.head !== r.head) drafts.delete(root); // the clone moved: that draft was for other commits
    SB.keepFocus(body, () => body.replaceChildren(...[
      summary(r),
      outcome(ctx, r),
      r.unpushedTag && unpushed(ctx, r),
      ...(r.total ? [groups(ctx, r), ciLine(r)] : [h('p', { class: 'muted small pj-calm', text: r.last ? `Nothing since ${r.last.tag}. 🐚` : 'No commits to release yet.' })]),
      drafts.has(root) ? draftForm(ctx, r) : actions(ctx, r),
    ].filter(Boolean)));
  }

  // "v0.70.2 · 3 days ago · 14 commits since"
  function summary(r) {
    const bits = r.last
      ? [h('b', { class: 'rl-tag', text: r.last.tag }), r.last.at && ago(r.last.at), r.total ? `${plural(r.total, 'commit')} since` : 'nothing since']
      : [h('b', { text: 'No releases yet' }), r.total && `${plural(r.total, 'commit')} so far`];
    return h('div', { class: 'row wrap rl-head' },
      h('p', { class: 'small rl-summary' }, ...bits.filter(Boolean).flatMap((b, i) => (i ? [h('span', { class: 'pj-sep', 'aria-hidden': 'true', text: '·' }), b] : [b]))),
      r.releasesUrl && act(r.forge === 'gitlab' ? 'Tags on GitLab' : 'Releases on GitHub', () => api.openExternal(r.releasesUrl), 'link-btn small'));
  }

  // A release tagged here that hasn't gone out yet.
  function unpushed(ctx, r) {
    return h('div', { class: 'rl-note warn' },
      h('span', { class: 'small', text: `${r.unpushedTag} is tagged on this PC but not pushed yet.` }),
      act(`Push ${r.unpushedTag}`, e => push(ctx, r.unpushedTag, e.currentTarget), 'btn slim-btn'));
  }

  // What the last Cut release or Push said, until the card shows something newer.
  function outcome(ctx, r) {
    const o = done.get(ctx.root);
    if (!o) return null;
    if (o.ok && o.pushed) {
      return h('div', { class: 'rl-note good', role: 'status' },
        h('span', { class: 'small', text: `${o.tag} is out: committed, tagged and pushed to ${o.remote || 'the remote'}.` }),
        r.releasesUrl && act(r.forge === 'gitlab' ? 'Open on GitLab' : 'Open on GitHub', () => api.openExternal(r.releasesUrl)),
        act('OK', () => { done.delete(ctx.root); draw(ctx, r); }));
    }
    if (o.ok) {
      return h('div', { class: `rl-note ${o.pushError ? 'warn' : 'good'}`, role: 'status' },
        h('span', { class: 'small', text: o.pushError ? `${o.tag} is committed and tagged on this PC. ${o.pushError}` : `${o.tag} is committed and tagged on this PC. Push it when you're ready.` }),
        act('OK', () => { done.delete(ctx.root); draw(ctx, r); }));
    }
    return null;
  }

  // The commits by kind: New, Fixed, Faster, Changed, then the behind-the-scenes ones folded away.
  function groups(ctx, r) {
    const list = h('div', { class: 'rl-groups' });
    for (const g of r.groups) {
      const key = `${ctx.root}:${g.id}`;
      const all = expanded.has(key);
      const shown = all ? g.commits : g.commits.slice(0, SHOWN);
      const rows = h('ul', { class: 'rl-commits' }, shown.map(c => h('li', { class: 'rl-commit', title: `${c.short}${c.author ? ` · ${c.author}` : ''}${c.at ? ` · ${ago(c.at)}` : ''}` },
        c.breaking && h('span', { class: 'pj-chip bad', text: 'breaking' }),
        c.scope && h('span', { class: 'pj-tag', text: c.scope }),
        h('span', { class: 'rl-text', text: c.text }),
        h('code', { class: 'muted rl-sha', text: c.short }))));
      const more = g.commits.length - shown.length;
      const foot = more > 0 && act(`${more} more`, () => { expanded.add(key); draw(ctx, seen.get(ctx.root)); }, 'link-btn small');
      const head = h('p', { class: `rl-group-name ${g.id}` }, g.label, h('span', { class: 'n', text: String(g.commits.length) }));
      if (g.user) list.append(h('section', { class: 'rl-group' }, head, rows, foot));
      else {
        const d = h('details', { class: 'pj-more rl-group' }, h('summary', { text: `${g.label} (${g.commits.length})` }), rows, foot);
        d.open = expanded.has(`${key}:open`);
        d.addEventListener('toggle', () => { if (d.open) expanded.add(`${key}:open`); else expanded.delete(`${key}:open`); });
        list.append(d);
      }
    }
    if (r.truncated) list.append(h('p', { class: 'muted small', text: `Showing the newest ${r.groups.reduce((n, g) => n + g.commits.length, 0)} of ${r.total}.` }));
    return list;
  }

  // CI on the commit about to be released, when GitHub (or GitLab, through glab) has it.
  function ciLine(r) {
    if (r.upstream?.ahead) {
      return h('p', { class: 'muted small rl-ci' }, h('span', { class: 'pj-dot off', 'aria-hidden': 'true' }),
        `${plural(r.upstream.ahead, 'commit')} not pushed yet, so CI hasn't seen ${r.upstream.ahead === 1 ? 'it' : 'them'}.`);
    }
    if (!r.ci) return null;
    const words = {
      passing: ['up', `CI passed on ${r.head.slice(0, 7)}.`],
      pending: ['starting', `CI is still running on ${r.head.slice(0, 7)}.`],
      failing: ['crashed', `CI failed on ${r.head.slice(0, 7)}: ${(r.ci.failing || []).join(', ') || 'checks'}.`],
      none: ['off', `No CI reported on ${r.head.slice(0, 7)}.`],
    }[r.ci.state];
    if (!words) return null;
    return h('p', { class: `small rl-ci ${r.ci.state}` }, h('span', { class: `pj-dot ${words[0]}`, 'aria-hidden': 'true' }), words[1]);
  }

  function actions(ctx, r) {
    if (!r.total && !r.next.prepared) return null;
    return h('div', { class: 'row wrap rl-acts' },
      act(`Draft release ${r.prefix}${r.next.suggested}…`, () => openDraft(ctx, r), 'btn slim-btn'),
      r.total > 0 && act('Write it with Claude', e => polish(ctx, r, e.currentTarget)),
      r.blocker && h('span', { class: 'muted small rl-why', text: r.blocker }));
  }

  // ------------------------------------------------------------------ the draft

  function openDraft(ctx, r) {
    drafts.set(ctx.root, {
      head: r.head, version: r.next.suggested, title: '', notes: r.draft.notes,
      push: !!r.remote, ack: false,
    });
    draw(ctx, r);
    ctx.body.querySelector('.rl-draft input[name="version"]')?.focus();
  }

  function draftForm(ctx, r) {
    const d = drafts.get(ctx.root);
    const tagOf = v => `${r.prefix}${v}`;
    const versionIn = h('input', { class: 'field rl-version', name: 'version', value: d.version, spellcheck: 'false', 'aria-label': 'Version', autocomplete: 'off' });
    const titleIn = h('input', { class: 'field', name: 'title', value: d.title, maxlength: '100', placeholder: 'What this release is about (optional)', 'aria-label': 'Title' });
    const notesIn = h('textarea', { class: 'field area rl-notes', name: 'notes', rows: '8', spellcheck: 'true', 'aria-label': `The ${r.changelog.name} entry` });
    notesIn.value = d.notes;
    const pushIn = h('input', { type: 'checkbox' });
    pushIn.checked = d.push;
    const ackIn = h('input', { type: 'checkbox' });
    ackIn.checked = d.ack;
    const steps = h('ol', { class: 'small rl-steps' });
    const cut = act('', () => doCut(ctx, r, cut), 'btn primary');
    const err = h('p', { class: 'small rl-err', role: 'alert', hidden: true });

    const ciRisk = r.ci && (r.ci.state === 'failing' || r.ci.state === 'pending');
    const valid = v => /^\d{1,6}\.\d{1,6}\.\d{1,6}(-[0-9A-Za-z.-]{1,40})?$/.test(v);
    const hasEntry = () => r.changelog.hasEntry && d.version === r.next.suggested;

    // Patch / Minor / Major, the suggested one marked; or type your own.
    const seg = r.next.base ? h('div', { class: 'seg rl-seg', role: 'radiogroup', 'aria-label': 'Next version' },
      ['patch', 'minor', 'major'].map(b => h('button', {
        type: 'button', role: 'radio', dataset: { v: r.next.choices[b] },
        onclick: () => { d.version = r.next.choices[b]; versionIn.value = d.version; sync(); },
      }, b[0].toUpperCase() + b.slice(1), h('span', { class: 'n', text: r.next.choices[b] })))) : null;

    function sync() {
      const v = d.version.trim();
      for (const b of seg?.querySelectorAll('button') || []) b.setAttribute('aria-checked', String(b.dataset.v === v));
      notesIn.hidden = hasEntry();
      entryNote.hidden = !hasEntry();
      const willPush = d.push && !!r.remote;
      steps.replaceChildren(...[
        r.file && r.file.version !== v && `Set package.json${r.lock ? ' and package-lock.json' : ''} to ${v || '…'}`,
        hasEntry() ? `Keep the ${v} entry already in ${r.changelog.name}` : `Add this entry to the top of ${r.changelog.name}${r.changelog.exists ? '' : ' (a new file)'}`,
        `Commit "${d.title.trim() ? `${v}: ${d.title.trim()}` : `chore: release ${tagOf(v)}`}" on ${r.branch || 'this branch'}`,
        `Tag it ${tagOf(v)}`,
        willPush ? `Push ${r.branch} and ${tagOf(v)} to ${r.remote}` : 'Keep it on this PC until you push it',
      ].filter(Boolean).map(t => h('li', { text: t })));
      const problem = r.blocker || (!valid(v) ? 'That isn\'t a version number like 1.2.3.' : null)
        || (!hasEntry() && !d.notes.trim() ? `Write something for ${r.changelog.name}.` : null);
      cut.textContent = `Cut release ${tagOf(valid(v) ? v : '…')}`;
      cut.disabled = !!problem || (ciRisk && !d.ack);
      why.textContent = problem || (ciRisk && !d.ack ? 'Tick the box above to release over CI that isn\'t green.' : '');
      why.hidden = !why.textContent;
    }

    const entryNote = h('p', { class: 'muted small rl-entry-note', text: `${r.changelog.name} already has an entry for this version. It goes in as it's written.` });
    const why = h('p', { class: 'muted small rl-why', hidden: true });
    versionIn.addEventListener('input', () => { d.version = versionIn.value.trim(); sync(); });
    titleIn.addEventListener('input', () => { d.title = titleIn.value; sync(); });
    notesIn.addEventListener('input', () => { d.notes = notesIn.value; sync(); });
    pushIn.addEventListener('change', () => { d.push = pushIn.checked; sync(); });
    ackIn.addEventListener('change', () => { d.ack = ackIn.checked; sync(); });

    const form = h('div', { class: 'rl-draft', role: 'group', 'aria-label': 'Release draft' },
      h('div', { class: 'rl-row' },
        h('label', { class: 'field-label rl-label', text: 'Version' }),
        seg, versionIn),
      h('p', { class: 'muted small rl-hint', text: r.next.prepared
        ? `package.json already says ${r.next.suggested}, so that's the one.`
        : `Suggested: ${r.next.bump}, for ${r.next.why}.` }),
      h('label', { class: 'field-label rl-label' }, 'Title', titleIn),
      h('div', { class: 'rl-label' },
        h('span', { class: 'field-label', text: r.changelog.name }),
        h('span', { class: 'field-hint', text: r.changelog.style === 'keepachangelog' ? ' Keep a Changelog style.' : ' In the style its earlier entries use.' })),
      notesIn, entryNote,
      h('p', { class: 'row-label rl-steps-label', text: 'Cut release will' }), steps,
      r.remote && h('label', { class: 'pj-check' }, pushIn, h('span', { text: `Push it to ${r.remote} too` })),
      ciRisk && h('label', { class: 'pj-check rl-ack' }, ackIn, h('span', { text: r.ci.state === 'failing' ? 'CI failed on this commit. Release it anyway.' : 'CI hasn\'t finished on this commit. Release it anyway.' })),
      err, why,
      h('div', { class: 'row wrap end rl-draft-acts' },
        r.total > 0 && act('Write it with Claude', e => polish(ctx, r, e.currentTarget)),
        act('Cancel', () => { drafts.delete(ctx.root); draw(ctx, r); }),
        cut));
    form.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); drafts.delete(ctx.root); draw(ctx, r); } });
    sync();
    return form;
  }

  async function doCut(ctx, r, btn) {
    const d = drafts.get(ctx.root);
    if (!d) return;
    btn.disabled = true;
    btn.textContent = d.push ? 'Releasing…' : 'Committing…';
    const res = await api.cutRelease({ root: ctx.root, head: r.head, version: d.version.trim(), title: d.title, notes: d.notes, push: d.push && !!r.remote, ack: d.ack }).catch(e => ({ ok: false, error: e.message }));
    if (!res?.ok) {
      const err = ctx.body.querySelector('.rl-err');
      if (err) { err.textContent = res?.error || 'Couldn\'t cut it.'; err.hidden = false; }
      btn.disabled = false;
      btn.textContent = `Cut release ${r.prefix}${d.version.trim()}`;
      if (res?.stale || res?.committed) { drafts.delete(ctx.root); if (res.committed) SB.toast(res.error); ctx.load(true); }
      return;
    }
    drafts.delete(ctx.root);
    done.set(ctx.root, res);
    SB.toast(res.pushed ? `${res.tag} is out. 🏷️` : res.pushError ? `${res.tag} is tagged here, but the push didn't go through.` : `${res.tag} is tagged on this PC.`);
    ctx.load(true);
  }

  async function push(ctx, tag, btn) {
    btn.disabled = true;
    btn.textContent = 'Pushing…';
    const res = await api.pushRelease({ root: ctx.root, tag }).catch(e => ({ ok: false, error: e.message }));
    if (!res?.ok) {
      btn.disabled = false;
      btn.textContent = `Push ${tag}`;
      return SB.toast(res?.error || 'The push didn\'t go through.');
    }
    done.set(ctx.root, { ok: true, pushed: true, tag, remote: res.remote });
    SB.toast(`${tag} is out. 🏷️`);
    ctx.load(true);
  }

  // Into the box of a new conversation in the project: Claude writes the entry, the card cuts the release.
  async function polish(ctx, r, btn) {
    if (SB.isCrabOnly()) return SB.claudeUpsell('release');
    btn.disabled = true;
    const version = drafts.get(ctx.root)?.version || r.next.suggested;
    const res = await api.releasePolishDraft({ root: ctx.root, version }).catch(() => null);
    btn.disabled = false;
    if (!res?.ok) return SB.toast(res?.error || 'Couldn\'t read its history.');
    SB.setView('chat');
    SB.newTabIn({ cwd: res.cwd, draft: res.draft });
  }

  SB.releasesCard = releasesCard;
})();
