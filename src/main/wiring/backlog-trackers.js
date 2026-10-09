'use strict';

// A project's Linear or Jira issues (backlog/trackers.js), read through an MCP
// server you already have by one short Claude call in the background.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const trackers = require('../backlog/trackers');
const mcpServers = require('../mcpservers');

const TICKETS_TTL_MS = 30 * 60 * 1000; // each read is a Claude call: kept longer than GitHub's

/** d: what main shares; resolve, claudeReady: wireBacklog's. */
function makeTrackers({ d, resolve, claudeReady }) {
  const ticketCache = new Map(); // project key -> { at, sig, tickets, error }
  const ticketReads = new Map(); // project key -> the read in flight

  const trackersAll = () => ({ ...(d.config.get('backlogTrackers') || {}) });
  const trackerReady = () => claudeReady() && !!d.workflows;
  const folderFor = p => p.root || os.homedir();

  /** Your MCP servers for this project, each with what it looks like: [{ name, kind, direct }]. */
  function serversFor(p) {
    if (!trackerReady()) return [];
    const cwd = folderFor(p);
    return d.workflows.mcpServerList(cwd).map(sv => {
      const r = sv.direct ? mcpServers.resolveServer(sv.name, { home: os.homedir(), cwd }) : null;
      return { name: sv.name, kind: trackers.kindOf(sv.name, r?.ok ? r.def : null), direct: !!sv.direct };
    });
  }

  /** One read through Claude. -> { ok, tickets } | { ok: false, error } */
  async function readTickets(p, setup) {
    const cwd = folderFor(p);
    const servers = serversFor(p);
    const server = servers.find(sv => sv.name === setup.server);
    if (!server) return { ok: false, error: `There's no MCP server called “${setup.server}” any more. Pick another with ${trackers.KINDS[setup.kind].label}… under the list.` };
    // A server Shellby can start itself says which of its tools only read; the rest go by the kind's known names.
    const listed = server.direct ? await d.workflows.mcpTools(setup.server, cwd).catch(() => null) : null;
    const allowed = trackers.allowedFor(setup, listed?.ok ? listed.tools : null);
    if (!allowed.length) return { ok: false, error: `“${setup.server}” has no tools that only read, so Shellby won't use it for this.` };
    const denied = trackers.deniedFor(setup, servers.map(sv => sv.name));
    // Only this server starts for the read, when Shellby can load it alone. Its definition
    // can hold a token, so it goes in a file of the read's own rather than on the command line.
    const own = server.direct ? mcpServers.configFor([setup.server], { home: os.homedir(), cwd }) : null;
    let mcpConfigFile = own?.ok ? path.join(os.tmpdir(), `shellby-mcp-${crypto.randomUUID()}.json`) : null;
    try {
      if (mcpConfigFile) fs.writeFileSync(mcpConfigFile, JSON.stringify(own.config), { mode: 0o600, flag: 'wx' });
    } catch { mcpConfigFile = null; }  // then every server starts, as before
    const res = await d.runClaudeOnce(trackers.fetchArgs(setup, { allowed, denied, mcpConfigFile }), trackers.FETCH_TIMEOUT_MS, { cwd })
      .finally(() => { if (mcpConfigFile) fs.rm(mcpConfigFile, { force: true }, () => {}); });
    if (res.timedOut) return { ok: false, error: `${trackers.KINDS[setup.kind].label} took too long to answer. Look again in a bit.` };
    if (!String(res.stdout || '').trim()) {
      d.log?.warn('Next up: reading tickets failed', String(res.stderr || res.err?.message || '').slice(-400));
      return { ok: false, error: 'Claude Code didn\'t answer. Check it\'s signed in, in Settings.' };
    }
    return trackers.parseTickets(res.stdout, setup);
  }

  /** Start a read in the background, unless one's going; the panel hears when it's done. */
  function refreshTickets(p, setup, sig) {
    if (ticketReads.has(p.key)) return;
    const read = readTickets(p, setup).catch(e => ({ ok: false, error: e.message })).then(r => {
      ticketReads.delete(p.key);
      // Changed or turned off while it was reading: this answer is for something else.
      if (JSON.stringify(trackersAll()[p.key] || null) !== sig) return;
      const hit = ticketCache.get(p.key);
      const kept = hit?.sig === sig ? hit.tickets : null;
      ticketCache.set(p.key, r.ok ? { at: Date.now(), sig, tickets: r.tickets, error: null } : { at: Date.now(), sig, tickets: kept, error: r.error });
      d.send(d.panel, 'backlog:changed', { root: p.root, repo: p.repo });
    });
    ticketReads.set(p.key, read);
  }

  /**
   * This project's Linear or Jira issues, as last read (never waits for Claude).
   * kick: start a read if they're old. -> { state, setup?, tickets?, error?, at?, loading? }
   */
  function ticketsFor(p, { fresh = false, kick = false } = {}) {
    const setup = trackersAll()[p.key];
    if (!setup) return { state: 'none' };
    if (!trackerReady()) return { state: 'off', setup };
    const sig = JSON.stringify(setup);
    const hit = ticketCache.get(p.key)?.sig === sig ? ticketCache.get(p.key) : null;
    if (kick && (fresh || !hit || Date.now() - hit.at > TICKETS_TTL_MS)) refreshTickets(p, setup, sig);
    const loading = ticketReads.has(p.key);
    if (!hit) return { state: 'loading', setup, loading };
    if (!hit.tickets) return { state: 'error', setup, error: hit.error, loading };
    return { state: 'ok', setup, tickets: hit.tickets, at: hit.at, error: hit.error, stale: !!hit.error, loading };
  }

  /**
   * What the card says about it. null when the project has none and you have no
   * Linear or Jira server, so nobody without one ever sees any of this.
   * offer: what the link under the list says ('Linear', 'Jira' or 'Linear or Jira').
   */
  function trackerView(p, t) {
    if (t.state === 'none') {
      const kinds = trackerReady() ? [...new Set(serversFor(p).map(sv => sv.kind).filter(Boolean))].sort((a, b) => b.localeCompare(a)) : [];
      return kinds.length ? { state: 'none', offer: kinds.map(k => trackers.KINDS[k].label).join(' or ') } : null;
    }
    const { kind, server, scope } = t.setup;
    return {
      state: t.state, kind, label: trackers.KINDS[kind].label, server, scope,
      error: t.error || null, stale: !!t.stale, loading: !!t.loading, at: t.at || null,
      count: t.tickets?.length || 0,
    };
  }

  /** For the Linear or Jira form: the servers to pick from (likely ones first) and what's set now. */
  async function trackerChoices({ root, repo } = {}) {
    const p = await resolve({ root, repo });
    if (!p.ok) return p;
    if (!trackerReady()) return { ok: false, error: 'That needs Claude Code: Shellby reads them through it.' };
    const servers = serversFor(p).map(({ name, kind }) => ({ name, kind }))
      .sort((a, b) => (!!b.kind - !!a.kind) || a.name.localeCompare(b.name));
    const hints = Object.fromEntries(Object.entries(trackers.KINDS).map(([k, v]) => [k, v.scopeHint]));
    return { ok: true, servers, setup: trackersAll()[p.key] || null, hints };
  }

  /** Save the setup ({ server, kind, scope }), or { off: true } to stop. */
  async function trackerSet({ root, repo, off = false, ...raw } = {}) {
    const p = await resolve({ root, repo });
    if (!p.ok) return p;
    const all = trackersAll();
    ticketCache.delete(p.key);
    if (off) {
      delete all[p.key];
      d.config.set({ backlogTrackers: all });
      return { ok: true };
    }
    const c = trackers.checkSetup(raw);
    if (!c.ok) return c;
    if (!serversFor(p).some(sv => sv.name === c.setup.server)) return { ok: false, error: `There's no MCP server called “${c.setup.server}” here. Add it in Toolbox → MCP first.` };
    all[p.key] = c.setup;
    d.config.set({ backlogTrackers: all });
    return { ok: true };
  }

  return { serversFor, readTickets, refreshTickets, ticketsFor, trackerView, trackerChoices, trackerSet };
}

module.exports = { makeTrackers };
