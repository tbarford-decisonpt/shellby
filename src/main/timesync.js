// Sending the timesheet to a time tracker (Toggl Track, Clockify or Harvest),
// so the hours Shellby kept become billable time there. Off until you paste a
// token on the Time page; then each Shellby project is matched to one of the
// tracker's projects (by name, else by client, else by hand), and a day's
// entries go over with one click. Sending a day again updates what it sent
// before rather than adding to it.
//
// Settings live in config.timeSync: { provider, account, links, sent }. The
// token never does: main keeps it encrypted by Windows (secret.get/set), and it
// never reaches the panel. No Electron here: `fetch` is passed in (main gives
// it net.fetch), which keeps this testable. See test/timesync.test.js.

const tt = require('./timetrack');

const TIMEOUT_MS = 15 * 1000;
const MAX_BYTES = 4 * 1024 * 1024;
const PROJECTS_TTL_MS = 10 * 60 * 1000;
const DAY_STARTS_AT = 9;          // entries on a day are laid end to end from 9:00
const MAX_LINKS = 200;
const MAX_A_DAY = 40;
const DESCRIPTION_MAX = 500;
const HARVEST_UA = 'Shellby (https://github.com/x-salmon/shellby)';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const okKey = k => typeof k === 'string' && k.length <= 400 && /^(?:[A-Za-z]:[\\/]|\/)/.test(k);
const okId = v => typeof v === 'string' && /^[A-Za-z0-9:_-]{1,100}$/.test(v);
const own = (map, k) => (map && Object.prototype.hasOwnProperty.call(map, k) ? map[k] : undefined);
const str = v => (typeof v === 'string' ? v : v == null ? '' : String(v));
// Clockify won't take milliseconds in a time.
const iso = t => new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
const fold = s => str(s).trim().toLowerCase();

class TrackerError extends Error {
  constructor(kind, message) { super(message); this.kind = kind; }
}

// ------------------------------------------------------------------ the trackers
//
// Each one: how to sign a request, who the token belongs to, its projects as
// [{ id, name, client, task?, project }] (project: the tracker's own project id,
// so a Harvest project's tasks count as one when matching), and saving one
// entry (a new one, or `id` again). `call(method, url, body)` does the request.

const TOGGL = 'https://api.track.toggl.com/api/v9';
const CLOCKIFY = 'https://api.clockify.me/api/v1';
const HARVEST = 'https://api.harvestapp.com/v2';

