/* Shellby panel — what Shellby knows about each project, as the Projects page
   shows it (projects.js draws the page around these). Main gathers the facts
   (src/main/projects/insights.js); this only words and draws them, and sends
   back the buttons you press: each one starts the same task the page it comes
   from (Routines, GitHub, Streaks, History) would. */
'use strict';
(function () {
  const { h, api } = SB;

  const { plural } = SB;
  const ago = t => (t ? SB.relTime(t) : '');

  /** 9000 -> "2h 30m", 600 -> "10m", under a minute -> "". */
  function hours(seconds) {
    const m = Math.round((seconds || 0) / 60);
    if (m < 1) return '';
    if (m < 60) return `${m}m`;
    return `${Math.floor(m / 60)}h${m % 60 ? ` ${String(m % 60).padStart(2, '0')}m` : ''}`;
  }

  // ------------------------------------------------------------------ the row's chips

  const REASON = {
    ci: r => ({ text: r.count > 1 ? `${r.count} PRs failing` : 'CI failing', tone: 'bad', title: 'A pull request has failing checks' }),
    vuln: r => ({ text: plural(r.count, 'vulnerability', 'vulnerabilities'), tone: r.worst === 'critical' || r.worst === 'high' ? 'bad' : 'warn', title: r.worst && r.worst !== 'unrated' ? `Worst: ${r.worst}` : 'From the last dependency check' }),
    unpushed: r => ({ text: `${r.count} unpushed`, tone: 'warn', title: 'Commits no remote has yet' }),
    flaky: r => ({ text: `${r.count} flaky`, tone: 'warn', title: 'Tests that flaked this week' }),
    outdated: r => ({ text: `${r.count} outdated`, tone: 'info', title: 'Packages with newer versions' }),
  };

  /** The chips under a project's name: trouble first, then what's simply true. */
  function chips(p) {
    const i = p.insights || {};
    const out = (i.reasons || []).filter(r => REASON[r.id]).map(r => REASON[r.id](r));
    if (p.todoCount) out.push({ text: `${p.todoCount} to do`, tone: 'info', title: 'On its to-do list' });
    const week = hours(i.time?.seconds);
    if (week) out.push({ text: `⏱ ${week}`, tone: 'info', title: 'Time on it this week' });
    if (i.quiet) out.push({ text: `quiet ${i.quietDays}d`, tone: 'info', title: `No commits for ${plural(i.quietDays, 'day')}` });
    if (i.git?.dirty) out.push({ text: `${i.git.dirty} changed`, tone: 'info', title: 'Uncommitted changes' });
    for (const m of i.sticker?.marks || []) out.push({ text: m.icon, tone: 'mark', title: m.name });
    return out;
  }

  const MAX_CHIPS = 3;
  function chipRow(p) {
    const all = chips(p);
    if (!all.length) return null;
    const shown = all.slice(0, MAX_CHIPS);
    const more = all.length - shown.length;
    return h('span', { class: 'pj-chips' },
      shown.map(c => h('span', { class: `pj-chip ${c.tone}`, title: c.title, text: c.text })),
      more > 0 && h('span', { class: 'pj-chip more', title: all.slice(MAX_CHIPS).map(c => c.title).join(', '), text: `+${more}` }));
  }

  // ------------------------------------------------------------------ the tile

  // A project's sticker when it has earned one; its initial on a colour of its own until then.
  function tile(p, size = 'sm') {
    const art = p.insights?.sticker?.art;
    if (art?.pixels) {
      const box = h('span', { class: `pj-tile ${size} art`, 'aria-hidden': 'true' });
      box.append(SB.Sprite.grid(art.pixels, art.palette, { px: size === 'lg' ? 3 : 2 }));
      return box;
    }
    let hash = 0;
    for (const ch of p.name) hash = (hash * 31 + ch.charCodeAt(0)) % 360;
    return h('span', { class: `pj-tile ${size}`, 'aria-hidden': 'true', style: `--hue:${hash}`, text: (p.name.match(/[a-z0-9]/i)?.[0] || '#').toUpperCase() });
  }

  // ------------------------------------------------------------------ the page's cards

  const card = (title, ...body) => h('section', { class: 'pj-panel', 'aria-label': title }, h('p', { class: 'row-label', text: title }), ...body);
  const act = (text, onclick, cls = 'btn ghost slim-btn') => h('button', { type: 'button', class: cls, text, onclick });

  // Buttons that start a task: one press, then wait, then off to watch it.
  // It stays off once started: a second press would start a second task (and branch).
  function taskButton(text, start, cls) {
    const btn = act(text, async () => {
      btn.disabled = true;
      const r = await Promise.resolve().then(start).catch(() => null); // a call that throws is a "couldn't"
      if (r?.needsClaude) { btn.disabled = false; return SB.claudeUpsell?.('deps'); }
      if (!r?.ok) { btn.disabled = false; return SB.toast(r?.error || "Couldn't start that."); }
      SB.toast('Started. It\'s in a new conversation.');
    }, cls);
    return btn;
  }

  /** Time this week, the last commit and the last time you were in it, plus nudges. */
  function pulse(p, { onChange }) {
    const i = p.insights || {};
    const stats = [
      i.time && stat('This week', hours(i.time.seconds) || '0m'),
      stat('Last commit', i.lastCommitAt ? ago(i.lastCommitAt) : '—'),
      stat('Last worked in', i.lastWorkedAt ? ago(i.lastWorkedAt) : '—'),
    ];
    const extra = i.time ? [bars(i.time.days)] : [];
    if (i.nudgeKey) {
      const box = h('input', { type: 'checkbox' });
      box.checked = !i.muted;
      box.addEventListener('change', async () => { await api.muteProject(i.nudgeKey, !box.checked); onChange(); });
      extra.push(h('label', { class: 'toggle pj-nudge' }, box, h('span', { class: 'switch' }), 'Nudge me when it goes quiet'));
    }
    if (!i.time) extra.push(h('p', { class: 'muted small', text: 'Turn on History → Time to see the hours you spend here.' }));
    return card('Pulse', h('div', { class: 'pj-stats' }, stats), extra);
  }

  function stat(label, value) {
    return h('div', { class: 'pj-stat' }, h('span', { class: 'pj-stat-label', text: label }), h('b', { class: 'pj-stat-value', text: value }));
  }

  // A bar for each day of the week so far, tallest day full height, its initial under it.
  function bars(days = []) {
    const top = Math.max(1, ...days.map(d => d.seconds));
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`; // local, as timetrack.js keys days
    return h('div', { class: 'pj-week', role: 'img', 'aria-label': `This week: ${days.map(d => `${weekday(d.day)} ${hours(d.seconds) || 'none'}`).join(', ')}` },
      days.map(d => h('span', { class: `pj-day${d.day === today ? ' today' : ''}`, title: `${weekday(d.day)}: ${hours(d.seconds) || 'nothing'}` },
        h('span', { class: 'pj-bar', style: `--v:${d.seconds ? Math.max(0.08, d.seconds / top) : 0}` }),
        h('span', { class: 'pj-day-name', text: weekday(d.day).slice(0, 2) }))));
  }
  const weekday = day => new Date(`${day}T12:00:00`).toLocaleDateString([], { weekday: 'short' });

  /** CI, dependencies and flaky tests, each with the button that deals with it. */
  function health(p) {
    const i = p.insights || {};
    const rows = [];
    for (const pr of i.prs || []) {
      rows.push(h('li', { class: 'pj-h-row' },
        h('span', { class: `pj-dot ${pr.state === 'failing' ? 'crashed' : pr.state === 'passing' ? 'up' : pr.state === 'pending' ? 'starting' : 'off'}`, 'aria-hidden': 'true' }),
        h('span', { class: 'pj-h-text' }, h('b', { text: `#${pr.number} ${pr.title}` }),
          h('span', { class: 'muted small', text: pr.state === 'failing' ? `Failing: ${(pr.failing || []).join(', ') || 'checks'}` : `Checks ${pr.state === 'none' ? 'not reported' : pr.state}` })),
        h('span', { class: 'pj-h-acts' },
          pr.state === 'failing' && act('Fix this build', () => SB.startFrom.open('build', pr.key), 'btn slim-btn'),
          pr.state === 'failing' && taskButton('Ask why', () => api.askAboutCi(pr.key)),
          pr.reviewComments > 0 && act('Address the review', () => SB.startFrom.open('review', pr.key)),
          act('Open', () => api.openPr(pr.key)))));
    }
    const d = i.deps;
    if (d) {
      rows.push(h('li', { class: 'pj-h-row' },
        h('span', { class: `pj-dot ${!d.ok ? 'off' : d.worst === 'critical' || d.worst === 'high' ? 'crashed' : d.attention ? 'starting' : 'up'}`, 'aria-hidden': 'true' }),
        h('span', { class: 'pj-h-text' }, h('b', { text: d.label ? `Dependencies (${d.label})` : 'Dependencies' }), h('span', { class: 'muted small', text: `${d.summary}${d.at ? ` · checked ${ago(d.at)}` : ''}` })),
        h('span', { class: 'pj-h-acts' }, d.attention && taskButton('Bump & open a PR', () => api.bumpDeps(d.key, d.manager), 'btn slim-btn'))));
    }
    for (const f of i.flaky || []) {
      const what = f.status === 'quarantined' ? 'Quarantined' : f.status === 'fixing' ? 'Being fixed' : `Flaked ${plural(f.week || f.total, 'time')}${f.week ? ' this week' : ''}`;
      rows.push(h('li', { class: 'pj-h-row' },
        h('span', { class: `pj-dot ${f.status === 'watching' ? 'starting' : 'off'}`, 'aria-hidden': 'true' }),
        h('span', { class: 'pj-h-text' }, h('b', { text: f.label }), h('span', { class: 'muted small', text: what })),
        h('span', { class: 'pj-h-acts' },
          f.status === 'watching' && taskButton('Fix it', () => api.flakyAct({ key: f.key, id: f.id, action: 'fix' }), 'btn slim-btn'),
          f.status === 'watching' && taskButton('Quarantine', () => api.flakyAct({ key: f.key, id: f.id, action: 'quarantine' })),
          f.retry && taskButton('Try it again', () => api.flakyAct({ key: f.key, id: f.id, action: 'unquarantine' })))));
    }
    if (!rows.length) {
      return card('Health', h('p', { class: 'muted small pj-calm', text: p.local.length
        ? 'Nothing needs you here. Pull requests, dependency checks and flaky tests show up here once Shellby has seen them.'
        : 'Clone it to see its dependencies and tests here.' }));
    }
    return card('Health', h('ul', { class: 'pj-h-list' }, rows));
  }

  /** The last few conversations in this project, to pick back up. */
  function conversations(p, { newHere }) {
    const list = p.sessions || [];
    const i = p.insights || {};
    const resume = i.nudgeKey
      ? act('Where did we leave off?', () => { api.openProject(i.nudgeKey); SB.setView('chat'); })
      : p.local[0] && act('Where did we leave off?', () => newHere(p.local[0].root, p.journal?.draft || `Where did we leave off in ${p.name}? Summarize what changed recently, what's unfinished, and suggest the next step.`));
    if (!list.length) return card('Conversations', h('p', { class: 'muted small', text: 'None here yet.' }), h('div', { class: 'row wrap' }, resume));
    return card('Conversations',
      h('ul', { class: 'pj-convos' }, list.map(s => h('li', {},
        h('button', { type: 'button', class: 'pj-convo', onclick: () => { SB.setView('chat'); SB.openHistory(s.id); } },
          h('span', { class: 'pj-convo-title', text: s.title }),
          s.copy && h('span', { class: 'pj-tag', text: 'in a copy', title: 'In a copy of the project Shellby made for it' }),
          s.done && h('span', { class: 'pj-tag', text: 'done' }),
          h('span', { class: 'pj-convo-when', text: ago(s.updatedAt) }))))),
      h('div', { class: 'row wrap' }, resume));
  }

  // ------------------------------------------------------------------ where you left off

  const PIN_LABEL = { decision: 'Decided', next: 'Next', blocker: 'Blocked', note: 'Note' };
  // A pin half typed survives the card being redrawn (a note landing after a turn).
  const pinDraft = { root: null, text: '', kind: 'decision' };

  // One line of a note: "Half-done: a; b", or nothing when there's nothing in it.
  function noteLine(label, list) {
    const items = (Array.isArray(list) ? list : [list]).filter(Boolean);
    return items.length ? h('li', {}, h('b', { text: `${label}: ` }), items.join('; ')) : null;
  }

  function noteBody(n) {
    const touched = n.files?.length ? `${n.files.join(', ')}${n.moreFiles ? ` (+${n.moreFiles} more)` : ''}` : '';
    return h('ul', { class: 'pj-jn-lines' },
      noteLine('Last asked', n.asked),
      noteLine('Half-done', n.open),
      noteLine('Next', n.next),
      noteLine('Decided', n.decisions),
      noteLine('Done', n.done),
      noteLine('Committed', n.commits),
      noteLine('Touched', touched),
      n.dirty ? noteLine('Uncommitted', plural(n.dirty, 'file')) : null,
      noteLine('Ended with', n.ended));
  }

  function noteHead(n) {
    return h('span', { class: 'pj-jn-head' },
      h('b', { class: 'pj-jn-title', text: n.title }),
      h('span', { class: 'muted small', text: [n.at && ago(n.at), n.branch && `on ${n.branch}`, n.turns > 1 && plural(n.turns, 'prompt')].filter(Boolean).join(' · ') }));
  }

  /**
   * The handoff notes Shellby kept from the last sessions here: answered on the
   * spot, no Claude turn. "Carry on with Claude" hands Claude the same notes,
   * so it starts from them instead of reading its way back in.
   */
  function journal(p, { newHere, onChange, keptDetails }) {
    const j = p.journal;
    const root = p.local[0]?.root;
    if (!root) return null;
    const notes = j?.notes || [];
    const pins = j?.pins || [];
    const [latest, ...older] = notes;
    // Unpin and Forget offer Undo: main keeps the last one taken off and puts it back.
    const forget = async (what) => {
      const r = await api.removeFromJournal({ root, ...what }).catch(() => null);
      onChange();
      if (!r?.ok) return SB.toast(what.pinId ? "Couldn't unpin that." : "Couldn't forget that note.");
      SB.toast(what.pinId ? 'Unpinned.' : 'Note forgotten.', { action: 'Undo', onAction: async () => {
        const back = await api.restoreToJournal({ root, ...what }).catch(() => null);
        onChange();
        SB.toast(back?.ok ? (what.pinId ? 'Pinned again.' : 'Note back.') : back?.error || "Couldn't put that back.");
      } });
    };

    if (pinDraft.root !== root) Object.assign(pinDraft, { root, text: '', kind: 'decision' });
    const text = h('input', { type: 'text', class: 'pj-jn-input', maxlength: '300', placeholder: 'Pin a decision or next step…', 'aria-label': 'Pin a decision or next step', dataset: { keep: 'jn-text' } });
    const pinBtn = h('button', { type: 'submit', class: 'pj-jn-pin-btn', text: 'Pin' });
    text.value = pinDraft.text;
    const ready = () => { pinBtn.disabled = !text.value.trim(); };
    ready();
    text.addEventListener('input', () => { pinDraft.text = text.value; ready(); });
    // The kinds as a row of chips, each in its own colour; the field takes the chosen one's.
    const kinds = h('div', { class: 'pj-jn-kinds', role: 'radiogroup', 'aria-label': 'Kind' },
      Object.entries(PIN_LABEL).map(([k, label]) => h('label', { class: `pj-jn-kind pj-jn-${k}` },
        h('input', { type: 'radio', name: `jn-kind-${root}`, value: k, checked: k === pinDraft.kind, dataset: { keep: `jn-kind-${k}` },
          onchange: e => { pinDraft.kind = k; e.target.form.dataset.kind = k; } }),
        h('span', { text: label }))));
    const pinIt = async e => {
      e.preventDefault();
      if (!text.value.trim()) return;
      const r = await api.pinToJournal({ root, kind: pinDraft.kind, text: text.value });
      if (!r?.ok) return SB.toast(r?.error || "Couldn't pin that.");
      text.value = pinDraft.text = '';
      onChange();
    };
    const form = h('form', { class: 'pj-jn-form', onsubmit: pinIt, dataset: { kind: pinDraft.kind } },
      kinds, h('div', { class: 'pj-jn-box' }, text, pinBtn));

    if (!latest && !pins.length) {
      return card('Where you left off',
        h('p', { class: 'muted small', text: 'After each Claude Code session here, Shellby writes a short note: what was asked, what\'s half-done, what was decided. Nothing yet.' }),
        form);
    }
    return card('Where you left off',
      latest && h('div', { class: 'pj-jn-note' }, noteHead(latest), noteBody(latest)),
      older.length > 0 && keptDetails('journal', plural(older.length, 'earlier session'),
        h('ul', { class: 'pj-jn-older' }, older.map(n => h('li', {},
          h('details', {}, h('summary', {}, noteHead(n)), noteBody(n),
            act('Forget this note', () => forget({ sessionId: n.sessionId }))))))),
      pins.length > 0 && h('ul', { class: 'pj-jn-pins', 'aria-label': 'Pinned' }, pins.map(pin => h('li', {},
        h('span', { class: `pj-tag pj-jn-${pin.kind}`, text: PIN_LABEL[pin.kind] || 'Note' }),
        h('span', { class: 'pj-jn-pin-text', text: pin.text }),
        h('button', { type: 'button', class: 'link-btn', text: 'Unpin', 'aria-label': `Unpin: ${pin.text}`, onclick: () => forget({ pinId: pin.id }) })))),
      form,
      j?.draft && h('div', { class: 'row wrap' },
        act('Carry on with Claude', () => newHere(root, j.draft), 'btn slim-btn')),
      h('p', { class: 'muted small', text: 'Read from each session as it ends, never by asking Claude, so these notes cost no tokens to keep.' }));
  }

  /** "2 need you" and the like, for the line above the list. */
  function needsYou(projects) {
    return projects.filter(p => (p.insights?.attention || 0) > 0).length;
  }

  SB.pjFacts = { hours, chips, chipRow, tile, pulse, health, conversations, journal, needsYou };
})();
