// Learning from corrections: Shellby sees you put Claude right in ways a
// terminal never does (a line comment on a diff, Deny on a permission card,
// Undo of a turn, a rewind, a "try again"). When the same correction comes up
// twice in one project, he offers to write it down as a rule in that project's
// CLAUDE.md (learned-rules.js does the writing), so Claude stops needing it.
//
// Everything here is pure and local: the events, spotting a pattern in them
// (shared words, the same command denied, the same folder undone), which
// patterns were already offered or turned down, and the rule's plain wording.
// The store lives in settings (`corrections`), capped and pruned like weekly.js.
// See test/corrections.test.js.

const DAY = 864e5;
const KEEP_DAYS = 60;          // older corrections don't count towards a pattern
const MAX_EVENTS = 300;        // across every project
const MAX_EVENTS_PER_ROOT = 100;
const MAX_OFFERS = 300;        // dismissed and added ones are what's kept longest
const OPEN_QUIET_DAYS = 7;     // an unanswered card isn't offered again this soon
const OPEN_KEEP_DAYS = 30;     // ...and is forgotten after this
const MAX_TEXT = 500;
const MAX_FILES = 40;
const MAX_RULE = 300;
const REPEATS = 2;             // "twice" is a pattern

const KINDS = ['comment', 'deny', 'undo', 'rewind', 'retry'];
const UNDOING = new Set(['undo', 'rewind', 'retry']);

