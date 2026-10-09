// Convening the Council: one-off `claude -p` calls with no tools, no MCP
// servers, no settings and no history entry, each answering in a small JSON
// schema. Three ways to run it, cheapest first:
//   quick   1 call: every advisor and the chair in one structured answer
//   full    N+1:    each advisor on their own (in parallel), then the chair
//   debate  N+2:    full, plus one batched round of rebuttals before the chair
// The question and project context go on stdin, the same for every call, so
// the parallel calls share a prompt the CLI can cache.
//
// Pure apart from convene(), which runs the CLI it's handed. See test/council.test.js.

const P = require('./prompts');

const TIMEOUT_MS = 120000;
// In full and debate, the advisors run a size down from the chair: their
// answers are short and many, the chair's is the one that counts.
const SEAT_MODEL = { haiku: 'haiku', sonnet: 'haiku', opus: 'sonnet' };
const MAX_STANCE = 120, MAX_ARGUMENT = 700, MAX_ITEM = 200, MAX_VERDICT = 400, MAX_REPLY = 400;

/** CLI arguments for one call. lean: skipSettings()'s flags. */
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

/** The CLI's JSON reply -> { ok, data, cost } or { ok: false, error }. */
function parse(stdout) {
  let reply;
  try { reply = JSON.parse(String(stdout).trim()); } catch { return { ok: false, error: "The answer didn't come through." }; }
  if (!reply || typeof reply !== 'object') return { ok: false, error: "The answer didn't come through." };
  const cost = Number.isFinite(reply.total_cost_usd) ? reply.total_cost_usd : 0;
  if (reply.is_error) {
    const text = typeof reply.result === 'string' ? reply.result : '';
    const why = /log(?:ged)? ?in|sign(?:ed)? ?in|auth/i.test(text) ? ' Sign in to Claude Code in Settings first.' : '';
    return { ok: false, error: `Claude couldn't answer.${why}`, cost };
  }
  const data = reply.structured_output;
  return data && typeof data === 'object' ? { ok: true, data, cost } : { ok: false, error: "The answer didn't hold up.", cost };
}

const list = (a, n) => (Array.isArray(a) ? a.map(x => P.clip(x, MAX_ITEM)).filter(Boolean).slice(0, n) : []);
const pct = n => (Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 50);
const vote = v => (P.VOTES.includes(v) ? v : 'conditional');

function cleanOpinion(o) {
  if (!o || typeof o !== 'object') return null;
  const stance = P.clip(o.stance, MAX_STANCE);
  if (!stance) return null;
  return { stance, argument: P.clip(o.argument, MAX_ARGUMENT), risks: list(o.risks, 3), vote: vote(o.vote), confidence: pct(o.confidence) };
}

function cleanVerdict(v) {
  if (!v || typeof v !== 'object') return null;
  const verdict = P.clip(v.verdict, MAX_VERDICT);
  if (!verdict) return null;
  return { verdict, agree: list(v.agree, 3), split: list(v.split, 3), next: list(v.next, 3), confidence: pct(v.confidence) };
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
    return [
      `${s.name} [${o.vote}, ${o.confidence}%]: ${o.stance}`,
      `  ${o.argument}`,
      o.risks.length ? `  Risks: ${o.risks.join('; ')}` : '',
      r ? `  After hearing the others [${r.vote}]: ${r.reply}` : '',
    ].filter(Boolean).join('\n');
  }).join('\n\n');
}

/**
 * q: { question, settings, context, prior, cwd, lean }. run(args, timeoutMs, { cwd, input }) -> the CLI's
 * { stdout, stderr, timedOut }. progress(event) is told as each seat starts and finishes.
 * -> { ok, mode, seats, opinions, rebuttals, chair, tally, cost, calls } or { ok: false, error }.
 */
