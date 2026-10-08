/* Shellby panel — one conversation's feed, including crew lanes for subagents.
   This file holds the Tab itself: its feed, scrolling, the cap on how much it
   keeps, and what each item becomes. Its other parts are their own files:
   feed-notes.js (terminal handoff, branches, ! commands), feed-asks.js
   (permission cards and questions), feed-changes.js (what a turn changed) and
   feed-lanes.js (helper lanes). The words are feed-logic.js's. */
'use strict';
(function () {
  const { h, api, state } = SB;
  const F = window.ShellbyFeedLogic;


  // Top-level blocks kept in one conversation's feed. Past this the oldest are
  // dropped (see Tab.trim); the transcript on disk is never touched.
  const MAX_BLOCKS = 400;

  // A fork: one line that splits in two (try again from here, in a new tab).
  // Drawn rather than the ⑂ character, which most fonts render tiny and faint.
  const FORK = 'M5 4.5v7M6.5 3a1.5 1.5 0 1 1-3 0a1.5 1.5 0 1 1 3 0M6.5 13a1.5 1.5 0 1 1-3 0a1.5 1.5 0 1 1 3 0M12.5 5a1.5 1.5 0 1 1-3 0a1.5 1.5 0 1 1 3 0M11 6.5c0 2.5-6 2-6 5';
  SB.forkIcon = () => SB.icon(FORK, { width: 1.3 });

  const SUGGESTIONS = [
    'Tidy my Downloads folder into subfolders by file type',
    "What's eating the most disk space on C:?",
    'Find every file I changed today and list them',
    'Summarize the documents on my Desktop',
    'Build yourself a skill that renames screenshots by date, then use it',
    'Send three helpers to audit my Documents, Desktop and Downloads in parallel',
  ];

  class Tab {
    constructor(id, { title = 'New task', cwd = '', saved = false, routineId = null } = {}) {
      Object.assign(this, { id, title, cwd, saved, routineId });
      this.busy = false;
      this.busySince = null;      // when the running turn started (main's clock, or ours until it reports)
      this.pending = 0;
      this.crew = 0;
      this.outcome = null;
      this.unread = false;
      this.statusText = 'Working…';
      this.modStatus = new Map(); // mod name -> its status line ($.ui.status), under the box while this tab shows
      this.draft = '';
      this.attachments = [];
      this.queue = [];            // messages typed while busy: [{ text, attachments }]
      this.queuePaused = false;   // after an error, wait for the user before sending the next
      this.tools = new Map();     // tool_use_id -> element
      this.asks = new Map();      // requestId -> card
      this.lanes = new Map();     // Agent tool_use_id -> lane
      this.taskLane = new Map();  // task_id -> Agent tool_use_id
      this.trimmed = 0;           // blocks dropped off the top (see trim())
      this.trimmedNotice = null;
      // Not a live region: every tool step would be read out. The turn's end
      // and permission asks are announced instead (SB.announce).
      this.el = h('section', { class: 'feed', role: 'tabpanel', dataset: { tab: id } });
      this.empty = SB.$('emptyTemplate').content.firstElementChild.cloneNode(true);
      this.el.append(this.empty); // its links open through core.js's a[data-href] handler
      this.renderEmpty();

      // Keep the newest message in view. `stuck` = you're at the bottom; the
      // feed shrinks whenever the Working bar, queued chips or attachments
      // appear above the composer, and without this the end of your prompt
      // would slide under them.
      // Only you scrolling up lets go: the feed shrinking under a scroll event that is
      // still on its way (the Working bar, 34px, plus a new message's 10px rise) would
      // otherwise read as 'not at the bottom', and the resize below would then leave
      // your prompt's last lines hidden.
      this.stuck = true;
      this.lastTop = 0;
      this.el.addEventListener('scroll', () => {
        const near = this.distanceFromEnd() < 40;
        if (near || this.el.scrollTop < this.lastTop) this.stuck = near;
        this.lastTop = this.el.scrollTop;
      }, { passive: true });
      this.resizer = new ResizeObserver(() => { if (this.stuck && this.isShown) this.scrollToEnd(); });
      this.resizer.observe(this.el);
    }

    distanceFromEnd() { return this.el.scrollHeight - this.el.scrollTop - this.el.clientHeight; }

    scrollToEnd() {
      this.el.scrollTop = this.el.scrollHeight;
      this.stuck = true;
    }

    // ------------------------------------------------------------ empty state
    renderEmpty() {
      const e = this.empty;
      e.querySelector('.empty-crab').replaceChildren(SB.sprite());
      e.querySelector('.empty-folder').textContent = SB.tildify(this.cwd || state.cwd);
      e.querySelector('.hotkey-hint').textContent = SB.prettyAccel(state.settings.hotkey) || 'The tray icon';
      // A quest card takes the third suggestion's room.
      const picks = [...SUGGESTIONS].sort(() => Math.random() - 0.5).slice(0, SB.questCardShows?.() ? 2 : 3);
      e.querySelector('.suggestions').replaceChildren(...picks.map((s, i) =>
        h('button', { class: 'suggestion', type: 'button', style: `animation-delay:${i * 60}ms`, onclick: () => SB.send(s) },
          h('span', { class: 'glyph', text: '›' }), s)));
      SB.renderQuestCard?.(e.querySelector('.quest-card'));
      const pinned = state.pinned || [];
      e.querySelector('.pinned-row').hidden = !pinned.length;
      e.querySelector('.pinned-chips').replaceChildren(...pinned.map(p => SB.toolChip(p)));
    }

    // ------------------------------------------------------------ helpers
    get isEmpty() { return !this.empty.hidden; }

    append(el, parent) {
      this.empty.hidden = true;
      const host = (parent && this.lanes.get(parent)?.body) || this.el;
      const follow = this.stuck || this.distanceFromEnd() < 140;
      host.append(el);
      if (host === this.el) this.trim();
      if (follow && this.isShown) this.scrollToEnd();
      return el;
    }

    // An overnight autonomous run can produce thousands of blocks, and the panel
    // is never closed, so the oldest ones are dropped once there are more than a
    // long scroll of history above you. The full transcript stays on disk, and
    // reopening the conversation from History replays it.
    trim() {
      let over = this.el.children.length - MAX_BLOCKS;
      if (over <= 0) return;
      for (const el of [...this.el.children]) {
        if (over <= 0) break;
        if (el === this.empty || el === this.trimmedNotice) continue;
        this.forget(el);
        el.remove();
        this.trimmed++;
        over--;
      }
      this.showTrimmed();
    }

    // Drop the maps' references to a block that's gone, so a long conversation
    // doesn't keep every tool and lane it ever showed.
    forget(el) {
      const toolId = el.dataset?.toolId;
      if (toolId) this.tools.delete(toolId);
      const laneId = el.dataset?.laneId;
      if (laneId) {
        this.lanes.delete(laneId);
        for (const [taskId, useId] of this.taskLane) if (useId === laneId) this.taskLane.delete(taskId);
      }
    }

    showTrimmed() {
      if (!this.trimmedNotice) {
        this.trimmedNotice = h('div', { class: 'feed-trimmed' });
        this.el.prepend(this.trimmedNotice);
      }
      this.trimmedNotice.textContent = F.trimmedLine(this.trimmed);
    }

    get isActive() { return state.activeTab === this.id; }
    get isShown() { return SB.isShown(this.id); }   // in a pane, focused or not (tab-panes.js)

    setStatus(text) {
      this.statusText = text;
      if (this.isActive) SB.$('statusText').textContent = text;
    }

    // ------------------------------------------------------------ items
    render(item, { replay = false } = {}) {
      switch (item.kind) {
        case 'user':
          // Something you just sent always comes into view, even if you'd scrolled up.
          if (!replay) this.stuck = true;
          return this.renderUser(item);
        case 'text': {
          const el = SB.renderMarkdownInto(h('div', { class: `msg assistant${item.sub ? ' sub' : ''}` }), item.text);
          return this.append(el, item.parent);
        }
        case 'thinking':
          if (!replay && !item.sub) this.setStatus('Thinking…');
          return;
        case 'tool':
          return item.agent ? this.renderLane(item, replay) : this.renderTool(item, replay);
        case 'tool_result': return this.renderToolResult(item);
        case 'task': return this.renderTask(item, replay);
        case 'permission':
          if (!replay && this.isActive) SB.announce(item.toolName === 'AskUserQuestion' ? 'Claude has a question for you' : 'Claude is asking for your OK');
          return this.renderAsk(item, replay);
        case 'decision': return this.markDecision(item);
        case 'result':
          if (!replay && this.isActive) SB.announce(item.interrupted ? 'Claude stopped' : item.ok ? 'Claude finished' : 'Claude ended with an error');
          return this.renderResult(item);
        case 'changes': return this.renderChanges(item);
        case 'undone': return this.markUndone(item);
        case 'checks': return SB.renderChecks?.(this, item);   // turn-checks.js
        case 'shots': return SB.renderShots?.(this, item);     // turn-checks.js
        case 'tries': return SB.renderTries?.(this, item, replay); // tries.js
        // Shellby's own one-line notes: moved into a copy, from the phone, brought
        // home, pushed, compacted, started fresh, rewound.
        case 'moved': case 'phone': case 'home': case 'pushed': case 'compacted': case 'fresh': case 'rewound': {
          const mark = F.markFor(item, SB.compact);
          return this.append(h('div', { class: 'home-mark' }, h('span', { class: 'chg-icon', 'aria-hidden': 'true', text: mark.icon }), mark.text));
        }
        // A crit hit or a clean landing (src/main/surprises.js), kept with the turn that earned it.
        case 'surprise': return this.append(h('div', { class: `home-mark surprise-mark ${item.what === 'landing' ? 'landing' : 'crit'}` },
          h('span', { class: 'chg-icon', 'aria-hidden': 'true', text: item.what === 'landing' ? '🛬' : '🎲' }),
          h('span', {}, h('b', { text: item.title || (item.what === 'landing' ? 'Clean landing' : 'Critical hit!') }), ` ${item.text || ''}`)));
        case 'suggest': return this.renderSuggestion(item, replay); // feed-asks.js
        case 'handoff': return this.renderHandoff(item, replay);
        case 'branched': return this.renderBranched(item);
        case 'branched-off': return this.renderBranchedOff(item);
        case 'checkpoint': return; // where the files stood, for branching: nothing to show
        case 'shell': return this.renderShell(item, replay);
        case 'error': return this.append(this.troubleBlock(item.trouble, item.text));
        case 'lesson': return SB.renderLesson ? this.append(SB.renderLesson(item)) : undefined; // lessons.js
        // What a mod shows (toolbox-mods.js): always under its own name, so it can't pass for Claude or Shellby.
        case 'modlog': return this.append(h('div', { class: 'home-mark mod-mark' },
          h('span', { class: 'chg-icon', 'aria-hidden': 'true', text: '🧩' }),
          h('span', {}, h('b', { class: 'mod-name', text: item.plugin }), h('span', { class: 'mod-tag', text: 'mod' }), item.text)));
        case 'modtoast':
          if (!replay && this.isActive && state.view === 'chat') SB.toast(`🧩 ${item.plugin} (mod): ${item.text}`, { ms: item.ms });
          return;
        case 'modstatus':
          // plugin null: the conversation's process ended, and its mods with it.
          if (!item.plugin) this.modStatus.clear();
          else if (item.text) this.modStatus.set(item.plugin, item.text);
          else this.modStatus.delete(item.plugin);
          if (this.isActive) SB.renderModStatus?.(this);
          return;
      }
    }

    // Rewind: the feed starts over from what's left of the transcript.
    reset(items) {
      for (const el of [...this.el.children]) if (el !== this.empty) el.remove();
      this.tools.clear();
      this.asks.clear();
      this.lanes.clear();
      this.taskLane.clear();
      this.trimmed = 0;
      this.trimmedNotice = null;
      this.shellPending = null;
      this.empty.hidden = false;
      for (const item of items) this.render(item, { replay: true });
      this.scrollToEnd();
    }

    // Something went wrong: what happened in a sentence, and the next step as a
    // button (main's trouble.js picks both). What the program said isn't shown,
    // it's in the log, and Copy details puts it on the clipboard. A transcript
    // from before Shellby said it this way shows the program's words, as it did.
    troubleBlock(trouble, raw) {
      if (!trouble?.message) return h('div', { class: 'error-block', text: raw });
      const act = trouble.action && trouble.action.id !== 'copy'
        ? h('button', { class: 'btn slim-btn', type: 'button', onclick: () => SB.troubleAction(trouble.action.id, this) }, trouble.action.label)
        : null;
      // Only when there's more to it than the sentence already says.
      const more = raw && !trouble.message.includes(raw.trim().replace(/\.$/, ''));
      const copy = more ? h('button', { class: 'btn ghost slim-btn', type: 'button', title: 'What the program said, word for word, for a bug report or a search',
        onclick: () => { api.copyText(raw); SB.toast('Copied the details.', { ms: 2500 }); } }, 'Copy details') : null;
      return h('div', { class: 'error-block trouble', role: 'alert', dataset: { kind: trouble.kind } },
        h('p', { class: 'trouble-text', text: trouble.message }),
        act || copy ? h('div', { class: 'trouble-actions' }, act, copy) : null);
    }

    renderUser(item) {
      const routine = item.routine ? h('div', { class: 'routine-tag' }, '⟳ ', item.routine.name, item.routine.reason === 'catch-up' ? ' · catch-up run' : '') : null;
      // Messages sent since rewind came in carry an id, and a way back to just
      // before them: in this tab (rewind), or in a new one that leaves this be (branch).
      // One read mid-turn (a steer) is part of the turn it went into, which keeps its id.
      if (!item.steerId) {
        this.lastTurnId = item.turnId || null;
        this.lastAsk = item.text || ''; // for Try again, after something goes wrong
      }
      const back = item.turnId ? h('button', { class: 'msg-rewind', type: 'button', title: 'Rewind to just before this message', 'aria-label': 'Rewind to just before this message', onclick: () => SB.openRewind(this, item.turnId) }) : null;
      const fork = item.turnId ? h('button', { class: 'msg-branch', type: 'button', title: 'Try again from here, in a new tab', 'aria-label': 'Try again from here, in a new tab', onclick: () => SB.openBranch(this, item.turnId, 'before') }, SB.forkIcon()) : null;
      this.append(h('div', { class: 'msg user' }, back, fork, routine, item.text || '',
        item.attachments?.length ? h('div', { class: 'att-list' }, SB.attachmentChips(item.attachments)) : null));
    }

    renderTool(item, replay) {
      const el = h('details', { class: `tool pending${item.sub ? ' sub' : ''}` },
        h('summary', {},
          h('span', { class: 't-state' }),
          h('span', { class: 't-label', text: item.label }),
          h('span', { class: 't-detail', text: item.detail, title: item.detail })));
      el.dataset.toolId = item.id; // so trim() can forget it with the element
      this.tools.set(item.id, el);
      this.append(el, item.parent);
      if (!replay && !item.sub) this.setStatus(`${item.label} ${item.detail}`.trim());
      const lane = item.parent && this.lanes.get(item.parent);
      if (lane && !replay) lane.setActivity(`${item.label} ${item.detail}`);
    }

    renderToolResult(item) {
      const lane = this.lanes.get(item.id);
      if (lane) return lane.finish({ ok: !item.isError, stats: item.agentStats, resultText: item.text });
      const el = this.tools.get(item.id);
      if (!el) return;
      el.classList.remove('pending');
      el.classList.add(item.isError ? (/declined|denied|interrupted/i.test(item.text) ? 'denied' : 'err') : 'ok');
      if (item.text?.trim()) el.append(h('pre', { class: 't-result', text: item.text }));
    }

    // ------------------------------------------------------------ crew lanes
    renderLane(item, replay) {
      const index = this.lanes.size;
      const lane = new SB.Lane(item, index);
      lane.el.dataset.laneId = item.id; // so trim() can forget it with the element
      this.lanes.set(item.id, lane);
      this.append(lane.el, item.parent);
      if (!replay) this.setStatus(`Sent a helper: ${item.agent.description || item.agent.type}`);
    }

    renderTask(item, replay) {
      if (item.toolUseId && item.taskId) this.taskLane.set(item.taskId, item.toolUseId);
      const lane = this.lanes.get(item.toolUseId || this.taskLane.get(item.taskId));
      if (!lane) return;
      lane.update(item, replay);
    }

    renderResult(item) {
      for (const el of this.tools.values()) if (el.classList.contains('pending')) el.classList.replace('pending', item.ok ? 'ok' : 'err');
      const { label, waiting } = F.resultLabel(item);
      // A reply you might want to take somewhere else: a new tab that remembers
      // everything up to here, with the files as this turn left them.
      const turnId = this.lastTurnId;
      const fork = turnId && item.anchor ? h('button', { class: 'meta-branch', type: 'button', title: 'Branch from here: a new tab that carries on from this reply, leaving this one as it is', onclick: () => SB.openBranch(this, turnId, 'after') }, SB.forkIcon(), 'branch') : null;
      const cost = item.cost?.line ? item.cost : null;
      this.append(h('div', { class: `meta${item.ok || item.interrupted ? '' : ' bad'}${waiting ? ' waiting' : ''}${cost ? ' has-cost' : ''}`, title: waiting ? 'This turn ended, but something it started is still running.' : null },
        h('span', { text: [label, SB.duration(item.durationMs), item.turns ? `${item.turns} turns` : null].filter(Boolean).join(' · ') }), fork));
      // What the turn cost (src/main/turncost.js): the context chip's menu scrolls back to it.
      if (cost) this.append(h('div', { class: 'turn-cost', title: cost.detail || null, dataset: turnId ? { turn: turnId } : {}, text: cost.line }));
      if (!item.ok && !item.interrupted && item.error) this.append(this.troubleBlock(item.trouble, item.error));
      if (item.interrupted) for (const lane of this.lanes.values()) if (lane.status === 'running') lane.finish({ ok: false, stopped: true });
    }

    destroy() {
      this.resizer.disconnect();
      this.el.remove();
    }
  }

  // The feed's other files write their part of Tab as a class of their own;
  // this copies its methods (and getters) across, so they behave as if written here.
  SB.extendTab = (part) => {
    for (const name of Object.getOwnPropertyNames(part.prototype)) {
      if (name !== 'constructor') Object.defineProperty(Tab.prototype, name, Object.getOwnPropertyDescriptor(part.prototype, name));
    }
  };

  // Pictures get a thumbnail, fetched once per path (main reads the file; the
  // panel's CSP only loads images from data:).
  const thumbs = new Map();
  const isPicture = f => /\.(png|jpe?g|gif|webp)$/i.test(f);
  const thumbImg = f => {
    const img = h('img', { class: 'att-thumb', alt: '' });
    if (!thumbs.has(f)) thumbs.set(f, api.attachThumb(f).catch(() => null));
    thumbs.get(f).then(url => { if (url) img.src = url; else img.remove(); });
    return img;
  };

  SB.attachmentChips = (files, onRemove) => files.map((f, i) => h('span', { class: `att${isPicture(f) ? ' pic' : ''}`, title: f },
    isPicture(f) ? thumbImg(f) : null,
    h('span', { text: SB.basename(f) }),
    onRemove ? h('button', { type: 'button', 'aria-label': `Remove ${SB.basename(f)}`, onclick: () => onRemove(i) }, '×') : null));

  // The next step after something went wrong, by trouble.js's action id. `tab`
  // is the conversation it happened in (or null, from a toast).
  SB.troubleAction = async (id, tab = SB.activeTab()) => {
    const ask = tab?.lastAsk || '';
    const signIn = async () => { if (await api.claudeLogin()) SB.toast('Finish signing in in the window that opened. Shellby notices when you’re done.', { ms: 6000 }); };
    const actions = {
      retry: () => {
        if (!tab || !ask) return SB.toast('Type your message again: there was nothing to resend.');
        SB.activate(tab.id);
        return SB.resend(tab, ask);
      },
      'sign-in': signIn,
      setup: () => { SB.onboardPath = 'claude'; SB.setView('onboarding'); },
      'fresh-tab': () => SB.newTabIn({ cwd: tab?.cwd || state.cwd, draft: ask }),
      hold: async () => {
        if (!tab || !ask) return SB.toast('Type your message again, then hold it with Ctrl+Shift+Enter.');
        const r = await api.holdForReset({ kind: 'message', tabId: tab.id, text: ask, attachments: [] });
        SB.toast(r?.ok ? `Held. It goes at ${r.atText}, once your usage resets.` : r?.error || "Couldn't hold it.", { ms: 5000 });
      },
    };
    return actions[id]?.();
  };

  SB.Tab = Tab;
})();
