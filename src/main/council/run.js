// Convening the Council: one-off `claude -p` calls with no history entry, each
// answering in a small JSON schema. A sitting goes:
//   read    (optional) one call that may only read the project (look.js), for
//           numbered, checked facts; it also picks who sits when Shellby picks
//   pick    without a read, picking who sits is one small tool-less call
//   quick   1 call: every advisor and the chair in one structured answer
//   debate  N+2: each advisor on their own (in parallel), one batched round of
//           rebuttals, then the chair
// The advisors and the chair have no tools at all. The question, facts and
// context go on stdin, the same for every call, so the parallel calls share a
// prompt the CLI can cache.
//
// Pure apart from convene(), which runs the CLI it's handed. See test/council.test.js.

const path = require('path');
const P = require('./prompts');
const L = require('./look');
const C = require('./cost');

const TIMEOUT_MS = 120000;
// In Debate, the advisors run a size down from the chair: their answers are
// short and many, the chair's is the one that counts.
const SEAT_MODEL = { haiku: 'haiku', sonnet: 'haiku', opus: 'sonnet' };
const MAX_STANCE = 120, MAX_ARGUMENT = 700, MAX_ITEM = 200, MAX_VERDICT = 400, MAX_REPLY = 400, MAX_SHORT = 160, MAX_AGAINST = 300;

/** CLI arguments for one advisor or chair call: no tools, no MCP servers. lean: skipSettings()'s flags. */
function args({ system, schema, model, lean = [] }) {
  return [
    '-p', '--output-format', 'json',
    '--json-schema', JSON.stringify(schema),
    '--system-prompt', system,
    '--model', model,
    '--tools', '',
    '--strict-mcp-config',
    '--no-session-persistence',
    ...lean,
  ];
}

/**
 * The CLI's JSON reply -> { ok, data, cost, usage } or { ok: false, error, cost, usage }.
 * cost is null when the reply didn't say what it cost.
 */
function parse(stdout) {
  let reply;
  try { reply = JSON.parse(String(stdout).trim()); } catch { return { ok: false, error: "The answer didn't come through." }; }
  if (!reply || typeof reply !== 'object') return { ok: false, error: "The answer didn't come through." };
  const cost = Number.isFinite(reply.total_cost_usd) ? reply.total_cost_usd : null;
  const usage = reply.usage && typeof reply.usage === 'object' ? reply.usage : null;
  if (/max_budget/i.test(String(reply.subtype || ''))) return { ok: false, error: 'It hit its spending cap before it finished.', cost, usage };
  if (reply.is_error) {
    const text = typeof reply.result === 'string' ? reply.result : '';
    const why = /log(?:ged)? ?in|sign(?:ed)? ?in|auth/i.test(text) ? ' Sign in to Claude Code in Settings first.' : '';
    return { ok: false, error: `Claude couldn't answer.${why}`, cost, usage };
  }
  const data = reply.structured_output;
  return data && typeof data === 'object' ? { ok: true, data, cost, usage } : { ok: false, error: "The answer didn't hold up.", cost, usage };
}

const list = (a, n, max = MAX_ITEM) => (Array.isArray(a) ? a.map(x => P.clip(x, max)).filter(Boolean).slice(0, n) : []);
const pct = n => (Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 50);
const vote = v => (P.VOTES.includes(v) ? v : 'conditional');
// Fact numbers that exist: an advisor can't cite [F7] when there were three.
const cites = (a, facts) => [...new Set(Array.isArray(a) ? a.filter(n => Number.isInteger(n) && n >= 1 && n <= facts) : [])].slice(0, 4);

function cleanOpinion(o, facts = 0) {
  if (!o || typeof o !== 'object') return null;
  const stance = P.clip(o.stance, MAX_STANCE);
  if (!stance) return null;
  const v = vote(o.vote);
  return {
    stance, argument: P.clip(o.argument, MAX_ARGUMENT), risks: list(o.risks, 3), vote: v,
    condition: v === 'conditional' ? P.clip(o.condition, MAX_SHORT) : '',
    wouldChange: P.clip(o.wouldChange, MAX_SHORT),
    cites: cites(o.cites, facts),
    confidence: pct(o.confidence),
  };
}

function cleanVerdict(v, facts = 0) {
  if (!v || typeof v !== 'object') return null;
  const verdict = P.clip(v.verdict, MAX_VERDICT);
  if (!verdict) return null;
  return {
    decision: P.DECISIONS.includes(v.decision) ? v.decision : null,
    verdict, against: P.clip(v.against, MAX_AGAINST),
    agree: list(v.agree, 3), split: list(v.split, 3), next: list(v.next, 3), open: list(v.open, 3),
    cites: cites(v.cites, facts),
    confidence: pct(v.confidence),
  };
}

