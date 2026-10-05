/* Shellby panel — one conversation's feed, including crew lanes for subagents. */
'use strict';
(function () {
  const { h, api, state } = SB;

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
      this.el = h('section', { class: 'feed', role: 'tabpanel', 'aria-live': 'polite', dataset: { tab: id } });
      this.empty = SB.$('emptyTemplate').content.firstElementChild.cloneNode(true);
      this.el.append(this.empty); // its links open through core.js's a[data-href] handler
      this.renderEmpty();

      // Keep the newest message in view. `stuck` = you're at the bottom; the
      // feed shrinks whenever the Working bar, queued chips or attachments
      // appear above the composer, and without this the end of your prompt
      // would slide under them.
      this.stuck = true;
      this.el.addEventListener('scroll', () => { this.stuck = this.distanceFromEnd() < 40; }, { passive: true });
      new ResizeObserver(() => { if (this.stuck && this.isActive) this.scrollToEnd(); }).observe(this.el);
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
      const picks = [...SUGGESTIONS].sort(() => Math.random() - 0.5).slice(0, 3);
      e.querySelector('.suggestions').replaceChildren(...picks.map((s, i) =>
        h('button', { class: 'suggestion', type: 'button', style: `animation-delay:${i * 60}ms`, onclick: () => SB.send(s) },
          h('span', { class: 'glyph', text: '›' }), s)));
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
      if (follow && this.isActive) this.scrollToEnd();
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
      this.trimmedNotice.textContent = `${this.trimmed.toLocaleString()} earlier ${this.trimmed === 1 ? 'step' : 'steps'} hidden — the full conversation is in History.`;
    }

    get isActive() { return state.activeTab === this.id; }

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
        case 'permission': return this.renderAsk(item, replay);
        case 'decision': return this.markDecision(item);
        case 'result': return this.renderResult(item);
        case 'changes': return this.renderChanges(item);
        case 'undone': return this.markUndone(item);
        case 'checks': return SB.renderChecks?.(this, item);   // turn-checks.js
        case 'shots': return SB.renderShots?.(this, item);     // turn-checks.js
        case 'moved': return this.append(h('div', { class: 'home-mark' },
          h('span', { class: 'chg-icon', 'aria-hidden': 'true', text: '⑂' }),
          `Moved into its own copy before changing anything: branch ${item.branch} (from ${item.base})`));
        case 'phone': return this.append(h('div', { class: 'home-mark' },
          h('span', { class: 'chg-icon', 'aria-hidden': 'true', text: '📱' }),
          'Started from your phone, in Ask first: he asks before he changes anything'));
        case 'home': return this.append(h('div', { class: 'home-mark' },
          h('span', { class: 'chg-icon', 'aria-hidden': 'true', text: '↩' }),
          `Brought home: ${item.commits} commit${item.commits === 1 ? '' : 's'} merged into ${item.base}`));
        case 'pushed': return this.append(h('div', { class: 'home-mark' },
          h('span', { class: 'chg-icon', 'aria-hidden': 'true', text: '⇡' }),
          `Pushed ${item.branch} to ${item.remote}: ${item.commits} commit${item.commits === 1 ? '' : 's'}${item.pulled ? `, after taking in ${item.pulled} from ${item.remote}` : ''}`));
        case 'compacted': return this.append(h('div', { class: 'home-mark' },
          h('span', { class: 'chg-icon', 'aria-hidden': 'true', text: '⇣' }),
          `${item.trigger === 'auto' ? 'Claude Code compacted the conversation to make room' : 'Compacted the conversation'}${item.preTokens ? ` (it was ${SB.compact(item.preTokens)} tokens)` : ''}`));
        case 'fresh': return this.append(h('div', { class: 'home-mark' },
          h('span', { class: 'chg-icon', 'aria-hidden': 'true', text: '↻' }),
          'Started fresh: a new conversation picks up from the summary above'));
        case 'rewound': return this.append(h('div', { class: 'home-mark' },
          h('span', { class: 'chg-icon', 'aria-hidden': 'true', text: '↶' }),
          item.conversation === false ? `Rewound the code: put ${item.restored || 0} file${item.restored === 1 ? '' : 's'} back`
            : `Rewound to an earlier message${item.code && item.restored ? `, and put ${item.restored} file${item.restored === 1 ? '' : 's'} back` : ''}`));
        case 'branched': return this.renderBranched(item);
        case 'branched-off': return this.renderBranchedOff(item);
        case 'checkpoint': return; // where the files stood, for branching: nothing to show
        case 'shell': return this.renderShell(item, replay);
        case 'error': return this.append(h('div', { class: 'error-block', text: item.text }));
      }
    }

    // ------------------------------------------------------------ branches (branching.js)
    // Where this conversation came from, at the top of a branch.
    renderBranched(item) {
      const where = item.at === 'after' ? `after its reply to "${item.text}"` : `just before "${item.text}"`;
      const files = item.shared ? 'It shares the original\'s folder, so changes either makes, the other sees.'
        : item.filesNow ? `Its own copy on ${item.branch}, with the files as they were in the original when it branched.`
          : item.branch ? `Its own copy on ${item.branch}, with the files exactly as they were then${item.approx ? ' (as near as Shellby can tell)' : ''}.`
            : '';
      this.append(h('div', { class: 'home-mark branch-mark' },
        h('span', { class: 'chg-icon', 'aria-hidden': 'true', text: '⑂' }),
        h('span', {},
          'Branched from ', SB.historyLink(item.from, item.fromTitle || 'another conversation'), ` ${where}. `,
          files, ' The original carries on by itself.')));
    }

    // In the original: where a branch of it went.
    renderBranchedOff(item) {
      const where = item.at === 'after' ? `from after the reply to "${item.text}"` : `from just before "${item.text}"`;
      this.append(h('div', { class: 'home-mark branch-mark' },
        h('span', { class: 'chg-icon', 'aria-hidden': 'true', text: '⑂' }),
        h('span', {}, 'Tried again in ', SB.historyLink(item.to, 'another tab'), ` ${where}${item.branch ? ` (${item.branch})` : ''}. This conversation is as it was.`)));
    }

    // Two tries side by side: what this one has that the other doesn't, now.
    // Not kept in the transcript; compare again for a fresh look.
    renderCompare(other, r) {
      const head = r.same ? `Same files as "${other.title}"` : `${r.files.length + (r.more || 0)} file${r.files.length + (r.more || 0) === 1 ? '' : 's'} differ from "${other.title}"`;
      const el = h('details', { class: 'changes compare', open: !r.same && r.files.length <= 8 },
        h('summary', {},
          h('span', { class: 'chg-icon', 'aria-hidden': 'true', text: '⇄' }),
          h('span', { class: 'chg-title', text: head }),
          r.same ? null : h('span', { class: 'chg-add', text: `+${r.added}` }),
          r.same ? null : h('span', { class: 'chg-del', text: `−${r.removed}` })),
        r.same ? h('p', { class: 'small muted', text: 'Both copies have exactly the same files right now.' }) : null,
        r.same ? null : h('ul', { class: 'chg-files' }, r.files.map(f => this.changeRow(f, null, file => api.compareDiff(this.id, other.id, file)))),
        r.more ? h('p', { class: 'small muted chg-more', text: `…and ${r.more} more.` }) : null,
        r.same ? null : h('p', { class: 'small muted', text: `+ is what this one has, − is what "${other.title}" has instead.` }));
      this.stuck = true;
      this.append(el);
    }

    // ------------------------------------------------------------ ! commands you ran yourself
    renderShell(item, replay) {
      const el = h('details', { class: `tool shell-run ${item.code ? 'err' : 'ok'}`, open: !replay && String(item.output || '').split('\n').length <= 12 },
        h('summary', {},
          h('span', { class: 't-state' }),
          h('span', { class: 't-label', text: 'You ran' }),
          h('span', { class: 't-detail', text: item.command, title: item.command }),
          item.code ? h('span', { class: 'shell-code', text: item.timedOut ? 'stopped' : `exit ${item.code}` }) : null),
        h('pre', { class: 't-result', text: item.output || '(no output)' }));
      if (!replay && this.shellPending) { this.shellPending.replaceWith(el); this.shellPending = null; return el; }
      return this.append(el);
    }

    // Shown while a ! command runs; its result replaces it. null clears it.
    renderShellPending(command) {
      if (!command) { this.shellPending?.remove(); this.shellPending = null; return; }
      this.stuck = true;
      this.shellPending?.remove();
      this.shellPending = this.append(h('details', { class: 'tool shell-run pending' },
        h('summary', {}, h('span', { class: 't-state' }), h('span', { class: 't-label', text: 'Running' }), h('span', { class: 't-detail', text: command, title: command }))));
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

    renderUser(item) {
      const routine = item.routine ? h('div', { class: 'routine-tag' }, '⟳ ', item.routine.name, item.routine.reason === 'catch-up' ? ' · catch-up run' : '') : null;
      // Messages sent since rewind came in carry an id, and a way back to just
      // before them: in this tab (rewind), or in a new one that leaves this be (branch).
      // One read mid-turn (a steer) is part of the turn it went into, which keeps its id.
      if (!item.steerId) this.lastTurnId = item.turnId || null;
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
      const lane = new Lane(item, index);
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

    // ------------------------------------------------------------ permission cards
    renderAsk(item, replay) {
      if (item.toolName === 'AskUserQuestion' && item.questions?.length) return this.renderQuestion(item, replay);
      const isPlan = item.toolName === 'ExitPlanMode';
      const always = item.suggestions?.[0];
      const persistent = always && always.destination && always.destination !== 'session';
      const tabId = this.id;

      const decide = async (decision, message) => {
        const ok = await api.answerPermission(tabId, item.requestId, decision, message);
        if (!ok) SB.toast('That request already expired.');
        if (ok && isPlan && decision !== 'deny') {
          const next = item.suggestions?.find(s => s.type === 'setMode')?.mode;
          const uiMode = next === 'acceptEdits' ? 'acceptEdits' : next === 'bypassPermissions' ? null : 'ask';
          if (uiMode) SB.chooseMode(uiMode, { quiet: true });
        }
      };

      const body = isPlan
        ? h('div', { class: 'ask-body' }, SB.renderMarkdownInto(h('div', { class: 'ask-plan msg assistant' }), item.plan || 'No plan text.'))
        : h('div', { class: 'ask-body' },
            h('code', { class: 'ask-cmd', text: item.detail || item.toolName }),
            item.description && item.description !== item.detail ? h('p', { class: 'ask-desc', text: item.description }) : null);

      // Extra context when Claude is building tools for itself.
      const flags = [];
      if (item.runsCreated?.length) {
        flags.push(h('div', { class: 'ask-flag warn' }, h('b', {}, 'Runs a file Claude wrote this session: '),
          item.runsCreated.map(f => h('code', { text: SB.basename(f), title: f })).reduce((acc, el, i) => (i ? [...acc, ', ', el] : [el]), []),
          '. Check what it does before allowing.'));
      }
      if (item.selfConfig) {
        flags.push(h('div', { class: 'ask-flag info' }, h('b', {}, 'Changes Claude Code itself: '), `this touches ${item.selfConfig}, which affects future sessions too.`));
      }

      const actions = isPlan
        ? [h('button', { class: 'btn allow', type: 'button', onclick: () => decide(always ? 'always' : 'allow') }, 'Approve plan'),
           h('button', { class: 'btn deny', type: 'button', onclick: () => decide('deny', 'Keep planning: the user wants to refine the plan before anything changes.') }, 'Keep planning')]
        : [h('button', { class: 'btn allow', type: 'button', 'data-key': 'y', onclick: () => decide('allow') }, 'Allow'),
           always ? h('button', { class: 'btn', type: 'button', 'data-key': 'a', title: persistent ? "Saves this rule to Claude Code's settings" : 'For the rest of this conversation', onclick: () => decide('always') }, suggestionLabel(always)) : null,
           h('button', { class: 'btn deny', type: 'button', 'data-key': 'n', onclick: () => decide('deny') }, 'Deny')];

      const who = item.agent
        ? h('span', { class: 'ask-who' }, SB.helperSprite(this.laneIndexForTask(item.agent.taskId)), item.agent.description || item.agent.type)
        : null;

      const card = h('div', { class: `ask${item.runsCreated?.length ? ' flagged' : ''}`, role: 'group', 'aria-label': `Permission request: ${item.label}` },
        h('div', { class: 'ask-head' },
          h('span', { class: 'ask-crab' }, SB.sprite()),
          h('div', {},
            h('div', { class: 'ask-title', text: isPlan ? "Here's my plan" : item.agent ? 'A helper wants to do this' : 'Can I do this?' }),
            h('div', { class: 'ask-sub' }, isPlan ? 'Nothing changes until you approve.' : `${item.label} · ${item.toolName}`, who ? [' · ', who] : null))),
        flags.length ? h('div', { class: 'ask-flags' }, flags) : null,
        body,
        h('div', { class: 'ask-actions' }, actions),
        isPlan ? null : h('div', { class: 'ask-keys' }, 'Keys: ', h('kbd', {}, 'Y'), ' allow · ', always ? [h('kbd', {}, 'A'), ' always · '] : null, h('kbd', {}, 'N'), ' deny'));
      this.asks.set(item.requestId, card);
      const laneId = item.agent?.toolUseId;
      this.append(card, laneId);
      if (laneId) this.lanes.get(laneId)?.setAsking(true);
      if (!replay) {
        this.setStatus('Waiting for your OK…');
        if (this.isActive) {
          card.querySelector('.btn.allow')?.focus({ preventScroll: true });
          card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
      }
    }

    // Claude's multiple-choice questions (AskUserQuestion): one block per
    // question, options as buttons (number keys pick them), an "Other" box for
    // your own words, then Send. A lone single-choice question sends on click.
    renderQuestion(item, replay) {
      const tabId = this.id;
      const qs = item.questions;
      const chosen = qs.map(() => new Set());
      const other = qs.map(() => '');
      const instant = qs.length === 1 && !qs[0].multiSelect;
      let card = null; // built below; the handlers above only read it once it is

      const answerText = i => [...chosen[i], ...(other[i].trim() ? [other[i].trim()] : [])].join(', ');
      const ready = () => qs.every((_, i) => answerText(i));
      const send = async () => {
        if (!ready()) return;
        const answers = Object.fromEntries(qs.map((q, i) => [q.question, answerText(i)]));
        card.answers = answers;
        const ok = await api.answerPermission(tabId, item.requestId, 'allow', undefined, answers);
        if (!ok) SB.toast('That question already expired.');
      };
      const skip = async () => {
        card.answers = null;
        const ok = await api.answerPermission(tabId, item.requestId, 'deny', "The user skipped the question. Continue with your best judgement, or ask in plain text if you're stuck.");
        if (!ok) SB.toast('That question already expired.');
      };

      let key = 0;
      const blocks = qs.map((q, i) => {
        const opts = q.options.map(o => {
          const n = ++key;
          const btn = h('button', {
            class: 'qa-opt', type: 'button', 'aria-pressed': 'false', 'data-key': n <= 9 ? String(n) : null,
            onclick: () => {
              if (q.multiSelect) {
                if (chosen[i].has(o.label)) chosen[i].delete(o.label); else chosen[i].add(o.label);
              } else {
                chosen[i].clear(); chosen[i].add(o.label);
              }
              block.querySelectorAll('.qa-opt').forEach(b => b.setAttribute('aria-pressed', String(chosen[i].has(b.dataset.label))));
              sendBtn.disabled = !ready();
              if (instant) send();
            },
          },
          n <= 9 ? h('kbd', { text: String(n) }) : null,
          h('span', { class: 'qa-label', text: o.label }),
          o.description ? h('span', { class: 'qa-desc', text: o.description }) : null);
          btn.dataset.label = o.label;
          return btn;
        });
        const otherInput = h('input', {
          class: 'field qa-other', type: 'text', maxlength: '500', placeholder: q.options.length ? 'Or type your own answer…' : 'Your answer…',
          'aria-label': `Your own answer to: ${q.question}`,
          oninput: e => { other[i] = e.target.value; sendBtn.disabled = !ready(); },
          onkeydown: e => { if (e.key === 'Enter' && ready()) { e.preventDefault(); send(); } },
        });
        const block = h('fieldset', { class: 'qa' },
          h('legend', {}, q.header ? h('span', { class: 'qa-chip', text: q.header }) : null, h('span', { class: 'qa-q', text: q.question })),
          q.multiSelect ? h('p', { class: 'qa-hint', text: 'Pick any that apply.' }) : null,
          h('div', { class: 'qa-opts' }, opts),
          otherInput);
        return block;
      });

      const sendBtn = h('button', { class: 'btn allow', type: 'button', disabled: true, onclick: send }, qs.length > 1 ? 'Send answers' : 'Send answer');
      const who = item.agent ? h('span', { class: 'ask-who' }, SB.helperSprite(this.laneIndexForTask(item.agent.taskId)), item.agent.description || item.agent.type) : null;
      card = h('div', { class: 'ask question', role: 'group', 'aria-label': `Question: ${qs[0].question}` },
        h('div', { class: 'ask-head' },
          h('span', { class: 'ask-crab' }, SB.sprite()),
          h('div', {},
            h('div', { class: 'ask-title', text: qs.length > 1 ? `I have ${qs.length} quick questions` : 'Quick question' }),
            h('div', { class: 'ask-sub' }, instant ? 'Pick one, or type your own answer.' : 'Answer, then send.', who ? [' · ', who] : null))),
        h('div', { class: 'ask-body' }, blocks),
        h('div', { class: 'ask-actions' }, instant ? null : sendBtn, h('button', { class: 'btn ghost', type: 'button', onclick: skip }, 'Skip')),
        h('div', { class: 'ask-keys' }, 'Keys: ', h('kbd', {}, '1'), '–', h('kbd', {}, String(Math.min(key, 9))), ' pick'));
      this.asks.set(item.requestId, card);
      const laneId = item.agent?.toolUseId;
      this.append(card, laneId);
      if (laneId) this.lanes.get(laneId)?.setAsking(true);
      if (!replay) {
        this.setStatus('Waiting for your answer…');
        if (this.isActive) {
          // Focus the first option so number keys pick right away (not typed into the box).
          card.querySelector('.qa-opt')?.focus({ preventScroll: true });
          card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
      }
    }

    laneIndexForTask(taskId) {
      const lane = this.lanes.get(this.taskLane.get(taskId));
      return lane ? lane.index : 0;
    }

    markDecision(item) {
      const card = this.asks.get(item.requestId);
      if (!card || card.classList.contains('decided')) return;
      card.classList.add('decided');
      const words = { allow: 'Allowed', always: 'Always allowed', deny: 'Denied', cancelled: 'Cancelled' };
      if (card.classList.contains('question')) {
        // Show what was answered instead of "Allowed".
        const a = card.answers ? Object.values(card.answers).join(' · ') : null;
        const text = item.decision === 'cancelled' ? '→ Not answered' : a ? `→ ${a}` : item.decision === 'deny' ? '→ Skipped' : '→ Answered';
        card.querySelectorAll('button, input').forEach(el => { el.disabled = true; });
        card.append(h('div', { class: `ask-verdict ${a ? 'allow' : 'deny'}`, text }));
      } else {
        card.append(h('div', { class: `ask-verdict ${item.decision === 'deny' || item.decision === 'cancelled' ? 'deny' : 'allow'}`, text: `→ ${words[item.decision] || item.decision}${item.via === 'phone' ? ' from your phone' : ''}` }));
      }
      for (const lane of this.lanes.values()) if (lane.body.contains(card)) lane.setAsking(false);
      if (this.busy) this.setStatus('Working…');
    }

    cancelOpenAsks() {
      for (const [requestId, card] of this.asks) if (!card.classList.contains('decided')) this.markDecision({ requestId, decision: 'cancelled' });
    }

    openAsk() {
      return [...this.asks.values()].reverse().find(c => !c.classList.contains('decided')) || null;
    }

    renderResult(item) {
      for (const el of this.tools.values()) if (el.classList.contains('pending')) el.classList.replace('pending', item.ok ? 'ok' : 'err');
      const waiting = item.ok && !item.interrupted && item.waiting?.length
        ? `waiting on ${item.waiting.length === 1 ? item.waiting[0] : `${item.waiting.length} background tasks`}`
        : null;
      const label = item.interrupted ? 'stopped' : waiting || (item.ok ? 'done' : 'ended with an error');
      // A reply you might want to take somewhere else: a new tab that remembers
      // everything up to here, with the files as this turn left them.
      const turnId = this.lastTurnId;
      const fork = turnId && item.anchor ? h('button', { class: 'meta-branch', type: 'button', title: 'Branch from here: a new tab that carries on from this reply, leaving this one as it is', onclick: () => SB.openBranch(this, turnId, 'after') }, SB.forkIcon(), 'branch') : null;
      this.append(h('div', { class: `meta${item.ok || item.interrupted ? '' : ' bad'}${waiting ? ' waiting' : ''}`, title: waiting ? 'This turn ended, but something it started is still running.' : null },
        h('span', { text: [label, SB.duration(item.durationMs), item.turns ? `${item.turns} turns` : null].filter(Boolean).join(' · ') }), fork));
      if (!item.ok && !item.interrupted && item.error) this.append(h('div', { class: 'error-block', text: item.error }));
      if (item.interrupted) for (const lane of this.lanes.values()) if (lane.status === 'running') lane.finish({ ok: false, stopped: true });
    }

    // ------------------------------------------------------------ what the turn changed
    // One block per turn in a git project: every file it touched, each one's
    // diff on a click, and Undo to put them back. The diffs are read from git
    // when you open them, not carried around in the transcript.
    renderChanges(item) {
      if (!Array.isArray(item.files) || !item.files.length) return;
      const ref = { root: item.root, before: item.before, after: item.after };
      const count = item.files.length + (item.more || 0);
      const files = `${count} file${count === 1 ? '' : 's'}`;
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

    destroy() { this.el.remove(); }
  }

  const STATUS_WORDS = { A: 'Added', M: 'Modified', D: 'Deleted', T: 'Type changed' };

  // A unified diff as coloured lines. Text only: nothing in a diff is markup.
  SB.renderDiff = (patch, { binary = false } = {}) => {
    const MAX_LINES = 4000;
    const lines = String(patch || '').replace(/\n$/, '').split('\n');
    const rows = [];
    let inHeader = true; // a removed "-- note" inside a hunk is "--- note", and that's code
    for (const line of lines) {
      if (rows.length >= MAX_LINES) break;
      if (line.startsWith('diff --git')) inHeader = true;
      if (inHeader && /^(diff --git|index |--- |\+\+\+ |new file mode|deleted file mode|old mode|new mode|similarity index)/.test(line)) continue;
      if (line.startsWith('@@')) inHeader = false;
      const cls = line.startsWith('@@') ? 'hunk' : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : line.startsWith('\\') ? 'meta' : 'ctx';
      rows.push(h('span', { class: `dl ${cls}`, text: line || ' ' }));
    }
    if (!rows.length) return h('p', { class: 'small muted', text: binary ? 'A binary file: nothing to show line by line.' : 'No line changes (a mode or line-ending change).' });
    return h('pre', { class: 'diff' }, rows);
  };

  // ------------------------------------------------------------ Lane
  class Lane {
    constructor(item, index) {
      this.id = item.id;
      this.index = index;
      this.status = 'running';
      this.startedAt = Date.now();
      this.stats = null;
      this.activity = h('span', { class: 'lane-activity', text: 'Getting started…' });
      this.meta = h('span', { class: 'lane-meta' });
      this.body = h('div', { class: 'lane-body' });
      this.summaryEl = h('div', { class: 'lane-summary', hidden: true });
      this.el = h('details', { class: 'lane running', open: true, style: `--lane-hue:${SB.HUES[index % SB.HUES.length]}deg` },
        h('summary', { class: 'lane-head' },
          h('span', { class: 'lane-crab' }, SB.helperSprite(index)),
          h('span', { class: 'lane-text' },
            h('span', { class: 'lane-title' }, h('b', { text: item.agent.description || 'Helper' }), h('span', { class: 'lane-type', text: item.agent.type }), item.agent.background ? h('span', { class: 'lane-type bg', text: 'background' }) : null),
            this.activity),
          this.meta,
          h('span', { class: 'lane-state', 'aria-hidden': 'true' })),
        this.body, this.summaryEl);
      Lane.all.add(this);
      this.tick();
    }

    setActivity(text) { if (this.status === 'running') this.activity.textContent = text; }

    setAsking(on) { this.el.classList.toggle('asking', on); if (on) this.el.open = true; }

    update(item, replay) {
      if (item.usage) this.stats = { ...this.stats, tokens: item.usage.tokens, toolUses: item.usage.toolUses };
      if (item.phase === 'progress' && item.description) this.setActivity(item.description);
      if (item.phase === 'started' && item.description) this.setActivity(replay ? item.description : 'Getting started…');
      if (item.phase === 'done' || (item.phase === 'updated' && item.status && item.status !== 'running')) {
        this.finish({ ok: item.status !== 'failed' && item.status !== 'killed', summary: item.summary, stopped: item.status === 'killed' });
      }
      this.tick();
    }

    finish({ ok = true, stats, summary, resultText, stopped = false }) {
      if (stats) this.stats = { ...this.stats, ...stats };
      if (this.status === 'running') {
        this.status = stopped ? 'stopped' : ok ? 'done' : 'failed';
        this.finishedAt = Date.now();
        this.el.classList.remove('running', 'asking');
        this.el.classList.add(this.status);
        this.activity.textContent = stopped ? 'Stopped' : ok ? 'Done' : 'Failed';
        // Collapse finished helpers so the main thread stays readable.
        setTimeout(() => { if (!this.el.classList.contains('asking')) this.el.open = false; }, 900);
      }
      const text = summary || resultText;
      if (text && this.summaryEl.hidden) {
        this.summaryEl.hidden = false;
        SB.renderMarkdownInto(this.summaryEl, text.length > 1800 ? text.slice(0, 1800) + '…' : text);
        const first = text.replace(/[#*`_>]/g, '').split('\n').find(l => l.trim());
        if (first) this.activity.textContent = first.trim().slice(0, 120);
      }
      this.tick();
    }

    tick() {
      const ms = this.stats?.durationMs ?? ((this.finishedAt || Date.now()) - this.startedAt);
      const bits = [];
      if (this.stats?.toolUses) bits.push(`${this.stats.toolUses} tool${this.stats.toolUses > 1 ? 's' : ''}`);
      if (this.stats?.tokens) bits.push(`${SB.compact(this.stats.tokens)} tok`);
      bits.push(SB.duration(ms));
      this.meta.textContent = bits.join(' · ');
      if (this.status !== 'running') Lane.all.delete(this);
    }
  }
  Lane.all = new Set();
  setInterval(() => { for (const lane of Lane.all) if (lane.el.isConnected) lane.tick(); else Lane.all.delete(lane); }, 1000);

  function suggestionLabel(s) {
    if (s?.type === 'setMode') return s.mode === 'acceptEdits' ? 'Allow all edits' : `Switch to ${s.mode}`;
    if (s?.type === 'addRules' && s.rules?.[0]) {
      const r = s.rules[0];
      return r.ruleContent ? `Always allow ${r.toolName}(${r.ruleContent.length > 24 ? r.ruleContent.slice(0, 22) + '…' : r.ruleContent})` : `Always allow ${r.toolName}`;
    }
    if (s?.type === 'addDirectories') return 'Always allow this folder';
    return 'Always allow';
  }

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

  SB.Tab = Tab;
  SB.Lane = Lane;
})();
