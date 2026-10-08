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
  const T = window.ShellbyTodos;


  // Top-level blocks kept in one conversation's feed. Past this the oldest are
  // dropped (see Tab.trim); the transcript on disk is never touched.
  const MAX_BLOCKS = 400;

  // A fork: one line that splits in two (try again from here, in a new tab).
  // Drawn rather than the ⑂ character, which most fonts render tiny and faint.
  const FORK = 'M5 4.5v7M6.5 3a1.5 1.5 0 1 1-3 0a1.5 1.5 0 1 1 3 0M6.5 13a1.5 1.5 0 1 1-3 0a1.5 1.5 0 1 1 3 0M12.5 5a1.5 1.5 0 1 1-3 0a1.5 1.5 0 1 1 3 0M11 6.5c0 2.5-6 2-6 5';
  SB.forkIcon = () => SB.icon(FORK, { width: 1.3 });

  // Edit rows whose diff isn't built yet -> { text (lower case), build() }, for find.js.
  const unbuiltDiffs = new WeakMap();
  SB.unbuiltDiffs = unbuiltDiffs;

  const SUGGESTIONS = [
    'Tidy my Downloads folder into subfolders by file type',
    "What's eating the most disk space on C:?",
    'Find every file I changed today and list them',
    'Summarize the documents on my Desktop',
    'Build yourself a skill that renames screenshots by date, then use it',
    'Send three helpers to audit my Documents, Desktop and Downloads in parallel',
  ];

  // The tour in a tab of its own, in Ask first, waiting to be sent. The folder
  // Shellby works in when it's a repository, or one you pick (tools:first-tour).
  async function firstTour() {
    const t = await api.firstTour();
    if (!t?.ok) return t?.cancelled ? null : t?.needsClaude ? SB.claudeUpsell('helpers') : SB.toast(t?.error || "Couldn't open the tour.");
    const r = await api.setSettings({ firstTour: false });
    state.settings = r.settings;
    SB.refreshEmptyStates();
    if (state.tabs.has(t.tabId)) SB.activate(t.tabId);
    SB.toast('Read the prompt, then send it. It runs in Ask first, so nothing changes.', { ms: 6000 });
  }

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
      this.todos = T.create();    // Claude's own to-do list, as its tool calls build it (shared/todos.js)
      this.jobs = [];             // what it left running in the background, from main's summary (jobs.js)
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
      // A new install's first tasks lead with a tour of a project, until it's opened once.
      const tour = state.settings.firstTour && !SB.isCrabOnly();
      const picks = [...SUGGESTIONS].sort(() => Math.random() - 0.5).slice(0, (SB.questCardShows?.() ? 2 : 3) - (tour ? 1 : 0));
      const chip = (text, onclick, i) => h('button', { class: 'suggestion', type: 'button', style: `animation-delay:${i * 60}ms`, onclick },
        h('span', { class: 'glyph', text: '›' }), text);
      e.querySelector('.suggestions').replaceChildren(
        ...(tour ? [chip('Show me around a project: what it is, how to run it, where to start', firstTour, 0)] : []),
        ...picks.map((s, i) => chip(s, () => SB.send(s), i + (tour ? 1 : 0))));
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
      // Claude's to-do list moves with its tool calls, replayed or live (native-strip.js draws it).
      if ((item.kind === 'tool' || item.kind === 'tool_result') && T.apply(this.todos, item) && this.isActive) SB.renderTodos?.(this);
      switch (item.kind) {
        case 'user':
          // Something you just sent always comes into view, even if you'd scrolled up.
          if (!replay) { this.stuck = true; this.dropCutOff(); }
          return this.renderUser(item);
        case 'text': {
          const el = SB.linkifyPaths(SB.renderMarkdownInto(h('div', { class: `msg assistant${item.sub ? ' sub' : ''}` }), item.text));
          return this.append(el, item.parent);
        }
        case 'thinking':
          if (!replay && !item.sub) this.setStatus('Thinking…');
          return;
        case 'tool':
          if (item.agent) return this.renderLane(item, replay);
          // One agent writing to another, a skill, a memory, Claude switching to planning (feed-native.js).
          if (item.message) return this.renderMessage(item, replay);
          if (item.name === 'EnterPlanMode' && !item.sub) this.renderPlanning(item);
          return this.renderTool(item, replay);
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
        case 'moved': case 'phone': case 'home': case 'home-wait': case 'pushed': case 'compacted': case 'fresh': case 'rewound': {
          const mark = F.markFor(item, SB.compact);
          return this.append(h('div', { class: 'home-mark' }, h('span', { class: 'chg-icon', 'aria-hidden': 'true', text: mark.icon }), mark.text));
        }
        // A crit hit or a clean landing (src/main/surprises.js), kept with the turn that earned it.
        case 'surprise': return this.append(h('div', { class: `home-mark surprise-mark ${item.what === 'landing' ? 'landing' : 'crit'}` },
          h('span', { class: 'chg-icon', 'aria-hidden': 'true', text: item.what === 'landing' ? '🛬' : '🎲' }),
          h('span', {}, h('b', { text: item.title || (item.what === 'landing' ? 'Clean landing' : 'Critical hit!') }), ` ${item.text || ''}`)));
        case 'suggest': return this.renderSuggestion(item, replay); // feed-asks.js
        case 'handoff': return this.renderHandoff(item, replay);
        case 'cutoff': return this.renderCutOff(item, replay);
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
      this.todos = T.create();
      this.trimmed = 0;
      this.trimmedNotice = null;
      this.shellPending = null;
      this.empty.hidden = false;
      for (const item of items) this.render(item, { replay: true });
      if (this.isActive) SB.renderTodos?.(this);
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
      // A steer has no point of its own to go back to (Shellby keeps the code
      // as it was between turns, not mid-turn), so it says so, and its ↶ goes
      // back to before the message whose turn it joined.
      const turnOf = item.steerId && !item.turnId ? item.turnOf || this.lastTurnId : null;
      const steerTip = 'Sent while Claude was working, so it rewinds with the message before it: back to just before that one';
      const back = item.turnId ? h('button', { class: 'msg-rewind', type: 'button', title: 'Rewind to just before this message', 'aria-label': 'Rewind to just before this message', onclick: () => SB.openRewind(this, item.turnId) })
        : turnOf ? h('button', { class: 'msg-rewind', type: 'button', title: steerTip, 'aria-label': steerTip, onclick: () => SB.openRewind(this, turnOf) }) : null;
      const fork = item.turnId ? h('button', { class: 'msg-branch', type: 'button', title: 'Try again from here, in a new tab', 'aria-label': 'Try again from here, in a new tab', onclick: () => SB.openBranch(this, item.turnId, 'before') }, SB.forkIcon()) : null;
      const steered = item.steerId ? h('div', { class: 'routine-tag', title: 'Claude read this between two steps of the turn before it' }, '↪ sent mid-turn') : null;
      this.append(h('div', { class: 'msg user' }, back, fork, routine || steered, item.text || '',
        item.attachments?.length ? h('div', { class: 'att-list' }, SB.attachmentChips(item.attachments)) : null));
    }

    renderTool(item, replay) {
      // Files it touched are links to your editor; edits fold open to their diff.
      const file = item.filePath || (item.name === 'Read' && item.detail ? item.detail : null);
      const edits = item.edits?.length ? item.edits : null;
      const el = h('details', { class: `tool pending${item.sub ? ' sub' : ''}${edits ? ' edit' : ''}` },
        h('summary', {},
          h('span', { class: 't-state' }),
          h('span', { class: 't-label', text: item.label }),
          file
            ? SB.fileLink(file, { line: item.line, text: SB.relPath(file, this.cwd), cls: 't-detail' })
            : h('span', { class: 't-detail', text: item.detail, title: item.detail }),
          edits ? SB.diffStats(edits) : null));
      el.dataset.toolId = item.id; // so trim() can forget it with the element
      // A picture Claude wrote or edited shows on its step once the write is done.
      if (item.filePath && isPicture(item.filePath)) el.dataset.picture = item.filePath;
      if (edits) {
        el.dataset.edit = '1';
        // Built on first open: a long conversation has hundreds of these. Until
        // then Ctrl+F looks in its text here, and builds it on a match (find.js).
        const build = () => {
          unbuiltDiffs.delete(el);
          if (!el.querySelector('.ediff')) el.querySelector('summary').after(SB.diffView(edits, { line: item.line }));
        };
        unbuiltDiffs.set(el, { text: edits.map(e => `${e.old || ''}\n${e.new || ''}`).join('\n').toLowerCase(), build });
        el.addEventListener('toggle', () => { if (el.open) build(); });
      }
      SB.decorateTool?.(this, el, item); // a skill says what it's for, a memory what was kept (feed-native.js)
      this.tools.set(item.id, el);
      this.append(el, item.parent);
      // In plain words when there are some (plain-words.js), else the step as Claude Code names it;
      // a to-do ticked over: what Claude is on now, as its list words it.
      const todoNow = item.todo ? T.summary(this.todos).current : null;
      const now = todoNow ? `${todoNow}…` : state.settings.plainCards !== false && item.doing ? `${item.doing}…` : `${item.label} ${item.detail}`.trim();
      if (!replay && !item.sub) this.setStatus(now);
      const lane = item.parent && this.lanes.get(item.parent);
      if (lane && !replay) lane.setActivity(now);
    }

    renderToolResult(item) {
      const lane = this.lanes.get(item.id);
      if (lane) return lane.finish({ ok: !item.isError, stats: item.agentStats, resultText: item.text });
      const el = this.tools.get(item.id);
      if (!el) return;
      el.classList.remove('pending');
      el.classList.add(item.isError ? (/declined|denied|interrupted/i.test(item.text) ? 'denied' : 'err') : 'ok');
      // A successful edit's result is "The file … has been updated"; the diff says it better.
      // A message sent, a to-do ticked: what the tool said back is noise unless it went wrong.
      // Its pictures stand in for the "[image]" Claude Code's text has where they were.
      const text = item.pictures?.length ? (item.text || '').replace(/^\[image\]$/gm, '').trim() : item.text;
      if (text?.trim() && !((el.dataset.edit || el.dataset.quiet) && !item.isError)) el.append(h('pre', { class: 't-result', text }));
      if (item.isError) return;
      const label = el.querySelector('.t-label')?.textContent || 'this step';
      const pictures = [
        ...(item.pictures || []).map(id => () => api.toolPicture({ tabId: this.id, id }).then(r => (r?.ok ? r.url : null))),
        ...(el.dataset.picture ? [() => api.filePicture(el.dataset.picture)] : []),
      ];
      if (pictures.length) el.after(pictureStrip(pictures, label));
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
      // A helper sent another message (SendMessage) starts again under that call's id:
      // it's still the lane its Agent call made, so the first id it had wins.
      if (item.toolUseId && item.taskId && (this.lanes.has(item.toolUseId) || !this.taskLane.has(item.taskId))) this.taskLane.set(item.taskId, item.toolUseId);
      const lane = this.lanes.get(this.taskLane.get(item.taskId)) || this.lanes.get(item.toolUseId);
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
      if (cost) {
        // How hard it thought, beside what it cost (turncost.js effortBadge).
        const badge = cost.effortBadge;
        this.append(h('div', { class: 'turn-cost', title: cost.detail || null, dataset: turnId ? { turn: turnId } : {} },
          badge ? h('span', { class: `effort-badge effort-${badge.level}`, title: badge.detail, text: badge.text }) : null,
          h('span', { class: 'turn-cost-line', text: cost.line })));
      }
      // A turn whose process went (main's session.js ended()): its error block is just above.
      if (!item.ok && !item.interrupted && item.error && !item.crashed) this.append(this.troubleBlock(item.trouble, item.error));
      // ...and its helpers went with it.
      if (item.interrupted || item.crashed) for (const lane of this.lanes.values()) if (lane.status === 'running') lane.finish({ ok: false, stopped: true });
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

  // A step's pictures, under it rather than folded inside it, so they're seen
  // as the work goes. Fetched once they scroll into view (a long conversation
  // reopened from History can hold dozens); a click shows one at full width.
  const pictureStrip = (loaders, label) => {
    const strip = h('div', { class: 'tool-pics' });
    for (const load of loaders) {
      const img = h('img', { alt: `A picture from ${label}` });
      const btn = h('button', { class: 'tool-pic', type: 'button', title: 'Show bigger', 'aria-pressed': 'false' }, img);
      btn.addEventListener('click', () => btn.setAttribute('aria-pressed', String(btn.classList.toggle('big'))));
      btn.load = load;
      strip.append(btn);
    }
    const seen = new IntersectionObserver(entries => {
      if (!entries.some(e => e.isIntersecting)) return;
      seen.disconnect();
      for (const btn of [...strip.children]) {
        Promise.resolve().then(btn.load).catch(() => null).then(url => {
          if (url) btn.firstChild.src = url; else btn.remove();
          if (!strip.children.length) strip.remove();
        });
      }
    });
    seen.observe(strip);
    return strip;
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
      remote: () => SB.showSetting('rcList'),
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
