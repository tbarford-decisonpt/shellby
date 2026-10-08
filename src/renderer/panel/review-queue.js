// The review inbox, the sorting half (review-view.js draws it): which open tabs
// have finished work waiting for you, oldest first like a queue, and what each
// row says about it. Pure, no DOM. Works in the browser and in Node (for tests).
//
// A tab's `ready` comes from main (src/main/review-inbox.js):
//   { after, turnId, files, added, removed, paths, at, reviewed }
(function (root) {
  const S = typeof module !== 'undefined' && module.exports ? require('./tab-sort') : root.ShellbyTabSort;

  const VERDICTS = {
    pass: { icon: '✅', text: 'Checks passed' },
    fail: { icon: '❌', text: 'Checks failed' },
    error: { icon: '⚠', text: "Couldn't run the checks" },
    running: { icon: '…', text: 'Checking…' },
    none: { icon: '', text: 'No checks run' },
  };

  /**
   * The tests' word on exactly these changes. running: the `after` tree a check
   * is running for in this tab right now, or null. A verdict on some other
   * turn's tree says nothing about this one.
   */
  function verdict(t, running = null) {
    const after = t.ready?.after;
    if (!after) return 'none';
    if (running && running === after) return 'running';
    const c = t.checks;
    if (!c || c.after !== after) return 'none';
    if (c.status === 'pass') return 'pass';
    if (c.status === 'error') return 'error';
    return 'fail';  // fail, or ran out of time
  }

  /** Tabs waiting for review, the longest-waiting first; ties keep strip order. */
  function queue(tabs) {
    return tabs
      .map((t, i) => ({ t, i }))
      .filter(({ t }) => S.toReview(t))
      .sort((a, b) => (a.t.ready.at || 0) - (b.t.ready.at || 0) || a.i - b.i)
      .map(({ t }) => t);
  }

  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

  /**
   * One row's facts. opts: { title, running, clash } — the shown title, the
   * tree being checked now, and the tab's clash line ('' for none).
   */
  function item(t, { title = t.title || 'Untitled', running = null, clash = '' } = {}) {
    const r = t.ready;
    const paths = (r.paths || []).slice(0, 5);
    const v = verdict(t, running);
    return {
      id: t.id, title, at: r.at || 0, after: r.after, turnId: r.turnId || null,
      branch: t.worktree?.branch || null,
      files: r.files || paths.length, added: r.added || 0, removed: r.removed || 0,
      paths, more: Math.max(0, (r.files || 0) - paths.length),
      verdict: v, clash: clash || '',
      // Red tests or a clash: shown loud, but it still waits its turn in the queue.
      flagged: v === 'fail' || !!clash,
    };
  }

  const filesLine = it => `${plural(it.files, 'file')} · +${it.added} −${it.removed}`;

  /** What a screen reader hears for a row. age: "5m ago" and the like. */
  function label(it, age = '') {
    return [
      it.title,
      it.branch ? `on branch ${it.branch}` : null,
      `${plural(it.files, 'file')} changed, ${it.added} added, ${it.removed} removed`,
      VERDICTS[it.verdict].text,
      it.clash ? `Warning: ${it.clash}` : null,
      age ? `Finished ${age}` : null,
    ].filter(Boolean).join('. ');
  }

  /** The strip's count and the overview's button. */
  const countLine = n => (n ? `${plural(n, 'conversation')} ready to review` : 'Nothing waiting for review');

  /** Which row to land on once `id` has left the list: the next one, else the one before. */
  function landOn(order, id) {
    const at = order.indexOf(id);
    if (at < 0) return order[0] ?? null;
    return order[at + 1] ?? order[at - 1] ?? null;
  }

  const api = { VERDICTS, verdict, queue, item, filesLine, label, countLine, landOn };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ShellbyReviewQueue = api;
})(typeof window !== 'undefined' ? window : globalThis);
