// GitLab, through the glab CLI: your merge requests and their pipelines in the
// inbox and on the CI sign, "Fix this build" and "Address the review" on them,
// and CI on the Releases card for a project that lives on GitLab. glab keeps
// the sign-in (`glab auth login`); Shellby only ever runs `glab api`.
// Kept out of main.js, which only wires it up.
const { shell } = require('electron');
const { GlabApi, runGlab, checkHost } = require('../gitlab/glab');
const { isGitLabHost } = require('../gitlab/remote');
const { GitLabWatcher } = require('../gitlab/watcher');

const MAX_HOSTS = 8;

/** config.gitlab -> { ci, hosts }: whether to watch, and self-managed hosts you added. */
function settingsOf(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const hosts = (Array.isArray(r.hosts) ? r.hosts : []).map(checkHost).filter(h => h && h !== 'gitlab.com');
  return { ci: r.ci === true, hosts: [...new Set(hosts)].slice(0, MAX_HOSTS) };
}

/** d: what main shares (main.js `shared`). */
function wireGitlab(d) {
  const apis = new Map();
  let glab = null; // { installed, version } once asked

  const gitlabSettings = () => settingsOf(d.config.get('gitlab'));
  const gitlabOn = () => gitlabSettings().ci;

  /** A GlabApi for one host, kept. */
  function gitlabApi(host) {
    const h = checkHost(host);
    if (!h) throw new Error('That isn\'t a GitLab host name.');
    if (!apis.has(h)) apis.set(h, new GlabApi({ host: h }));
    return apis.get(h);
  }

  // The clones on this PC whose origin is on a GitLab: { root, host, path }.
  async function gitlabClones() {
    if (!d.projects) return [];
    const listed = gitlabSettings().hosts;
    return (await d.projects.localRepos().catch(() => []))
      .filter(r => r.forge && isGitLabHost(r.forge.host, listed))
      .map(r => ({ root: r.root, host: r.forge.host, path: r.forge.path }));
  }

  /** Which hosts to ask: gitlab.com, the ones you added, and any your clones point at. */
  async function gitlabHosts() {
    const fromClones = (await gitlabClones()).map(c => c.host);
    return [...new Set(['gitlab.com', ...gitlabSettings().hosts, ...fromClones])].slice(0, MAX_HOSTS + 4);
  }

  /** The clone on this PC of a GitLab project, for a copy to start from. */
  async function gitlabCloneOf(host, path) {
    const want = `${host}/${path}`.toLowerCase();
    return (await gitlabClones()).find(c => `${c.host}/${c.path}`.toLowerCase() === want)?.root || null;
  }

  /** Is glab here at all? Asked once (and again when you press Check now). */
  async function glabInfo({ fresh = false } = {}) {
    if (glab && !fresh) return glab;
    const r = await runGlab(['--version'], { timeout: 10000 });
    glab = { installed: r.ok, version: r.ok ? (/(\d+\.\d+\.\d+)/.exec(r.out)?.[1] || null) : null };
    return glab;
  }

  function createGitLabWatcher() {
    d.ciGitlab = new GitLabWatcher({
      api: gitlabApi,
      hosts: gitlabHosts,
      seen: { load: () => d.config.get('gitlabSeen'), save: v => d.config.set({ gitlabSeen: v }) },
    });
    return d.ciGitlab;
  }

  // Follows the GitLab toggle.
  function followGitLab() {
    if (!d.ciGitlab) return;
    if (gitlabOn()) { if (!d.ciGitlab.running) d.ciGitlab.start(); } else if (d.ciGitlab.running) d.ciGitlab.stop();
  }

  async function gitlabView() {
    const s = gitlabSettings();
    const w = d.ciGitlab ? d.ciGitlab.view() : null;
    return {
      on: s.ci, hosts: s.hosts,
      glab: await glabInfo(),
      watched: w?.hosts || [],
      error: s.ci ? w?.error || null : null,
      lastPollAt: s.ci ? w?.lastPollAt || null : null,
      prs: s.ci ? w?.prs || [] : [],
      reviews: s.ci ? w?.reviews || [] : [],
    };
  }

  /** patch: { ci?, hosts? } from Settings → GitLab. */
  async function setGitLab(patch = {}) {
    const now = gitlabSettings();
    const next = {
      ci: typeof patch.ci === 'boolean' ? patch.ci : now.ci,
      hosts: Array.isArray(patch.hosts) ? settingsOf({ hosts: patch.hosts }).hosts : now.hosts,
    };
    const bad = Array.isArray(patch.hosts) ? patch.hosts.filter(h => String(h || '').trim() && !checkHost(h)) : [];
    d.config.set({ gitlab: next });
    followGitLab();
    if (next.ci) {
      await glabInfo({ fresh: true });
      await d.ciGitlab?.poll().catch(() => null);
    }
    return { ok: !bad.length, error: bad.length ? `${String(bad[0]).slice(0, 60)} isn't a host name like gitlab.example.org.` : null, view: await gitlabView() };
  }

  /** Check now: is glab there, and what do the hosts say? */
  async function checkGitLab() {
    await glabInfo({ fresh: true });
    if (gitlabOn()) await d.ciGitlab?.poll().catch(() => null);
    return gitlabView();
  }

  // Only https pages on a GitLab host Shellby watches, for merge requests the watcher reported.
  function openGitLabUrl(url) {
    let u;
    try { u = new URL(String(url)); } catch { return false; }
    if (u.protocol !== 'https:' || u.username || u.password) return false;
    const host = checkHost(u.host);
    const known = new Set(['gitlab.com', ...gitlabSettings().hosts, ...(d.ciGitlab?.view().hosts || []).map(h => h.host)]);
    if (!host || !known.has(host)) return false;
    shell.openExternal(u.href);
    return true;
  }

  return { createGitLabWatcher, followGitLab, gitlabApi, gitlabCloneOf, gitlabClones, gitlabHosts, gitlabOn, gitlabSettings, gitlabView, setGitLab, checkGitLab, openGitLabUrl };
}

module.exports = { wireGitlab, settingsOf };
