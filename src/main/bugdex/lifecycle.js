// Bugs on the loose: an encounter opens when a failure shows a species, Claude
// engages it by writing code in that project, and it closes when it's caught,
// fled (the merge was aborted) or it slips away after a day. Seeing a bug
// pays nothing; only the catch does. See docs/plans/bugdex.md §1 and §4.
//
// Pure: lists in, new lists out, no clock. See test/bugdex.test.js.

const HOUR = 60 * 60 * 1000;
const ENCOUNTER_TTL = 24 * HOUR;    // the same as xp.js RED_FOR
const MAX_OPEN = 40;
const MAX_KEYS = 8;
const SOURCES = new Set(['bash', 'server', 'ci', 'home', 'push', 'audit', 'flaky']);
const HEX12 = /^[0-9a-f]{12}$/;
const TREE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const ID = /^[a-z0-9-]{1,40}$/;

const pos = v => (Number.isFinite(v) && v > 0 ? v : 0);
const str = (v, n) => (typeof v === 'string' && v.length <= n ? v.replace(/[\u0000-\u001f\u007f]/g, '') : null);

/** An encounter's id: one per bug per project. */
const encId = e => `${e.project}|${e.fp}`;

/** Tolerate anything read from disk. */
function normalizeOpen(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const seen = new Set();
  const out = [];
  for (const e of list) {
    if (!e || typeof e !== 'object' || !ID.test(e.species || '') || !HEX12.test(e.fp || '') || !str(e.project, 80) || !SOURCES.has(e.source)) continue;
    const id = encId(e);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      species: e.species, fp: e.fp, project: e.project, name: str(e.name, 80) || '', source: e.source,
      key: str(e.key, 200) || null,
      keys: (Array.isArray(e.keys) ? e.keys : []).filter(k => HEX12.test(k)).slice(0, MAX_KEYS),
      kind: str(e.kind, 12) || 'run',
      failTree: TREE.test(e.failTree || '') ? e.failTree : null,
      tabId: str(e.tabId, 80),
      lang: str(e.lang, 8),
      firstAt: pos(e.firstAt) || pos(e.at), at: pos(e.at),
      engaged: e.engaged === true, reruns: Math.floor(pos(e.reruns)),
      refused: str(e.refused, 20), passed: Number.isInteger(e.passed) && e.passed >= 0 ? e.passed : null,
    });
  }
  return out.slice(0, MAX_OPEN);
}

/**
 * A failure showed a bug: open its encounter, or refresh the one already
 * open (it failed again: if Claude had been at it, that's a rerun that
 * didn't work, which loses "first try").
 * -> { list, isNew, enc }
 */
function open(listIn, enc, now) {
  const list = normalizeOpen(listIn);
  const id = encId(enc);
  const was = list.find(e => encId(e) === id);
  const fresh = normalizeOpen([{ ...was, ...enc, firstAt: was?.firstAt || now, at: now, engaged: was?.engaged || false, reruns: (was?.reruns || 0) + (was?.engaged ? 1 : 0), refused: null, passed: enc.passed ?? was?.passed ?? null }])[0];
  if (!fresh) return { list, isNew: false, enc: null };
  // Newest first; the oldest drop off the end.
  return { list: [fresh, ...list.filter(e => encId(e) !== id)].slice(0, MAX_OPEN), isNew: !was, enc: fresh };
}

/** Claude wrote code in a project: everything open there is being worked on. */
function engage(listIn, project, now) {
  const list = normalizeOpen(listIn);
  if (!list.some(e => e.project === project && !e.engaged && e.at <= now)) return list;
  return list.map(e => (e.project === project && e.at <= now ? { ...e, engaged: true } : e));
}

/** Engage one encounter by source and key (a dev server's fix turn, a CI fix). */
function engageKey(listIn, source, key) {
  const list = normalizeOpen(listIn);
  return list.map(e => (e.source === source && e.key === key ? { ...e, engaged: true } : e));
}

/** Open encounters a passing command in this project could catch. */
function candidates(listIn, { project, key }) {
  return normalizeOpen(listIn).filter(e => e.source === 'bash' && e.project === project && key && e.keys.includes(key));
}

/** Open encounters for a source's own key (a server id, a pull request, a copy). */
const byKey = (listIn, source, key) => normalizeOpen(listIn).filter(e => e.source === source && e.key === key);

/** A would-be catch that wasn't a fix: stays open, and says why. */
function refuse(listIn, id, reason) {
  return normalizeOpen(listIn).map(e => (encId(e) === id ? { ...e, refused: reason } : e));
}

/** Caught, fled or gone. */
const close = (listIn, id) => normalizeOpen(listIn).filter(e => encId(e) !== id);

/** Close every encounter of one source and key (a merge aborted). -> { list, closed } */
function closeKey(listIn, source, key, project = null) {
  const list = normalizeOpen(listIn);
  const hit = e => e.source === source && (key == null || e.key === key) && (project == null || e.project === project);
  return { list: list.filter(e => !hit(e)), closed: list.filter(hit) };
}

// A red build or a branch that won't come home can take longer than a day to see to.
const TTL = { ci: 7 * ENCOUNTER_TTL, home: 7 * ENCOUNTER_TTL, push: 3 * ENCOUNTER_TTL };
const ttlOf = source => TTL[source] || ENCOUNTER_TTL;

/** Slip away after a day (a week for CI and copies), quietly. */
const prune = (listIn, now) => normalizeOpen(listIn).filter(e => now - e.at <= ttlOf(e.source));

module.exports = { ENCOUNTER_TTL, MAX_OPEN, encId, ttlOf, normalizeOpen, open, engage, engageKey, candidates, byKey, refuse, close, closeKey, prune };