// Control and invisible formatting characters out, so nothing hides in a rule.
const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
// Text that looks like it carries a key isn't kept at all.
const SECRET = /(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|AKIA[0-9A-Z]{16}|xox[abposr]-[\w-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY|\b(password|passwd|secret|api[_-]?key|token)\s*[=:]\s*\S{6,})/i;

const oneLine = (s, max) => String(s ?? '').replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const isStr = s => typeof s === 'string' && s.length > 0;
const rootKey = r => String(r || '').replace(/[\\/]+$/, '').toLowerCase();

// ------------------------------------------------------------ words

// Words that say nothing about *what* was wrong. "don't" and "keep" carry the
// rule's tone, not its subject, so they don't count towards two comments being alike.
const STOP = new Set(`
a an the and or but if then else so than that this these those there here it its it's
is are was were be been being am do does did done doing have has had having
to of in on at by for with from as into onto about over under up down out off
i me my we our you your he she they them their what which who whom when where why how
not no nor don't dont doesn't didn't isn't aren't won't can't cannot shouldn't
should would could can will shall may might must also just only very really
please pls thanks thank ok okay yes yeah one some any all each every more most
use using used make makes made keep get got put let like want need needs here's
again still instead rather maybe probably actually now always never ever
line lines code file files bit thing things stuff way
`.split(/\s+/).filter(Boolean));

const stem = w => (w.length > 4 && w.endsWith('ies') ? `${w.slice(0, -3)}y`
  : w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);

/** The words that carry a correction's meaning, as a Set. */
function words(text) {
  const out = new Set();
  for (const raw of String(text || '').toLowerCase().replace(/[’']/g, '').split(/[^a-z0-9_]+/)) {
    if (raw.length < 3 || STOP.has(raw) || /^\d+$/.test(raw)) continue;
    out.add(stem(raw));
  }
  return out;
}

const shared = (a, b) => new Set([...a].filter(w => b.has(w)));

/**
 * Do two sets of words say the same thing? Two shared words that are most of
 * the shorter one, or the very same words ("typo" twice).
 */
function alike(a, b) {
  if (!a.size || !b.size) return false;
  const s = shared(a, b).size;
  if (s === a.size && s === b.size) return true;
  return s >= 2 && s / Math.min(a.size, b.size) >= 0.6;
}

// ------------------------------------------------------------ what a deny was about

// Commands whose second word is the real verb: `git push`, not just `git`.
const TWO_WORD = new Set(['git', 'npm', 'npx', 'pnpm', 'yarn', 'bun', 'docker', 'gh', 'cargo', 'pip', 'pip3', 'python', 'py', 'kubectl', 'dotnet', 'go', 'terraform', 'az', 'aws', 'gcloud', 'vercel', 'winget', 'choco', 'scoop']);

function commandHead(command) {
  const first = String(command || '').split(/&&|\|\||[;|\n]/)[0].trim();
  const parts = first.split(/\s+/).filter(p => p && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(p) && p !== 'sudo');
  if (!parts.length) return '';
  const exe = parts[0].replace(/^.*[\\/]/, '').replace(/\.(exe|cmd|bat|ps1)$/i, '').toLowerCase();
  const next = parts[1];
  return TWO_WORD.has(exe) && next && !next.startsWith('-') ? `${exe} ${next.toLowerCase()}` : exe;
}

const posix = p => String(p || '').replace(/\\/g, '/');

/** A path as it sits in the project (forward slashes), or null when it's outside it. */
function inProject(file, root) {
  const f = posix(file), r = posix(root).replace(/\/+$/, '');
  if (!f) return null;
  if (!/^([a-z]:)?\//i.test(f)) return f.replace(/^\.\//, '');
  return r && f.toLowerCase().startsWith(`${r.toLowerCase()}/`) ? f.slice(r.length + 1) : null;
}

/** The folder a file is in, as the place it belongs to; a file at the top is its own place. */
function areaOf(rel) {
  const p = posix(rel).replace(/^\/+/, '');
  if (!p) return '';
  const cut = p.lastIndexOf('/');
  return cut < 0 ? p : `${p.slice(0, cut)}/`;
}

/**
 * What a denied tool call was about: { tool, subject, label }.
 * label is what the card and the rule call it (a command, a folder, a site).
 */
function denySubject(toolName, input, root) {
  const tool = oneLine(toolName, 80) || 'a tool';
  const i = input && typeof input === 'object' ? input : {};
  if (/^(Bash|PowerShell)$/.test(tool)) {
    const head = commandHead(i.command);
    return head ? { tool, subject: head, label: head, what: 'command' } : { tool, subject: tool, label: tool, what: 'tool' };
  }
  const file = i.file_path || i.notebook_path || i.path;
  if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(tool) && isStr(file)) {
    const rel = inProject(file, root);
    const area = rel ? areaOf(rel) : posix(file);
    return { tool, subject: area.toLowerCase(), label: area, what: rel && area.endsWith('/') ? 'folder' : 'file' };
  }
  if (tool === 'WebFetch' && isStr(i.url)) {
    try { const host = new URL(i.url).hostname.replace(/^www\./, ''); return { tool, subject: host, label: host, what: 'site' }; } catch { /* fall through */ }
  }
  return { tool, subject: tool, label: tool, what: 'tool' };
}

// ------------------------------------------------------------ the store

function cleanEvent(e, now) {
  if (!e || typeof e !== 'object' || !KINDS.includes(e.kind) || !isStr(e.root)) return null;
  const at = Number.isFinite(e.at) ? e.at : now;
  if (now - at > KEEP_DAYS * DAY) return null;
  let text = oneLine(e.text, MAX_TEXT);
  if (SECRET.test(text)) text = '';
  const files = Array.isArray(e.files) ? [...new Set(e.files.filter(isStr).map(f => posix(f).slice(0, 300)))].slice(0, MAX_FILES) : [];
  const out = { kind: e.kind, root: String(e.root).slice(0, 400), at };
  if (isStr(e.project)) out.project = oneLine(e.project, 80);
  if (text) out.text = text;
  if (files.length) out.files = files;
  if (isStr(e.batch)) out.batch = e.batch.slice(0, 80);
  if (Array.isArray(e.refs)) out.refs = e.refs.filter(isStr).slice(0, 20).map(r => r.slice(0, 80));
  if (e.kind === 'deny') {
    if (!isStr(e.subject)) return null;
    out.tool = oneLine(e.tool, 80);
    out.subject = oneLine(e.subject, 200);
    out.label = oneLine(e.label || e.subject, 200);
    out.what = ['command', 'folder', 'file', 'site', 'tool'].includes(e.what) ? e.what : 'tool';
  }
  if (e.kind === 'comment' && !out.text) return null;
  if (UNDOING.has(e.kind) && !out.files) return null;
  return out;
}

const OFFER_STATES = ['open', 'added', 'dismissed'];

function cleanOffer(o, now) {
  if (!o || typeof o !== 'object' || !isStr(o.id) || !isStr(o.root) || !isStr(o.type) || !OFFER_STATES.includes(o.state)) return null;
  const at = Number.isFinite(o.at) ? o.at : now;
  if (o.state === 'open' && now - at > OPEN_KEEP_DAYS * DAY) return null;
  return {
    id: o.id.slice(0, 80), root: String(o.root).slice(0, 400), project: oneLine(o.project, 80),
    type: o.type, key: oneLine(o.key, 300), tokens: Array.isArray(o.tokens) ? o.tokens.filter(isStr).slice(0, 30) : [],
    count: Number.isInteger(o.count) ? o.count : REPEATS, quote: oneLine(o.quote, 200), label: oneLine(o.label, 200),
    what: oneLine(o.what, 20), rule: oneLine(o.rule, MAX_RULE), evidence: Array.isArray(o.evidence) ? o.evidence.filter(isStr).slice(0, 6).map(t => oneLine(t, 300)) : [],
    state: o.state, at, ...(Number.isFinite(o.doneAt) ? { doneAt: o.doneAt } : {}),
  };
}

/** Whatever settings held -> { events, offers }, old and broken entries dropped. */
function normalize(raw, now = Date.now()) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const events = (Array.isArray(r.events) ? r.events : []).map(e => cleanEvent(e, now)).filter(Boolean);
  const offers = (Array.isArray(r.offers) ? r.offers : []).map(o => cleanOffer(o, now)).filter(Boolean);
  return { events: prune(events), offers: pruneOffers(offers) };
}

// Newest kept: no more than MAX_EVENTS_PER_ROOT for one project, MAX_EVENTS in all.
function prune(events) {
  const sorted = [...events].sort((a, b) => a.at - b.at);
  const perRoot = new Map();
  const kept = [];
  for (let i = sorted.length - 1; i >= 0 && kept.length < MAX_EVENTS; i--) {
    const k = rootKey(sorted[i].root);
    const n = perRoot.get(k) || 0;
    if (n >= MAX_EVENTS_PER_ROOT) continue;
    perRoot.set(k, n + 1);
    kept.push(sorted[i]);
  }
  return kept.reverse();
}

// Over the cap, open cards go first, then the oldest answers.
function pruneOffers(offers) {
  if (offers.length <= MAX_OFFERS) return offers;
  const rank = o => (o.state === 'open' ? 0 : 1);
  const drop = new Set([...offers].sort((a, b) => rank(a) - rank(b) || a.at - b.at).slice(0, offers.length - MAX_OFFERS));
  return offers.filter(o => !drop.has(o));
}

// ------------------------------------------------------------ spotting a pattern

const sameRoot = (a, b) => rootKey(a) === rootKey(b);
const firstLine = t => String(t || '').split(/(?<=[.!?])\s/)[0];

// Comments: the newest one, against the others in this project from other reviews.
function commentPattern(latest, earlier) {
  const mine = words(latest.text);
  if (!mine.size) return null;
  const matches = earlier.filter(e => e.kind === 'comment' && (!latest.batch || e.batch !== latest.batch) && alike(mine, words(e.text)));
  const occasions = new Set(matches.map(e => e.batch || `${e.at}`));
  if (occasions.size + 1 < REPEATS) return null;
  const best = matches.reduce((b, e) => (shared(mine, words(e.text)).size > shared(mine, words(b.text)).size ? e : b), matches[0]);
  const tokens = [...shared(mine, words(best.text))].sort();
  const texts = [latest.text, ...matches.map(e => e.text)];
  const quote = oneLine([...texts].map(firstLine).sort((a, b) => a.length - b.length)[0], 160);
  return {
    type: 'comment', key: `comment:${(tokens.length ? tokens : [...mine].sort()).join(' ')}`,
    tokens: tokens.length ? tokens : [...mine].sort(), count: occasions.size + 1, quote, label: '', what: '',
    evidence: [...new Set(texts)].slice(0, 6),
  };
}

// The same command (or folder, site, tool) said no to in two different turns.
function denyPattern(latest, earlier) {
  const occasion = e => e.batch || `${e.at}`;
  const matches = earlier.filter(e => e.kind === 'deny' && e.tool === latest.tool && e.subject === latest.subject);
  const occasions = new Set([latest, ...matches].map(occasion));
  if (occasions.size < REPEATS) return null;
  return {
    type: 'deny', key: `deny:${latest.tool}:${latest.subject}`, tokens: [], count: occasions.size,
    quote: '', label: latest.label, what: latest.what, tool: latest.tool, evidence: [],
  };
}

const areasOf = e => new Set((e.files || []).map(areaOf).filter(Boolean));
// Undo, then a rewind past the same turn, is one correction, not two.
const overlaps = (a, b) => !!a.refs?.length && !!b.refs?.length && a.refs.some(r => b.refs.includes(r));

function areaPattern(latest, earlier) {
  const others = earlier.filter(e => UNDOING.has(e.kind) && !overlaps(e, latest));
  let best = null;
  for (const area of areasOf(latest)) {
    const hits = others.filter(e => areasOf(e).has(area));
    if (hits.length + 1 < REPEATS) continue;
    // More undos wins; then the narrower place (a deeper folder says more).
    if (!best || hits.length > best.hits.length || (hits.length === best.hits.length && area.length > best.area.length)) best = { area, hits };
  }
  if (!best) return null;
  const prompts = [latest, ...best.hits].map(e => e.text).filter(isStr);
  return {
    type: 'area', key: `area:${best.area.toLowerCase()}`, tokens: [], count: best.hits.length + 1,
    quote: '', label: best.area, what: best.area.endsWith('/') ? 'folder' : 'file', evidence: [...new Set(prompts)].slice(0, 6),
  };
}

/** The pattern the newest event completes, or null. Only ever about that event. */
function detect(events, latest, now = Date.now()) {
  if (!latest) return null;
  const earlier = events.filter(e => e !== latest && sameRoot(e.root, latest.root) && now - e.at <= KEEP_DAYS * DAY && e.at <= latest.at);
  if (latest.kind === 'comment') return commentPattern(latest, earlier);
  if (latest.kind === 'deny') return denyPattern(latest, earlier);
  return areaPattern(latest, earlier);
}

/**
 * Has this pattern been offered already? Turned down or added: never again.
 * Offered and not answered: not again for a week.
 */
function blocked(offers, root, p, now = Date.now()) {
  return offers.some(o => {
    if (!sameRoot(o.root, root) || o.type !== p.type) return false;
    const same = p.type === 'comment' ? alike(new Set(o.tokens), new Set(p.tokens)) || o.key === p.key : o.key === p.key;
    if (!same) return false;
    return o.state !== 'open' || now - o.at < OPEN_QUIET_DAYS * DAY;
  });
}

// ------------------------------------------------------------ wording

const code = s => `\`${String(s).replace(/`/g, "'")}\``;
const times = n => (n === 2 ? 'twice' : n === 3 ? 'three times' : `${n} times`);
const sentence = t => {
  const s = oneLine(t, MAX_RULE - 1).replace(/^[-*#>\s]+/, '');
  if (!s) return '';
  const up = s[0].toUpperCase() + s.slice(1);
  return /[.!?]$/.test(up) ? up : `${up}.`;
};

/** The rule in your own words (or the plain one for a deny or an undo): never needs Claude. */
function fallbackRule(p) {
  if (p.type === 'comment') return sentence(p.quote);
  if (p.type === 'deny') {
    if (p.what === 'command') return `Don't run ${code(p.label)} yourself: leave it to me, or ask first.`;
    if (p.what === 'folder') return `Don't edit files in ${code(p.label)} without asking me first.`;
    if (p.what === 'file') return `Don't edit ${code(p.label)} without asking me first.`;
    if (p.what === 'site') return `Don't fetch pages from ${code(p.label)}.`;
    return `Don't use ${code(p.label)} unless I ask for it.`;
  }
  return p.what === 'file'
    ? `Check with me before changing ${code(p.label)}.`
    : `Check with me before changing files in ${code(p.label)}.`;
}

/** What the card says, before the rule itself. */
function headline(p, project) {
  const where = project ? ` in ${project}` : '';
  if (p.type === 'comment') return `You've asked for this ${times(p.count)}${where}: "${p.quote}"`;
  if (p.type === 'deny') return `You've said no to ${code(p.label)} ${times(p.count)}${where}.`;
  return p.what === 'file'
    ? `You've undone changes to ${code(p.label)} ${times(p.count)}${where}.`
    : `You've undone changes in ${code(p.label)} ${times(p.count)}${where}.`;
}

/** A rule as it may go into CLAUDE.md: one line, no markdown heading or list marker, or ''. */
function cleanRule(text) {
  const s = oneLine(text, MAX_RULE + 1).replace(/^[-*#>\s]+/, '').trim();
  return s.length > MAX_RULE ? '' : s;
}

// ------------------------------------------------------------ the whole step

/**
 * Note one correction. -> { store, offer }: offer is a new card to show, or null.
 * opts: { now, id } (id for the offer; tests pass their own).
 */
function record(store, event, { now = Date.now(), id } = {}) {
  const s = normalize(store, now);
  const e = cleanEvent({ ...event, at: now }, now);
  if (!e) return { store: s, offer: null };
  const events = prune([...s.events, e]);
  const p = detect(events, e, now);
  if (!p || blocked(s.offers, e.root, p, now)) return { store: { ...s, events }, offer: null };
  const offer = {
    id: id || `${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    root: e.root, project: e.project || '', ...p, rule: fallbackRule(p), state: 'open', at: now,
  };
  const clean = cleanOffer(offer, now);
  return { store: { events, offers: pruneOffers([...s.offers, clean]) }, offer: { ...clean, headline: headline(clean, clean.project) } };
}

/** An offer answered: 'added' or 'dismissed'. Unknown ids leave the store as it was. */
function resolve(store, id, state, now = Date.now()) {
  const s = normalize(store, now);
  if (!['added', 'dismissed'].includes(state) || !s.offers.some(o => o.id === id)) return s;
  return { ...s, offers: s.offers.map(o => (o.id === id ? { ...o, state, doneAt: now } : o)) };
}

const offerOf = (store, id) => (isStr(id) ? normalize(store).offers.find(o => o.id === id) || null : null);

/** Projects with a rule added from a card, newest first: [{ root, project }]. */
function learnedRoots(store) {
  const seen = new Map();
  for (const o of [...normalize(store).offers].sort((a, b) => (b.doneAt || b.at) - (a.doneAt || a.at))) {
    if (o.state === 'added' && !seen.has(rootKey(o.root))) seen.set(rootKey(o.root), { root: o.root, project: o.project });
  }
  return [...seen.values()];
}

module.exports = {
  KINDS, KEEP_DAYS, MAX_EVENTS, MAX_EVENTS_PER_ROOT, MAX_OFFERS, OPEN_QUIET_DAYS, MAX_RULE,
  words, alike, commandHead, denySubject, areaOf, inProject,
  normalize, detect, blocked, record, resolve, offerOf, learnedRoots,
  fallbackRule, headline, cleanRule,
};
