/* Shellby panel — the learned-rule card: the same correction twice in a
 * project (a review comment, a Deny, an Undo; main's corrections.js spots it),
 * and he offers to write it into that project's CLAUDE.md.
 *
 * The card always shows exactly what goes into the file, worked out by main
 * from the file as it is now, and Add sends that same text back: if CLAUDE.md
 * changed in between, main writes nothing and the card shows the new version.
 * "Edit first" opens the rule's wording (and lets Claude word it, if you like);
 * "Not this one" means he never suggests it again. */
'use strict';
(function () {
  const { h, api } = SB;
  const PREVIEW_DELAY_MS = 250;

  /** A conversation's lesson item -> its card (answered ones as a single line). */
  SB.renderLesson = item => {
    const el = h('div', { class: 'lesson', role: 'group', 'aria-label': 'A rule Shellby could learn' });
    // Replayed or not, main knows whether it was answered (maybe in another tab).
    api.lessonState(item.id).then(s => {
      if (!s) settle(el, 'gone');
      else if (s.state !== 'open') settle(el, s.state, item.rule, item.type);
      else open(el, item);
    }).catch(() => settle(el, 'gone'));
    return el;
  };

  // A deny-rule card (5 nos to the same thing) writes a permission rule into a
  // settings file instead of CLAUDE.md; the rest of the card works the same.
  const isPerm = type => type === 'deny-rule';

  function settle(el, state, rule, type) {
    el.classList.add('done');
    const text = state === 'added' ? `${isPerm(type) ? 'Blocked for good' : 'Added to CLAUDE.md'}: ${rule || 'a new rule'}`
      : state === 'dismissed' ? "Not this one. He won't suggest it again."
        : 'A rule he offered here. Rules he has learned are in Toolbox → Memory.';
    el.replaceChildren(h('div', { class: 'lesson-line' },
      h('span', { class: 'chg-icon', 'aria-hidden': 'true', text: state === 'added' ? '✓' : '·' }),
      h('span', { text })));
  }

  function open(el, item) {
    const perm = isPerm(item.type);
    let rule = item.rule || '';
    let shown = null;        // the last preview: { file, where, added, fresh }
    let asking = 0;          // the newest preview asked for, so a slow one can't land late
    let timer = null;

    const ruleText = h('p', { class: 'lesson-rule', text: rule });
    const input = h('textarea', { class: 'field lesson-input', rows: '2', maxlength: '300', hidden: true, 'aria-label': 'The rule, in your words' });
    const word = h('button', { class: 'link-btn inline', type: 'button', hidden: true }, 'Word it with Claude');
    const note = h('p', { class: 'small muted lesson-note', role: 'status' });
    const where = h('p', { class: 'small muted lesson-where' });
    const what = h('pre', { class: 'ask-cmd lesson-preview' });
    const add = h('button', { class: 'btn primary slim-btn', type: 'button', disabled: true }, perm ? 'Add deny rule' : 'Add to CLAUDE.md');
    const edit = h('button', { class: 'btn slim-btn', type: 'button' }, 'Edit first');
    const no = h('button', { class: 'btn ghost slim-btn', type: 'button' }, 'Not this one');

    async function preview() {
      const mine = ++asking;
      add.disabled = true;
      const r = await api.lessonPreview(item.id, rule).catch(() => null);
      if (mine !== asking) return;
      show(r);
    }
    function show(r) {
      if (!r?.ok) {
        shown = null;
        what.hidden = true;
        where.textContent = '';
        note.textContent = r?.error || "Shellby couldn't read CLAUDE.md.";
        return;
      }
      shown = r;
      what.hidden = false;
      what.textContent = r.added.replace(/^\n+/, '');
      where.textContent = perm
        ? `${r.exists ? 'Changes' : 'Creates'} ${r.where} (other settings stay as they are):`
        : r.exists ? `${r.fresh ? 'Goes at the end of' : 'Goes under "Learned from your corrections" in'} ${r.where}:`
        : `Creates ${r.where} with:`;
      note.textContent = '';
      add.disabled = false;
    }
    const later = () => { clearTimeout(timer); add.disabled = true; timer = setTimeout(preview, PREVIEW_DELAY_MS); };

    input.addEventListener('input', () => { rule = input.value.replace(/\s+/g, ' ').trim(); later(); });
    input.addEventListener('keydown', e => { if (e.key === 'Enter') e.preventDefault(); }); // one line in the file
    edit.addEventListener('click', () => {
      input.value = rule;
      input.hidden = false;
      word.hidden = perm; // Claude words CLAUDE.md rules; a permission rule has a fixed form
      ruleText.hidden = true;
      edit.hidden = true;
      input.focus();
    });
    word.addEventListener('click', async () => {
      word.disabled = true;
      note.textContent = 'Asking Claude for the wording…';
      const r = await api.draftLesson(item.id).catch(() => null);
      word.disabled = false;
      if (!r?.ok) { note.textContent = r?.error || "Claude couldn't word it. Your own words are still there."; return; }
      input.value = rule = r.rule;
      note.textContent = '';
      preview();
    });
    add.addEventListener('click', async () => {
      if (!shown || !rule) return;
      add.disabled = true;
      const r = await api.addLesson(item.id, rule, shown.added).catch(() => null);
      if (r?.ok && perm) { settle(el, 'added', r.rule, item.type); SB.toast(`Added to ${r.where}. Claude Code won't ask for that again.`); return; }
      if (r?.ok) { SB.toolboxSetup?.learnedChanged(); settle(el, 'added', r.rule); SB.toast(`Added. New conversations in ${item.project || 'this project'} follow it.`); return; }
      if (r?.state) { settle(el, r.state, rule, item.type); return; }
      if (r?.preview) show(r.preview); // CLAUDE.md changed: here's what would go in now
      else add.disabled = false;
      note.textContent = r?.error || "Couldn't add it.";
    });
    no.addEventListener('click', async () => {
      no.disabled = true;
      const r = await api.dismissLesson(item.id).catch(() => null);
      if (r?.ok) settle(el, 'dismissed');
      else { no.disabled = false; note.textContent = "Couldn't save that. Try again."; }
    });

    el.replaceChildren(
      h('div', { class: 'ask-head' },
        h('span', { class: 'ask-crab' }, SB.sprite()),
        h('div', {},
          h('div', { class: 'lesson-title', text: perm ? 'Make it a deny rule?' : 'Make it a rule?' }),
          h('div', { class: 'ask-sub', text: item.headline || '' }))),
      h('div', { class: 'ask-body' },
        ruleText, input, h('div', { class: 'lesson-tools' }, word), where, what, note),
      h('div', { class: 'ask-actions' }, add, edit, no));
    preview();
  }
})();