async function convene(q, run, progress = () => {}) {
  const question = P.cleanQuestion(q.question);
  if (!question) return { ok: false, error: `Ask the council something, up to ${P.MAX_QUESTION} characters.` };
  const settings = P.normalize(q.settings);
  const table = P.seats(settings);
  const { mode, model } = settings;
  const input = P.brief({ question, context: q.context, prior: P.clip(q.prior, 1200) });
  let cost = 0, calls = 0, detail = '';
  const call = async (system, schema, callModel) => {
    calls++;
    const res = await run(args({ system, schema, model: callModel, lean: q.lean }), TIMEOUT_MS, { cwd: q.cwd, input });
    if (res.timedOut) return { ok: false, error: 'Took too long.' };
    if (!String(res.stdout || '').trim()) {
      detail = String(res.stderr || res.err?.message || '').trim().split('\n').slice(-2).join(' ');
      return { ok: false, error: "Claude Code didn't answer. Check it's signed in, in Settings." };
    }
    const r = parse(res.stdout);
    cost += r.cost || 0;
    return r;
  };
  const seatsOut = table.map(s => ({ id: s.id, name: s.name, hue: s.hue, custom: !!s.custom }));
  const done = (extra) => ({ ok: true, mode, model, seats: seatsOut, cost, calls, detail, ...extra });

  if (mode === 'quick') {
    for (const s of table) progress({ kind: 'thinking', seat: s.id });
    const r = await call(P.SYSTEM.quick(table), P.quickSchema(table), model);
    if (!r.ok) return { ok: false, error: r.error, detail, cost };
    const opinions = {};
    for (const s of table) {
      opinions[s.id] = cleanOpinion(r.data.opinions?.[s.id]);
      progress({ kind: 'spoke', seat: s.id, opinion: opinions[s.id] });
    }
    const chair = cleanVerdict(r.data.chair);
    if (!chair && !Object.values(opinions).some(Boolean)) return { ok: false, error: "The council's answer didn't hold up. Try again.", detail, cost };
    return done({ opinions, rebuttals: {}, chair, tally: tally(opinions) });
  }

  // full and debate: every seat on its own, all at once
  const opinions = {};
  await Promise.all(table.map(async s => {
    progress({ kind: 'thinking', seat: s.id });
    const r = await call(P.SYSTEM.seat(s), P.OPINION, SEAT_MODEL[model]);
    opinions[s.id] = r.ok ? cleanOpinion(r.data) : null;
    progress({ kind: 'spoke', seat: s.id, opinion: opinions[s.id] });
  }));
  if (!Object.values(opinions).some(Boolean)) return { ok: false, error: "None of the council answered. Check Claude Code is signed in, in Settings.", detail, cost };

  const rebuttals = {};
  if (mode === 'debate') {
    progress({ kind: 'debating' });
    const r = await callWith(call, P.SYSTEM.rebut(table), P.REBUTTAL, SEAT_MODEL[model], minutes(table, opinions));
    for (const x of (r.ok && Array.isArray(r.data.rebuttals) ? r.data.rebuttals : [])) {
      if (!x || !opinions[x.seat] || rebuttals[x.seat]) continue;
      const reply = P.clip(x.reply, MAX_REPLY);
      if (reply) rebuttals[x.seat] = { reply, vote: vote(x.vote) };
    }
    progress({ kind: 'rebutted', rebuttals });
  }

  progress({ kind: 'thinking', seat: 'chair' });
  const r = await callWith(call, P.SYSTEM.chair(), P.VERDICT, model, minutes(table, opinions, rebuttals));
  const chair = r.ok ? cleanVerdict(r.data) : null;
  return done({ opinions, rebuttals, chair, tally: tally(opinions, rebuttals) });
}

// The rebuttal and chair calls read the advisors' answers too: they go in the
// system prompt, so stdin (the question and context) stays the shared part.
const callWith = (call, system, schema, model, notes) => call(`${system}\n\nThe council's answers:\n${notes}`, schema, model);

/** Roughly how many calls a mode makes, for the panel's cost hint. */
const callsFor = (mode, seated) => (mode === 'quick' ? 1 : seated + 1 + (mode === 'debate' ? 1 : 0));

module.exports = { args, parse, convene, cleanOpinion, cleanVerdict, tally, minutes, callsFor, SEAT_MODEL, TIMEOUT_MS };
