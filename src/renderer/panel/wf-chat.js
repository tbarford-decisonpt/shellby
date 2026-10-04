/* Shellby panel — Build it with Claude: a chat beside the workflow editor, and
   the routine editor too.
   You say what you want; Claude changes the workflow while you watch, and can
   test it: the editor saves it (a new one switched off), runs it by hand, and
   the run comes back to Claude, who fixes what went wrong and tries again, a
   few rounds at most per message. workflows.js and routines.js own their
   editors and hand this a small host:
     noun -> 'workflow' or 'routine', for the words
     getDef() -> the workflow (or routine) as it is in the editor
     ask({ def, messages, runId }) -> one turn: { ok, reply, test, def?, errors? } | { ok: false, error }
     apply(def, { since }) -> show Claude's change: true, false if the editor's gone, or
       'conflict' if you changed it since `since` (the JSON Claude was sent)
     testSave() -> { ok, id } | { ok: false, error, declined? }
     startRun(id) -> { ok, runId } | { ok: false, error }
     stopRun(runId), getRun(runId) -> { id, status, error } | null
     openRun(runId)
     extras?(res, turns) -> elements to add under Claude's reply (optional)
     alive() -> false once the editor this chat belongs to has closed
   A run's updates come in through onRun({ id, status, error, waiting?, done?, steps? }).
   Claude's replies are untrusted text: they go through the escaping markdown
   renderer, and everything else through textContent. */
