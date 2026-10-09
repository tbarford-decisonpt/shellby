// Start a task from where the work already is (startfrom.js): "Fix this build"
// and "Address the review" on your pull requests, and "Do this" on a loose end
// in a project. Kept out of main.js, which only wires it up.
//
// Merge requests on GitLab work the same way, through glab (gitlab/mrwork.js).
//
// The pull request ones go the crashed-server way: the panel is shown the
// exact prompt first, and Send carries that prompt's hash, so what's sent is
// what you read or nothing. They work in a copy of the clone on this PC
// started from the pull request's latest commit, and push back to its branch.
// A loose end's prompt is Next up's (wiring/backlog.js): it waits in the box
// of a conversation in a copy, for you to send.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const startfrom = require('../startfrom');
const prwork = require('../github/prwork');
const mrwork = require('../gitlab/mrwork');
const worktrees = require('../worktrees');

const DRAFT_TTL_MS = 10 * 60 * 1000;  // what GitHub said, kept while the sheet is open
const SCAN_TTL_MS = 5 * 60 * 1000;
const SCAN_MS = 10000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

const hashOf = s => crypto.createHash('sha256').update(s).digest('hex');
const firstLine = s => String(s || '').trim().split('\n').filter(Boolean).pop() || '';

/** d: what main shares (main.js `shared`). */
function wireStartFrom(d) {
  const fetched = new Map();  // `${kind}:${key}` -> { at, data }
  const scans = new Map();    // root (lower case) -> { at, items, more }

  const claudeReady = () => !d.config.get('crabOnly') && !!d.claudeStatus?.installed && !!d.claudeStatus?.loggedIn;
  const web = () => d.githubEndpoints().web;

  // Only pull requests the CI watcher found: yours, open, on GitHub (or merge requests on GitLab).
  const knownPr = key => (typeof key === 'string' && d.ci ? d.ci.view().prs.find(p => p.key === key) : null) || null;
  const onGitLab = pr => pr?.forge === 'gitlab';
  const refOf = pr => pr.ref || `${pr.repo}#${pr.number}`;

  async function cloneOf(pr) {
    if (!d.projects) return null;
    if (onGitLab(pr)) return (await d.gitlabCloneOf?.(pr.host, pr.repo)) || null;
    const want = String(pr.repo).toLowerCase();
    return (await d.projects.localRepos()).find(r => r.remote && r.remote.toLowerCase() === want)?.root || null;
  }

  // What GitLab said, through glab, in the shapes GitHub's answers have.
  async function gitlabMaterial(kind, pr) {
    const gl = d.gitlabApi(pr.host);
    const mr = { host: pr.host, projectId: pr.projectId, number: pr.number, repo: pr.repo };
    const data = kind === 'build' ? await mrwork.failingBuild(gl, mr) : await mrwork.reviewThreads(gl, mr);
    if (data.error) return data;
    // Your commits are the ones under your emails: GitLab ties no commit to an account.
    const who = await mrwork.myEmails(gl);
    const changes = await mrwork.mrChanges(gl, mr, who);
    return { ...data, risk: startfrom.prRisks({ ...changes, login: who.me, headSha: data.pull.sha, forge: 'gitlab' }) };
  }

  // What GitHub said for this pull request, fetched once per sheet (a note
  // typed in it only rewrites the prompt).
  async function material(kind, pr, fresh) {
    const id = `${kind}:${pr.key}`;
    const hit = fetched.get(id);
    if (!fresh && hit && Date.now() - hit.at < DRAFT_TTL_MS) return hit.data;
    if (onGitLab(pr)) {
      const full = await gitlabMaterial(kind, pr);
      if (!full.error) fetched.set(id, { at: Date.now(), data: full });
      return full;
    }
    const gh = d.github.gh();
    const data = kind === 'build'
      ? await prwork.failingBuild(gh, { repo: pr.repo, number: pr.number, web: web() })
      : await prwork.reviewThreads(gh, { repo: pr.repo, number: pr.number });
    if (data.error) return data;
    // What Claude Code would load in the copy, and whose commits it holds (startfrom.prRisks).
    const changes = await prwork.prChanges(gh, { repo: pr.repo, number: pr.number });
    const risk = startfrom.prRisks({ ...changes, login: d.github.view().login, headSha: data.pull.sha });
    const full = { ...data, risk };
    fetched.set(id, { at: Date.now(), data: full });
    return full;
  }

  /**
   * What Send would send for a pull request. kind: 'build' | 'review'.
   * -> { ok, prompt, hash, title, where, url, ...facts } | { ok: false, error, needsClone? }
   */
  async function draft({ kind, key, note = '', fresh = false }) {
    const pr = knownPr(key);
    if (onGitLab(pr)) {
      if (!d.gitlabOn?.()) return { ok: false, error: 'Turn on GitLab in Settings → GitLab first.' };
    } else if (!d.github?.signedIn) return { ok: false, error: 'Sign in with GitHub first (Settings → GitHub).' };
    if (!pr) return { ok: false, error: 'Shellby isn\'t watching that pull request any more.' };
    const root = await cloneOf(pr);
    if (!root) {
      return onGitLab(pr)
        ? { ok: false, error: `${pr.repo} isn't cloned on this PC. Clone it from ${pr.host}, then add it on the Projects page, so Claude has somewhere to work.` }
        : { ok: false, needsClone: true, repo: pr.repo, error: `${pr.repo} isn't cloned on this PC. Clone it from the Projects page first, so Claude has somewhere to work.` };
    }
    const m = await material(kind, pr, fresh);
    if (m.error) return { ok: false, error: m.error };
    const forge = onGitLab(pr) ? 'gitlab' : 'github';
    const facts = { repo: pr.repo, number: pr.number, title: m.pull.title || pr.title, url: pr.url, forge };
    const copy = { headRef: m.pull.headRef, headRepo: m.pull.headRepo };
    // The checks to tick go in the hash too: a different list is a different draft.
    const ack = startfrom.needsAck(m.risk) ? m.risk : null;
    const sign = prompt => hashOf(`${prompt}\n${JSON.stringify(ack)}`);
    const base = { ok: true, kind, key, forge, where: root, url: pr.url, branch: m.pull.headRef, risk: ack };
    if (kind === 'build') {
      const log = m.log ? startfrom.trimLog(m.log, { format: forge }) : null;
      const shown = log?.lines.length ? log : null;
      const why = shown ? '' : m.why || 'it was empty';
      const prompt = startfrom.buildPrompt({ pr: facts, job: m.job, log: shown, why, note, copy });
      return { ...base, prompt, hash: sign(prompt), title: `Fix the build on ${refOf(pr)}`, job: m.job.name, step: m.job.step, jobUrl: m.job.url, logShown: !!shown, why };
    }
    const threads = startfrom.openThreads(m.threads);
    if (!threads.length) return { ok: false, error: `Every review comment on ${refOf(pr)} is resolved.` };
    const prompt = startfrom.reviewPrompt({ pr: facts, threads, resolvedKnown: m.resolvedKnown, note, copy });
    return { ...base, prompt, hash: sign(prompt), title: `Address the review on ${refOf(pr)}`, comments: threads.length, resolvedKnown: m.resolvedKnown };
  }

  // The pull request's head in the clone, to start the copy from: exactly the
  // commit the sheet's checks were made against, never whatever was pushed
  // since. Fetched as refs/pull/N/head, which GitHub keeps for forks' too
  // (GitLab's is refs/merge-requests/N/head, fetched with your own git sign-in).
  async function prStart(root, pr, sha) {
    const gitlab = onGitLab(pr);
    const name = gitlab ? 'GitLab' : 'GitHub';
    const what = gitlab ? 'merge request' : 'pull request';
    if (!/^[0-9a-f]{40}$/.test(String(sha))) return { ok: false, error: `${name} didn't say which commit that ${what} is on.` };
    const ref = `refs/remotes/origin/shellby-${gitlab ? 'mr' : 'pr'}/${pr.number}`;
    const from = gitlab ? `refs/merge-requests/${pr.number}/head` : `refs/pull/${pr.number}/head`;
    const got = await worktrees.git(root, ['fetch', '--quiet', '--no-tags', 'origin', `+${from}:${ref}`], { timeout: 120000, env: gitlab ? {} : d.github.claudeEnv() });
    // Offline, or the fetch was refused: the commit may be here already.
    if ((await worktrees.git(root, ['cat-file', '-e', `${sha}^{commit}`], { timeout: 5000 })).ok) return { ok: true, start: sha };
    return got.ok
      ? { ok: false, stale: true, error: `The ${what} has changed since Shellby looked. Check it again, then send.` }
      : { ok: false, error: `Couldn't get the ${what}'s branch from ${name}: ${firstLine(got.error) || 'git refused.'}` };
  }

  /**
   * Send: exactly the draft you were shown (by its hash), in a copy started
   * from the pull request. ack: you ticked "I've looked at these", needed
   * when the draft names risky files or other people's commits.
   * -> { ok, tabId } | { ok: false, error, stale?, needsAck? }
   */
  async function send({ kind, key, note = '', hash, ack = false }) {
    if (!claudeReady()) return { ok: false, needsClaude: true, error: 'That needs Claude Code: set it up first.' };
    const r = await draft({ kind, key, note });
    if (!r.ok) return r;
    if (r.hash !== hash) return { ok: false, stale: true, error: 'What would be sent has changed. Check it again, then send.' };
    if (r.risk && ack !== true) return { ok: false, needsAck: true, error: "Tick “I've looked at these” first: this pull request could change what Claude Code runs." };
    const pr = knownPr(key);
    if (!pr) return { ok: false, error: 'That pull request has just closed or merged.' };
    const m = fetched.get(`${kind}:${key}`)?.data;
    const at = await prStart(r.where, pr, m?.pull?.sha);
    if (!at.ok) return at;
    const res = await d.startTaskInCopy(r.where, r.title, () => r.prompt, { start: at.start });
    if (res.ok) fetched.delete(`${kind}:${key}`);
    if (res.ok && kind === 'build') d.bugdex?.ciEngaged(key); // Shellby's on that red build: it can be caught
    return res;
  }

  // ---- loose ends

  const rootOk = root => typeof root === 'string' && path.isAbsolute(root) && !!d.projects?.knowsRoot(root) && fs.existsSync(root);

  /** TODO, FIXME and HACK comments in a clone's tracked files. -> { ok, items, more } */
  async function looseEnds(root, { fresh = false } = {}) {
    if (!rootOk(root)) return { ok: false, error: 'That folder isn\'t on the Projects page.' };
    const id = root.toLowerCase();
    const hit = scans.get(id);
    if (!fresh && hit && Date.now() - hit.at < SCAN_TTL_MS) return { ok: true, items: hit.items, more: hit.more };
    // Tracked files only, so .gitignore'd and untracked ones never come up; -I skips binaries.
    const r = await worktrees.git(root, ['-c', 'core.quotepath=off', 'grep', '-n', '-z', '-I', '--no-color', '-E', '-e', `(${startfrom.TODO_TAGS.join('|')})`], { timeout: SCAN_MS });
    // git grep exits 1 when nothing matches; past its output cap, what came is still used.
    if (!r.ok && !r.out && r.error) return { ok: false, error: `Couldn't look through it: ${firstLine(r.error)}` };
    const { items, more } = startfrom.parseTodos(r.out);
    scans.set(id, { at: Date.now(), items, more });
    return { ok: true, items, more };
  }

  /**
   * "Do this": the prompt for one loose end the last scan found, with the lines
   * around it as the file is now. -> { ok, draft, cwd } | { ok: false, error }
   */
  function looseEndDraft({ root, file, line }) {
    if (!rootOk(root)) return { ok: false, error: 'That folder isn\'t on the Projects page.' };
    const item = scans.get(root.toLowerCase())?.items.find(t => t.file === file && t.line === line);
    if (!item) return { ok: false, error: 'That one isn\'t in the list any more. Look again.' };
    let lines;
    try {
      // Inside the project once links are followed, and not a link itself (git grep never follows one).
      const full = fs.realpathSync.native(path.resolve(root, ...item.file.split('/')));
      const rel = path.relative(fs.realpathSync.native(root), full);
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return { ok: false, error: 'That file isn\'t in the project.' };
      const st = fs.lstatSync(path.resolve(root, ...item.file.split('/')));
      if (st.isSymbolicLink() || !st.isFile()) return { ok: false, error: 'That file isn\'t in the project.' };
      if (st.size > MAX_FILE_BYTES) return { ok: false, error: 'That file is too big to quote.' };
      lines = fs.readFileSync(full, 'utf8').split(/\r?\n/);
    } catch {
      return { ok: false, error: 'Couldn\'t read that file. Has it moved?' };
    }
    // Edited since the scan: the line no longer says what the list does.
    if (!String(lines[item.line - 1] || '').includes(item.tag)) {
      scans.delete(root.toLowerCase());
      return { ok: false, stale: true, error: 'That file has changed since Shellby looked. Look again.' };
    }
    const from = Math.max(1, item.line - startfrom.AROUND);
    const to = Math.min(lines.length, item.line + startfrom.AROUND);
    const around = [];
    for (let n = from; n <= to; n++) around.push({ n, text: lines[n - 1] });
    const project = d.projects.nameFor(root);
    return { ok: true, cwd: root, draft: startfrom.todoPrompt({ project, item, around }) };
  }

  // A red build's notification, or a new review comment's (ci-proposals.js),
  // opens its sheet in the panel (startfrom.js there): nothing starts until Send.
  function showBuildFix(key, kind = 'build') {
    d.showPanel({ focusInput: false });
    d.send(d.panel, 'startfrom:open', { kind: kind === 'review' ? 'review' : 'build', key });
  }

  return { startFromDraft: draft, startFromSend: send, looseEnds, looseEndDraft, showBuildFix };
}

module.exports = { wireStartFrom };
