/* Shellby panel — a feed's notes about the conversation itself: carried on in
   a terminal and back, where a branch came from and went, two tries compared,
   and ! commands you ran yourself. Part of Tab (feed.js). */
'use strict';
(function () {
  const { h, api } = SB;
  const F = window.ShellbyFeedLogic;

  class FeedNotes {
    // ------------------------------------------------------------ to a terminal and back (handoff.js)
    // Off to a terminal: Pick it up here sits on the note while it's out there
    // (in a replay, only if it still is). Coming back takes the button away.
    renderHandoff(item, replay) {
      if (item.to === 'terminal') {
        const shell = F.shellName(item.shell);
        const pick = !replay || this.inTerminal
          ? h('button', { class: 'btn slim-btn handoff-pick', type: 'button', onclick: () => SB.pickUpHere(this.id) }, 'Pick it up here')
          : null;
        return this.append(h('div', { class: 'home-mark handoff-mark' },
          h('span', { class: 'chg-icon', 'aria-hidden': 'true', text: '›_' }),
          h('span', { text: `Carried on in ${shell}. Nothing is sent from here until you pick it up again.` }), pick));
      }
      for (const b of this.el.querySelectorAll('.handoff-pick')) b.remove();
      return this.append(h('div', { class: 'home-mark handoff-mark' },
        h('span', { class: 'chg-icon', 'aria-hidden': 'true', text: '↩' }),
        item.from
          ? `Brought in from ${item.from}. Type /exit there before you send anything here.`
          : "Picked up again here. Whatever was said in the terminal, Claude remembers, but it isn't shown above."));
    }

    // ------------------------------------------------------------ cut off mid-turn (history.takeCutOff)
    // Carry on sits on the note while the conversation is still unfinished (in a
    // replay, only if it is); sending anything here takes it away.
    renderCutOff(item, replay) {
      const go = !replay || this.outcome === 'cut'
        ? h('button', { class: 'btn slim-btn cutoff-go', type: 'button', onclick: async e => {
          e.currentTarget.disabled = true;
          if (await SB.sendDirect(this, F.CARRY_ON)) this.dropCutOff(); else e.currentTarget.disabled = false;
        } }, 'Carry on')
        : null;
      return this.append(h('div', { class: 'home-mark cutoff-mark', role: 'status' },
        h('span', { class: 'chg-icon', 'aria-hidden': 'true', text: '⏸' }),
        h('span', { text: F.cutOffLine(item) }), go));
    }

    dropCutOff() { for (const b of this.el.querySelectorAll('.cutoff-go')) b.remove(); }

    // ------------------------------------------------------------ branches (branching.js)
    // Where this conversation came from, at the top of a branch.
    renderBranched(item) {
      const { where, files } = F.branchedFrom(item);
      this.append(h('div', { class: 'home-mark branch-mark' },
        h('span', { class: 'chg-icon', 'aria-hidden': 'true', text: '⑂' }),
        h('span', {},
          'Branched from ', SB.historyLink(item.from, item.fromTitle || 'another conversation'), ` ${where}. `,
          files, ' The original carries on by itself.')));
    }

    // In the original: where a branch of it went.
    renderBranchedOff(item) {
      const where = F.branchedOffWhere(item);
      this.append(h('div', { class: 'home-mark branch-mark' },
        h('span', { class: 'chg-icon', 'aria-hidden': 'true', text: '⑂' }),
        h('span', {}, 'Tried again in ', SB.historyLink(item.to, 'another tab'), ` ${where}${item.branch ? ` (${item.branch})` : ''}. This conversation is as it was.`)));
    }

    // Two tries side by side: what this one has that the other doesn't, now.
    // Not kept in the transcript; compare again for a fresh look.
    renderCompare(other, r) {
      const head = F.compareHead(other.title, r);
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

    // ------------------------------------------------------------ /btw side questions (btw.js)
    // Not kept in the transcript, and Claude never sees it: × puts it away.
    renderBtw(question) {
      const body = h('div', { class: 'btw-body muted', text: 'Thinking…' });
      const el = h('div', { class: 'btw-card pending', role: 'note', 'aria-busy': 'true' },
        h('div', { class: 'btw-head' },
          h('span', { class: 'btw-tag', text: 'by the way' }),
          h('span', { class: 'btw-q', text: question, title: question }),
          h('button', { class: 'btw-close', type: 'button', title: 'Put it away', 'aria-label': 'Put this side question away', onclick: () => el.remove() }, '×')),
        body,
        h('div', { class: 'btw-foot small muted', text: 'A side question: Claude answered from the conversation, which carries on without it.' }));
      this.stuck = true;
      this.append(el);
      const done = () => { el.classList.remove('pending'); el.removeAttribute('aria-busy'); };
      return {
        answer: text => {
          done();
          body.className = 'btw-body msg assistant';
          body.textContent = '';
          SB.linkifyPaths(SB.renderMarkdownInto(body, text));
        },
        fail: error => { done(); el.classList.add('err'); body.textContent = error; },
      };
    }

    // Shown while a ! command runs; its result replaces it. null clears it.
    renderShellPending(command) {
      if (!command) { this.shellPending?.remove(); this.shellPending = null; return; }
      this.stuck = true;
      this.shellPending?.remove();
      this.shellPending = this.append(h('details', { class: 'tool shell-run pending' },
        h('summary', {}, h('span', { class: 't-state' }), h('span', { class: 't-label', text: 'Running' }), h('span', { class: 't-detail', text: command, title: command }))));
    }
  }

  SB.extendTab(FeedNotes);
})();
