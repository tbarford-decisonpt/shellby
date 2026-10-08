// Errors from Sentry on Next up (backlog/sentry.js, docs/plans/next-up.md).
// Nothing shows for a project that doesn't use Sentry. One that does gets a
// quiet "Show its new errors here?" on its card; one token, pasted once,
// connects every project, each matched to its Sentry project by its config
// or its name (or picked from a list when that's unclear).
//
// The token is encrypted by Windows (safeStorage) like the channel's, never
// reaches the panel, and only goes to the Sentry address you gave. Kept out of
// main.js, which only wires it up.
const fs = require('fs');
const os = require('os');
const path = require('path');
const sentry = require('../backlog/sentry');
const mcpServers = require('../mcpservers');

const ERRORS_TTL_MS = 5 * 60 * 1000;
const PROJECTS_TTL_MS = 10 * 60 * 1000;
const DETECT_TTL_MS = 5 * 60 * 1000;
const SNOOZE_MS = 30 * 24 * 60 * 60 * 1000; // "Not now" asks again after a month
const MAX_FILE_BYTES = 256 * 1024;

const lower = s => String(s || '').toLowerCase();

/** d: what main shares (main.js `shared`). Tests hand in a stand-in for safeStorage (box) and for fetch (fetchImpl). */
function wireSentry(d, { box: testBox = null, fetchImpl = null } = {}) {
  const detected = new Map(); // root (lower case) -> { at, data }
  const errorCache = new Map(); // `${org}/${id}` -> { at, data }
  let projectsCache = null;     // { at, list }

  const box = () => testBox || require('electron').safeStorage;
  const settings = () => ({ url: sentry.DEFAULT_URL, token: null, links: {}, snoozed: {}, ...(d.config.get('sentry') || {}) });
  const save = patch => d.config.set({ sentry: { ...settings(), ...patch } });

  function token() {
    const raw = settings().token;
    if (!raw || !box().isEncryptionAvailable()) return null;
    try { return box().decryptString(Buffer.from(raw, 'base64')); } catch { return null; }
  }

  const apiWith = (t, base) => new sentry.SentryApi({ token: t, base, ...(fetchImpl ? { fetchImpl } : {}) });
  const api = () => { const t = token(); return t ? apiWith(t, settings().url) : null; };

  /** A file at the project's root, if it's a plain, smallish file. */
  function readRootFile(root, name) {
    const file = path.join(root, name);
    try {
      const st = fs.lstatSync(file);
      if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
      return fs.readFileSync(file, 'utf8');
    } catch { return null; }
  }

  function detectIn(root) {
    const id = lower(root);
    const hit = detected.get(id);
    if (hit && Date.now() - hit.at < DETECT_TTL_MS) return hit.data;
    const data = sentry.detect(name => readRootFile(root, name));
    detected.set(id, { at: Date.now(), data });
    return data;
  }

  async function projects(fresh) {
    if (!fresh && projectsCache && Date.now() - projectsCache.at < PROJECTS_TTL_MS) return projectsCache.list;
    const list = await sentry.listProjects(api());
    projectsCache = { at: Date.now(), list };
    return list;
  }

  const picks = list => list.map(p => ({ org: p.org, slug: p.slug, name: p.name }));

  /**
   * Next up's errors for a cloned project. p: wiring/backlog.js's resolved project.
   * -> { state: 'none' | 'offer' | 'pick' | 'ok' | 'error', errors?, projects?, project?, error?, stale? }
   */
  async function forProject(p, { fresh = false } = {}) {
    if (!p?.root) return { state: 'none' };
    const s = settings();
    const link = s.links[p.key];
    if (link === null) return { state: 'none' }; // "Not this project"
    if (!token()) {
      const snoozed = Date.now() - (s.snoozed[p.key] || 0) < SNOOZE_MS;
      return detectIn(p.root).uses && !snoozed ? { state: 'offer' } : { state: 'none' };
    }
    let target = link;
    if (!target) {
      const hints = detectIn(p.root);
      let list;
      try { list = await projects(fresh); } catch (e) { return hints.uses ? { state: 'error', error: sentry.errorText(e) } : { state: 'none' }; }
      const names = [p.repo ? p.repo.split('/')[1] : null, path.basename(p.root)];
      const match = sentry.matchProject(list, { ...hints, names });
      if (!match) return hints.uses && list.length ? { state: 'pick', projects: picks(list) } : { state: 'none' };
      target = { org: match.org, slug: match.slug, id: match.id };
      save({ links: { ...s.links, [p.key]: target } });
    }
    return { ...(await errorsOf(target, fresh)), project: `${target.org}/${target.slug}` };
  }

  async function errorsOf(link, fresh) {
    const id = `${link.org}/${link.id}`;
    const hit = errorCache.get(id);
    if (!fresh && hit && Date.now() - hit.at < ERRORS_TTL_MS) return hit.data;
    const r = await sentry.fetchErrors(api(), link);
    if (r.ok) {
      const data = { state: 'ok', errors: r.errors, environment: r.environment };
      errorCache.set(id, { at: Date.now(), data });
      return data;
    }
    // Offline or limited: the last list, marked as old.
    if (hit && r.status !== 401 && r.status !== 404) return { ...hit.data, stale: true, error: r.error };
    return { state: 'error', error: r.error };
  }

  /** "Connect": check the token can list projects, then keep it, encrypted. -> { ok, projects } | { ok: false, error } */
  async function connect({ token: t, url }) {
    const base = sentry.checkUrl(url);
    if (!base) return { ok: false, error: 'That doesn\'t look like a Sentry address. It starts with https://.' };
    if (!sentry.isToken(t)) return { ok: false, error: 'That doesn\'t look like a Sentry token.' };
    if (!box().isEncryptionAvailable()) return { ok: false, error: 'Windows can\'t encrypt the token on this PC, so Shellby won\'t keep it.' };
    let list;
    try { list = await sentry.listProjects(apiWith(t, base)); } catch (e) { return { ok: false, error: sentry.errorText(e) }; }
    if (!list.length) return { ok: false, error: 'That token can\'t see any Sentry projects. It needs project:read and org:read (and event:read for the errors).' };
    save({ url: base, token: box().encryptString(t).toString('base64') });
    projectsCache = { at: Date.now(), list };
    errorCache.clear();
    return { ok: true, projects: list.length };
  }

  /** Which Sentry project a project is. slug null: none of them, so stop showing Sentry there. */
  async function link(p, { org = null, slug = null } = {}) {
    const s = settings();
    if (slug === null) {
      save({ links: { ...s.links, [p.key]: null } });
      return { ok: true };
    }
    if (!token()) return { ok: false, error: 'Connect Sentry first.' };
    const list = await projects(false).catch(() => []);
    const found = list.find(x => x.org === org && x.slug === slug);
    if (!found) return { ok: false, stale: true, error: 'Sentry doesn\'t list that project any more. Look again.' };
    save({ links: { ...s.links, [p.key]: { org: found.org, slug: found.slug, id: found.id } } });
    return { ok: true };
  }

  /** Pick again: forget which Sentry project this is. */
  function unlink(p) {
    const links = { ...settings().links };
    delete links[p.key];
    save({ links });
    return { ok: true };
  }

  function snooze(p) {
    save({ snoozed: { ...settings().snoozed, [p.key]: Date.now() } });
    return { ok: true };
  }

  /** Forget the token and every project's link. */
  function disconnect() {
    d.config.set({ sentry: null });
    projectsCache = null;
    errorCache.clear();
    return { ok: true };
  }

  /** For Fix this error: the latest event's stack and tags, and whether Claude has Sentry's MCP server there. */
  async function details(p, error) {
    const target = settings().links[p.key];
    const a = api();
    const event = target && a ? await sentry.latestEvent(a, { org: target.org, id: error.id }) : null;
    let mcp = false;
    try {
      mcp = mcpServers.listServers({ home: os.homedir(), cwd: p.root, live: d.toolbox?.current?.mcp || [] }).some(srv => /sentry/i.test(srv.name));
    } catch { /* unknown is no */ }
    return { stack: event ? sentry.stackLines(event) : [], tags: event ? sentry.eventTags(event) : [], mcp };
  }

  return {
    sentryFor: forProject, sentryConnect: connect, sentryLink: link, sentryUnlink: unlink,
    sentrySnooze: snooze, sentryDisconnect: disconnect, sentryDetails: details,
    sentryUrl: () => settings().url,
  };
}

module.exports = { wireSentry };