const PROVIDERS = Object.freeze({
  toggl: {
    name: 'Toggl Track',
    where: 'In Toggl Track: Profile settings, then API Token at the bottom.',
    headers: token => ({ authorization: `Basic ${Buffer.from(`${token}:api_token`).toString('base64')}` }),
    async account(call) {
      const me = await call('GET', `${TOGGL}/me`);
      if (!me?.default_workspace_id) throw new TrackerError('odd', 'Toggl Track sent something odd.');
      return { id: str(me.default_workspace_id), name: str(me.fullname || me.email) };
    },
    async projects(call, account) {
      const [projects, clients] = await Promise.all([
        call('GET', `${TOGGL}/workspaces/${account.id}/projects?active=true&per_page=200`),
        call('GET', `${TOGGL}/workspaces/${account.id}/clients`),
      ]);
      const clientName = new Map((Array.isArray(clients) ? clients : []).map(c => [c.id, str(c.name)]));
      return (Array.isArray(projects) ? projects : []).map(p => ({ id: str(p.id), project: str(p.id), name: str(p.name), client: clientName.get(p.client_id ?? p.cid) || '' }));
    },
    async save(call, account, e, id) {
      const body = {
        created_with: 'Shellby', workspace_id: Number(account.id), project_id: Number(e.target),
        description: e.description, billable: e.billable, start: iso(e.start), stop: iso(e.start + e.seconds * 1000), duration: e.seconds,
      };
      const r = id
        ? await call('PUT', `${TOGGL}/workspaces/${account.id}/time_entries/${id}`, body)
        : await call('POST', `${TOGGL}/workspaces/${account.id}/time_entries`, body);
      return str(r?.id);
    },
  },

  clockify: {
    name: 'Clockify',
    where: 'In Clockify: Preferences, then Advanced, then Manage API keys.',
    headers: token => ({ 'x-api-key': token }),
    async account(call) {
      const me = await call('GET', `${CLOCKIFY}/user`);
      const ws = me?.activeWorkspace || me?.defaultWorkspace;
      if (!ws) throw new TrackerError('odd', 'Clockify sent something odd.');
      return { id: str(ws), name: str(me.name || me.email) };
    },
    async projects(call, account) {
      const list = await call('GET', `${CLOCKIFY}/workspaces/${account.id}/projects?archived=false&page-size=500`);
      return (Array.isArray(list) ? list : []).map(p => ({ id: str(p.id), project: str(p.id), name: str(p.name), client: str(p.clientName) }));
    },
    async save(call, account, e, id) {
      const body = { start: iso(e.start), end: iso(e.start + e.seconds * 1000), billable: e.billable, description: e.description, projectId: e.target };
      const r = id
        ? await call('PUT', `${CLOCKIFY}/workspaces/${account.id}/time-entries/${id}`, body)
        : await call('POST', `${CLOCKIFY}/workspaces/${account.id}/time-entries`, body);
      return str(r?.id);
    },
  },

  // Harvest wants a task as well as a project, so each of your project's tasks
  // is an option of its own ("Website · Development").
  harvest: {
    name: 'Harvest',
    where: 'In Harvest: id.getharvest.com/developers, then Create new personal access token.',
    headers: (token, account) => ({ authorization: `Bearer ${token}`, 'user-agent': HARVEST_UA, ...(account ? { 'harvest-account-id': account.id } : {}) }),
    async account(call) {
      const r = await call('GET', 'https://id.getharvest.com/api/v2/accounts');
      const a = (Array.isArray(r?.accounts) ? r.accounts : []).find(x => x.product === 'harvest');
      if (!a) throw new TrackerError('auth', 'That token has no Harvest account.');
      const u = r.user || {};
      return { id: str(a.id), name: [str(a.name), [u.first_name, u.last_name].filter(Boolean).join(' ')].filter(Boolean).join(', ') };
    },
    async projects(call) {
      const out = [];
      for (let page = 1; page && page <= 10;) {
        const r = await call('GET', `${HARVEST}/users/me/project_assignments?is_active=true&per_page=100&page=${page}`);
        for (const pa of Array.isArray(r?.project_assignments) ? r.project_assignments : []) {
          if (pa.is_active === false || !pa.project) continue;
          for (const ta of Array.isArray(pa.task_assignments) ? pa.task_assignments : []) {
            if (ta.is_active === false || !ta.task) continue;
            out.push({ id: `${pa.project.id}:${ta.task.id}`, project: str(pa.project.id), name: str(pa.project.name), client: str(pa.client?.name), task: str(ta.task.name) });
          }
        }
        page = r?.next_page || null;
      }
      return out;
    },
    async save(call, account, e, id) {
      const [project, task] = e.target.split(':');
      const body = { project_id: Number(project), task_id: Number(task), spent_date: e.day, hours: tt.hours(e.seconds), notes: e.description };
      const r = id ? await call('PATCH', `${HARVEST}/time_entries/${id}`, body) : await call('POST', `${HARVEST}/time_entries`, body);
      return str(r?.id);
    },
  },
});