/** Each seat's rebuttal, kept only for seats that answered, once each. */
function cleanRebuttals(data, opinions) {
  const out = {};
  for (const x of (Array.isArray(data?.rebuttals) ? data.rebuttals : [])) {
    if (!x || !opinions[x.seat] || out[x.seat]) continue;
    const reply = P.clip(x.reply, MAX_REPLY);
    if (!reply) continue;
    const to = typeof x.to === 'string' && x.to !== x.seat && opinions[x.to] ? x.to : null;
    const v = vote(x.vote);
    out[x.seat] = { reply, vote: v, to, changed: v !== opinions[x.seat].vote };
  }
  return out;
}

/** How the advisors voted: { for, against, conditional }. */
function tally(opinions, rebuttals = {}) {
  const t = { for: 0, against: 0, conditional: 0 };
  for (const [id, o] of Object.entries(opinions)) {
    const v = rebuttals[id]?.vote || o?.vote;
    if (v) t[v]++;
  }
  return t;
}

/** What the chair reads: every answer by name, and the rebuttals. */
function minutes(table, opinions, rebuttals = {}) {
  return table.map(s => {
    const o = opinions[s.id];
    if (!o) return `${s.name}: (no answer)`;
    const r = rebuttals[s.id];
    const to = r?.to ? table.find(x => x.id === r.to)?.name : '';
    return [
      `${s.name} [${o.vote}${o.condition ? ` if ${o.condition}` : ''}, ${o.confidence}%]: ${o.stance}`,
      `  ${o.argument}`,
      o.risks.length ? `  Risks: ${o.risks.join('; ')}` : '',
      o.wouldChange ? `  Would change their mind: ${o.wouldChange}` : '',
      r ? `  After hearing the others [${r.vote}]${to ? ` (to ${to})` : ''}: ${r.reply}` : '',
    ].filter(Boolean).join('\n');
  }).join('\n\n');
}

/**
 * q: { question, settings, context, prior, cwd, root, records, lean }. root: the project folder to
 * read first (settings.read), or '' for none. records: store.js records(), for the chair.
 * run(args, timeoutMs, { cwd, input }) -> the CLI's { stdout, stderr, timedOut }.
 * progress(event) is told as the read, the seating and each seat start and finish.
 * -> { ok, mode, seats, facts, unknowns, opinions, rebuttals, chair, tally, cost, unpriced, weight, calls, ... }
 * or { ok: false, error, cost, unpriced, weight, calls }: cost is what the calls reported
 * (a floor when unpriced > 0), weight their spend.js weight.
 */
