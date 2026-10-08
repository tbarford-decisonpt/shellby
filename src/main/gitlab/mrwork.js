// What one of your GitLab merge requests needs from you, fetched for a task to
// start from (startfrom.js writes the prompt): the job that failed and its log,
// or the threads nobody has resolved yet. github/prwork.js's GitLab twin, with
// its answers in the same shapes.
//
// All through glab (glab.js), with the sign-in glab already has. Whatever
// GitLab won't share is said, not guessed: the build falls back to the job's
// name and link.
//
// gl is a GlabApi for the merge request's host (or a stand-in in tests:
// test/gitlab.test.js). mr: { host, projectId, number, repo }.
const { checkPath } = require('./remote');
const { failedJobs, pipelineState } = require('./watcher');

const SHA_RE = /^[0-9a-f]{40}$/;
const REF_RE = /^(?!-)(?!.*\.\.)[\w./+-]{1,200}$/;
const LOG_CHARS = 4000000;
const PAGES = 3; // of 100: past 300 files, commits or threads, Shellby says it couldn't read them all

const clip = (s, n) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, n) : '');
const idOf = v => (Number.isInteger(v) && v > 0 ? v : null);
const onHost = (u, host) => (typeof u === 'string' && u.startsWith(`https://${host}/`) && !/\s/.test(u) ? u.slice(0, 500) : '');

/** Why GitLab wouldn't hand something over, in words for the sheet and the prompt. */
function whyNoLog(e) {
  if (e?.missing) return 'glab isn\'t installed on this PC';
  if (e?.signedOut) return 'glab isn\'t signed in to that GitLab. Run glab auth login';
  if (e?.status === 404 || e?.status === 403) return 'GitLab wouldn\'t share it with glab\'s sign-in';
  if (e?.status === 410) return 'GitLab has erased it';
  return `glab said: ${clip(e?.message, 120) || 'nothing useful'}`;
}

/**
 * The merge request as a copy needs it.
 * -> { title, sha, headRef, headRepo, baseRepo, pipeline: { id, project, status } | null, raw } | null
 */
async function pullOf(gl, { projectId, number, repo }) {
  if (!idOf(projectId) || !idOf(number)) return null;
  const mr = await gl.get(`projects/${projectId}/merge_requests/${number}`);
  const sha = mr?.sha;
  const headRef = mr?.source_branch;
  if (!SHA_RE.test(String(sha)) || !REF_RE.test(String(headRef))) return null;
  // A merge request from a fork: its branch lives in the fork.
  let headRepo = repo;
  const source = idOf(mr.source_project_id);
  if (source && source !== projectId) {
    const p = await gl.get(`projects/${source}`).catch(() => null);
    headRepo = checkPath(p?.path_with_namespace) || `${repo} (a fork)`;
  }
  const pipe = mr.head_pipeline;
  return {
    title: clip(mr.title, 200), sha, headRef, headRepo, baseRepo: repo,
    pipeline: idOf(pipe?.id) ? { id: pipe.id, project: idOf(pipe.project_id) || projectId, status: String(pipe.status || '') } : null,
  };
}

// The jobs that failed in a pipeline, or in the child pipeline one of its trigger jobs started.
async function failedIn(gl, project, pipeline, depth = 0) {
  const jobs = await gl.get(`projects/${project}/pipelines/${pipeline}/jobs?scope[]=failed&per_page=100`).catch(() => null);
  const failed = (Array.isArray(jobs) ? jobs : []).filter(j => j?.status === 'failed' && j.allow_failure !== true && idOf(j.id))
    .sort((a, b) => a.id - b.id);
  if (failed.length || depth > 0) return failed.map(j => ({ ...j, project }));
  const bridges = await gl.get(`projects/${project}/pipelines/${pipeline}/bridges?per_page=100`).catch(() => null);
  for (const b of Array.isArray(bridges) ? bridges : []) {
    const down = b?.downstream_pipeline;
    if (b?.status !== 'failed' || b.allow_failure === true || !idOf(down?.id)) continue;
    const inner = await failedIn(gl, idOf(down.project_id) || project, down.id, depth + 1);
    if (inner.length) return inner;
  }
  return [];
}

/**
 * The first job that failed in the merge request's latest pipeline, with its
 * log if GitLab will share it.
 *   -> { pull, job: { id, name, url, step }, log: string|null, why } | { error }
 * step is the job's stage (GitLab jobs have no steps of their own).
 */
async function failingBuild(gl, mr) {
  let pull;
  try { pull = await pullOf(gl, mr); } catch (e) { return { error: `Couldn't read the merge request: ${whyNoLog(e)}.` }; }
  if (!pull) return { error: 'GitLab didn\'t say which commit that merge request is on.' };
  if (!pull.pipeline) return { error: 'That merge request has no pipeline.' };
  if (pull.pipeline.status !== 'failed') return { error: 'Nothing is failing on that merge request any more.' };
  const [first] = await failedIn(gl, pull.pipeline.project, pull.pipeline.id);
  if (!first) {
    return { pull, job: { id: null, name: 'pipeline', url: `https://${gl.host}/${mr.repo}/-/pipelines/${pull.pipeline.id}`, step: null }, log: null, why: 'GitLab didn\'t say which job failed' };
  }
  const job = { id: first.id, name: clip(first.name, 120) || 'job', url: onHost(first.web_url, gl.host), step: clip(first.stage, 120) || null };
  try {
    return { pull, job, log: await gl.text(`projects/${first.project}/jobs/${first.id}/trace`, { maxChars: LOG_CHARS }), why: '' };
  } catch (e) {
    return { pull, job, log: null, why: whyNoLog(e) };
  }
}

