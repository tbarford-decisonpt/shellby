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

const path = require('path');
const { validateRoutine, describeSchedule } = require('./routines');
const { MODELS } = require('./models');
const todo = require('./projects/todo');
const { PIN_KINDS, MAX_PIN_TEXT } = require('./journal');
const { safePath } = require('./handoff');

const modelName = id => MODELS.find(m => m.id === id)?.label || id;

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
// The Projects page from a terminal (projects/terminal.js): read-only, bar the to-do list.
const PROJECT_ACTIONS = ['projects', 'next_up', 'server_log', 'add_task', 'finish_task'];
// What needs the crab token on /v1/crab: the project questions, and the journal (what you asked, which files, and pins).
const TOKEN_ACTIONS = [...PROJECT_ACTIONS, 'journal'];
const ACTIONS = ['say', 'celebrate', 'wear', 'status', 'add_routine', 'list_routines', 'list_workflows', 'run_workflow', 'add_workflow', 'journal', ...PROJECT_ACTIONS];
const MAX_PROJECT = 200;
const MAX_FOLDER = 400;
const LOG_LINES = { min: 10, max: 200, default: 50 };
// A package.json script name, as devservers/scripts.js allows them.
const SCRIPT = /^[A-Za-z0-9:._-]{1,100}$/;
const MAX_TODO_NUMBER = 999;

// Workflows. The full check of a proposed workflow is schema.js's
// validateWorkflow in main; this only bounds what is handed to it.
const MAX_WORKFLOW_NAME = 60;
const MAX_WORKFLOW_INPUTS = 10;
const MAX_INPUT_VALUE = 2000;
const MAX_WORKFLOW_BYTES = 64 * 1024;
// Same shape as an input name in a workflow (schema.js ID). `__proto__` can't
// match it, so an input object can never reach a prototype.
const INPUT_KEY = /^[a-z][a-z0-9_]{0,31}$/;

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
    case 'run_workflow': {
      const call = parseWorkflowCall(args.name, args.inputs);
      if (!call.ok) return call;
      return { ok: true, intent: { action, name: call.name, inputs: call.inputs } };
    }
    case 'add_workflow':
      return parseWorkflowProposal(args.workflow);
    case 'journal':
      return parseJournal(args);
    case 'projects': case 'next_up': case 'server_log': case 'add_task': case 'finish_task':
      return parseProjectAsk(action, args);
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
    // Checked against the models Shellby offers (models.js); '' is the user's default.
    model: typeof args.model === 'string' ? args.model.trim() : undefined,
    schedule: s && { type: s.type, time: s.time, days: s.days, everyHours: s.everyHours },
  }, { allowAutonomous: false });
  if (!routine) return { ok: false, error: errors.join(' ') };
  // modelGiven: left out, a routine being changed keeps the model it had (main.js proposeRoutine).
  return { ok: true, intent: { action: 'add_routine', routine, modelGiven: typeof args.model === 'string' } };
}

const isPlainObject = v => !!v && typeof v === 'object' && !Array.isArray(v)
  && [Object.prototype, null].includes(Object.getPrototypeOf(v));

/**
 * Which workflow to run, and with what. Shared by `run_workflow` (MCP) and
 * `shellby flow run` (clipath.parseFlowRequest), so both doors check the same.
 * Whether that workflow exists and lets Claude start it is main's question.
 *   -> { ok: true, name, inputs } | { ok: false, error }
 */
function parseWorkflowCall(rawName, rawInputs) {
  if (typeof rawName !== 'string') return { ok: false, error: 'Name the workflow to run.' };
  const name = clip(rawName.replace(UNSAFE, ''), MAX_WORKFLOW_NAME);
  if (!name) return { ok: false, error: 'Name the workflow to run.' };

  const inputs = {};
  if (rawInputs === undefined || rawInputs === null) return { ok: true, name, inputs };
  if (!isPlainObject(rawInputs)) return { ok: false, error: 'Inputs must be a set of names and values.' };
  const keys = Object.keys(rawInputs);
  if (keys.length > MAX_WORKFLOW_INPUTS) return { ok: false, error: `At most ${MAX_WORKFLOW_INPUTS} inputs.` };
  for (const key of keys) {
    if (!INPUT_KEY.test(key)) return { ok: false, error: `"${clip(key.replace(UNSAFE, ''), 32)}" can't be an input name: use lowercase letters, digits and _.` };
    const raw = rawInputs[key];
    const ok = typeof raw === 'string' || typeof raw === 'boolean' || (typeof raw === 'number' && Number.isFinite(raw));
    if (!ok) return { ok: false, error: `Input "${key}" must be text.` };
    const value = String(raw).replace(/\r\n?/g, '\n').replace(UNSAFE, '');
    if (value.length > MAX_INPUT_VALUE) return { ok: false, error: `Input "${key}" is longer than ${MAX_INPUT_VALUE} characters.` };
    inputs[key] = value;
  }
  return { ok: true, name, inputs };
}