async function convene(q, run, progress = () => {}) {
  const question = P.cleanQuestion(q.question);
  if (!question) return { ok: false, error: `Ask the council something, up to ${P.MAX_QUESTION} characters.` };
  const settings = P.normalize(q.settings);
  const { mode, model } = settings;
  const prior = P.clip(q.prior, 1200);
  // What every call cost: a call with no answer, or no cost in it, makes the total a floor.
  let spent = C.NO_CALLS, calls = 0, detail = '';
  const once = async (callArgs, timeout, cwd, input) => {
    calls++;
    const callModel = callArgs[callArgs.indexOf('--model') + 1];
    const res = await run(callArgs, timeout, { cwd, input });
    if (res.timedOut) {
      spent = C.addCall(spent, null, callModel);
      return { ok: false, error: 'Took too long.' };
    }
    if (!String(res.stdout || '').trim()) {
      spent = C.addCall(spent, null, callModel);
      detail = String(res.stderr || res.err?.message || '').trim().split('\n').slice(-2).join(' ');
      return { ok: false, error: "Claude Code didn't answer. Check it's signed in, in Settings." };
    }
    const r = parse(res.stdout);
    spent = C.addCall(spent, r, callModel);
    return r;
  };
  const failed = error => ({ ok: false, error, detail, ...spent, calls });

  // ---- read the project first, and pick who sits
  const pickFrom = settings.pick ? P.everyone(settings) : null;
  const lookInput = P.brief({ question, context: q.context, prior });
  let facts = [], unknowns = [], picked = null, dropped = 0, hidden = 0, readError = '';
  if (settings.read && q.root) {
    progress({ kind: 'reading', project: path.basename(q.root) });
    const r = await once(L.lookArgs({ model, pickFrom, lean: q.lean }), L.LOOK_TIMEOUT_MS, q.root, lookInput);
    if (r.ok) ({ facts, unknowns, picked, dropped, hidden } = L.cleanLook(r.data, q.root));
    else readError = r.error;
    progress({ kind: 'read', facts, unknowns, dropped, hidden, error: readError });
  }
  // The read's pick can fall short (too few, or advisors that don't exist): then pick on its own.
  if (pickFrom && !P.pickedIds(settings, picked)) {
    progress({ kind: 'picking' });
    const r = await once(L.pickArgs({ pickFrom, lean: q.lean }), L.PICK_TIMEOUT_MS, q.cwd, P.brief({ question }));
    if (r.ok && Array.isArray(r.data.seats)) picked = r.data.seats;
  }
  const chosen = pickFrom ? P.pickedIds(settings, picked) : null;
  const table = P.seats(settings, chosen);
  const seatsOut = table.map(s => ({ id: s.id, name: s.name, hue: s.hue, custom: !!s.custom }));
  progress({ kind: 'seated', seats: seatsOut, picked: !!chosen });

  // ---- the sitting
  const input = P.brief({ question, context: q.context, facts, unknowns, prior });
  const call = (system, schema, callModel) => once(args({ system, schema, model: callModel, lean: q.lean }), TIMEOUT_MS, q.cwd, input);
  const n = facts.length;
  const done = (extra) => ({
    ok: true, mode, model, seats: seatsOut, picked: !!chosen, facts, unknowns, dropped, hidden, readError,
    ...spent, calls, detail, ...extra,
  });

  if (mode === 'quick') {
    for (const s of table) progress({ kind: 'thinking', seat: s.id });
    const r = await call(P.SYSTEM.quick(table, q.records), P.quickSchema(table), model);
    if (!r.ok) return failed(r.error);
    const opinions = {};
    for (const s of table) {
      opinions[s.id] = cleanOpinion(r.data.opinions?.[s.id], n);
      progress({ kind: 'spoke', seat: s.id, opinion: opinions[s.id] });
    }
    const chair = cleanVerdict(r.data.chair, n);
    if (!chair && !Object.values(opinions).some(Boolean)) return failed("The council's answer didn't hold up. Try again.");
    return done({ opinions, rebuttals: {}, chair, tally: tally(opinions) });
  }

  // debate: every seat on its own, all at once
  const opinions = {};
  await Promise.all(table.map(async s => {
    progress({ kind: 'thinking', seat: s.id });
    const r = await call(P.SYSTEM.seat(s), P.OPINION, SEAT_MODEL[model]);
    opinions[s.id] = r.ok ? cleanOpinion(r.data, n) : null;
    progress({ kind: 'spoke', seat: s.id, opinion: opinions[s.id] });
  }));
  if (!Object.values(opinions).some(Boolean)) return failed('None of the council answered. Check Claude Code is signed in, in Settings.');

  progress({ kind: 'debating' });
  const rb = await callWith(call, P.SYSTEM.rebut(table), P.REBUTTAL, SEAT_MODEL[model], minutes(table, opinions));
  const rebuttals = rb.ok ? cleanRebuttals(rb.data, opinions) : {};
  progress({ kind: 'rebutted', rebuttals });

  progress({ kind: 'thinking', seat: 'chair' });
  const r = await callWith(call, P.SYSTEM.chair(table, q.records), P.VERDICT, model, minutes(table, opinions, rebuttals));
  const chair = r.ok ? cleanVerdict(r.data, n) : null;
  return done({ opinions, rebuttals, chair, tally: tally(opinions, rebuttals) });
}

// The rebuttal and chair calls read the advisors' answers too: they go in the
// system prompt, so stdin (the question, facts and context) stays the shared part.
const callWith = (call, system, schema, model, notes) => call(`${system}\n\nThe council's answers:\n${notes}`, schema, model);

/**
 * Roughly how many calls a sitting makes, for the panel's cost hint. seated: how many
 * sit (the most, when Shellby picks). read: reading the project; pick: Shellby picks.
 */
const callsFor = (mode, seated, { read = false, pick = false } = {}) =>
  (read || pick ? 1 : 0) + (mode === 'quick' ? 1 : seated + 2);

module.exports = { args, parse, convene, cleanOpinion, cleanVerdict, cleanRebuttals, tally, minutes, callsFor, SEAT_MODEL, TIMEOUT_MS };
