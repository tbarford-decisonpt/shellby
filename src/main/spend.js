// Usage by project. The 5-hour and weekly meters (limits.js) only say how full
// each window is; this keeps a small ledger of what each tab, routine and
// project spent, so the meters can say who filled them.
//
// Spend comes from the per-call token counts on assistant events (stream.js
// spendFrom), weighted by roughly what the model costs, because a limit fills
// faster on Opus than on Haiku. Only shares are ever shown, so the units don't
// matter. Pure: callers pass `now` (test/spend.test.js).

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const BUCKET_MS = 10 * MIN;          // spend is summed per source per 10 minutes
const KEEP_MS = 8 * 24 * HOUR;       // a little over the weekly window
const MAX_ENTRIES = 3000;
const WINDOW_MS = { fiveHour: 5 * HOUR, sevenDay: 7 * 24 * HOUR };
const TOP = 6;                       // rows before the rest become "Everything else"

// Relative price per input token; output costs 5×, cache writes 1.25×, cache reads 0.1×.
const RATES = [[/haiku/i, 1], [/sonnet/i, 3], [/opus|fable/i, 5]];
const DEFAULT_RATE = 3;

const KINDS = new Set(['tab', 'routine', 'workflow']);
const num = v => (Number.isFinite(v) && v > 0 ? v : 0);
const clip = (s, n) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, n) : '');

/** What one API call cost, in model-weighted tokens (0 when there's nothing to count). */
function weightOf(usage, model) {
  if (!usage || typeof usage !== 'object') return 0;
  const rate = (RATES.find(([re]) => re.test(model || '')) || [null, DEFAULT_RATE])[1];
  const tokens = num(usage.input_tokens) + 5 * num(usage.output_tokens)
    + 1.25 * num(usage.cache_creation_input_tokens) + 0.1 * num(usage.cache_read_input_tokens);
  return Math.round(rate * tokens);
}

function normalizeEntry(e) {
  if (!e || typeof e !== 'object' || !Number.isFinite(e.t) || !num(e.w) || typeof e.k !== 'string' || !e.k || e.k.length > 80) return null;
  return {
    t: e.t, k: e.k, w: e.w,
    kind: KINDS.has(e.kind) ? e.kind : 'tab',
    label: clip(e.label, 80) || 'Untitled',
    project: clip(e.project, 80) || null,
    pk: clip(e.pk, 400) || null,   // the project's full path, so two "app" folders stay apart
  };
}

/** Tolerate anything read from disk: an array of entries, oldest first. */
function normalize(raw) {
  return (Array.isArray(raw) ? raw : []).map(normalizeEntry).filter(Boolean).sort((a, b) => a.t - b.t).slice(-MAX_ENTRIES);
}

/**
 * Add one call's spend. `source` is { key, kind, label, project }. Returns a new
 * ledger: calls from the same source in the same 10 minutes share one entry,
 * and anything older than the weekly window is dropped.
 */
function record(ledger, source, weight, now) {
  const kept = ledger.filter(e => now - e.t < KEEP_MS);
  if (!num(weight) || !source?.key) return kept;
  const t = now - (now % BUCKET_MS);
  const at = kept.findIndex(e => e.t === t && e.k === source.key);
  const entry = normalizeEntry({ ...source, k: source.key, t, w: (at >= 0 ? kept[at].w : 0) + weight });
  if (!entry) return kept;
  const next = at >= 0 ? kept.map((e, i) => (i === at ? entry : e)) : [...kept, entry];
  return next.slice(-MAX_ENTRIES);
}

/** When a usage window began: its reset minus its length, or a plain look-back without one. */
function windowStart(window, resetsAt, now) {
  const len = WINDOW_MS[window];
  if (!len) return now;
  if (!Number.isFinite(resetsAt)) return now - len;
  // A reset already past means a new window began then (at the latest).
  return resetsAt > now ? resetsAt - len : Math.max(now - len, resetsAt);
}

/**
 * Who spent what since `since`, as rows { key, label, kind, share } (share is
 * 0..1 of everything Shellby ran), biggest first. `by` is 'task' (each tab and
 * routine) or 'project' (the folder it worked in). Rows past TOP fold into one.
 */
function breakdown(ledger, since, by = 'task') {
  const rows = new Map();
  let total = 0;
  for (const e of ledger) {
    // A bucket that straddles the window start is counted: 10 minutes of slack.
    if (e.t + BUCKET_MS <= since) continue;
    const key = by === 'project' ? `p:${e.pk || e.project || ''}` : e.k;
    const row = rows.get(key) || { key, weight: 0 };
    // Later entries win, so a tab that got its title after its first call shows the title.
    row.label = by === 'project' ? e.project || 'No folder' : e.label;
    row.kind = by === 'project' ? 'project' : e.kind;
    row.detail = by === 'project' ? e.pk : null;
    row.weight += e.w;
    rows.set(key, row);
    total += e.w;
  }
  if (!total) return [];
  const sorted = [...rows.values()].sort((a, b) => b.weight - a.weight);
  const shown = sorted.length > TOP + 1 ? sorted.slice(0, TOP) : sorted;
  const rest = sorted.slice(shown.length).reduce((n, r) => n + r.weight, 0);
  const row = r => ({ key: r.key, label: r.label, kind: r.kind, detail: r.detail, share: r.weight / total });
  const out = shown.map(row);
  // The folded rows ride along, so the panel can unfold them.
  if (rest) out.push({ key: 'rest', label: `${sorted.length - shown.length} more`, kind: 'rest', detail: null, share: rest / total, rows: sorted.slice(shown.length).map(row) });
  return out;
}

/**
 * What was spent since `since`, by everything Shellby ran or by one source
 * (`key`), with the same 10 minutes of slack as breakdown().
 */
function weightSince(ledger, since, key = null) {
  let total = 0;
  for (const e of Array.isArray(ledger) ? ledger : []) {
    if (e.t + BUCKET_MS <= since || (key && e.k !== key)) continue;
    total += e.w;
  }
  return total;
}

module.exports = { weightOf, normalize, record, windowStart, breakdown, weightSince, BUCKET_MS, KEEP_MS, WINDOW_MS };