/**
 * An `add_workflow` -> the proposal, bounded in size only. main runs it through
 * schema.js's validateWorkflow (never allowing Autonomous) and asks the user.
 */
function parseWorkflowProposal(workflow) {
  if (!isPlainObject(workflow)) return { ok: false, error: 'add_workflow needs a workflow object.' };
  let size;
  try { size = Buffer.byteLength(JSON.stringify(workflow), 'utf8'); } catch { return { ok: false, error: 'That workflow could not be read.' }; }
  if (size > MAX_WORKFLOW_BYTES) return { ok: false, error: `Keep the workflow under ${MAX_WORKFLOW_BYTES / 1024} KB.` };
  return { ok: true, intent: { action: 'add_workflow', workflow } };
}

/** A folder a question came from: absolute, on this PC (never a share), short, printable. Else ''. */
function folderOf(v) {
  // UNSAFE is global, so .test() would carry lastIndex over between calls.
  if (typeof v !== 'string' || !v || v.length > MAX_FOLDER || v.replace(UNSAFE, '') !== v) return '';
  return path.isAbsolute(v) && !/^[\\/]{2}/.test(v) ? path.resolve(v) : '';
}

/**
 * The project tools -> a checked intent for projects/service.js forTerminal.
 * project: what Claude named (a name, owner/name or folder); cwd: the folder the
 * question came from, used when no project is named.
 */
function parseProjectAsk(action, args) {
  const via = args.via === 'cli' ? 'cli' : 'mcp';
  if (action === 'projects') return { ok: true, intent: { action, via } };
  const project = typeof args.project === 'string' ? clip(args.project.replace(UNSAFE, ''), MAX_PROJECT) : '';
  const base = { action, via, project, cwd: folderOf(args.cwd) };
  switch (action) {
    case 'next_up':
      return { ok: true, intent: { ...base, everywhere: args.everywhere === true } };
    case 'server_log': {
      if (args.script !== undefined && args.script !== '' && !(typeof args.script === 'string' && SCRIPT.test(args.script))) {
        return { ok: false, error: 'script must be the name of a package.json script, like dev.' };
      }
      const n = args.lines === undefined ? LOG_LINES.default : args.lines;
      if (!Number.isInteger(n) || n < LOG_LINES.min || n > LOG_LINES.max) return { ok: false, error: `lines must be a whole number from ${LOG_LINES.min} to ${LOG_LINES.max}.` };
      return { ok: true, intent: { ...base, script: args.script || '', lines: n } };
    }
    case 'add_task': {
      if (typeof args.text !== 'string') return { ok: false, error: 'add_task needs the text of the to-do.' };
      // Measured as it would be kept (one line, runs of spaces as one), as the MCP server and the command measure it.
      if (todo.oneLine(args.text).length > todo.MAX_TEXT) return { ok: false, error: `Keep a to-do under ${todo.MAX_TEXT} characters.` };
      const text = todo.cleanText(args.text);
      if (!text) return { ok: false, error: 'add_task needs the text of the to-do.' };
      return { ok: true, intent: { ...base, text } };
    }
    default: { // finish_task
      const t = args.task;
      const isNumber = (Number.isInteger(t) && t >= 1 && t <= MAX_TODO_NUMBER) || (typeof t === 'string' && /^\d{1,3}$/.test(t) && Number(t) >= 1);
      if (!isNumber && !(typeof t === 'string' && todo.ID.test(t))) return { ok: false, error: "finish_task needs the to-do's id or number, as next_up lists it." };
      return { ok: true, intent: { ...base, task: isNumber ? Number(t) : t } };
    }
  }
}

const MODE_NAMES = { ask: 'Ask first', smart: 'Smart', acceptEdits: 'Auto-edit', plan: 'Plan only', autonomous: 'Autonomous' };

