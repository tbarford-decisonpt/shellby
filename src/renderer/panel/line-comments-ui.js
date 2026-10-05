/* Shellby panel — line comments on a turn's diff, sent back as one follow-up.
 *
 * Correcting Claude in chat means describing where ("in parse(), the bit after
 * the loop…"). In a diff you can just point: click a line's number (Shift+click
 * for several), say what should change, and carry on reading. Comments pile up
 * across files and turns until you send them, all at once, as one message that
 * quotes the code each is about (line-comments.js writes it). Whatever is in the box
 * goes with them as an overall note.
 *
 * Kept per conversation in localStorage until sent, so a restart doesn't lose a
 * half-finished review. The diff is read as before, and the review goes out
 * through SB.send like anything you type (so it queues if Shellby is busy).
 * Once sent, its comments are passed to main as corrections (corrections.js),
 * so the same one twice can become a rule in CLAUDE.md (lessons.js). */
'use strict';
(function () {
  const { h, $, api } = SB;
  const R = window.ShellbyLineComments;
  const STORE = 'shellby.lineComments.v1';
  const DISARM_MS = 4000;

  // ------------------------------------------------------------ storage

  const loadAll = () => {
    try {
      const all = JSON.parse(window.localStorage.getItem(STORE) || '{}');
      return all && typeof all === 'object' && !Array.isArray(all) ? all : {};
    } catch { return {}; }
  };

  function commentsOf(tab) {
    if (!tab.review) tab.review = R.sanitize(loadAll()[tab.id]);
    return tab.review;
  }

  function setComments(tab, list) {
    tab.review = list;
    // Every write tidies the rest too: a closed conversation's comments age out.
    const all = {};
    for (const [id, kept] of Object.entries(loadAll())) {
      const fresh = R.sanitize(kept);
      if (fresh.length) all[id] = fresh;
    }
    if (list.length) all[tab.id] = list;
    else delete all[tab.id];
    try { window.localStorage.setItem(STORE, JSON.stringify(all)); } catch { /* lasts this session */ }
    refresh(tab);
  }

  const sameChange = (c, ref) => c.root === ref.root && c.before === ref.before && c.after === ref.after;
  const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  // Everything showing comments in this tab: open diffs, change blocks, the bar.
  function refresh(tab) {
    for (const view of tab.reviewViews || []) {
      if (view.el.isConnected) view.draw();
      else tab.reviewViews.delete(view);
    }
    for (const block of tab.el.querySelectorAll('details.changes[data-before]')) markBlock(tab, block);
    if (tab.isActive) renderBar();
  }

  // A turn's block says how many comments wait on it, next to its +/− counts.
  function markBlock(tab, block) {
    const ref = { root: block.dataset.root, before: block.dataset.before, after: block.dataset.after };
    const n = commentsOf(tab).filter(c => sameChange(c, ref)).length;
    let badge = block.querySelector(':scope > summary .chg-notes');
    if (!n) { badge?.remove(); return; }
    if (!badge) block.querySelector(':scope > summary').append(badge = h('span', { class: 'chg-notes' }));
    badge.textContent = plural(n, 'comment');
  }
  SB.markReviewBlock = markBlock;

  // ------------------------------------------------------------ one file's diff

  /** One file's diff for a turn, with its lines open to comments. */
  SB.reviewDiff = (tab, patch, { file, ref, binary }) => {
    const rows = R.numberLines(patch);
    if (!rows.some(R.commentable)) return SB.renderDiff(patch, { binary });
    const view = new DiffView(tab, rows, file, ref);
    (tab.reviewViews ||= new Set()).add(view);
    view.draw();
    return h('div', { class: 'rv-wrap' },
      h('p', { class: 'rv-hint small muted', text: 'Click a line number to comment · Shift+click for several' }),
      view.el, view.live);
  };

  class DiffView {
    constructor(tab, rows, file, ref) {
      Object.assign(this, { tab, rows, file, ref });
      this.pick = null;    // { a, b }: rows picked, a where it started
      this.box = null;     // the comment being written, if any
      this.lines = rows.map((r, i) => h('div', { class: `dl ${r.kind}`, dataset: { i }, title: r.kind === 'del' ? `Removed: line ${r.old} before this turn` : null },
        h('span', { class: 'ln', 'aria-hidden': 'true', text: R.commentable(r) ? String(r.kind === 'del' ? r.old : r.new) : '' }),
        h('span', { class: 'code', text: r.text || ' ' })));
      this.el = h('div', {
        class: 'diff reviewable', tabindex: '0',
        'aria-label': `Changes to ${file}. Up and Down to move between lines, Shift to pick several, Enter to comment.`,
      }, this.lines);
      this.live = h('span', { class: 'sr-only', 'aria-live': 'polite' });
      this.el.addEventListener('mousedown', e => {
        // A line number picks lines; it doesn't start a text selection.
        if (e.target.closest('.ln')) { e.preventDefault(); this.el.focus({ preventScroll: true }); }
      });
      this.el.addEventListener('click', e => {
        const ln = e.target.closest('.dl > .ln');
        if (!ln) return;
        const i = Number(ln.parentElement.dataset.i);
        if (!R.commentable(this.rows[i]) || this.busyWriting()) return;
        this.select(e.shiftKey && this.pick ? this.pick.a : i, i);
        this.write();
      });
      this.el.addEventListener('keydown', e => this.keydown(e));
    }

    // ---- picking lines

    select(a, b) {
      this.pick = { a, b };
      const [lo, hi] = a <= b ? [a, b] : [b, a];
      this.lines.forEach((el, i) => {
        el.classList.toggle('picked', i >= lo && i <= hi && R.commentable(this.rows[i]));
        el.classList.toggle('cursor', i === b);
      });
    }

    clearPick() {
      this.pick = null;
      for (const el of this.lines) el.classList.remove('picked', 'cursor');
    }

    keydown(e) {
      if (e.target !== this.el) return; // typing in a comment box
      const step = { ArrowDown: 1, ArrowUp: -1 }[e.key];
      if (step) {
        e.preventDefault();
        const from = this.pick ? this.pick.b : step > 0 ? -1 : this.rows.length;
        let i = from + step;
        while (i >= 0 && i < this.rows.length && !R.commentable(this.rows[i])) i += step;
        if (i < 0 || i >= this.rows.length) return;
        this.select(e.shiftKey && this.pick ? this.pick.a : i, i);
        this.lines[i].scrollIntoView({ block: 'nearest' });
        const a = R.anchor(this.rows, this.pick.a, i);
        if (a) this.live.textContent = `${R.where(a)}: ${this.rows[i].text}`;
      } else if (e.key === 'Enter' && this.pick && !this.busyWriting()) {
        e.preventDefault();
        this.write();
      } else if (e.key === 'Escape' && this.pick) {
        e.stopPropagation(); // not Stop, while you're only letting go of a line
        this.clearPick();
      }
    }

    // ---- writing a comment

    // Words you're halfway through aren't thrown away for another line: back to them.
    busyWriting() {
      if (!this.box?.text.value.trim() || this.box.pristine()) return false;
      this.box.text.focus();
      SB.toast('Finish or cancel the comment you are writing first.');
      return true;
    }

    // A box under the picked lines, or under the comment being edited.
    write(editing = null) {
      if (this.busyWriting()) return;
      this.closeBox();
      const anchor = editing || (this.pick && R.anchor(this.rows, this.pick.a, this.pick.b));
      if (!anchor) return;
      const text = h('textarea', {
        class: 'rv-text', rows: '2', maxlength: String(R.MAX_BODY),
        placeholder: 'What should change here? e.g. "no, keep this function pure"',
        'aria-label': `Comment on ${this.file}, ${R.where(anchor).toLowerCase()}`,
      });
      text.value = editing?.body || '';
      const add = h('button', { class: 'btn primary slim-btn', type: 'button', disabled: !text.value.trim() }, editing ? 'Save' : 'Add comment');
      const cancel = h('button', { class: 'btn ghost slim-btn', type: 'button' }, 'Cancel');
      const el = h('div', { class: 'rv-box' },
        h('div', { class: 'rv-where', text: R.where(anchor) }),
        text,
        h('div', { class: 'rv-actions' }, add, cancel, h('span', { class: 'small muted', text: 'Ctrl+Enter to add · Esc to cancel' })));
      const save = () => {
        const body = text.value.trim();
        if (!body) return;
        const list = commentsOf(this.tab);
        const c = editing
          ? { ...editing, body, at: Date.now() }
          : { id: newId(), file: this.file, ...this.ref, ...anchor, body, at: Date.now() };
        el.remove();
        this.box = null;
        this.clearPick();
        // Sent or discarded while you were editing it: what you wrote stays, as a new one.
        const stillThere = editing && list.some(x => x.id === c.id);
        setComments(this.tab, stillThere ? list.map(x => (x.id === c.id ? c : x)) : [...list, editing ? { ...c, id: newId() } : c]);
        this.el.focus({ preventScroll: true });
      };
      text.addEventListener('input', () => { add.disabled = !text.value.trim(); });
      text.addEventListener('keydown', e => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.closeBox(); this.el.focus({ preventScroll: true }); }
      });
      add.addEventListener('click', save);
      cancel.addEventListener('click', () => { this.closeBox(); this.el.focus({ preventScroll: true }); });
      this.box = { el, text, editing, pristine: () => text.value === (editing?.body || '') };
      if (editing) this.draw(); // hides the note it replaces
      this.place(el, editing ? R.rowsFor(this.rows, editing)?.last : Math.max(this.pick.a, this.pick.b));
      text.focus();
    }

    closeBox() {
      if (!this.box) return;
      const wasEditing = this.box.editing;
      this.box.el.remove();
      this.box = null;
      if (wasEditing) this.draw();
    }

    // After row i and any notes already hanging off it (at the top if it no longer lines up).
    place(el, i) {
      if (i == null) { this.el.prepend(el); return; }
      let at = this.lines[i];
      while (at.nextElementSibling && !at.nextElementSibling.classList.contains('dl')) at = at.nextElementSibling;
      at.after(el);
    }

    // ---- the comments already left here

    draw() {
      for (const n of this.el.querySelectorAll('.rv-note')) n.remove();
      for (const el of this.lines) el.classList.remove('commented');
      const mine = c => c.file === this.file && sameChange(c, this.ref);
      const sent = (this.tab.sentReview || []).filter(mine).map(c => ({ ...c, sent: true }));
      for (const c of [...sent, ...commentsOf(this.tab).filter(mine)]) {
        if (this.box?.editing?.id === c.id) continue;
        const span = R.rowsFor(this.rows, c);
        if (span) for (let i = span.first; i <= span.last; i++) if (R.commentable(this.rows[i])) this.lines[i].classList.add('commented');
        this.place(this.note(c), span?.last);
      }
    }

    note(c) {
      const actions = c.sent ? [h('span', { class: 'rv-sent', text: 'sent' })] : [
        h('button', { class: 'rv-link', type: 'button', onclick: () => this.write(c) }, 'Edit'),
        h('button', { class: 'rv-link', type: 'button', onclick: () => setComments(this.tab, commentsOf(this.tab).filter(x => x.id !== c.id)) }, 'Delete'),
      ];
      return h('div', { class: `rv-note${c.sent ? ' sent' : ''}` },
        h('div', { class: 'rv-note-head' }, h('span', { class: 'rv-where', text: R.where(c) }), ...actions),
        h('div', { class: 'rv-body', text: c.body }));
    }
  }

  // ------------------------------------------------------------ the bar above the box

  // Two presses to discard, like Undo. The bar is redrawn whenever the queue is
  // (tabs.js), so the first press is remembered here, for exactly these comments.
  let armed = null; // { tab, n, timer }
  const disarm = () => { if (armed) clearTimeout(armed.timer); armed = null; };

  function renderBar() {
    const bar = $('review');
    if (!bar) return;
    const tab = SB.activeTab();
    const list = tab ? commentsOf(tab) : [];
    if (armed && (armed.tab !== tab || armed.n !== list.length)) disarm();
    bar.hidden = !list.length;
    if (!list.length) { bar.replaceChildren(); return; }
    const files = new Set(list.map(c => c.file)).size;
    const discard = h('button', { class: `btn ghost slim-btn${armed ? ' deny' : ''}`, type: 'button' }, armed ? `Discard ${plural(list.length, 'comment')}?` : 'Discard');
    discard.addEventListener('click', () => {
      if (armed) { disarm(); setComments(tab, []); return; }
      armed = { tab, n: list.length, timer: setTimeout(() => { armed = null; renderBar(); }, DISARM_MS) };
      renderBar();
    });
    bar.replaceChildren(
      SB.icon('M3 3.5h10v7H7l-3 2.5v-2.5H3z', { width: 1.4 }),
      h('button', { class: 'review-text', type: 'button', title: 'Show where they are', onclick: () => reveal(tab) },
        `${plural(list.length, 'review comment')}${files > 1 ? ` on ${files} files` : ''}`),
      h('button', { class: 'btn primary slim-btn', type: 'button', disabled: !!tab.sendingReview, title: 'Sends every comment as one message. Anything in the box goes with it as an overall note.', onclick: () => sendReview(tab) }, 'Send review'),
      discard);
  }
  SB.renderReview = renderBar;

  // Open the first turn with comments waiting and bring it into view.
  function reveal(tab) {
    const block = tab.el.querySelector('details.changes .chg-notes')?.closest('details.changes');
    if (!block) { SB.toast('Those changes are further back than this conversation shows.'); return; }
    block.open = true;
    block.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  async function sendReview(tab) {
    const list = commentsOf(tab);
    if (!list.length || tab !== SB.activeTab() || tab.sendingReview) return;
    const text = R.compose(list, $('input').value);
    if (!text) return;
    tab.sendingReview = true; // a second click while it goes would send it twice
    renderBar();
    let sent;
    try { sent = await SB.send(text); } finally { tab.sendingReview = false; }
    if (!sent) { renderBar(); return; }
    // Only what went: a comment added while it was sending waits for the next review.
    // What went is still shown where it was left, marked sent, until the panel reloads.
    const ids = new Set(list.map(c => c.id));
    // Each comment is a correction: the same one in two reviews and he offers to make it a rule.
    api.noteReviewComments(tab.id, list.map(c => ({ file: c.file, body: c.body })), list[0].id).catch(() => {});
    tab.sentReview = [...(tab.sentReview || []), ...list];
    setComments(tab, commentsOf(tab).filter(c => !ids.has(c.id)));
  }
})();
