// What one of your pull requests needs from you, fetched for a task to start
// from (startfrom.js writes the prompt): the job that failed and its log, or
// the review comments nobody has resolved yet.
//
// All with the sign-in you already gave Shellby. A public repository's logs
// need nothing more; a private one's need the `repo` scope that "Let Claude
// tasks push" asks for. Whatever GitHub won't share is said, not guessed: the
// build falls back to the job's name and link.
//
// gh is a GitHubApi (or a stand-in in tests: test/prwork.test.js).
const { threadsFromRest } = require('../startfrom');
const { verdict } = require('./ci');

const REPO_RE = /^(?!\.{1,2}\/)[A-Za-z0-9_.-]{1,100}\/(?!\.{1,2}$)[A-Za-z0-9_.-]{1,100}$/; // no . or .. segments
const REF_RE = /^(?!-)(?!.*\.\.)[\w./-]{1,200}$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const FAILED = new Set(['failure', 'timed_out', 'startup_failure']);
const LOG_CHARS = 4000000;

const clip = (s, n) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, n) : '');
const webUrl = (u, web) => (typeof u === 'string' && u.startsWith(`${web}/`) && !/\s/.test(u) ? u.slice(0, 500) : '');
// Another CI's page: any https link will do, it's only shown and quoted.
const httpsUrl = u => (typeof u === 'string' && /^https:\/\/[^\s"'<>]+$/.test(u) ? u.slice(0, 500) : '');

/**
 * The pull request as a copy needs it. -> { title, sha, headRef, headRepo, baseRepo } | null
 */
async function pullOf(gh, repo, number) {
  if (!REPO_RE.test(String(repo)) || !Number.isInteger(number)) return null;
  const pull = await gh.get(`/repos/${repo}/pulls/${number}`);
  const sha = pull?.head?.sha;
  const headRef = pull?.head?.ref;
  if (!SHA_RE.test(String(sha)) || !REF_RE.test(String(headRef))) return null;
  const headRepo = REPO_RE.test(String(pull.head.repo?.full_name)) ? pull.head.repo.full_name : repo;
  return { title: clip(pull.title, 200), sha, headRef, headRepo, baseRepo: repo };
}

/** Why GitHub wouldn't hand over a log, in words for the sheet and the prompt. */
function whyNoLog(e) {
  if (e?.status === 404 || e?.status === 403) return 'GitHub wouldn\'t share it with Shellby\'s sign-in. For a private repository, turn on "Let Claude tasks push" in Settings → GitHub';
  if (e?.status === 410) return 'GitHub has deleted it: logs expire after a while';
  if (e?.status === 401) return 'GitHub signed Shellby out';
  return `GitHub said: ${clip(e?.message, 120) || 'nothing useful'}`;
}

/**
 * The first job that failed on the pull request's latest commit, with its log
 * if GitHub will share it.
 *   -> { pull, job: { id, name, url, step }, log: string|null, why } | { error }
 * step is the failing step's name when the job's steps could be read.
 */
async function failingBuild(gh, { repo, number, web = 'https://github.com' }) {
  let pull;
  try { pull = await pullOf(gh, repo, number); } catch (e) { return { error: `Couldn't read the pull request: ${whyNoLog(e)}.` }; }
  if (!pull) return { error: 'GitHub didn\'t say which commit that pull request is on.' };
  const base = `/repos/${repo}`;
  const [runs, status] = await Promise.all([
    gh.get(`${base}/commits/${pull.sha}/check-runs?filter=latest&per_page=100`).catch(() => null),
    gh.get(`${base}/commits/${pull.sha}/status`).catch(() => null),
  ]);
  const failed = (runs?.check_runs || []).filter(r => r?.status === 'completed' && FAILED.has(r.conclusion));
  // GitHub Actions jobs first: theirs are the logs Shellby can read.
  const run = failed.find(r => r.app?.slug === 'github-actions') || failed[0];
  if (!run) {
    // A commit status from another CI (CircleCI, Vercel…): its name and link, no log.
    const s = (status?.statuses || []).find(x => x?.state === 'failure' || x?.state === 'error');
    if (s) return { pull, job: { id: null, name: clip(s.context, 120) || 'status', url: httpsUrl(s.target_url), step: null }, log: null, why: 'it ran outside GitHub Actions, so GitHub doesn\'t keep its log' };
    const v = verdict(runs?.check_runs, status?.statuses);
    return { error: v.state === 'failing' ? 'GitHub didn\'t say which job failed.' : 'Nothing is failing on that pull request any more.' };
  }
  const job = { id: Number.isInteger(run.id) ? run.id : null, name: clip(run.name, 120) || 'check', url: webUrl(run.html_url, web) || webUrl(run.details_url, web), step: null };
  if (run.app?.slug !== 'github-actions' || !job.id) return { pull, job, log: null, why: 'it isn\'t a GitHub Actions job, so its log lives elsewhere' };
  // For Actions, a check run's id is its job's id.
  const detail = await gh.get(`${base}/actions/jobs/${job.id}`).catch(() => null);
  const step = (Array.isArray(detail?.steps) ? detail.steps : []).find(s => s?.conclusion === 'failure');
  if (step) job.step = clip(step.name, 120) || null;
  try {
    return { pull, job, log: await gh.text(`${base}/actions/jobs/${job.id}/logs`, { maxChars: LOG_CHARS }), why: '' };
  } catch (e) {
    return { pull, job, log: null, why: whyNoLog(e) };
  }
}

const THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { reviewThreads(first: 60) { nodes {
    isResolved isOutdated path line originalLine
    comments(first: 6) { nodes { author { login } body } }
  } } } }
}`;

/**
 * The review threads on a pull request. GraphQL knows which are resolved;
 * REST (the fallback) doesn't, and says so.
 *   -> { pull, threads: [raw thread], resolvedKnown } | { error }
 * Raw threads go through startfrom.openThreads().
 */
async function reviewThreads(gh, { repo, number }) {
  let pull;
  try { pull = await pullOf(gh, repo, number); } catch (e) { return { error: `Couldn't read the pull request: ${whyNoLog(e)}.` }; }
  if (!pull) return { error: 'GitHub didn\'t say which commit that pull request is on.' };
  const [owner, name] = repo.split('/');
  try {
    const r = await gh.post('/graphql', { query: THREADS_QUERY, variables: { owner, name, number } });
    const nodes = r?.data?.repository?.pullRequest?.reviewThreads?.nodes;
    if (Array.isArray(nodes)) {
      return {
        pull,
        resolvedKnown: true,
        threads: nodes.map(t => ({
          path: t?.path, line: t?.line, originalLine: t?.originalLine, isResolved: !!t?.isResolved, isOutdated: !!t?.isOutdated,
          comments: (t?.comments?.nodes || []).map(c => ({ author: c?.author?.login || '', body: c?.body })),
        })),
      };
    }
  } catch { /* REST below */ }
  try {
    const list = await gh.get(`/repos/${repo}/pulls/${number}/comments?per_page=100`);
    return { pull, resolvedKnown: false, threads: threadsFromRest(list) };
  } catch (e) {
    return { error: `Couldn't read the review comments: ${whyNoLog(e)}.` };
  }
}

module.exports = { pullOf, failingBuild, reviewThreads, whyNoLog };
