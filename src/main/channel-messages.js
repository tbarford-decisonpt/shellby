// What a phone notification says: the events Shellby can tell you about, and
// one event -> the title, body, priority and tags every provider sends. Pure,
// no network: delivery and settings live in channels.js.

const MAX_TITLE = 100;
const MAX_BODY = 500;

// What Shellby can tell you about, and whether it's on by default. "asking" is
// the one that matters when you've walked away, so it leads.
const EVENTS = Object.freeze({
  asking: { label: 'He needs permission', default: true, priority: 'high' },
  done: { label: 'A task finished', default: true, priority: 'normal' },
  limit: { label: 'Usage limit reached, and when it resets', default: true, priority: 'normal' },
  // Work you queued for the reset, often overnight: what it came to, not just that it ended.
  queue: { label: 'A task you queued for the reset finished, with its result', default: true, priority: 'normal' },
  health: { label: 'Something is overheating or filling up', default: false, priority: 'high' },
  ci: { label: 'A build goes red or green', default: false, priority: 'normal' },
  // A workflow's own "tell me on my phone" step: asked for by name, so on by default.
  workflow: { label: 'A workflow sends you a message', default: true, priority: 'normal' },
});

const clip = (s, n) => String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

const EMOJI = { asking: '🦀', done: '✅', limit: '😴', queue: '🌙', health: '🥵', ci: '🔴', workflow: '⚡' };

/**
 * One event -> what every provider sends.
 *   event: { kind, project?, message?, tools?, seconds?, title?, body?, url?, at? }
 */
function composeMessage(event) {
  const m = describeEvent(event);
  // Some providers put the message in the body (ntfy) and some in a field next
  // to the title. An empty body would arrive as a blank notification on the
  // first kind, so the title stands in for it.
  return { ...m, title: m.title || 'Shellby', body: m.body || m.title || 'Shellby' };
}

function describeEvent(event) {
  const e = event && typeof event === 'object' ? event : {};
  const project = clip(e.project, 60);
  const at = Number.isFinite(e.at) ? e.at : Date.now();
  const base = { event: e.kind, project, at, priority: EVENTS[e.kind]?.priority || 'normal', tags: [], emoji: EMOJI[e.kind] || '🦀', url: clip(e.url, 300) || null, reply: null };

  switch (e.kind) {
    case 'asking': {
      // Buttons only on a prompt, and only with a nonce of the right shape: it
      // goes into a header and a callback, and is the whole of the answer's proof.
      const reply = typeof e.reply?.nonce === 'string' && /^[A-Za-z0-9_-]{22}$/.test(e.reply.nonce) ? { nonce: e.reply.nonce } : null;
      const deskOnly = !reply && clip(e.deskOnly, 80);
      const asked = clip(e.message, deskOnly ? MAX_BODY - 81 : MAX_BODY) || 'A task is waiting for your permission.';
      return {
        ...base, tags: ['crab', 'warning'], reply,
        title: project ? `Shellby needs you in ${project}` : 'Shellby needs you',
        body: deskOnly ? `${asked}\n${deskOnly}` : asked,
      };
    }
    case 'done':
      return {
        ...base, tags: ['crab', 'white_check_mark'],
        title: project ? `Finished in ${project}` : 'Shellby finished',
        body: clip([e.tools ? `${e.tools} tool${e.tools === 1 ? '' : 's'}` : '', duration(e.seconds)].filter(Boolean).join(' · '), MAX_BODY)
          || 'The task is done.',
      };
    case 'limit':
      return {
        ...base, tags: ['crab', 'sleeping'],
        title: e.resetsAt ? 'Usage limit reached' : 'Your usage limit has reset',
        body: e.resetsAt ? `Shellby is napping until ${timeOf(e.resetsAt)}.` : 'Shellby is awake again and ready to go.',
      };
    case 'queue': {
      // status: 'ok' | 'error' | 'stopped' | 'paused' (the window ran dry partway; it carries on at resumeAt).
      const name = clip(e.title, 70) || 'Your queued task';
      const left = Number.isFinite(e.left) && e.left > 0 ? `${e.left} more queued.` : '';
      const head = {
        ok: { emoji: '✅', tag: 'white_check_mark', title: `Done: ${name}` },
        error: { emoji: '⚠️', tag: 'warning', title: `Hit a problem: ${name}` },
        stopped: { emoji: '⏹️', tag: 'stop_button', title: `Stopped: ${name}` },
        paused: { emoji: '😴', tag: 'sleeping', title: `Out of usage partway: ${name}` },
      }[e.status] || { emoji: '🌙', tag: 'crescent_moon', title: name };
      const said = e.status === 'paused'
        ? `It carries on from where it stopped${e.resumeAt ? ` at ${timeOf(e.resumeAt)}` : ' after the next reset'}.`
        : clip(e.body, MAX_BODY - 100) || (e.status === 'ok' ? 'It finished.' : '');
      const facts = [project, duration(e.seconds), left].filter(Boolean).join(' · ');
      return {
        ...base, emoji: head.emoji, tags: ['crab', head.tag],
        title: clip(head.title, MAX_TITLE),
        // Its own line for the facts, so the result reads first.
        body: [said, facts].filter(Boolean).join('\n'),
      };
    }
    case 'health':
      return {
        ...base, tags: ['crab', 'fire'],
        title: clip(e.title, MAX_TITLE) || 'Something needs a look',
        body: clip(e.body, MAX_BODY) || '',
      };
    case 'ci':
      return {
        ...base, tags: ['crab', e.passing ? 'white_check_mark' : 'red_circle'],
        emoji: e.passing ? '✅' : '🔴',
        title: e.passing ? `Build fixed: ${project || 'your pull request'}` : `Build failed: ${project || 'your pull request'}`,
        body: clip(e.body, MAX_BODY) || (e.passing ? 'It went green again.' : 'CI went red.'),
      };
    case 'workflow':
      return {
        ...base, tags: ['crab', 'zap'],
        title: clip(e.title, MAX_TITLE) || (project ? `From ${project}` : 'From a workflow'),
        body: clip(e.body, MAX_BODY) || '',
      };
    default:
      return { ...base, title: clip(e.title, MAX_TITLE) || 'Shellby', body: clip(e.body, MAX_BODY) || '' };
  }
}

function duration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m ${Math.round(seconds % 60)}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function timeOf(ms) {
  const d = new Date(ms);
  return Number.isFinite(d.getTime()) ? d.toTimeString().slice(0, 5) : 'soon';
}

module.exports = { EVENTS, MAX_TITLE, MAX_BODY, clip, composeMessage, duration };
