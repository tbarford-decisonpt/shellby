/* Shellby panel — one conversation's feed, including crew lanes for subagents. */
'use strict';
(function () {
  const { h, api, state } = SB;

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
      this.pending = 0;
      this.crew = 0;
      this.outcome = null;
      this.unread = false;
      this.statusText = 'Working…';
      this.draft = '';
      this.attachments = [];
      this.tools = new Map();     // tool_use_id -> element
      this.asks = new Map();      // requestId -> card
      this.lanes = new Map();     // Agent tool_use_id -> lane
      this.taskLane = new Map();  // task_id -> Agent tool_use_id
      this.el = h('section', { class: 'feed', role: 'tabpanel', 'aria-live': 'polite', dataset: { tab: id } });
      this.empty = SB.$('emptyTemplate').content.firstElementChild.cloneNode(true);
      this.el.append(this.empty);
      this.el.addEventListener('click', e => {
        const a = e.target.closest('a[data-href]');
        if (a) { e.preventDefault(); api.openExternal(a.dataset.href); }
      });
      this.renderEmpty();
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
      const nearBottom = this.el.scrollHeight - this.el.scrollTop - this.el.clientHeight < 140;
      host.append(el);
      if (nearBottom && this.isActive) this.el.scrollTop = this.el.scrollHeight;
      return el;
    }

    get isActive() { return state.activeTab === this.id; }

    setStatus(text) {
      this.statusText = text;
      if (this.isActive) SB.$('statusText').textContent = text;
    }

    // ------------------------------------------------------------ items
    render(item, { replay = false } = {}) {
      switch (item.kind) {
        case 'user': return this.renderUser(item);
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
        case 'error': return this.append(h('div', { class: 'error-block', text: item.text }));
      }
    }

    renderUser(item) {
      const routine = item.routine ? h('div', { class: 'routine-tag' }, '⟳ ', item.routine.name, item.routine.reason === 'catch-up' ? ' · catch-up run' : '') : null;
      this.append(h('div', { class: 'msg user' }, routine, item.text || '',
        item.attachments?.length ? h('div', { class: 'att-list' }, SB.attachmentChips(item.attachments)) : null));
    }

    renderTool(item, replay) {
      const el = h('details', { class: `tool pending${item.sub ? ' sub' : ''}` },
        h('summary', {},
          h('span', { class: 't-state' }),
          h('span', { class: 't-label', text: item.label }),
          h('span', { class: 't-detail', text: item.detail, title: item.detail })));
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

    laneIndexForTask(taskId) {
      const lane = this.lanes.get(this.taskLane.get(taskId));
      return lane ? lane.index : 0;
    }

    markDecision(item) {
      const card = this.asks.get(item.requestId);
      if (!card || card.classList.contains('decided')) return;
      card.classList.add('decided');
      const words = { allow: 'Allowed', always: 'Always allowed', deny: 'Denied', cancelled: 'Cancelled' };
      card.append(h('div', { class: `ask-verdict ${item.decision === 'deny' || item.decision === 'cancelled' ? 'deny' : 'allow'}`, text: `→ ${words[item.decision] || item.decision}` }));
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
      const label = item.interrupted ? 'stopped' : item.ok ? 'done' : 'ended with an error';
      this.append(h('div', { class: `meta${item.ok || item.interrupted ? '' : ' bad'}`, text: [label, SB.duration(item.durationMs), item.turns ? `${item.turns} turns` : null].filter(Boolean).join(' · ') }));
      if (!item.ok && !item.interrupted && item.error) this.append(h('div', { class: 'error-block', text: item.error }));
      if (item.interrupted) for (const lane of this.lanes.values()) if (lane.status === 'running') lane.finish({ ok: false, stopped: true });
    }

    destroy() { this.el.remove(); }
  }

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

  SB.attachmentChips = (files, onRemove) => files.map((f, i) => h('span', { class: 'att', title: f },
    h('span', { text: SB.basename(f) }),
    onRemove ? h('button', { type: 'button', 'aria-label': `Remove ${SB.basename(f)}`, onclick: () => onRemove(i) }, '×') : null));

  SB.Tab = Tab;
  SB.Lane = Lane;
})();
