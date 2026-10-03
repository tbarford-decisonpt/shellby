// The app side of "Claude drives the crab" (claude-plugin/mcp/server.js).
//
// The MCP server validates its own tool calls, but it is not the only thing
// that can reach the port it posts to, so everything is checked again here.
// What arrives is treated as hostile: a name, a length, a known action, or it
// is refused.
//
// Nothing in this file touches the critter or the wardrobe. It turns a request
// into a checked intent and a sentence to answer with, and main.js supplies the
// effects. That keeps it pure, so it is all unit-tested.

const { validateRoutine, describeSchedule } = require('./routines');

const MAX_TEXT = 120;
const MAX_ITEM = 60;
// A routine Claude proposes is shown in full in the confirm window, so it can't
// hide a tail there; the panel's own editor allows longer ones.
const MAX_ROUTINE_PROMPT = 1000;
const MAX_ROUTINE_LINES = 20;
// Control characters (bar tab and newline) and the bidi overrides that can make
// text read differently from what it says.
const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f‎‏‪-‮⁦-⁩]/g;
const MOODS = ['happy', 'worried', 'thinking', 'proud', 'sleepy'];
const ACTIONS = ['say', 'celebrate', 'wear', 'status', 'add_routine', 'list_routines'];

// Flattened to one line and capped: this ends up in a speech bubble on the
// desktop, so no newlines, no control characters, nothing unbounded.
const clip = (s, n) => String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

/**
 * A POSTed { action, args } -> a checked intent, or an error to answer with.
 *   { ok: true, intent: { action, ... } } | { ok: false, error }
 */
function parseRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'Expected a JSON object.' };
  const action = typeof body.action === 'string' ? body.action : '';
  if (!ACTIONS.includes(action)) return { ok: false, error: `Unknown action: ${clip(action, 40) || '(none)'}` };
  const args = body.args && typeof body.args === 'object' && !Array.isArray(body.args) ? body.args : {};

  switch (action) {
    case 'say': {
      const text = clip(args.text, MAX_TEXT);
      if (!text) return { ok: false, error: 'Nothing to say.' };
      return { ok: true, intent: { action, text, mood: MOODS.includes(args.mood) ? args.mood : 'happy' } };
    }
    case 'celebrate':
      return { ok: true, intent: { action, reason: clip(args.reason, MAX_TEXT) } };
    case 'wear': {
      const item = clip(args.item, MAX_ITEM);
      if (!item) return { ok: false, error: 'No accessory named.' };
      return { ok: true, intent: { action, item } };
    }
    case 'add_routine':
      return parseRoutine(args);
    default:
      return { ok: true, intent: { action } };
  }
}

/**
 * An `add_routine` -> a validated routine, or an error Claude can act on. Only
 * the fields Claude may choose are passed through: never an id, never enabled,
 * never Autonomous. Whether it's saved at all is the user's call (main.js asks).
 */
