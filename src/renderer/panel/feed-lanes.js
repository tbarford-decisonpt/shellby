/* Shellby panel — a helper's lane in the feed: what it's doing, how long it
   has taken, and its summary once done. feed.js makes one per Agent tool. */
'use strict';
(function () {
  const { h } = SB;
  const F = window.ShellbyFeedLogic;

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
            h('span', { class: 'lane-title' }, h('b', { text: item.agent.description || 'Helper' }), h('span', { class: 'lane-type', text: item.agent.type }),
              item.agent.name ? h('span', { class: 'lane-type name', title: 'Other agents write to it by this name', text: `@${item.agent.name}` }) : null,
              item.agent.background ? h('span', { class: 'lane-type bg', text: 'background' }) : null),
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
      // Sent another message after it finished (SendMessage): it's back at work in the same lane.
      if (item.phase === 'started' && this.status !== 'running') this.reopen(replay);
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
        const first = F.laneFirstLine(text);
        if (first) this.activity.textContent = first;
      }
      this.tick();
    }

    // What it spent, once its turn has ended (the result's cost.helpers): its
    // tokens counted the way the turn's line counts them, so the two agree.
    setCost(c) {
      this.stats = { ...this.stats, tokens: c.tokens || this.stats?.tokens, share: c.shareText || null };
      this.meta.title = F.laneCostTitle(c, SB.compact);
      this.tick();
    }

    reopen(replay) {
      this.el.classList.remove('done', 'failed', 'stopped');
      this.el.classList.add('running');
      this.status = 'running';
      this.finishedAt = null;
      this.startedAt = Date.now();
      this.stats = null;
      this.activity.textContent = 'Picking it up again…';
      if (!replay) this.el.open = true;
      // Its next answer goes under the first, which stays.
      this.summaryEl = h('div', { class: 'lane-summary', hidden: true });
      this.el.append(this.summaryEl);
      Lane.all.add(this);
    }

    tick() {
      const ms = this.stats?.durationMs ?? ((this.finishedAt || Date.now()) - this.startedAt);
      this.meta.textContent = F.laneMeta(this.stats, ms, { compact: SB.compact, duration: SB.duration });
      if (this.status !== 'running') Lane.all.delete(this);
    }
  }
  Lane.all = new Set();
  setInterval(() => { for (const lane of Lane.all) if (lane.el.isConnected) lane.tick(); else Lane.all.delete(lane); }, 1000);

  SB.Lane = Lane;
})();
