/* Shellby panel — what a turn changed: its files, each one's diff, and Undo.
   Part of Tab (feed.js), with the diff renderer it uses. */
'use strict';
(function () {
  const { h, api } = SB;
  const F = window.ShellbyFeedLogic;

  class TurnChanges {
    // ------------------------------------------------------------ what the turn changed
    // One block per turn in a git project: every file it touched, each one's
    // diff on a click, and Undo to put them back. The diffs are read from git
    // when you open them, not carried around in the transcript.
    renderChanges(item) {
      if (!Array.isArray(item.files) || !item.files.length) return;
      const ref = { root: item.root, before: item.before, after: item.after };
      const files = F.files(item.files.length + (item.more || 0));
      const undo = h('button', { class: 'btn ghost slim-btn', type: 'button' }, 'Undo');
      const note = h('span', { class: 'small muted', text: 'Puts these files back the way they were before this turn.' });
      const el = h('details', { class: 'changes', dataset: { root: item.root, before: item.before, after: item.after } },
        h('summary', {},
          h('span', { class: 'chg-icon', 'aria-hidden': 'true', text: '±' }),
          h('span', { class: 'chg-title', text: `${files} changed` }),
          h('span', { class: 'chg-add', text: `+${item.added}` }),
          h('span', { class: 'chg-del', text: `−${item.removed}` })),
        h('ul', { class: 'chg-files' }, item.files.map(f => this.changeRow(f, ref))),
        item.more ? h('p', { class: 'small muted chg-more', text: `…and ${item.more} more.` }) : null,
        h('div', { class: 'chg-actions' }, undo, note));

      // Two presses, so a stray click can't take a turn's work back.
      let armed = null;
      const disarm = () => { clearTimeout(armed); armed = null; undo.textContent = 'Undo'; undo.classList.remove('deny'); };
      undo.addEventListener('click', async () => {
        if (!armed) {
          undo.textContent = `Undo ${files}?`;
          undo.classList.add('deny');
          armed = setTimeout(disarm, 4000);
          return;
        }
        disarm();
        undo.disabled = true;
        const r = await api.undoChanges({ tabId: this.id, ...ref });
        if (r?.ok) return; // the 'undone' item marks the block
        undo.disabled = false;
        SB.toast(r?.error || "Couldn't undo that.", { ms: 5000 });
        if (r?.changedSince?.length) note.textContent = `Changed since: ${r.changedSince.slice(0, 4).join(', ')}${r.changedSince.length > 4 ? '…' : ''}`;
      });
      el.undoButton = undo;
      el.undoNote = note;
      SB.decorateChanges?.(this, el, ref); // Run checks, and room for the verdict and pictures (turn-checks.js)
      SB.markReviewBlock?.(this, el); // comments waiting on this turn (line-comments-ui.js)
      this.append(el);
    }

    // read: how to fetch one file's diff (a turn's, unless a comparison says otherwise).
    // A turn's own diff takes line comments (line-comments-ui.js); a comparison's doesn't.
    changeRow(f, ref, read = file => api.changesDiff({ tabId: this.id, ...ref, file })) {
      const reviewable = !!ref && !!SB.reviewDiff;
      const diff = h('div', { class: 'chg-diff', hidden: true });
      let loaded = false;
      const toggle = h('button', { class: 'chg-file', type: 'button', 'aria-expanded': 'false', title: f.path },
        h('span', { class: `chg-badge s-${f.status}`, text: f.status, title: STATUS_WORDS[f.status] || f.status }),
        h('span', { class: 'chg-path', text: f.path }),
        f.binary ? h('span', { class: 'chg-bin', text: 'binary' }) : [h('span', { class: 'chg-add', text: `+${f.added}` }), h('span', { class: 'chg-del', text: `−${f.removed}` })]);
      toggle.addEventListener('click', async () => {
        const open = diff.hidden;
        diff.hidden = !open;
        toggle.setAttribute('aria-expanded', String(open));
        if (!open || loaded) return;
        loaded = true;
        diff.replaceChildren(h('p', { class: 'small muted', text: 'Reading the diff…' }));
        const r = await read(f.path);
        if (r?.error) { loaded = false; diff.replaceChildren(h('p', { class: 'small warn', text: r.error })); return; }
        const shown = reviewable && !f.binary ? SB.reviewDiff(this, r.patch, { file: f.path, ref, binary: f.binary }) : SB.renderDiff(r.patch, { binary: f.binary });
        // A turn's own file opens in VS Code's diff too (turn-checks.js); a comparison's doesn't.
        const bar = ref ? SB.editorBar?.(this, ref, f) : null;
        diff.replaceChildren(...[bar, shown, r.truncated ? h('p', { class: 'small muted', text: 'That is as much of it as fits here.' }) : null].filter(Boolean));
      });
      return h('li', {}, toggle, diff);
    }

    markUndone(item) {
      const el = [...this.el.querySelectorAll('details.changes')].find(d => d.dataset.after === item.after);
      if (!el || el.classList.contains('undone')) return;
      el.classList.add('undone');
      el.querySelector('.chg-title').textContent += ' · undone';
      if (el.undoButton) { el.undoButton.disabled = true; el.undoButton.textContent = 'Undone'; }
      if (el.undoNote) el.undoNote.textContent = 'These files are back the way they were before this turn.';
    }
  }

  SB.extendTab(TurnChanges);

  const STATUS_WORDS = { A: 'Added', M: 'Modified', D: 'Deleted', T: 'Type changed' };

  // A unified diff as coloured lines. Text only: nothing in a diff is markup.
  SB.renderDiff = (patch, { binary = false } = {}) => {
    const rows = F.diffRows(patch).map(r => h('span', { class: `dl ${r.cls}`, text: r.text }));
    if (!rows.length) return h('p', { class: 'small muted', text: binary ? 'A binary file: nothing to show line by line.' : 'No line changes (a mode or line-ending change).' });
    return h('pre', { class: 'diff' }, rows);
  };
})();
