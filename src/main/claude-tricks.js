// What Claude Code learned since the last version Shellby saw. Shellby is how
// people find out what Claude can do: when the CLI's version moves on, he reads
// Anthropic's public changelog (one plain-text GET, no Claude call, no tokens),
// keeps the releases between the old version and the new one, and picks a few
// highlights, each new feature with a prompt to try it. The prompt only goes
// into a new tab's box; nothing is sent until you press Enter.
//
// Pure apart from fetchChangelog, whose fetch is passed in
// (test/claude-tricks.test.js). wiring/claude-tricks.js decides when.
const CHANGELOG_URL = 'https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md';
const CHANGELOG_PAGE = 'https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md';

const FETCH_TIMEOUT_MS = 20000;
const MAX_BYTES = 6 * 1024 * 1024; // about 1 MB today; anything far bigger isn't it
const MAX_HIGHLIGHTS = 4;
const MAX_TEXT = 300;
const MAX_VERSIONS = 60; // a very old install catching up: the newest 60 releases are plenty

const VERSION_RE = /^\d{1,9}\.\d{1,9}\.\d{1,9}$/;
const version = v => (typeof v === 'string' && VERSION_RE.test(v) ? v : null);
const clip = (s, n) => String(s ?? '').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

/** -1, 0 or 1, for two plain x.y.z versions. */
function compare(a, b) {
  const [x, y] = [a, b].map(v => v.split('.').map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

/** The changelog's markdown -> [{ version, items: [line] }], in the file's order (newest first). */
function parseChangelog(text) {
  const out = [];
  let cur = null;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const head = raw.match(/^##\s+v?(\d+\.\d+\.\d+)\s*$/);
    if (head) {
      cur = version(head[1]) ? { version: head[1], items: [] } : null;
      if (cur) out.push(cur);
      continue;
    }
    const item = raw.match(/^[-*]\s+(.+)$/);
    if (cur && item) cur.items.push(item[1]);
  }
  return out;
}

/** The releases after `from`, up to and including `to`. */
function between(sections, from, to) {
  if (!version(from) || !version(to)) return [];
  return sections.filter(s => compare(s.version, from) > 0 && compare(s.version, to) <= 0).slice(0, MAX_VERSIONS);
}

// Lines about other products ("[Claude Tag] …", "[VSCode] …") or other systems
// than this one (Shellby only runs on Windows) aren't Claude Code news for you.
const ELSEWHERE = /^(\[[^\]]+\]|(macOS|Mac|Linux|Self-hosted runner|SDK|Agent SDK|VSCode|VS Code|JetBrains)\s*:)/i;
const KINDS = [['added', /^(Added|New|Introduced)\b/i], ['improved', /^Improved\b/i], ['changed', /^Changed\b/i], ['fixed', /^Fixed\b/i]];

/** One changelog line -> { text, kind } (kind: added, improved, changed, fixed, other), or null to leave out. */
function classify(line) {
  const text = clip(String(line || '').replace(/^Windows\s*:\s*/i, ''), MAX_TEXT);
  if (!text || ELSEWHERE.test(text) || /^Reverted\b/i.test(text)) return null;
  const kind = (KINDS.find(([, re]) => re.test(text)) || ['other'])[0];
  return { text, kind };
}

/** What to put in a new tab's box for "Try it": a question about the feature, never an action. */
function tryPrompt(text) {
  const plain = clip(text, MAX_TEXT).replace(/`/g, '');
  return `Claude Code just added this: "${plain}"\n\nIn a few sentences, what does it do, and how could I use it in this project? Show me rather than change anything.`;
}

/**
 * The releases between two versions -> what the card says, or null when
 * nothing in them is worth a card (only fixes for other products, say).
 * { from, to, releases, added, total, highlights: [{ text, kind, tryIt? }] }
 */
function digest(sections, from, to, { max = MAX_HIGHLIGHTS } = {}) {
  const releases = between(sections, from, to);
  const lines = releases.flatMap(s => s.items.map(classify).filter(Boolean));
  if (!lines.length) return null;
  const rank = { added: 0, improved: 1, changed: 2, other: 3, fixed: 4 };
  const picked = lines.map((l, i) => ({ ...l, i }))
    .filter(l => l.kind !== 'fixed')
    .sort((a, b) => rank[a.kind] - rank[b.kind] || a.i - b.i)
    .slice(0, max)
    .map(({ text, kind }) => (kind === 'added' ? { text, kind, tryIt: tryPrompt(text) } : { text, kind }));
  if (!picked.length) return null;
  return {
    from, to,
    releases: releases.length,
    added: lines.filter(l => l.kind === 'added').length,
    total: lines.length,
    highlights: picked,
  };
}

/** Tolerate anything read from disk. */
function normalizeState(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const p = s.pending && typeof s.pending === 'object' ? s.pending : null;
  const highlights = Array.isArray(p?.highlights)
    ? p.highlights.filter(h => h && typeof h.text === 'string').slice(0, MAX_HIGHLIGHTS).map(h => ({
      text: clip(h.text, MAX_TEXT),
      kind: typeof h.kind === 'string' ? h.kind : 'other',
      ...(typeof h.tryIt === 'string' ? { tryIt: h.tryIt.slice(0, 2000) } : {}),
    }))
    : [];
  const count = n => (Number.isInteger(n) && n >= 0 ? n : 0);
  return {
    lastSeen: version(s.lastSeen),
    pending: p && version(p.from) && version(p.to) && highlights.length
      ? { from: p.from, to: p.to, releases: count(p.releases), added: count(p.added), total: count(p.total), highlights }
      : null,
  };
}

/** The changelog's text. Throws on anything but a clean answer. */
async function fetchChangelog({ fetchImpl = globalThis.fetch, url = CHANGELOG_URL, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('No fetch available');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    let res;
    try {
      res = await fetchImpl(url, { signal: ctrl.signal, redirect: 'error', cache: 'no-store', headers: { accept: 'text/plain' } });
    } catch {
      throw new Error(ctrl.signal.aborted ? 'The changelog took too long to load.' : "Couldn't reach Claude Code's changelog.");
    }
    if (!res.ok) throw new Error(`The changelog answered with HTTP ${res.status}.`);
    const declared = Number(res.headers?.get?.('content-length'));
    if (Number.isFinite(declared) && declared > MAX_BYTES) throw new Error('The changelog was too big.');
    const text = await res.text();
    if (text.length > MAX_BYTES) throw new Error('The changelog was too big.');
    return text;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  CHANGELOG_URL, CHANGELOG_PAGE, MAX_HIGHLIGHTS,
  between, classify, compare, digest, version, fetchChangelog, normalizeState, parseChangelog, tryPrompt,
};
