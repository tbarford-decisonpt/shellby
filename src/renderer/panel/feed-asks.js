/* Shellby panel — a feed's permission cards and Claude's multiple-choice
   questions, and what was decided on them, and the Shellby features Claude
   offers. Part of Tab (feed.js). */
'use strict';
(function () {
  const { h, api, state } = SB;
  const F = window.ShellbyFeedLogic;

  class AskCards {
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
          const uiMode = F.modeAfterPlan(item.suggestions);
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
           always ? h('button', { class: 'btn', type: 'button', 'data-key': 'a', title: persistent ? "Saves this rule to Claude Code's settings" : 'For the rest of this conversation', onclick: () => decide('always') }, F.suggestionLabel(always)) : null,
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
      if (card.classList.contains('question')) {
        // Show what was answered instead of "Allowed".
        const v = F.questionVerdict(item.decision, card.answers);
        card.querySelectorAll('button, input').forEach(el => { el.disabled = true; });
        card.append(h('div', { class: `ask-verdict ${v.tone}`, text: v.text }));
      } else {
        const v = F.decisionVerdict(item.decision, item.via);
        card.append(h('div', { class: `ask-verdict ${v.tone}` }, v.text, this.expandToggle(card)));
      }
      for (const lane of this.lanes.values()) if (lane.body.contains(card)) lane.setAsking(false);
      if (this.busy) this.setStatus('Working…');
    }

    // A decided card shrinks its command to a few lines; this brings the rest
    // back. Only offered when something is actually cut off (a card replayed
    // into a hidden tab has no layout yet, so judge by the text there).
    expandToggle(card) {
      const cmd = card.querySelector('.ask-cmd');
      if (!cmd) return null;
      const clipped = cmd.clientHeight ? cmd.scrollHeight > cmd.clientHeight + 1 : cmd.textContent.length > 120 || cmd.textContent.includes('\n');
      if (!clipped) return null;
      const btn = h('button', { class: 'ask-more', type: 'button', 'aria-expanded': 'false' }, 'show all');
      btn.onclick = () => {
        const open = card.classList.toggle('open');
        btn.setAttribute('aria-expanded', String(open));
        btn.textContent = open ? 'show less' : 'show all';
      };
      return btn;
    }

    // A Shellby feature Claude offered (src/main/selfaware.js). Nothing has
    // happened yet: the button does it, or the card is ignored. Cards from an
    // earlier session replay as a one-line note, not as something to answer.
    renderSuggestion(item, replay) {
      if (replay) return this.append(h('div', { class: 'meta suggest-note', text: `Shellby suggested: ${item.title.replace(/\?$/, '')}` }));
      const tabId = this.id;
      const cwd = this.cwd;
      let card = null;
      const close = verdict => {
        card.classList.add('decided');
        card.append(h('div', { class: 'ask-verdict allow', text: `→ ${verdict}` }));
      };
      const act = async () => {
        if (item.feature === 'routine') {
          SB.openRoutineEditor({ ...item.draft, mode: 'smart', cwd: cwd || null, isTemplate: true });
          return close('Opened in Routines');
        }
        if (item.feature === 'focus') {
          await api.startFocus(item.minutes);
          SB.toast(`Guarding your focus for ${item.minutes} minutes ⛑️`);
          return close('Focus on');
        }
        if (item.feature === 'review') {
          const r = await api.reviewFromSuggestion(tabId);
          if (r?.needsClaude) return SB.claudeUpsell('review');
          if (!r?.ok) return SB.toast(r?.error || "Couldn't start that.");
          return close('Review started in a new tab');
        }
        if (item.feature === 'notify') {
          SB.setView('settings');
          setTimeout(() => document.getElementById('channelsGroup')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
          return close('Opened Settings');
        }
      };
      const mute = async () => {
        state.settings.mutedSuggestions = await api.muteSuggestion(item.feature, true);
        close("Won't offer this again");
      };
      const draft = item.draft
        ? h('div', { class: 'ask-body' },
            h('div', { class: 'suggest-draft' }, h('b', { text: item.draft.name }), h('span', { text: ` · ${item.draft.when}` })),
            h('p', { class: 'ask-desc', text: item.draft.prompt }))
        : null;
      card = h('div', { class: 'ask suggest', role: 'group', 'aria-label': `Suggestion: ${item.title}` },
        h('div', { class: 'ask-head' },
          h('span', { class: 'ask-crab' }, SB.sprite()),
          h('div', {},
            h('div', { class: 'ask-title', text: item.title }),
            h('div', { class: 'ask-sub', text: item.why }))),
        draft,
        h('div', { class: 'ask-actions' },
          h('button', { class: 'btn allow', type: 'button', onclick: act }, item.button),
          h('button', { class: 'btn ghost', type: 'button', onclick: () => close('Not now') }, 'Not now'),
          h('button', { class: 'btn ghost', type: 'button', title: "Claude won't offer this one again. Turn it back on in Settings.", onclick: mute }, "Don't offer this")));
      this.append(card);
    }

    cancelOpenAsks() {
      for (const [requestId, card] of this.asks) if (!card.classList.contains('decided')) this.markDecision({ requestId, decision: 'cancelled' });
    }

    openAsk() {
      return [...this.asks.values()].reverse().find(c => !c.classList.contains('decided')) || null;
    }
  }

  SB.extendTab(AskCards);
})();