'use strict';
(function () {
  const { h } = SB;
  const MAX_ROUNDS = 3;         // test-and-fix rounds Claude takes on its own per message
  const MAX_TEXT = 2000;
  const POLL_MS = 4000;         // a test run's end is pushed; this catches one that ends without a word (its tab closed)
  const ENDED = new Set(['ok', 'error', 'stopped', 'interrupted']);
  const RUN_WORD = { ok: 'worked', error: 'failed', stopped: 'was stopped', interrupted: 'was interrupted' };
  const PREF_TESTS = 'shellby.wf.chatTests';
  const testsPref = () => { try { return window.localStorage.getItem(PREF_TESTS) !== 'off'; } catch { return true; } };
  const setTestsPref = on => { try { window.localStorage.setItem(PREF_TESTS, on ? 'on' : 'off'); } catch { /* lasts this session */ } };

  let chatN = 0;

  function create(host, { greeting = '' } = {}) {
    const n = ++chatN;
    const noun = host.noun || 'workflow';
    const s = {
      turns: [],         // what Claude sees: { role: 'user' | 'claude' | 'run', text }
      busy: false,       // a Claude call or a test run is under way
      stopped: false,    // Stop pressed: no more rounds until you say something
      rounds: 0,         // tests Claude has started since your last message
      run: null,         // { id, line } while a test run is going
      poll: null,        // the interval checking on it
      text: '',
    };

    const log = h('ol', { class: 'wf-chat-log', 'aria-label': 'The conversation', 'aria-live': 'polite' });
    const box = h('textarea', {
      class: 'field area wf-chat-text', id: `wfChatText${n}`, rows: 2, maxlength: MAX_TEXT,
      placeholder: 'Tell Claude what it should do, or what to change',
      oninput: e => { s.text = e.target.value; },
      onkeydown: e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } },
    });
    const sendBtn = h('button', { type: 'submit', class: 'btn primary slim-btn' }, 'Send');
    const stopBtn = h('button', { type: 'button', class: 'btn ghost slim-btn', hidden: true, onclick: stop }, 'Stop');
    const tests = h('input', { type: 'checkbox', checked: testsPref(), onchange: e => setTestsPref(e.target.checked) });
    const status = h('p', { class: 'wf-chat-status', role: 'status' });

    const el = h('section', { class: 'wf-chat', 'aria-labelledby': `wfChatHead${n}` },
      h('div', { class: 'wf-chat-head' },
        h('h3', { class: 'wf-h3', id: `wfChatHead${n}`, text: 'Build it with Claude' }),
        h('label', { class: 'toggle wf-chat-tests', title: 'Claude saves it (a new one switched off) and runs it by hand to see that it works, then fixes what went wrong. Anything risky still asks you first.' },
          tests, h('span', { class: 'switch' }), h('span', { text: 'Let Claude test it' }))),
      log,
      status,
      h('form', { class: 'wf-chat-form', novalidate: true, onsubmit: e => { e.preventDefault(); send(); } },
        h('label', { class: 'sr-only', for: box.id, text: 'Message to Claude' }),
        box,
        h('div', { class: 'wf-chat-btns' }, stopBtn, sendBtn)));

    if (greeting) say('claude', greeting);
    else line('hint', `Say what should happen and when. Claude changes the ${noun} while you watch, and can run it to check it works.`);
    paint();

    // ------------------------------------------------------------ the log

    function line(kind, text, extra = []) {
      const li = h('li', { class: `wf-chat-msg ${kind}` });
      const body = h('div', { class: 'wf-chat-body' });
      if (kind === 'claude') SB.renderMarkdownInto(body, text); else body.textContent = text;
      li.append(body, ...extra.filter(Boolean));
      log.append(li);
      li.scrollIntoView({ block: 'nearest' });
      return { li, body };
    }

    function say(role, text, extra) {
      s.turns.push({ role, text: String(text).slice(0, MAX_TEXT) });
      return line(role === 'user' ? 'you' : role === 'claude' ? 'claude' : 'run', text, extra);
    }

    // The box stays open while Claude works, so you can write the next thing.
    function paint(note = '') {
      sendBtn.disabled = s.busy;
      stopBtn.hidden = !s.busy;
      el.classList.toggle('busy', s.busy);
      status.replaceChildren(...(note ? [h('span', { class: 'wf-spin', 'aria-hidden': 'true' }), note] : []));
    }

    const runBtn = id => h('button', { type: 'button', class: 'btn ghost slim-btn', onclick: () => host.openRun(id) }, 'See the run');

    // ------------------------------------------------------------ talking to Claude

    async function send() {
      const text = s.text.trim();
      if (!text || s.busy) { if (!text) box.focus(); return; }
      s.text = '';
      box.value = '';
      s.stopped = false;
      s.rounds = 0;
      say('user', text);
      await ask(null);
    }

    async function ask(runId) {
      if (!host.alive()) return done(); // the editor closed: nothing more goes to Claude
      s.busy = true;
      paint(runId ? 'Claude is looking at the run…' : 'Claude is working on it…');
      const sent = host.getDef();
      const since = JSON.stringify(sent);
      let res;
      try { res = await host.ask({ def: sent, messages: s.turns, runId }); } catch { res = { ok: false, error: 'Couldn\'t reach Claude. Try again.' }; }
      if (!host.alive()) return done();
      if (!res?.ok) {
        line('err', res?.error || 'Claude couldn\'t answer that. Try saying it another way.');
        return done();
      }
      const applied = res.def ? host.apply(res.def, { since }) : false;
      const conflict = applied === 'conflict';
      const tagText = conflict ? `You changed the ${noun} while Claude worked, so this wasn't applied. Send it again and Claude will work on your version.`
        : applied ? (res.errors?.length ? `Changed the ${noun}. Some things still need fixing; they're marked.` : `Changed the ${noun}.`) : '';
      const wantsTest = res.test && !res.errors?.length && !conflict;
      say('claude', res.reply, [
        tagText ? h('p', { class: 'wf-chat-tag', text: tagText }) : null,
        ...(host.extras?.(res, s.turns) || []),
        wantsTest && !tests.checked ? testBtn() : null,
      ]);
      if (!wantsTest || !tests.checked || s.stopped) return done();
      if (s.rounds >= MAX_ROUNDS) {
        line('hint', `Claude has tried ${MAX_ROUNDS} times. Say what to do next, or press Test it.`, [testBtn()]);
        return done();
      }
      return test();
    }

    // You asked for a test yourself: it starts a fresh round count.
    function testBtn() {
      return h('button', {
        type: 'button', class: 'btn slim-btn',
        onclick: e => {
          if (s.busy) return;
          e.currentTarget.remove();
          s.rounds = 0;
          s.stopped = false;
          test();
        },
      }, 'Test it');
    }

    function done() {
      s.busy = false;
      s.run = null;
      unwatch();
      paint();
    }

    // ------------------------------------------------------------ test runs

    async function test() {
      if (!host.alive()) return done();
      s.busy = true;
      s.rounds++;
      paint('Saving it to test…');
      let saved;
      try { saved = await host.testSave(); } catch { saved = { ok: false, error: 'Couldn\'t save it.' }; }
      if (!host.alive()) return done();
      if (!saved?.ok) {
        if (saved?.declined) { line('run', 'You said no, so it wasn\'t saved or run.'); return done(); }
        say('run', `Couldn't save it to test: ${saved?.error || 'it has problems'}`);
        return s.stopped ? done() : ask(null);
      }
      // Stop pressed while it saved (or while the confirmation window was up): no run.
      if (s.stopped) { line('hint', 'Stopped. It\'s saved, but it didn\'t run.'); return done(); }
      paint('Running it…');
      let started;
      try { started = await host.startRun(saved.id); } catch { started = { ok: false, error: 'Couldn\'t start it.' }; }
      if (started?.ok && started.runId && (s.stopped || !host.alive())) {
        Promise.resolve(host.stopRun(started.runId)).catch(() => {});
        if (host.alive()) line('hint', 'Stopped the test run.');
        return done();
      }
      if (!started?.ok || !started.runId) {
        say('run', `The test run didn't start: ${started?.error || 'something went wrong'}`);
        return s.stopped ? done() : ask(null);
      }
      const { li, body } = line('run', 'Test run started.', [runBtn(started.runId)]);
      s.run = { id: started.runId, li, body };
      // A quick run can finish before this line: catch up once, in case its last update came first.
      await checkRun(started.runId);
      if (s.run?.id === started.runId) { unwatch(); s.poll = setInterval(() => checkRun(started.runId), POLL_MS); }
    }

    async function checkRun(id) {
      if (s.run?.id !== id || !host.alive()) return unwatch();
      let rec = null;
      try { rec = await host.getRun(id); } catch { /* the updates still come */ }
      if (rec && s.run?.id === rec.id && ENDED.has(rec.status)) onRun({ id: rec.id, status: rec.status, error: rec.error });
    }

    function unwatch() {
      clearInterval(s.poll);
      s.poll = null;
    }

    /** Every run update in the panel comes here; only the test run's matter. */
    function onRun(summary) {
      if (!s.run || summary?.id !== s.run.id) return;
      const { body } = s.run;
      if (summary.waiting?.question) { body.textContent = `The test run is asking you: ${summary.waiting.question}`; paint('Waiting for your answer…'); return; }
      if (summary.waiting?.permission) { body.textContent = 'The test run is waiting for you to allow something in its Claude tab.'; paint('Waiting for you…'); return; }
      if (!ENDED.has(summary.status)) {
        // A routine has no steps to count: Claude Code is at work in its tab.
        body.textContent = summary.steps ? `Test run: ${summary.done || 0} of ${summary.steps} steps done.` : 'Test run going in its own tab.';
        paint('Running it…');
        return;
      }
      const text = `The test run ${RUN_WORD[summary.status]}${summary.error ? `: ${String(summary.error).slice(0, 300)}` : '.'}`;
      body.textContent = text;
      s.turns.push({ role: 'run', text });
      const id = s.run.id;
      s.run = null;
      unwatch();
      if (s.stopped || summary.status === 'stopped') return done();
      ask(id);
    }

    function stop() {
      s.stopped = true;
      if (s.run) Promise.resolve(host.stopRun(s.run.id)).catch(() => {});
      paint(s.run ? 'Stopping the test run…' : 'Stopping after Claude\'s answer…');
    }

    return { el, onRun, focus: () => box.focus() };
  }

  SB.wfChat = { create };
})();
