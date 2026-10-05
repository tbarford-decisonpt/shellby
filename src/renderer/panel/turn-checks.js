/* Shellby panel — what Shellby checked about a turn, on its diff.
 *
 * Three things hang off a turn's changes block (feed.js renderChanges):
 *   - the tests' verdict (src/main/checks.js): a stamp in the summary row, and
 *     what ran, what failed and the end of the output inside, plus "Run checks";
 *   - before/after pictures of the dev server (src/main/shots.js), loaded the
 *     first time the block is opened, and a viewer to compare them;
 *   - "Open in VS Code" on each file's diff (src/main/editor.js).
 * Verdicts and pictures arrive as items of their own after the block, live and
 * on replay alike, and find their block by its `after` tree. Nothing here
 * hands main a path: every call names a change main already reported. */
'use strict';
(function () {
  const { h, api, state } = SB;

  const blockFor = (tab, after) => [...tab.el.querySelectorAll('details.changes')].reverse().find(d => d.dataset.after === after) || null;

  // ------------------------------------------------------------ the verdict

  function headline(item) {
    const cmds = item.commands || [];
    const failing = [...new Set(cmds.flatMap(c => c.failed || []))];
    const took = SB.duration(item.durationMs);
    if (item.status === 'pass') return { icon: '✅', tone: 'pass', text: `Checks passed · ${cmds.map(c => c.cmd).join(', ')} ${took}` };
    if (item.status === 'timeout') return { icon: '⏱', tone: 'fail', text: `Checks ran out of time · ${cmds.filter(c => c.timedOut).map(c => c.cmd).join(', ')}` };
    if (item.status === 'error') return { icon: '⚠', tone: 'warn', text: "Couldn't run the checks" };
    if (failing.length) {
      const names = failing.slice(0, 3).join(', ');
      return { icon: '❌', tone: 'fail', text: `${failing.length} failing: ${names}${failing.length > 3 ? '…' : ''}` };
    }
    return { icon: '❌', tone: 'fail', text: `${cmds.filter(c => !c.ok).map(c => c.cmd).join(', ')} failed` };
  }

  function verdictBody(item) {
    const stale = item.tree && item.after && item.tree !== item.after;
    return h('div', { class: 'chk-body' },
      stale ? h('p', { class: 'small muted', text: 'Checked the folder as it is now, which has changed since this turn.' }) : null,
      h('ul', { class: 'chk-cmds' }, (item.commands || []).map(c => h('li', { class: c.ok ? 'ok' : 'bad' },
        h('span', { class: 'chk-mark', 'aria-hidden': 'true', text: c.ok ? '✓' : '✗' }),
        h('code', { text: c.cmd }),
        h('span', { class: 'small muted', text: [c.ok ? 'passed' : c.timedOut ? 'ran out of time' : c.error ? "wouldn't start" : 'failed', SB.duration(c.durationMs)].join(' · ') }),
        c.failed?.length ? h('ul', { class: 'chk-failed' }, c.failed.map(n => h('li', { text: n }))) : null,
        c.tail ? h('details', { class: 'chk-tail' }, h('summary', { text: 'The end of what it printed' }), h('pre', { class: 'diff', text: c.tail })) : null))));
  }

  function stamp(block, item) {
    const v = headline(item);
    const where = block.querySelector('.chg-stamp');
    where.className = `chg-stamp ${v.tone}`;
    where.replaceChildren(h('span', { 'aria-hidden': 'true', text: v.icon }), ` ${v.text}`);
    where.hidden = false;
    block.querySelector('.chg-checks').replaceChildren(verdictBody(item));
    block.classList.remove('checking');
    if (block.runChecks) { block.runChecks.disabled = false; block.runChecks.textContent = 'Run checks again'; }
  }

  // A verdict whose turn isn't on screen (trimmed off the top, or a check
  // before bringing home with nothing new since) stands on its own line.
  SB.renderChecks = (tab, item) => {
    const block = item.after && blockFor(tab, item.after);
    if (block) return stamp(block, item);
    const v = headline(item);
    tab.append(h('details', { class: `chk-alone ${v.tone}` },
      h('summary', {}, h('span', { 'aria-hidden': 'true', text: v.icon }), ` ${v.text}`),
      verdictBody(item)));
  };

  // While a check runs: "Checking…" on the block it's for (or the newest).
  api.onChecksRunning?.(({ tabId, after, running }) => {
    const tab = state.tabs.get(tabId);
    // A check before bringing home (no turn of its own) says so in its toast instead.
    if (!tab || !after) return;
    const block = blockFor(tab, after);
    if (!block?.runChecks) return;
    block.classList.toggle('checking', !!running);
    block.runChecks.disabled = !!running;
    const where = block.querySelector('.chg-stamp');
    if (running) {
      where.className = 'chg-stamp busy';
      where.replaceChildren(h('span', { 'aria-hidden': 'true', text: '…' }), ' Checking…');
      where.hidden = false;
      block.runChecks.textContent = 'Checking…';
    } else if (where.classList.contains('busy')) {
      // Stopped without a verdict (he started something new, or the tab closed).
      where.hidden = true;
      block.runChecks.textContent = 'Run checks';
    }
  });

  // ------------------------------------------------------------ on every changes block

  SB.decorateChanges = (tab, el, ref) => {
    el.querySelector('summary').append(h('span', { class: 'chg-stamp', hidden: true }));
    const run = h('button', { class: 'btn ghost slim-btn', type: 'button', title: "Runs the project's own test scripts on this PC (its test script, and a typecheck or build). He asks first in a project he hasn't checked before." }, 'Run checks');
    run.addEventListener('click', async () => {
      run.disabled = true;
      const r = await api.runChecks({ tabId: tab.id, ...ref });
      if (r?.ok || r?.cancelled) return; // the verdict (or its absence) arrives on its own
      run.disabled = false;
      if (r?.declined) return; // you said no in the question: nothing more to say
      SB.toast(r?.error || "Couldn't run the checks.", { ms: 6000 });
    });
    el.runChecks = run;
    const actions = el.querySelector('.chg-actions');
    el.insertBefore(h('div', { class: 'chg-shots', hidden: true }), actions);
    el.insertBefore(h('div', { class: 'chg-checks' }), actions);
    actions.append(run);
  };

  // ------------------------------------------------------------ before/after pictures

  SB.renderShots = (tab, item) => {
    const block = item.after && blockFor(tab, item.after);
    const ids = item.shots;
    if (!block || !ids?.before || !ids?.after) return;
    const box = block.querySelector('.chg-shots');
    const thumb = (which, label) => {
      const img = h('img', { alt: `${label}: the page ${which === 'before' ? 'before' : 'after'} this turn`, loading: 'lazy' });
      const btn = h('button', { class: 'shot-thumb', type: 'button', 'aria-label': `Compare before and after, starting with ${label.toLowerCase()}` }, img, h('span', { class: 'shot-label', text: label }));
      return { img, btn };
    };
    const b = thumb('before', 'Before');
    const a = thumb('after', 'After');
    let loaded = null;
    const load = () => {
      loaded ||= Promise.all([ids.before, ids.after].map(id => api.shotImage({ tabId: tab.id, id }))).then(([x, y]) => {
        if (!x?.ok || !y?.ok) { box.replaceChildren(h('p', { class: 'small muted', text: 'Those pictures have been tidied away.' })); return null; }
        b.img.src = x.url;
        a.img.src = y.url;
        return { before: x.url, after: y.url };
      }).catch(() => { loaded = null; return null; }); // try again next time
      return loaded;
    };
    const open = async () => { const urls = await load(); if (urls) openViewer(urls, item.url); };
    b.btn.addEventListener('click', open);
    a.btn.addEventListener('click', open);
    box.replaceChildren(h('div', { class: 'shot-pair' }, b.btn, a.btn), h('p', { class: 'small muted', text: `Your dev server at ${item.url}` }));
    box.hidden = false;
    if (block.open) load(); else block.addEventListener('toggle', () => { if (block.open) load(); }, { once: true });
  };

  // One at a time: the two pictures over each other with a slider, or side by side.
  let viewerOpen = false;
  function openViewer({ before, after }, url) {
    if (viewerOpen) return; // a double click is one viewer
    viewerOpen = true;
    const back = document.activeElement;
    const top = h('img', { class: 'shot-after', src: after, alt: 'After this turn' });
    const slider = h('input', { type: 'range', min: '0', max: '100', value: '50', class: 'shot-slider', 'aria-label': 'Slide between before and after' });
    const stage = h('div', { class: 'shot-stage' }, h('img', { class: 'shot-before', src: before, alt: 'Before this turn' }), top);
    const clip = () => { top.style.clipPath = `inset(0 0 0 ${slider.value}%)`; };
    slider.addEventListener('input', clip);
    clip();
    const side = h('button', { class: 'btn ghost slim-btn', type: 'button', 'aria-pressed': 'false' }, 'Side by side');
    side.addEventListener('click', () => {
      const on = stage.classList.toggle('side');
      side.setAttribute('aria-pressed', String(on));
      slider.hidden = on;
      if (on) top.style.clipPath = 'none'; else clip();
    });
    const close = h('button', { class: 'btn slim-btn', type: 'button' }, 'Close');
    const box = h('div', { class: 'shot-viewer', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Before and after' },
      h('div', { class: 'shot-panel' },
        h('div', { class: 'shot-head' }, h('b', { text: 'Before and after' }), h('span', { class: 'small muted', text: url || '' }), side, close),
        stage, slider,
        h('p', { class: 'small muted', text: 'Left of the line is before, right of it is after.' })));
    const shut = () => { viewerOpen = false; box.remove(); document.removeEventListener('keydown', onKey, true); back?.focus?.(); };
    const onKey = e => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); shut(); }
      if (e.key === 'Tab') { // keep focus inside
        const f = [...box.querySelectorAll('button, input:not([hidden])')];
        const i = f.indexOf(document.activeElement);
        if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); } else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
      }
    };
    close.addEventListener('click', shut);
    box.addEventListener('click', e => { if (e.target === box) shut(); });
    document.addEventListener('keydown', onKey, true);
    document.body.append(box);
    slider.focus();
  }

  // ------------------------------------------------------------ Open in VS Code

  SB.editorBar = (tab, ref, f) => {
    const btn = h('button', { class: 'btn ghost slim-btn', type: 'button', title: `Open ${f.path} in VS Code's diff` }, 'Open in VS Code');
    const note = h('span', { class: 'small muted', role: 'status' });
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const r = await api.openInEditor({ tabId: tab.id, ...ref, file: f.path });
      btn.disabled = false;
      if (!r?.ok) { note.textContent = r?.error || "Couldn't open it."; return; }
      note.textContent = r.live ? 'Opened. The right side is the real file, so edits land in the project.' : 'Opened. Both sides are copies: the file has changed since.';
    });
    return h('div', { class: 'chg-diff-bar' }, btn, note);
  };
})();