/** One request to a tracker -> its JSON. Throws a TrackerError whose message can go on the page. */
async function request(fetchImpl, provider, method, url, headers, body) {
  const name = PROVIDERS[provider].name;
  let res;
  try {
    res = await fetchImpl(url, {
      method, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch (e) {
    throw new TrackerError('net', e?.name === 'TimeoutError' || e?.name === 'AbortError' ? `${name} didn't answer.` : `Couldn't reach ${name}.`);
  }
  if (res.status === 401 || res.status === 403) throw new TrackerError('auth', `${name} didn't take that token.`);
  if (res.status === 404) throw new TrackerError('gone', `${name} couldn't find that.`);
  if (res.status === 429) throw new TrackerError('busy', `${name} asked to slow down. Try again in a minute.`);
  if (!res.ok) throw new TrackerError('http', `${name} said ${res.status}.`);
  const text = await res.text();
  if (Buffer.byteLength(text) > MAX_BYTES) throw new TrackerError('odd', `${name} sent too much.`);
  try { return text ? JSON.parse(text) : null; } catch { throw new TrackerError('odd', `${name} sent something odd.`); }
}

// ------------------------------------------------------------------ pure parts

/** Tolerate anything read from disk. */
function normalize(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const provider = own(PROVIDERS, src.provider) ? src.provider : null;
  const account = provider && src.account && okId(str(src.account.id)) ? { id: str(src.account.id), name: str(src.account.name).slice(0, 120) } : null;
  const links = Object.fromEntries(Object.entries(src.links && typeof src.links === 'object' ? src.links : {})
    .filter(([k, v]) => okKey(k) && okId(v)).slice(0, MAX_LINKS));
  const sent = {};
  const days = Object.keys(src.sent && typeof src.sent === 'object' ? src.sent : {}).filter(d => DAY_RE.test(d)).sort().slice(-tt.KEEP_DAYS);
  for (const day of days) {
    const m = src.sent[day] && typeof src.sent[day] === 'object' ? src.sent[day] : {};
    const entries = Object.entries(m).filter(([k, v]) => okKey(k) && v && okId(str(v.id))).slice(0, MAX_A_DAY)
      .map(([k, v]) => [k, { id: str(v.id), seconds: Math.max(0, Math.round(Number(v.seconds) || 0)) }]);
    if (entries.length) sent[day] = Object.fromEntries(entries);
  }
  return provider && account ? { provider, account, links, sent } : { provider: null, account: null, links: {}, sent: {} };
}

/**
 * The tracker project a Shellby project goes to when you haven't picked one:
 * the one with the same name, else the only one for its client. null when it
 * isn't clear. A Harvest project's tasks count as one project (its first task).
 */
function guessLink(p, options) {
  const one = list => (list.length && list.every(o => o.project === list[0].project) ? list[0].id : null);
  const byName = (options || []).filter(o => fold(o.name) && fold(o.name) === fold(p?.name));
  if (byName.length) return one(byName);
  return p?.client ? one((options || []).filter(o => fold(o.client) === fold(p.client))) : null;
}

/** Your pick, else a guess: { id, guessed } or null. */
function linkFor(state, key, p, options) {
  const picked = own(state.links, key);
  if (picked && (!options || options.some(o => o.id === picked))) return { id: picked, guessed: false };
  const g = options ? guessLink(p, options) : null;
  return g ? { id: g, guessed: true } : null;
}

/**
 * What goes over for one day: an entry per project with billed time, laid end
 * to end from 9:00. summary: timetrack.summarize for just that day.
 * -> { entries: [{ key, name, day, target, start, seconds, description, billable }], unmatched: [name] }
 */
function planDay(summary, day, state, options) {
  const entries = [];
  const unmatched = [];
  const [y, m, d] = day.split('-').map(Number);
  let at = new Date(y, m - 1, d, DAY_STARTS_AT).getTime();
  for (const p of summary.projects) {
    const row = p.days.find(r => r.day === day);
    if (!row?.billed) continue;
    const link = linkFor(state, p.key, p, options);
    if (!link) { unmatched.push(p.name); continue; }
    const description = (tt.lineText(row) || `Work on ${p.name}`).slice(0, DESCRIPTION_MAX);
    entries.push({ key: p.key, name: p.name, day, target: link.id, start: at, seconds: row.billed, description, billable: !!p.billable });
    at += row.billed * 1000;
  }
  return { entries, unmatched };
}

// ------------------------------------------------------------------ the service

/**
 * deps: {
 *   config, fetch, now?()
 *   secret: { get() -> token | '', set(token | null) -> bool (false: Windows can't keep it safe) }
 *   tracker: the TimeTracker (its state and summary())
 * }
 */
class TimeSync {
  constructor(deps) {
    this.deps = deps;
    this.now = deps.now || Date.now;
    this.cache = null;        // { at, options }: the tracker's projects
    this.sending = null;
  }

  get state() { return normalize(this.deps.config.get('timeSync')); }
  save(state) { this.deps.config.set({ timeSync: state }); }

  caller(provider, token, account = null) {
    const p = PROVIDERS[provider];
    return (method, url, body) => request(this.deps.fetch, provider, method, url, p.headers(token, account), body);
  }

  /** What the Time page shows. Never the token. */
  view() {
    const s = this.state;
    return {
      provider: s.provider, account: s.account?.name || '',
      providers: Object.entries(PROVIDERS).map(([id, p]) => ({ id, name: p.name, where: p.where })),
      sentDays: Object.keys(s.sent),
    };
  }

  async connect(provider, token) {
    if (!own(PROVIDERS, provider)) return { ok: false, error: 'Pick a tracker.' };
    const t = str(token).trim();
    if (!/^[\x21-\x7e]{8,300}$/.test(t)) return { ok: false, error: 'That doesn’t look like a token. Paste it as it is.' };
    let account;
    try { account = await PROVIDERS[provider].account(this.caller(provider, t)); } catch (e) { return { ok: false, error: e.message }; }
    if (!okId(account.id)) return { ok: false, error: `${PROVIDERS[provider].name} sent something odd.` };
    if (!this.deps.secret.set(t)) return { ok: false, error: "Windows can't keep the token safe on this PC, so it wasn't saved." };
    this.cache = null;
    this.save({ provider, account, links: {}, sent: {} });
    return { ok: true };
  }

  disconnect() {
    this.deps.secret.set(null);
    this.cache = null;
    this.save(null);
    return { ok: true };
  }

  /** The tracker's projects, and the pick (or guess) for each Shellby project on the books. */
  async projects({ fresh = false } = {}) {
    const s = this.state;
    const token = this.deps.secret.get();
    if (!s.provider || !token) return { ok: false, error: 'Not connected.' };
    if (fresh || !this.cache || this.now() - this.cache.at > PROJECTS_TTL_MS) {
      try {
        const options = await PROVIDERS[s.provider].projects(this.caller(s.provider, token, s.account), s.account);
        this.cache = { at: this.now(), options: options.filter(o => okId(o.id)) };
      } catch (e) { return { ok: false, error: e.message }; }
    }
    const options = this.cache.options;
    const links = {};
    for (const [key, p] of Object.entries(this.deps.tracker.state.projects)) {
      const l = linkFor(s, key, p, options);
      if (l) links[key] = l;
    }
    return { ok: true, options, links };
  }

  /** Your pick for a project; null goes back to guessing. */
  link(key, target) {
    if (!okKey(key) || (target !== null && !okId(target))) return { ok: false, error: 'Which project?' };
    const s = this.state;
    if (!s.provider) return { ok: false, error: 'Not connected.' };
    const links = { ...s.links };
    if (target) links[key] = target; else delete links[key];
    this.save({ ...s, links });
    return { ok: true };
  }

  /** Send one day's entries. Ones sent before are updated, not doubled. */
  sendDay(day) {
    if (this.sending) return this.sending;
    this.sending = this.doSend(day).finally(() => { this.sending = null; });
    return this.sending;
  }

  async doSend(day) {
    if (!DAY_RE.test(str(day))) return { ok: false, error: 'Pick a day.' };
    if (day > tt.dayKey(this.now())) return { ok: false, error: "That day hasn't happened yet." };
    const list = await this.projects();
    if (!list.ok) return list;
    const s = this.state;
    const p = PROVIDERS[s.provider];
    const call = this.caller(s.provider, this.deps.secret.get(), s.account);
    const { summary } = await this.deps.tracker.summary({ range: 'custom', from: day, to: day });
    const { entries, unmatched } = planDay(summary, day, s, list.options);
    if (!entries.length) return { ok: false, error: unmatched.length ? `None of that day's projects are matched to ${p.name} yet.` : 'No billed time that day to send.', unmatched };
    const sent = { ...(s.sent[day] || {}) };
    let done = 0;
    let seconds = 0;
    let error = null;
    for (const e of entries) {
      const before = own(sent, e.key)?.id;
      try {
        let id;
        try { id = await p.save(call, s.account, e, before); } catch (err) {
          // Deleted over there since: send it as a new one.
          if (!before || err.kind !== 'gone') throw err;
          id = await p.save(call, s.account, e, null);
        }
        if (okId(id)) sent[e.key] = { id, seconds: e.seconds };
        done += 1;
        seconds += e.seconds;
      } catch (err) {
        error = err.message || `Couldn't send to ${p.name}.`;
        if (err.kind === 'auth' || err.kind === 'net' || err.kind === 'busy') break;
      }
    }
    // Whatever went, even when something after it failed, so sending again updates it.
    const now = this.state;
    if (now.provider === s.provider) this.save({ ...now, sent: { ...now.sent, [day]: sent } });
    return { ok: done > 0 && !error, sent: done, of: entries.length, hours: tt.hours(seconds), unmatched, error, tracker: p.name };
  }
}

module.exports = { PROVIDERS, TrackerError, TimeSync, normalize, guessLink, linkFor, planDay, request };
