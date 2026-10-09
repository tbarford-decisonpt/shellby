'use strict';

// ClaudeSession's spend, token, cache and context-window bookkeeping, mixed
// into its prototype by session.js.

const { weightOf } = require('./spend');
const ctx = require('./context');
const turncost = require('./turncost');
const eff = require('./efficiency');

const accounting = {
  // What each API call cost, for the usage-by-project ledger (spend.js). One
  // call arrives as several events repeating its usage, so only growth past
  // what was already reported counts. Kept off the 'item' stream so it never
  // lands in the transcript.
  countSpend(s) {
    if (!s) return;
    if (this.turn) this.countTurnTokens(s);
    const weight = weightOf(s.usage, s.model);
    const before = this.counted.get(s.messageId) || 0;
    if (weight <= before) return;
    this.counted.delete(s.messageId);
    this.counted.set(s.messageId, weight);
    if (this.counted.size > 500) this.counted.delete(this.counted.keys().next().value);
    if (this.turn) {
      this.turn.weight += weight - before;
      if (s.parent) this.helperOf(s.parent).weight += weight - before;
    }
    this.emit('spend', { messageId: s.messageId, weight: weight - before });
  },

  // The running turn's tokens so far, counted as its result's cost will count
  // them, for the panel's live "12s · 4.2k tokens". 'tokens' only when it grows.
  countTurnTokens(s) {
    const turn = this.turn;
    turn.usages.set(s.messageId, turncost.mergeUsage(turn.usages.get(s.messageId), s.usage));
    if (s.parent) {
      const helper = this.helperOf(s.parent);
      helper.usages.set(s.messageId, turn.usages.get(s.messageId));
    }
    const { fresh } = turncost.tokensOf([...turn.usages.values()]);
    if (fresh <= turn.tokens) return;
    turn.tokens = fresh;
    this.emit('tokens', fresh);
  },

  // What one helper (by the Agent call that sent it) has spent this turn.
  helperOf(parent) {
    const helpers = this.turn.helpers ||= new Map();
    if (!helpers.has(parent)) helpers.set(parent, { usages: new Map(), weight: 0 });
    return helpers.get(parent);
  },

  // The turn's cost goes on its result, so History keeps it with the turn.
  // Helpers' calls count too: they spend from the same window. Each helper's
  // part is kept beside it, for its lane.
  closeTurn(item) {
    const turn = this.turn;
    this.turn = null;
    if (!turn) return;
    const helpers = [...(turn.helpers || [])].map(([id, x]) => ({ id, usages: [...x.usages.values()], weight: x.weight }));
    const cost = turncost.turnCost({ usages: [...turn.usages.values()], weight: turn.weight, effort: turn.effort, thinking: item.thinkingTokens, helpers }, this.context);
    if (cost) item.cost = cost;
    this.growths = turncost.addGrowth(this.growths, turn.before, this.context?.tokens);
  },

  // The prompt cache and setup weight (efficiency.js), off the transcript like
  // spend. 'call' carries each call's growth in cache reads, cache writes and
  // fresh input; 'cache' says when the main thread last touched the cache.
  countCall(event) {
    const c = eff.callFrom(event);
    if (!c) return;
    const prev = this.calls.get(c.messageId);
    const grow = f => Math.max(0, c[f] - (prev?.[f] || 0));
    const delta = { input: grow('input'), write: grow('write'), read: grow('read'), isNew: !prev };
    this.calls.delete(c.messageId);
    this.calls.set(c.messageId, { input: Math.max(c.input, prev?.input || 0), write: Math.max(c.write, prev?.write || 0), read: Math.max(c.read, prev?.read || 0) });
    if (this.calls.size > 500) this.calls.delete(this.calls.keys().next().value);
    // A brand-new conversation's first call is everything it carries before your first word.
    let setup = null;
    if (c.main && !prev && this.setupChars !== null) {
      setup = eff.setupTokens(c, this.setupChars);
      this.setupChars = null;
    }
    if (delta.input || delta.write || delta.read || setup) this.emit('call', { ...delta, setup });
    // Stamped on a call's first event, close to when it read the cache: its later
    // blocks arrive as it writes, which would make the cache look warmer than it is.
    if (c.main && !prev) {
      this.cache = { at: Date.now(), ttlMs: c.ttlMs || this.cache?.ttlMs || eff.DEFAULT_TTL_MS };
      this.emit('cache', this.cache);
    }
  },

  // How full the context window is, from each main-thread reply's token counts.
  // Emitted as 'context', off the transcript like spend.
  measure(event) {
    const windows = ctx.windowsFrom(event);
    if (windows) {
      this.windows = windows;
      if (this.context) this.setContext(this.context.tokens, this.lastModel);
      return;
    }
    if (event?.type === 'system' && event.subtype === 'compact_boundary') return this.setContext(0);
    const t = ctx.tokensFrom(event);
    if (!t) return;
    this.lastModel = t.model || this.lastModel;
    this.setContext(t.tokens, this.lastModel);
  },

  setContext(tokens, model = this.lastModel) {
    const next = ctx.view(tokens, ctx.windowFor(model, this.windows, this.model));
    const before = this.context;
    if (before?.tokens === next?.tokens && before?.window === next?.window) return;
    this.context = next;
    this.emit('context', next, before);
  },
};

module.exports = { accounting };