/** The confirm window's text for a routine Claude proposed. `replacing` is the one it would overwrite. */
// own: saved from the Routines page rather than proposed by Claude.
function routineQuestion(routine, { replacing = null, defaultFolder = '', own = false } = {}) {
  const who = own ? 'Save' : replacing ? 'Claude wants to change' : 'Claude wants to add';
  return {
    title: replacing ? 'Change a routine?' : 'Add a routine?',
    message: `${who} "${(replacing && !own ? replacing : routine).name}": ${describeSchedule(routine.schedule)}.`,
    // Folder and mode first: they're the facts a long prompt must not push away.
    detail: `Folder: ${routine.cwd || `${defaultFolder} (default)`}\nMode: ${MODE_NAMES[routine.mode] || routine.mode}${routine.model ? `\nModel: ${modelName(routine.model)}` : ''}${routine.mcp?.length ? `\nUses without asking: ${routine.mcp.join(', ')} (MCP${routine.mcpOnly ? ', and no other servers' : ''})` : ''}\n\n${routine.prompt}`,
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
 * What `list_workflows` (and `shellby flow list`) reads back: the ones Claude
 * may start first, with their inputs, then the rest by name.
 *   list: [{ name, description, enabled, triggers: [text], inputs: [{ name, label, required }],
 *            claudeCanRun, lastRun: { status, startedAt } | null }]
 */
function workflowsReply(list) {
  const all = (Array.isArray(list) ? list : []).filter(w => w && typeof w === 'object');
  if (!all.length) return 'The user has no workflows yet. add_workflow can propose one.';
  const line = w => {
    const bits = [
      ...(Array.isArray(w.triggers) ? w.triggers.map(t => clip(t, 80)).filter(Boolean).slice(0, 8) : []),
      w.enabled === false ? 'paused' : null,
      w.lastRun?.status ? `last run ${clip(w.lastRun.status, 20)}` : null,
    ].filter(Boolean);
    const desc = clip(w.description, 160);
    return `- "${clip(w.name, MAX_WORKFLOW_NAME)}"${bits.length ? ` (${bits.join(', ')})` : ''}${desc ? `: ${desc}` : ''}`;
  };
  const inputsOf = w => {
    const inputs = (Array.isArray(w.inputs) ? w.inputs : []).filter(i => i && typeof i.name === 'string');
    if (!inputs.length) return '';
    return `\n  inputs: ${inputs.map(i => {
      const label = clip(i.label, 80);
      const extra = [label && label !== i.name ? label : null, i.required ? 'required' : null].filter(Boolean);
      return `${clip(i.name, 32)}${extra.length ? ` (${extra.join(', ')})` : ''}`;
    }).join('; ')}`;
  };

  const mine = all.filter(w => w.claudeCanRun === true);
  const rest = all.filter(w => w.claudeCanRun !== true);
  const parts = [`${all.length} workflow${all.length === 1 ? '' : 's'}.`];
  if (mine.length) parts.push(`You can start ${mine.length === 1 ? 'this one' : 'these'} with run_workflow:\n${mine.map(w => line(w) + inputsOf(w)).join('\n')}`);
  else parts.push('None of them can be started by Claude Code (that needs the "Claude Code" trigger).');
  if (rest.length) parts.push(`${mine.length ? 'The user can run the rest' : 'The user can run them'} from Shellby's Automate page:\n${rest.map(line).join('\n')}`);
  return parts.join('\n');
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

/**
 * The project journal (journal.js): read the notes for a folder, or pin a line
 * to them. Only a local drive's folder (handoff.js safePath): a network share
 * would have git, run in it to find the project, reach out to another machine.
 */
function parseJournal(args) {
  const folder = typeof args.folder === 'string' ? args.folder.trim() : '';
  if (!safePath(folder)) return { ok: false, error: "That folder isn't a full path on this PC." };
  if (args.pin === undefined || args.pin === null) return { ok: true, intent: { action: 'journal', folder, pin: null } };
  const p = args.pin && typeof args.pin === 'object' && !Array.isArray(args.pin) ? args.pin : {};
  const text = clip(String(p.text ?? '').replace(UNSAFE, ''), MAX_PIN_TEXT);
  if (!text) return { ok: false, error: 'A pin needs some text.' };
  return { ok: true, intent: { action: 'journal', folder, pin: { kind: PIN_KINDS.includes(p.kind) ? p.kind : 'note', text } } };
}

module.exports = {
  parseRequest, matchItem, wearReply, statusReply, ackReply,
  routineQuestion, routineReply, routinesReply,
  parseWorkflowCall, workflowsReply,
  ACTIONS, PROJECT_ACTIONS, TOKEN_ACTIONS, LOG_LINES, MOODS, MAX_TEXT, MAX_ITEM, MAX_ROUTINE_PROMPT, MAX_ROUTINE_LINES,
  MAX_WORKFLOW_NAME, MAX_WORKFLOW_INPUTS, MAX_INPUT_VALUE, MAX_WORKFLOW_BYTES, INPUT_KEY,
};
