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
      const el = h('details', { class: 'changes', dataset: { root: item.root, before: item.before, after: item.after, ...(item.turnId ? { turn: item.turnId } : {}) } },
        h('summary', {},
          h('span', { class: 'chg-icon', 'aria-hidden': 'true', text: '±' }),
          h('span', { class: 'chg-title', text: `${files} changed` }),
          h('span', { class: 'chg-add', text: `+${item.added}` }),
          h('span', { class: 'chg-del', text: `−${item.removed}` })),
        this.changeList(item, ref),
        item.more ? h('p', { class: 'small muted chg-more', text: `…and ${item.more} more.` }) : null,
        h('div', { class: 'chg-actions' }, undo, note));
      if (F.quizWorthy(item)) this.addQuiz(el, ref);

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

    // The files, flat, or in the steps the turn wrote them in (src/main/change-story.js).
    changeList(item, ref) {
      const steps = F.storySteps(item);
      if (!steps) return h('ul', { class: 'chg-files' }, item.files.map(f => this.changeRow(f, ref)));
      return h('ol', { class: 'chg-story' }, steps.map(s => h('li', { class: 'chg-step' },
        h('div', { class: 'chg-step-title' },
          h('span', { text: s.title }),
          h('span', { class: 'chg-add', text: `+${s.added}` }),
          h('span', { class: 'chg-del', text: `−${s.removed}` })),
        h('ul', { class: 'chg-files' }, s.files.map(f => this.changeRow(f, ref))))));
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
      // Read again after a hunk of it is taken back, to show what's left.
      const load = async () => {
        diff.replaceChildren(h('p', { class: 'small muted', text: 'Reading the diff…' }));
        const r = await read(f.path);
        if (r?.error) { loaded = false; diff.replaceChildren(h('p', { class: 'small warn', text: r.error })); return; }
        const shown = reviewable && !f.binary
          ? SB.reviewDiff(this, r.patch, { file: f.path, ref, binary: f.binary, status: f.status, onChanged: load })
          : SB.renderDiff(r.patch, { binary: f.binary, file: f.path });
        // A turn's own file opens in VS Code's diff too (turn-checks.js); a comparison's doesn't.
        const bar = ref ? SB.editorBar?.(this, ref, f) : null;
        diff.replaceChildren(...[bar, shown, r.truncated ? h('p', { class: 'small muted', text: 'That is as much of it as fits here.' }) : null].filter(Boolean));
      };
      toggle.addEventListener('click', () => {
        const open = diff.hidden;
        diff.hidden = !open;
        toggle.setAttribute('aria-expanded', String(open));
        if (!open || loaded) return;
        loaded = true;
        load();
      });
      return h('li', {}, toggle, diff);
    }

    // "Quiz me": three questions on what this turn changed (src/main/quiz.js). Main
    // keeps the answers, so each pick asks it whether that was right. Not kept in
    // the transcript: it's there until the panel reloads.
    addQuiz(el, ref) {
      const start = h('button', { class: 'btn ghost slim-btn', type: 'button', title: 'Claude writes three questions on what this change does. Uses a little of your plan.' }, 'Quiz me');
      el.querySelector('.chg-actions').append(start);
      start.addEventListener('click', async () => {
        start.disabled = true;
        const box = h('div', { class: 'quiz', role: 'group', 'aria-label': 'Quiz on this change', 'aria-busy': 'true' },
          h('p', { class: 'small muted quiz-wait', text: 'Claude is writing three questions about this change…' }));
        el.append(box);
        el.open = true;
        const r = await api.startQuiz({ tabId: this.id, ...ref });
        box.removeAttribute('aria-busy');
        if (!r?.ok) {
          start.disabled = false;
          box.replaceChildren(h('p', { class: 'small warn', text: r?.error || "Couldn't write a quiz." }));
          return;
        }
        start.remove();
        const result = h('p', { class: 'quiz-result', 'aria-live': 'polite' });
        box.replaceChildren(...r.questions.map((q, i) => this.quizQuestion(q, i, ref, result, r.questions.length)), result);
        box.querySelector('.quiz-choice')?.focus();
      });
    }

    quizQuestion(q, i, ref, result, total) {
      const why = h('p', { class: 'small quiz-why', hidden: true, 'aria-live': 'polite' });
      const choices = q.choices.map(text => h('button', { class: 'quiz-choice', type: 'button', text }));
      choices.forEach((b, c) => b.addEventListener('click', async () => {
        choices.forEach(x => { x.disabled = true; });
        const r = await api.pickQuiz({ tabId: this.id, after: ref.after, question: i, choice: c });
        if (!r || r.error) {
          why.hidden = false;
          why.textContent = r?.error || "Couldn't check that one.";
          return;
        }
        b.classList.add(r.right ? 'right' : 'wrong');
        if (!r.right) choices[r.answer]?.classList.add('right');
        b.setAttribute('aria-label', `${b.textContent}: ${r.right ? 'right' : 'not quite'}`);
        why.hidden = false;
        why.textContent = `${r.right ? 'Right.' : 'Not quite.'} ${r.why || ''}`.trim();
        if (r.done) result.textContent = F.quizResult(r.score, total);
      }));
      return h('fieldset', { class: 'quiz-q' },
        h('legend', { text: `${i + 1}. ${q.question}` }),
        h('div', { class: 'quiz-choices' }, choices),
        why);
    }

    // ------------------------------------------------------------ Undo to here
    // A step that changed files and has a checkpoint before it (main's
    // step-undo.js) gets a button on its row. Hidden until the turn has ended
    // (its 'checkpoint' item): while it runs, the files are still moving.
    renderStepPoint(item) {
      const el = this.tools.get(item.toolId);
      if (!el) return;
      const btn = h('button', { class: 'btn ghost slim-btn step-undo', type: 'button', hidden: true, title: 'Puts the files back the way they were just before this step. Later steps of this turn go too; the conversation stays.' }, 'Undo to here');
      const step = { toolId: item.toolId, btn, el, done: false };
      let armed = null;
      const disarm = () => { clearTimeout(armed); armed = null; btn.textContent = 'Undo to here'; btn.classList.remove('deny'); };
      btn.addEventListener('click', async e => {
        e.preventDefault(); // a button in the row's summary: no folding open
        e.stopPropagation();
        if (step.done) return;
        if (!armed) { btn.textContent = 'Undo from here on?'; btn.classList.add('deny'); armed = setTimeout(disarm, 4000); return; }
        disarm();
        btn.disabled = true;
        const r = await api.undoToStep({ tabId: this.id, turnId: item.turnId, toolId: item.toolId });
        if (r?.ok) return; // the 'undone-step' item marks it
        btn.disabled = false;
        if (!r?.cancelled) SB.toast(r?.error || "Couldn't undo to there.", { ms: 5000 });
      });
      el.querySelector('summary')?.append(btn);
      this.stepUndos ??= new Map();
      if (!this.stepUndos.has(item.turnId)) this.stepUndos.set(item.turnId, []);
      this.stepUndos.get(item.turnId).push(step);
    }

    showStepUndos(cp) {
      if (!cp?.turnId) return;
      this.stepEnds ??= new Map();
      if (cp.end) this.stepEnds.set(cp.end, cp.turnId);
      for (const s of this.stepUndos?.get(cp.turnId) || []) if (!s.done) s.btn.hidden = false;
    }

    // That step and every later one of the turn are undone.
    markStepUndone(item) {
      const steps = this.stepUndos?.get(item.turnId) || [];
      const at = steps.findIndex(s => s.toolId === item.toolId);
      if (at < 0) return;
      steps.slice(at).forEach((s, i) => {
        s.done = true;
        s.el.classList.add('step-undone');
        s.btn.disabled = true;
        s.btn.textContent = 'Undone to here';
        s.btn.hidden = i > 0;
      });
    }

    markUndone(item) {
      // The whole turn went back: its steps have nothing left to undo.
      const turnId = this.stepEnds?.get(item.after);
      for (const s of (turnId && this.stepUndos?.get(turnId)) || []) { s.done = true; s.btn.hidden = true; }
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
  // file: its name, for the language's colours (code.js).
  SB.renderDiff = (patch, { binary = false, file = null } = {}) => {
    const paint = file ? SB.diffPainter?.(file) : null;
    const rows = F.diffRows(patch).map((r) => {
      const toks = paint && r.cls !== 'meta' ? paint(r.cls, r.text.slice(1)) : null;
      return toks ? SB.paintTokens(h('span', { class: `dl ${r.cls}` }, r.text[0] || ''), toks) : h('span', { class: `dl ${r.cls}`, text: r.text });
    });
    if (!rows.length) return h('p', { class: 'small muted', text: binary ? 'A binary file: nothing to show line by line.' : 'No line changes (a mode or line-ending change).' });
    return h('pre', { class: 'diff' }, rows);
  };
})();
