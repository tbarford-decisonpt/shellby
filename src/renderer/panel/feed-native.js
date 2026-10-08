/* Shellby panel — what Claude Code does by itself, as the feed shows it: one
   agent writing to another (SendMessage), a skill it reached for and what that
   skill is for, a memory it wrote down, switching itself to planning, and the
   to-do and background-command calls that the strip above the box already
   tracks (native-strip.js). Part of Tab (feed.js). */
'use strict';
(function () {
  const { h, api, state } = SB;
  const F = window.ShellbyFeedLogic;

  // Tools whose news is told elsewhere: the to-do strip and the background tray.
  const TODO_TOOLS = new Set(['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'TodoWrite']);
  const JOB_TOOLS = new Set(['TaskStop', 'TaskOutput']);

  /** A skill as the Toolbox knows it: by its full name, or a plugin's "plugin:skill". */
  function skillInfo(name) {
    const all = state.toolbox?.skills || [];
    return all.find(s => s.name === name) || all.find(s => s.name.endsWith(`:${name}`) || name.endsWith(`:${s.name}`)) || null;
  }

  // Whose words a message is: the helper lane it was sent from, or Claude itself.
  function senderOf(tab, item) {
    const lane = item.parent && tab.lanes.get(item.parent);
    if (!lane) return 'Claude';
    const title = lane.el.querySelector('.lane-title b')?.textContent;
    const name = lane.el.querySelector('.lane-type.name')?.textContent;
    return name || title || 'A helper';
  }

  class NativeFeed {
    // One agent writing to another: who to, and what it said. The reply comes
    // back in that helper's own lane, which picks up again (feed-lanes.js reopen).
    renderMessage(item, replay) {
      const m = item.message;
      const from = senderOf(this, item);
      const to = m.to.length > 30 && /^[a-f0-9]+$/i.test(m.to) ? 'a helper' : `@${m.to.replace(/^@/, '')}`;
      const text = m.text || m.summary || '';
      const long = text.length > 280;
      const textEl = h('div', { class: 'agent-msg-text', text: long ? `${text.slice(0, 280)}…` : text });
      const el = h('div', { class: `agent-msg${item.sub ? ' sub' : ''}`, role: 'note', dataset: { toolId: item.id, quiet: '1' } },
        h('div', { class: 'agent-msg-head' },
          h('span', { class: 'agent-msg-icon', 'aria-hidden': 'true', text: '📨' }),
          h('b', { text: from }), h('span', { class: 'muted', text: ' → ' }), h('b', { text: to }),
          m.summary && m.text ? h('span', { class: 'agent-msg-sum muted', text: ` · ${m.summary}` }) : null),
        textEl,
        long ? h('button', { class: 'link-btn inline', type: 'button', onclick: e => { textEl.textContent = text; e.target.remove(); } }, 'Show all') : null);
      this.tools.set(item.id, el);
      this.append(el, item.parent);
      if (!replay && !item.sub) this.setStatus(`Messaged ${to}`);
    }

    // Claude's plan (ExitPlanMode), to read before anything changes. Any line of
    // it can take a note; notes go back together as the reason it wasn't
    // approved yet (feed-logic.js planNotesMessage), and Claude revises it.
    renderPlanAsk(item, replay) {
      const tabId = this.id;
      const notes = [];            // [{ quote, note, line }]
      let card = null;
      const decide = async (decision, message) => {
        const ok = await api.answerPermission(tabId, item.requestId, decision, message);
        if (!ok) { SB.toast('That plan already expired.'); return; }
        if (decision !== 'deny') {
          const uiMode = F.modeAfterPlan(item.suggestions);
          if (uiMode) SB.chooseMode(uiMode, { quiet: true });
        }
      };

      const planEl = SB.renderMarkdownInto(h('div', { class: 'ask-plan msg assistant' }), item.plan || 'No plan text.');
      const noteList = h('ul', { class: 'plan-notes', 'aria-label': 'Your notes on the plan' });
      const overall = h('textarea', { class: 'field area plan-overall', rows: 2, placeholder: 'Anything else? (optional)', 'aria-label': 'Anything else about the plan' });
      const sendBtn = h('button', { class: 'btn', type: 'button', disabled: true }, 'Send notes');
      const count = () => notes.length + (overall.value.trim() ? 1 : 0);
      const sync = () => {
        sendBtn.disabled = !count();
        sendBtn.textContent = notes.length ? `Send ${notes.length} note${notes.length === 1 ? '' : 's'}` : 'Send notes';
        noteList.hidden = !notes.length;
        noteList.replaceChildren(...notes.map((n, i) => h('li', { class: 'plan-note' },
          h('div', { class: 'plan-note-quote muted small', text: n.quote }),
          h('div', { class: 'plan-note-text', text: n.note }),
          h('button', { class: 'icon-btn plan-note-x', type: 'button', 'aria-label': 'Remove this note', title: 'Remove', onclick: () => { n.line.classList.remove('noted'); notes.splice(i, 1); sync(); } }, '×'))));
      };
      overall.addEventListener('input', sync);

      // A note on one line: a box under it, Enter (or Ctrl+Enter) keeps it.
      const addNote = line => {
        if (card.classList.contains('decided') || line.querySelector(':scope > .plan-note-box')) return;
        const box = h('textarea', { class: 'field area plan-note-box', rows: 2, placeholder: 'What should change here?', 'aria-label': 'Your note on this line' });
        let closed = false;
        const done = keep => {
          if (closed) return; // Enter, then the blur its removal can bring
          closed = true;
          const text = box.value.trim();
          box.remove();
          if (keep && text) {
            notes.push({ quote: line.textContent.replace(/💬/g, '').trim(), note: text, line });
            line.classList.add('noted');
            sync();
          }
        };
        box.addEventListener('keydown', e => {
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); done(true); }
          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); }
        });
        box.addEventListener('blur', () => done(true));
        line.append(box);
        box.focus();
      };
      // Every line worth a note: list items, paragraphs, headings, code.
      for (const line of planEl.querySelectorAll('li, p, h1, h2, h3, h4, h5, h6, pre')) {
        if (line.tagName === 'P' && line.closest('li')) continue;
        line.classList.add('plan-line');
        line.append(h('button', { class: 'plan-line-note', type: 'button', title: 'Add a note on this line', 'aria-label': 'Add a note on this line', onclick: e => { e.stopPropagation(); addNote(line); } }, '💬'));
      }

      sendBtn.addEventListener('click', () => {
        const message = F.planNotesMessage(notes, overall.value);
        if (!message) return;
        card.notesSent = count();
        decide('deny', message);
      });
      const approve = h('button', { class: 'btn allow', type: 'button', onclick: () => decide(item.suggestions?.[0] ? 'always' : 'allow') }, 'Approve plan');
      const keep = h('button', { class: 'btn deny', type: 'button', title: 'Claude keeps planning, and asks what you would like changed',
        onclick: () => decide('deny', 'Keep planning: the user wants to refine the plan before anything changes. Ask them what they would like changed.') }, 'Keep planning');
      const copy = h('button', { class: 'btn ghost slim-btn', type: 'button', onclick: () => { api.copyText(item.plan || ''); SB.toast('Copied the plan.', { ms: 2500 }); } }, 'Copy');

      card = h('div', { class: 'ask plan-card', role: 'group', 'aria-label': "Claude's plan" },
        h('div', { class: 'ask-head' },
          h('span', { class: 'ask-crab' }, SB.sprite()),
          h('div', {},
            h('div', { class: 'ask-title', text: "Here's my plan" }),
            h('div', { class: 'ask-sub', text: 'Nothing changes until you approve. Hover a line and press 💬 to leave a note on it.' })),
          copy),
        h('div', { class: 'ask-body' }, planEl),
        noteList,
        overall,
        h('div', { class: 'ask-actions' }, approve, sendBtn, keep));
      sync();
      this.asks.set(item.requestId, card);
      const laneId = item.agent?.toolUseId;
      this.append(card, laneId);
      if (laneId) this.lanes.get(laneId)?.setAsking(true);
      if (!replay) {
        this.setStatus('Waiting for you to read the plan…');
        if (this.isActive) {
          approve.focus({ preventScroll: true });
          card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
      }
    }

    // A decided plan: what happened to it, in words, and nothing left to press.
    markPlanDecision(card, item) {
      card.querySelectorAll('button:not(.ask-more), textarea').forEach(el => { el.disabled = true; });
      const n = card.notesSent || 0;
      const text = item.decision === 'cancelled' ? '→ Cancelled'
        : item.decision === 'deny' ? (n ? `→ Sent back with ${n} note${n === 1 ? '' : 's'}` : '→ Kept planning')
          : `→ Plan approved${item.via === 'phone' ? ' from your phone' : item.via === 'deck' ? ' from the Stream Deck' : ''}`;
      card.append(h('div', { class: `ask-verdict ${item.decision === 'deny' || item.decision === 'cancelled' ? 'deny' : 'allow'}`, text }));
    }

    // Claude switched itself to planning (EnterPlanMode): nothing changes until a plan is approved.
    renderPlanning() {
      this.append(h('div', { class: 'home-mark plan-mark' },
        h('span', { class: 'chg-icon', 'aria-hidden': 'true', text: '🗺️' }),
        'Claude switched to planning: it reads and thinks, and changes nothing until you approve its plan.'));
    }
  }
  SB.extendTab(NativeFeed);

  /**
   * A tool row with more to say (feed.js renderTool calls this before it's shown):
   * a skill says what it's for, a memory what was kept, a to-do or a background
   * call steps back, since the strip above the box shows those.
   */
  SB.decorateTool = (tab, el, item) => {
    const summary = el.querySelector('summary');
    if (item.skill) {
      el.classList.add('skill-use');
      el.dataset.skill = item.skill;
      const info = skillInfo(item.skill);
      summary.querySelector('.t-detail').textContent = `/${item.skill}`;
      // Why it fits: the description is what Claude matched your ask against.
      el.append(h('div', { class: 'skill-why' },
        info?.description
          ? [h('b', { text: 'What it is for: ' }), info.description.slice(0, 400)]
          : 'A skill Claude picked by itself, because your ask matched what it says it is for.',
        h('button', { class: 'link-btn inline', type: 'button', onclick: () => SB.showToolbox('skill') }, 'See it in the Toolbox')));
      el.open = !item.sub && !!info?.description;
    }
    if (item.memory && !item.memory.index) {
      el.classList.add('memory-write');
      summary.querySelector('.t-label').textContent = 'Remembered';
      el.append(h('div', { class: 'memory-why' },
        'Claude wrote this down to remember next time. ',
        h('button', { class: 'link-btn inline', type: 'button', onclick: () => SB.openMemories?.(item.memory.file) }, 'See what Claude remembers')));
    } else if (item.memory?.index) {
      el.classList.add('memory-write', 'quiet-tool');
      summary.querySelector('.t-label').textContent = 'Updated its memory index';
    }
    if (TODO_TOOLS.has(item.name) || JOB_TOOLS.has(item.name)) { el.classList.add('quiet-tool'); el.dataset.quiet = '1'; }
    if (item.background || item.name === 'Monitor') {
      el.classList.add('bg-tool');
      summary.append(h('span', { class: 'lane-type bg', text: item.name === 'Monitor' ? 'watching' : 'background' }));
    }
  };

  // The first time Claude uses a skill in Shellby (main's wiring/native.js): the
  // row says so, and a toast for when you weren't looking.
  api.onSkillFirst?.(({ tabId, name } = {}) => {
    const tab = state.tabs.get(tabId);
    const row = tab && [...tab.el.querySelectorAll('.skill-use')].reverse().find(el => el.dataset.skill === name);
    row?.querySelector('summary')?.append(h('span', { class: 'first-badge', text: 'first time' }));
    SB.toast(`✦ First time Claude reached for /${name} here.`, { ms: 5000, action: 'What is it?', onAction: () => SB.showToolbox('skill') });
  });
})();
