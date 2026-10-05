// What the usage banner and held messages say (panel/outlook.js): which note
// shows, which actions it offers, and the words for them. No DOM, so it runs
// in the browser and in Node (for tests).
(function (root) {
  /** The banner's note: at the limit beats a warning; null when there's nothing to say. */
  const noteFor = o => (o?.limit
    ? { text: `You're at your ${o.limit.name} limit until ${o.limit.at}.`, key: o.limit.resetsAt, cls: 'limit' }
    : o?.warning ? { text: o.warning.text, key: o.warning.resetsAt, cls: 'warning' } : null);

  /** Which buttons the banner offers: send what's typed, hold the queue, or the hint (only once the reset time is known). */
  const actionsFor = ({ resetAt, typed, queued }) => {
    if (!resetAt) return [];
    if (!typed && !queued) return ['hint'];
    return [typed ? 'send-typed' : null, queued ? 'hold-queue' : null].filter(Boolean);
  };

  /** A tab's held messages, from the outlook main sent. */
  const heldFor = (outlook, tabId) => (outlook?.held || []).filter(x => x.kind === 'message' && x.tabId === tabId);

  /** A held message as its chip shows it: its text, or what's attached. */
  const describe = m => m.text || `${m.attachments.length} attached file${m.attachments.length === 1 ? '' : 's'}`;

  /** Why what's typed can't be held ({ text, ms } for the toast), or null when it can. */
  const holdRefusal = (text, resetAt) => {
    if (!resetAt) return { text: "Shellby doesn't know when your window resets yet. He finds out with your next message.", ms: 5000 };
    // A command you run yourself happens here and now, never later (composer.js).
    if (text.startsWith('!') && !text.startsWith('!!')) return { text: 'Commands you run with ! can\'t wait for the reset.', ms: null };
    return null;
  };

  /** The toast after holding a tab's queue. */
  const queueHeldText = (n, at) => `${n === 1 ? 'Your queued message goes' : `${n} queued messages go`} at ${at}, once your usage resets.`;

  const api = { noteFor, actionsFor, heldFor, describe, holdRefusal, queueHeldText };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ShellbyOutlookFormat = api;
})(typeof window !== 'undefined' ? window : globalThis);