// Every page of a list, or null if GitLab wouldn't give all of it.
async function allPages(gl, path) {
  const out = [];
  const sep = path.includes('?') ? '&' : '?';
  for (let page = 1; page <= PAGES; page++) {
    const list = await gl.get(`${path}${sep}per_page=100&page=${page}`).catch(() => null);
    if (!Array.isArray(list)) return null;
    out.push(...list);
    if (list.length < 100) return out;
  }
  return null;
}

/**
 * The threads on a merge request, as startfrom.openThreads() takes them.
 * GitLab always says which are resolved.
 *   -> { pull, threads: [raw thread], resolvedKnown: true } | { error }
 */
async function reviewThreads(gl, mr) {
  let pull;
  try { pull = await pullOf(gl, mr); } catch (e) { return { error: `Couldn't read the merge request: ${whyNoLog(e)}.` }; }
  if (!pull) return { error: 'GitLab didn\'t say which commit that merge request is on.' };
  const discussions = await allPages(gl, `projects/${mr.projectId}/merge_requests/${mr.number}/discussions`);
  if (!discussions) return { error: 'Couldn\'t read the merge request\'s threads.' };
  const threads = [];
  for (const d of discussions) {
    const notes = (Array.isArray(d?.notes) ? d.notes : []).filter(n => n && !n.system);
    const resolvable = notes.filter(n => n.resolvable);
    if (!resolvable.length) continue; // a plain comment, not a thread to resolve
    const pos = notes[0]?.position || null;
    const line = Number.isInteger(pos?.new_line) ? pos.new_line : null;
    threads.push({
      path: pos?.new_path || pos?.old_path || null,
      line,
      originalLine: Number.isInteger(pos?.old_line) ? pos.old_line : null,
      isResolved: resolvable.every(n => n.resolved),
      // Left on an older push of the branch: the code may have moved on since.
      isOutdated: !!(pos?.head_sha && pos.head_sha !== pull.sha),
      comments: notes.map(n => ({ author: n.author?.username || '', body: n.body })),
    });
  }
  return { pull, resolvedKnown: true, threads };
}

/**
 * The files a merge request changes and its commits, in the shapes
 * startfrom.prRisks reads (GitHub's), oldest commit first.
 * emails: yours, so your own commits aren't someone else's; me: your username.
 * -> { files: [] | null, commits: [] | null }
 */
async function mrChanges(gl, mr, { me = null, emails = [] } = {}) {
  if (!idOf(mr?.projectId) || !idOf(mr?.number)) return { files: null, commits: null };
  const base = `projects/${mr.projectId}/merge_requests/${mr.number}`;
  const [diffs, commits] = await Promise.all([allPages(gl, `${base}/diffs`), allPages(gl, `${base}/commits`)]);
  const mine = new Set(emails.map(e => String(e).toLowerCase()));
  return {
    files: diffs ? diffs.map(f => ({ filename: f?.new_path, previous_filename: f?.renamed_file ? f.old_path : undefined })) : null,
    // GitLab lists the newest first.
    commits: commits ? commits.slice().reverse().map(c => ({
      sha: c?.id,
      author: { login: me && mine.has(String(c?.author_email || '').toLowerCase()) ? me : null },
      commit: { author: { name: c?.author_name } },
    })) : null,
  };
}

/**
 * CI on a commit, from its newest pipeline: { state, failing } as
 * github/ci.js's verdict() gives it, for the Releases card. null when GitLab
 * couldn't say. path: "group/project".
 */
async function commitCi(gl, path, sha) {
  if (!gl || !checkPath(path) || !SHA_RE.test(String(sha))) return null;
  const project = encodeURIComponent(path);
  const list = await gl.get(`projects/${project}/pipelines?sha=${sha}&order_by=id&sort=desc&per_page=1`).catch(() => null);
  if (!Array.isArray(list)) return null;
  const pipe = list[0];
  if (!pipe) return { state: 'none', failing: [] };
  const state = pipelineState(pipe.status);
  if (state !== 'failing' || !idOf(pipe.id)) return { state, failing: [] };
  const jobs = await gl.get(`projects/${project}/pipelines/${pipe.id}/jobs?scope[]=failed&per_page=100`).catch(() => null);
  return { state, failing: failedJobs(jobs) };
}

/** Every address your commits could be under, from glab's user. */
async function myEmails(gl) {
  const [me, list] = await Promise.all([gl.get('user').catch(() => null), gl.get('user/emails').catch(() => null)]);
  const out = [me?.email, me?.commit_email, me?.public_email, ...(Array.isArray(list) ? list.map(e => e?.email) : [])];
  return { me: typeof me?.username === 'string' ? me.username : null, emails: [...new Set(out.filter(e => typeof e === 'string' && e.includes('@')))] };
}

module.exports = { pullOf, failingBuild, reviewThreads, mrChanges, commitCi, myEmails, whyNoLog };
