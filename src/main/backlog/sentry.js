// A project's new production errors from Sentry, for its Next up list
// (docs/plans/next-up.md, "Errors from Sentry"). Read when the project's page
// opens, never polled.
//
//   detect        does the project report to Sentry (an SDK in its manifests),
//                 and which Sentry org and project its config names, if any
//   SentryApi     a tiny client: one token, one Sentry address, GET only
//   fetchErrors   unresolved issues first seen in the last 14 days, in
//                 production when the project has a production environment
//   stackLines    the latest event's exception and stack, as text for a prompt
//
// Error titles and stack traces come from your app's users and their requests,
// so everything is cleaned like an issue's title (issues.js clip) and goes to
// Claude only fenced, with secrets blanked (backlog/prompts.js).
//
// Pure, apart from SentryApi's fetch (injectable). test/backlog-sentry.test.js.
const { clip } = require('../github/issues');

const DAYS = 14;
const MAX_ERRORS = 25;
const MAX_PROJECTS = 100;
const MAX_FRAMES = 20;
const MAX_LINES = 80;
const CONTEXT_FRAMES = 2;   // in-app frames that get their lines of code
const LIBRARY_FRAMES = 3;   // frames outside your code shown above the first of yours
const SLUG_RE = /^[a-z0-9][a-z0-9_.-]{0,99}$/i;
const ID_RE = /^\d{1,20}$/;
const TOKEN_RE = /^[\x21-\x7e]{16,500}$/;
const DEFAULT_URL = 'https://sentry.io';

// ---------------------------------------------------------------- detection

