// How hard Claude should think in a conversation, sized from its first message
// (sessions.js). On Auto every chat gets Claude Code's own default, which is
// high: a quick question then thinks, reads and fills its context like a build.
// Words only, no model call: it has to be instant and free. It never picks
// xhigh or max, which only you choose.

// A job that spans the code or needs working out.
const BIG = /\b(refactor\w*|rewrit\w*|redesign\w*|architect\w*|migrat\w*|implement\w*|overhaul\w*|investigat\w*|audit\w*|debug\w*|root cause|from scratch|end[- ]to[- ]end|across the|the whole|the entire|every (file|test|page|screen)|all the (files|tests|places)|build (a|an|the|me)|design (a|an|the))\b/i;
// How a question or a small, named change starts.
const ASK = /^(what|why|where|when|which|who|whose|is|are|was|does|do|did|can|could|would|should|explain|show|list|tell|rename|bump|remind)\b/i;

const LONG = 120; // words: a brief this long is a big job whatever it says
const SHORT = 25; // words: a question this short is a quick one

/**
 * -> 'low' | 'medium' | 'high', or null when there's nothing to go on (a
 * /command, or no words): the next real message picks instead.
 * files: how many attachments came with it.
 */
function pickEffort(text, files = 0) {
  const t = String(text || '').trim();
  if (!t || t.startsWith('/')) return null;
  const words = t.split(/\s+/).length;
  if (words >= LONG || BIG.test(t)) return 'high';
  if (!files && words <= SHORT && (ASK.test(t) || t.endsWith('?'))) return 'low';
  return 'medium';
}

module.exports = { pickEffort };