function parseRoutine(args) {
  // Blank-line runs collapse, so padding can't scroll the real instruction out
  // of the confirm window's sight.
  const prompt = typeof args.prompt === 'string'
    ? args.prompt.replace(/\r\n?/g, '\n').replace(UNSAFE, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
    : '';
  if (prompt.length > MAX_ROUTINE_PROMPT) return { ok: false, error: `Keep the routine's prompt under ${MAX_ROUTINE_PROMPT} characters.` };
  if (prompt.split('\n').length > MAX_ROUTINE_LINES) return { ok: false, error: `Keep the routine's prompt under ${MAX_ROUTINE_LINES} lines.` };
  if (typeof args.folder === 'string' && (args.folder.match(UNSAFE) || []).length) return { ok: false, error: 'That folder name has characters Shellby won\'t show.' };
  const s = args.schedule && typeof args.schedule === 'object' && !Array.isArray(args.schedule) ? args.schedule : null;
  const { routine, errors } = validateRoutine({
    name: typeof args.name === 'string' ? args.name.replace(UNSAFE, ' ') : args.name,
    prompt,
    cwd: args.folder,
    mode: args.mode,
    catchUp: typeof args.catchUp === 'boolean' ? args.catchUp : undefined,
    schedule: s && { type: s.type, time: s.time, days: s.days, everyHours: s.everyHours },
  }, { allowAutonomous: false });
  if (!routine) return { ok: false, error: errors.join(' ') };
  return { ok: true, intent: { action: 'add_routine', routine } };
}

const MODE_NAMES = { ask: 'Ask first', smart: 'Smart', acceptEdits: 'Auto-edit', plan: 'Plan only', autonomous: 'Autonomous' };

/** The confirm window's text for a routine Claude proposed. `replacing` is the one it would overwrite. */
function routineQuestion(routine, { replacing = null, defaultFolder = '' } = {}) {
  return {
    title: replacing ? 'Change a routine?' : 'Add a routine?',
    message: replacing
      ? `Claude wants to change "${replacing.name}": ${describeSchedule(routine.schedule)}.`
      : `Claude wants to add "${routine.name}": ${describeSchedule(routine.schedule)}.`,
    // Folder and mode first: they're the facts a long prompt must not push away.
    detail: `Folder: ${routine.cwd || `${defaultFolder} (default)`}\nMode: ${MODE_NAMES[routine.mode] || routine.mode}\n\n${routine.prompt}`,
    note: 'Each run is a Claude Code task on your subscription. You can pause, edit or delete it in Routines.',
  };
}

/** The sentence Claude reads back once the user has answered. */
function routineReply(routine, { added, replaced = false, next = null }) {
  if (!added) return `The user decided not to ${replaced ? 'change' : 'add'} the "${routine.name}" routine. Nothing was saved.`;
  const when = describeSchedule(routine.schedule);
  const nextText = Number.isFinite(next) ? ` Next run: ${new Date(next).toLocaleString()}.` : '';
  return `${replaced ? 'Changed' : 'Added'} the "${routine.name}" routine (${when}).${nextText} The user can pause, edit or delete it from Shellby's Routines page.`;
}

/**
 * What `list_routines` reads back. Short per routine, because it goes into a
 * model's context: enough to avoid a duplicate or change the right one.
 * Prompts and folders are included on purpose: changing a routine means
 * sending it back whole, and anything that can reach the port runs as the user
 * and could read them from Shellby's settings file anyway.
 *   view: [{ name, prompt, cwd, mode, enabled, scheduleText, next, lastStatus }]
 */
function routinesReply(view) {
  const list = Array.isArray(view) ? view : [];
  if (!list.length) return 'The user has no routines yet.';
  const lines = list.map(r => {
    const bits = [r.scheduleText, r.enabled ? null : 'paused', MODE_NAMES[r.mode] || r.mode, r.cwd ? `in ${r.cwd}` : null,
      r.lastStatus ? `last run ${r.lastStatus}` : null].filter(Boolean);
    return `- "${r.name}" (${bits.join(', ')}): ${clip(r.prompt, 160)}`;
  });
  return `${list.length} routine${list.length === 1 ? '' : 's'}:\n${lines.join('\n')}`;
}

/**
 * Find the accessory someone meant. Claude passes a human name ("party hat"),
 * not Shellby's internal id, so: exact id, then exact name, then every word of
 * the request appearing in the name, then a loose contains. Only items the user
 * has actually unlocked can win.
 *   items: [{ id, name, slot, owned }]
 *   -> { item } | { suggestions: [name] }
 */
function matchItem(query, items) {
  const list = (Array.isArray(items) ? items : []).filter(i => i && typeof i.name === 'string');
  const q = clip(query, MAX_ITEM).toLowerCase();
  const owned = list.filter(i => i.owned);
  const norm = s => String(s).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const nq = norm(q);
  // No name is not a match for everything: `words.every` on an empty list is
  // true, which would otherwise dress him at random.
  if (!nq) return { suggestions: [] };

  const exact = owned.find(i => String(i.id).toLowerCase() === q || norm(i.name) === nq);
  if (exact) return { item: exact };

  const words = nq.split(' ').filter(Boolean);
  const allWords = owned.filter(i => words.every(w => norm(i.name).includes(w)));
  if (allWords.length === 1) return { item: allWords[0] };
  // Several hats match "hat": prefer the shortest name, which is the plainest one.
  if (allWords.length > 1) return { item: allWords.sort((a, b) => a.name.length - b.name.length)[0] };

  const loose = owned.filter(i => norm(i.name).includes(nq) || nq.includes(norm(i.name)));
  if (loose.length) return { item: loose.sort((a, b) => a.name.length - b.name.length)[0] };

  // Nothing owned matched. If it exists but is locked, say so rather than
  // pretending it isn't a thing.
  const locked = list.find(i => !i.owned && (norm(i.name) === nq || words.length && words.every(w => norm(i.name).includes(w))));
  if (locked) return { suggestions: [], locked: locked.name };
  return { suggestions: nearest(nq, owned).slice(0, 4) };
}

// The owned items sharing the most words with the request, best first.
function nearest(nq, owned) {
  const words = new Set(nq.split(' ').filter(Boolean));
  return owned
    .map(i => {
      const theirs = String(i.name).toLowerCase().split(/\s+/);
      return { name: i.name, score: theirs.filter(w => words.has(w)).length };
    })
    .filter(x => x.score > 0)
    // Ties broken by name, so the same request always suggests the same things.
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .map(x => x.name);
}

/** The sentence the MCP server reads back after a `wear`. */
function wearReply(match, item) {
  if (match.item) return `Shellby is wearing the ${match.item.name} now.`;
  if (match.locked) return `Shellby has not unlocked the ${match.locked} yet, so he can't put it on.`;
  if (match.suggestions?.length) return `No "${item}" in his wardrobe. He does have: ${match.suggestions.join(', ')}.`;
  return `No "${item}" in his wardrobe.`;
}

/**
 * The status line Claude gets back: the crab, then the machine. One short
 * paragraph, because it is going into a model's context on every call.
 *   view: { level, title, xp, state, busy, mood, health, sample, limit, focus }
 */
function statusReply(view = {}) {
  const parts = [];
  const lvl = view.level ? `Level ${view.level}${view.title ? ` ${view.title}` : ''}` : null;
  if (lvl) parts.push(Number.isFinite(view.xp) ? `${lvl}, ${view.xp} XP` : lvl);

  if (view.limit?.resetsAt) parts.push(`napping until the usage limit resets at ${timeOf(view.limit.resetsAt)}`);
  else if (view.busy > 0) parts.push(`${view.busy} task${view.busy === 1 ? '' : 's'} running`);
  else if (view.state === 'asking') parts.push('waiting on a permission prompt');
  else parts.push('idle');

  if (view.focus?.phase === 'focus') parts.push('guarding the user\'s focus');

  const machine = [];
  const s = view.sample;
  const temp = v => `${Math.round(v)}°C`;
  if (s?.cpu?.temp != null) machine.push(`CPU ${temp(s.cpu.temp)}`);
  if (s?.cpu?.load != null) machine.push(`CPU load ${Math.round(s.cpu.load)}%`);
  const gpu = s?.gpus?.[0];
  if (gpu?.temp != null) machine.push(`GPU ${temp(gpu.temp)}${gpu.load != null ? ` at ${Math.round(gpu.load)}%` : ''}`);
  if (s?.ram?.pct != null) machine.push(`memory ${Math.round(s.ram.pct)}% used`);
  const tight = (s?.disks || []).filter(d => d.free / 1024 ** 3 < 50);
  if (tight.length) machine.push(`${tight.map(d => `${d.id} ${(d.free / 1024 ** 3).toFixed(0)} GB free`).join(', ')}`);

  const lines = [`Shellby: ${parts.join(', ')}.`];
  if (machine.length) lines.push(`This PC: ${machine.join(', ')}.`);
  if (view.mood) lines.push(`He is ${MOOD_WORDS[view.mood.mood] || view.mood.mood} (${view.mood.text}).`);
  if (!machine.length && !view.mood) lines.push('Health monitoring is off, so no readings for this PC.');
  return lines.join(' ');
}

const MOOD_WORDS = {
  hot: 'sweating, something is running hot',
  scorching: 'panting, something is overheating',
  dizzy: 'dizzy, memory is nearly full',
  stuffed: 'overstuffed, a drive is nearly full',
};

function timeOf(ms) {
  const d = new Date(ms);
  return Number.isFinite(d.getTime()) ? d.toTimeString().slice(0, 5) : 'soon';
}

/** The sentence for a `say` or `celebrate` that went through. */
function ackReply(intent) {
  if (intent.action === 'say') return `Shellby said it.`;
  if (intent.action === 'celebrate') return intent.reason ? `Shellby is celebrating: ${intent.reason}` : 'Shellby is celebrating.';
  return 'Done.';
}

module.exports = {
  parseRequest, matchItem, wearReply, statusReply, ackReply,
  routineQuestion, routineReply, routinesReply,
  ACTIONS, MOODS, MAX_TEXT, MAX_ITEM, MAX_ROUTINE_PROMPT, MAX_ROUTINE_LINES,
};
