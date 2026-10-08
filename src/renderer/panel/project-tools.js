/* Shellby panel — Helpers, a card on a project's page (src/main/ipc/project-tools.js):
   When did this break? (git bisect in a copy), Check the docs (fixes in a
   copy, or a weekly report you save as a routine) and Show me around (a tour,
   in Ask first).

   Every one opens a conversation with its prompt in the box: nothing goes to
   Claude, and none of your usage is spent, until you press Send. The panel
   names the project by the root the page was given; main looks it up. */
'use strict';
(function () {
  const { h, api, state } = SB;

  const forms = new Map(); // root -> what you'd typed in the bisect form, so a redraw keeps it
  const tagsFor = new Map(); // root -> [{ name, date }]

  function openTab(tabId) {
    SB.setView('chat');
    if (state.tabs.has(tabId)) SB.activate(tabId); else SB.openHistory(tabId);
  }

  // Runs one helper: the button says it's busy, a failure says why, and the
  // conversation it opened comes to the front.
  async function run(btn, busyText, call, done) {
    if (SB.isCrabOnly()) return SB.claudeUpsell('helpers');
    const was = btn.textContent;
    btn.disabled = true;
    btn.textContent = busyText;
    const r = await call().catch(() => null);
    btn.disabled = false;
    btn.textContent = was;
    if (!r?.ok) {
      if (r?.needsClaude) return SB.claudeUpsell('helpers');
      return SB.toast(r?.error || "Couldn't start that.", { ms: 7000 });
    }
    openTab(r.tabId);
    SB.toast(done, { ms: 6000 });
    return r;
  }

  /** The Helpers card. project: { root, name } (a clone on this PC). */
  function card({ root, name }) {
    const form = forms.get(root) || { open: false, what: '', test: '', good: '', other: '' };
    forms.set(root, form);
    const box = h('section', { class: 'pj-panel pt-card', 'aria-label': 'Helpers' }, h('p', { class: 'row-label', text: 'Helpers' }));
    const row = (title, sub, ...acts) => h('div', { class: 'pt-row' },
      h('div', { class: 'pt-text' }, h('p', { class: 'pt-title', text: title }), h('p', { class: 'muted small', text: sub })),
      h('div', { class: 'row wrap pt-acts' }, acts));
    const btn = (text, onclick, cls = 'btn slim-btn') => h('button', { type: 'button', class: cls, text, onclick });

    // append() writes a null as text, unlike h(): only what's there goes in.
    box.append(...[
      row('When did this break?', 'Claude finds the commit that broke it with git bisect, in a copy, so your checkout stays put.',
        btn(form.open ? 'Close' : 'Find it…', () => { form.open = !form.open; redraw(); })),
      form.open ? bisectForm(root, form) : null,
      row('Show me around', `A tour of ${name}: how to run it, what's where, and a good first change. Changes nothing.`,
        btn('Show me around', e => run(e.currentTarget, 'Opening…', () => api.showMeAround(root), 'Read the prompt, then send it. It runs in Ask first, so nothing changes.'))),
      row('Check the docs', 'Claude checks the README and docs against the code and fixes what is out of date, in a copy on its own branch.',
        btn('Check the docs', e => run(e.currentTarget, 'Making a copy…', () => api.checkDocs(root), "It's in a copy on its own branch. Read the prompt, then send it.")),
        btn('Make it automatic…', () => makeRoutine(root), 'btn ghost slim-btn')),
      h('p', { class: 'muted small pt-foot', text: 'Each one puts its prompt in a new conversation for you to read. Nothing is sent, and none of your Claude usage is spent, until you press Send.' }),
    ].filter(Boolean));

    function redraw() { box.replaceWith(card({ root, name })); }
    return box;
  }

  // What broke, how to see it, and the last version that worked.
  function bisectForm(root, form) {
    const what = h('textarea', { class: 'field pt-what', rows: '3', maxlength: '2000', placeholder: 'What broke? e.g. "The login page shows a blank screen" or "npm test fails in auth.spec"', 'aria-label': 'What broke' });
    what.value = form.what;
    what.addEventListener('input', () => { form.what = what.value; go.disabled = !what.value.trim(); });
    const test = h('input', { class: 'field', type: 'text', maxlength: '300', placeholder: 'A command that shows it (optional), e.g. npm test -- auth', 'aria-label': 'A command that shows it' });
    test.value = form.test;
    test.addEventListener('input', () => { form.test = test.value; });
    const pick = h('select', { class: 'field', 'aria-label': 'The last version that worked' });
    const other = h('input', { class: 'field', type: 'text', maxlength: '100', placeholder: 'A tag, branch or commit', 'aria-label': 'Tag, branch or commit', hidden: form.good !== '*' });
    other.value = form.other;
    other.addEventListener('input', () => { form.other = other.value.trim(); });
    const fill = tags => {
      pick.replaceChildren(
        h('option', { value: '', text: "I don't know: let Claude find one" }),
        ...tags.map(t => h('option', { value: t.name, text: t.date ? `${t.name} (${t.date})` : t.name })),
        h('option', { value: '*', text: 'Something else…' }));
      pick.value = [...pick.options].some(o => o.value === form.good) ? form.good : '';
    };
    fill(tagsFor.get(root) || []);
    if (!tagsFor.has(root)) api.bisectRefs(root).then(r => { tagsFor.set(root, r?.tags || []); fill(tagsFor.get(root)); });
    pick.addEventListener('change', () => { form.good = pick.value; other.hidden = pick.value !== '*'; if (!other.hidden) other.focus(); });
    const go = h('button', { type: 'button', class: 'btn primary slim-btn', text: 'Write the prompt', disabled: !form.what.trim() });
    go.addEventListener('click', async () => {
      const good = form.good === '*' ? form.other : form.good;
      const r = await run(go, 'Making a copy…', () => api.startBisect({ root, what: form.what, test: form.test, good }),
        "It's in a copy at your latest commit. Read the prompt, then send it.");
      if (r?.ok) forms.delete(root);
    });
    return h('div', { class: 'pt-form' },
      what,
      h('label', { class: 'pt-field' }, h('span', { class: 'small', text: 'How to see it' }), test),
      h('label', { class: 'pt-field' }, h('span', { class: 'small', text: 'The last version that worked' }), pick),
      other,
      h('div', { class: 'row wrap' }, go));
  }

  // A weekly report, opened in the routine editor. It only runs once you save it there.
  async function makeRoutine(root) {
    if (SB.isCrabOnly()) return SB.claudeUpsell('helpers');
    const r = await api.docsRoutine(root);
    if (!r?.ok) return SB.toast(r?.error || "Couldn't draft the routine.");
    SB.openRoutineEditor({ ...r.routine, isTemplate: true });
    SB.toast('Check it over, then press Save. Nothing runs until you do.', { ms: 7000 });
  }

  SB.projectTools = { card };
})();