// Manifests and what in them means a Sentry SDK.
/** @type {[string, RegExp][]} */
const SDKS = [
  ['package.json', /"@sentry\/[a-z0-9-]+"\s*:/],
  ['requirements.txt', /^\s*sentry-sdk\b/im],
  ['pyproject.toml', /["'\s]sentry-sdk\b/i],
  ['Pipfile', /^\s*sentry-sdk\s*=/im],
  ['Gemfile', /gem\s+["']sentry-(?:ruby|rails)["']/],
  ['go.mod', /github\.com\/getsentry\/sentry-go\b/],
  ['Cargo.toml', /^\s*sentry\s*=/m],
  ['composer.json', /"sentry\/[a-z0-9-]+"\s*:/],
  ['mix.exs', /\{:sentry,/],
];
// Where a project names its Sentry org and project (the wizard writes these).
const HINT_FILES = [
  '.sentryclirc', 'sentry.properties',
  'next.config.js', 'next.config.mjs', 'next.config.ts',
  'vite.config.js', 'vite.config.mjs', 'vite.config.ts',
  'astro.config.mjs', 'nuxt.config.ts', 'svelte.config.js',
];

const slug = s => (SLUG_RE.test(String(s || '')) ? String(s) : null);

/** The org and project a config file names. -> { org, project } (either may be null) */
function hintsIn(name, text) {
  const t = String(text || '');
  if (name === '.sentryclirc') {
    return { org: slug(/^\s*org\s*=\s*([^\s#;]+)/m.exec(t)?.[1]), project: slug(/^\s*project\s*=\s*([^\s#;]+)/m.exec(t)?.[1]) };
  }
  if (name === 'sentry.properties') {
    return { org: slug(/^\s*defaults\.org\s*=\s*(\S+)/m.exec(t)?.[1]), project: slug(/^\s*defaults\.project\s*=\s*(\S+)/m.exec(t)?.[1]) };
  }
  // withSentryConfig(..., { org: "acme", project: "web" }), sentryVitePlugin({ org, project }).
  if (!/sentry/i.test(t)) return { org: null, project: null };
  return { org: slug(/\borg\s*:\s*["'`]([^"'`]+)["'`]/.exec(t)?.[1]), project: slug(/\bproject\s*:\s*["'`]([^"'`]+)["'`]/.exec(t)?.[1]) };
}

/**
 * Does the project report to Sentry? read(name): a file at its root as text, or null.
 * -> { uses, org, project }
 */
function detect(read) {
  /** @type {string | null} */
  let org = null;
  /** @type {string | null} */
  let project = null;
  for (const name of HINT_FILES) {
    const text = read(name);
    if (text == null) continue;
    const h = hintsIn(name, text);
    org = org || h.org;
    project = project || h.project;
  }
  const uses = !!(org || project) || SDKS.some(([name, re]) => {
    const text = read(name);
    return text != null && re.test(text);
  });
  return { uses, org, project };
}

// ---------------------------------------------------------------- the API

/** A Sentry address someone typed -> its base URL (no trailing slash), or null. https only, but for a local one. */
function checkUrl(raw) {
  let u;
  try { u = new URL(String(raw || '').trim() || DEFAULT_URL); } catch { return null; }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return null;
  if (u.username || u.password || u.search || u.hash) return null;
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}

const isToken = t => typeof t === 'string' && TOKEN_RE.test(t);

class SentryApi {
  /** base: from checkUrl. The token is only ever sent there. */
  constructor({ token, base = DEFAULT_URL, fetchImpl = fetch }) {
    this.token = token; this.base = base; this.fetchImpl = fetchImpl;
  }

  async get(p) {
    const res = await this.fetchImpl(`${this.base}/api/0${p}`, {
      headers: { accept: 'application/json', authorization: `Bearer ${this.token}`, 'user-agent': 'Shellby' },
      // A redirect would carry the token somewhere else: refused, not followed.
      redirect: 'manual',
      signal: AbortSignal.timeout(15000),
    });
    if (res.status >= 300 && res.status < 400) throw Object.assign(new Error('Sentry sent Shellby somewhere else. Check its address.'), { status: 502 });
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!res.ok) throw Object.assign(new Error(clip(data?.detail, 160) || `Sentry answered ${res.status}`), { status: res.status });
    return data;
  }
}

/** What went wrong, in words for the card. */
function errorText(e) {
  if (e?.status === 401) return 'Sentry turned down the token (expired, or revoked). Connect it again.';
  if (e?.status === 403) return "The Sentry token can't read this project's errors. It needs event:read, project:read and org:read.";
  if (e?.status === 404) return "Sentry can't find that project any more.";
  if (e?.status === 429) return 'Sentry is limiting how often Shellby can ask. Try again in a few minutes.';
  return `Couldn't read its errors from Sentry: ${clip(e?.message, 120) || 'Sentry didn\'t answer.'}`;
}

/** Every project the token can see. -> [{ id, org, slug, name, platform }] */
async function listProjects(api) {
  const raw = await api.get('/projects/');
  return (Array.isArray(raw) ? raw : []).map(p => ({
    id: ID_RE.test(String(p?.id)) ? String(p.id) : null,
    org: slug(p?.organization?.slug),
    slug: slug(p?.slug),
    name: clip(p?.name, 80) || '',
    platform: clip(p?.platform, 40) || '',
  })).filter(p => p.id && p.org && p.slug).slice(0, MAX_PROJECTS);
}

/**
 * The Sentry project that's this one: the one its config names, else the only
 * one whose slug is the repository's or folder's name. -> a project, or null.
 *   hints: detect's { org, project }. names: the repository's and folder's names.
 */
function matchProject(projects, { org = null, project = null, names = [] } = {}) {
  const same = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();
  const only = list => (list.length === 1 ? list[0] : null);
  if (project) {
    const named = projects.filter(p => same(p.slug, project) && (!org || same(p.org, org)));
    if (named.length) return only(named);
  }
  const want = names.filter(Boolean).map(n => String(n).toLowerCase());
  return only(projects.filter(p => want.includes(p.slug.toLowerCase()) && (!org || same(p.org, org))));
}

/** The environment to look at: production, when the project has one. -> name or null */
async function productionOf(api, { org, slug: s }) {
  const raw = await api.get(`/projects/${org}/${s}/environments/`).catch(() => null);
  const names = (Array.isArray(raw) ? raw : []).map(e => String(e?.name || ''));
  return names.find(n => n.toLowerCase() === 'production') || names.find(n => n.toLowerCase() === 'prod') || null;
}

const time = s => { const t = Date.parse(s); return Number.isFinite(t) ? t : null; };
const count = v => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0; };

/** An issue as Sentry lists it -> the item rank.js reads, or null. base: links only into this Sentry. */
function errorOf(raw, { base = DEFAULT_URL } = {}) {
  if (!raw || !ID_RE.test(String(raw.id))) return null;
  const host = (() => { try { return new URL(base).hostname; } catch { return ''; } })();
  const link = (() => {
    try {
      const u = new URL(String(raw.permalink || ''));
      // sentry.io links go to <org>.sentry.io.
      return u.protocol === 'https:' && (u.hostname === host || u.hostname.endsWith(`.${host}`)) ? u.href : null;
    } catch { return null; }
  })();
  return {
    id: String(raw.id),
    shortId: clip(raw.shortId, 60) || `#${raw.id}`,
    title: clip(raw.title, 200) || 'An error with no message',
    culprit: clip(raw.culprit, 200),
    url: link,
    level: clip(raw.level, 20) || 'error',
    substatus: clip(raw.substatus, 30) || null,
    count: count(raw.count),
    users: count(raw.userCount),
    firstSeen: time(raw.firstSeen),
    lastSeen: time(raw.lastSeen),
    unhandled: raw.isUnhandled === true,
  };
}

/**
 * The project's new errors. link: { org, slug, id }.
 * -> { ok: true, errors, environment } | { ok: false, error, status }
 */
async function fetchErrors(api, link) {
  if (!slug(link?.org) || !slug(link?.slug) || !ID_RE.test(String(link?.id))) return { ok: false, error: 'That isn\'t a Sentry project.', status: 400 };
  try {
    const environment = await productionOf(api, link);
    const q = new URLSearchParams({
      project: link.id, query: `is:unresolved firstSeen:-${DAYS}d`, sort: 'date', statsPeriod: `${DAYS}d`, limit: String(MAX_ERRORS),
      ...(environment ? { environment } : {}),
    });
    const raw = await api.get(`/organizations/${link.org}/issues/?${q}`);
    const errors = (Array.isArray(raw) ? raw : []).map(r => errorOf(r, { base: api.base })).filter(Boolean);
    return { ok: true, errors, environment };
  } catch (e) {
    return { ok: false, error: errorText(e), status: e?.status || 0 };
  }
}

/** The newest event of one error, as Sentry has it, or null. */
function latestEvent(api, { org, id }) {
  if (!slug(org) || !ID_RE.test(String(id))) return Promise.resolve(null);
  return api.get(`/organizations/${org}/issues/${id}/events/latest/`).catch(() => null);
}

// ---------------------------------------------------------------- the stack trace

const TAGS = ['environment', 'release', 'transaction', 'url', 'browser', 'os', 'runtime'];

/** The handful of tags worth telling Claude. -> [[key, value]] */
function eventTags(event) {
  const tags = Array.isArray(event?.tags) ? event.tags : [];
  return TAGS.map(k => [k, clip(tags.find(t => t?.key === k)?.value, 200)]).filter(([, v]) => v);
}

function frameLine(f) {
  const file = clip(f.filename || f.absPath || f.module, 200) || '?';
  const at = [file, Number.isInteger(f.lineNo) ? f.lineNo : null, Number.isInteger(f.colNo) ? f.colNo : null].filter(x => x !== null).join(':');
  const fn = clip(f.function, 120);
  return `  at ${fn ? `${fn} (${at})` : at}`;
}

function contextLines(f) {
  const ctx = Array.isArray(f.context) ? f.context : [];
  return ctx.filter(c => Array.isArray(c) && Number.isInteger(c[0])).slice(0, 7)
    .map(([n, code]) => `    ${n === f.lineNo ? '>' : ' '} ${String(n).padStart(4)} | ${String(code ?? '').replace(/[\r\n]+/g, ' ').slice(0, 200)}`);
}

/**
 * The latest event's exceptions and stacks, newest call first, the way a
 * stack trace reads. Your own frames (Sentry's inApp) are all shown, the top
 * ones with their code; frames from libraries fold away. -> lines (may be empty)
 */
function stackLines(event) {
  const entries = Array.isArray(event?.entries) ? event.entries : [];
  const values = entries.find(e => e?.type === 'exception')?.data?.values;
  const lines = [];
  // Sentry lists a chain cause first; the one that was thrown is last.
  for (const ex of (Array.isArray(values) ? values : []).slice(-3).reverse()) {
    const head = [clip(ex?.type, 120), clip(ex?.value, 300)].filter(Boolean).join(': ');
    if (lines.length) lines.push('', 'Caused by:');
    lines.push(head || 'An exception with no message');
    const frames = (Array.isArray(ex?.stacktrace?.frames) ? ex.stacktrace.frames : []).filter(f => f && typeof f === 'object').reverse();
    const anyMine = frames.some(f => f.inApp === true);
    let shown = 0;
    let withCode = 0;
    let folded = 0;
    frames.forEach((f, i) => {
      const keep = shown < MAX_FRAMES && (f.inApp === true || !anyMine || (i < LIBRARY_FRAMES && !frames.slice(0, i).some(x => x.inApp === true)));
      if (!keep) { folded++; return; }
      if (folded) { lines.push(`  … ${folded} frame${folded === 1 ? '' : 's'} from libraries`); folded = 0; }
      lines.push(frameLine(f));
      if (f.inApp === true && withCode < CONTEXT_FRAMES) { lines.push(...contextLines(f)); withCode++; }
      shown++;
    });
    if (folded) lines.push(`  … ${folded} more frame${folded === 1 ? '' : 's'}`);
  }
  if (!lines.length && event?.message) lines.push(clip(event.message, 300));
  return lines.slice(0, MAX_LINES);
}

module.exports = {
  detect, hintsIn, checkUrl, isToken, SentryApi, errorText, listProjects, matchProject,
  fetchErrors, latestEvent, errorOf, stackLines, eventTags, DEFAULT_URL, DAYS, ID_RE, SLUG_RE,
};
