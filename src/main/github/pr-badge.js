// "Built with Shellby" on pull requests (opt-in): when a tab's work becomes a
// pull request, a small picture of your crab, dressed as he is now, goes at
// the bottom of its description with your level and a link to Shellby.
//
// GitHub only shows a description's image when it's served as an image, and
// gist files come back as text/plain (see profile-card.js). Files in a public
// repository do come back as images, so the picture lives in one,
// <you>/shellby-badge, made the first time it's needed. Each new look is a
// commit there and the description links to that commit, so a pull request
// keeps the outfit he wore that day (and the link never changes under it).
//
// The panel draws the crab (pr-badge.js there); this side checks the SVG,
// uploads it when it changed, and adds the badge to a pull request: in the
// body it's opened with (workflows), or by editing it afterwards (a tab's
// `gh pr create`). Pure helpers are exported for test/pr-badge.test.js.
const crypto = require('crypto');
const { cleanSvg } = require('./profile-card');

const REPO = 'shellby-badge';
const FILE = 'crab.svg';
const SHELLBY_URL = 'https://github.com/x-salmon/shellby';
const START = '<!-- shellby-badge -->';
const END = '<!-- /shellby-badge -->';
const BLOCK_RE = /\n*<!-- shellby-badge -->[\s\S]*?<!-- \/shellby-badge -->\n*/;
const IMG_WIDTH = 72;
const BODY_MAX = 60000; // pullrequest.js BODY_MAX: GitHub's limit is 65536
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const REPO_RE = /^(?!\.{1,2}\/)[A-Za-z0-9_.-]{1,100}\/(?!\.{1,2}$)[A-Za-z0-9_.-]{1,100}$/; // no . or .. segments
const WEB_RE = /^https?:\/\/[^\s"'<>]+$/;
const PR_CREATE_RE = /\bgh\s+pr\s+create\b/i;

const hashOf = svg => crypto.createHash('sha256').update(svg).digest('hex');
const clip = (s, n) => String(s || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, n);

/** Did this shell command open a pull request with gh? (Rehearsals don't.) */
function isPrCreate(command) {
  if (typeof command !== 'string') return false;
  const c = command.slice(0, 4000);
  return PR_CREATE_RE.test(c) && !/--dry-run\b|\s--web\b|\s-w\b/.test(c);
}

/**
 * The pull request `gh pr create` printed, or null. gh prints its URL on a line
 * of its own, last; anything else in the output (a chained command, a hook)
 * could name some other pull request, so only the last line like that counts.
 */
function prFromOutput(text, web = 'https://github.com') {
  const host = web.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^\\s*${host}/([A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100})/pull/(\\d{1,9})\\s*$`, 'gm');
  const m = [...String(text || '').matchAll(re)].pop();
  return m && REPO_RE.test(m[1]) ? { repo: m[1], number: Number(m[2]) } : null;
}

/** Where the picture at this commit is served as an image. */
function pictureUrl(login, commit, web = 'https://github.com') {
  if (!LOGIN_RE.test(String(login)) || !SHA_RE.test(String(commit)) || !WEB_RE.test(String(web))) return null;
  return web === 'https://github.com'
    ? `https://raw.githubusercontent.com/${login}/${REPO}/${commit}/${FILE}`
    : `${web}/${login}/${REPO}/raw/${commit}/${FILE}`;
}

/** The badge, as it goes in a description. */
function badgeBlock({ login, commit, level, web }) {
  const src = pictureUrl(login, commit, web);
  if (!src) return null;
  const lv = Number.isFinite(level) ? Math.min(99, Math.max(1, Math.floor(level))) : 1;
  return [
    START,
    `<a href="${SHELLBY_URL}"><img src="${src}" width="${IMG_WIDTH}" alt="Shellby, a pixel hermit crab, at level ${lv}"></a><br>`,
    `<sub>Built with <a href="${SHELLBY_URL}">Shellby</a> · Lv ${lv}</sub>`,
    END,
  ].join('\n');
}

/** A description with the badge at the bottom (replacing one already there). */
function withBadge(body, block) {
  const rest = String(body || '').replace(BLOCK_RE, '\n').trimEnd();
  const out = rest ? `${rest}\n\n${block}` : block;
  return out.length > BODY_MAX ? String(body || '') : out; // no room: leave it as it was
}

const hasBadge = body => typeof body === 'string' && body.includes(START);

/**
 * Keeps the picture in step with the panel's drawing and puts badges on pull requests.
 *   config: Shellby's Config ('prBadge' holds { hash, commit, error })
 *   github: GitHubService (can('prBadge'), gh(), view().login)
 *   level(): your level now
 */
class PrBadge {
  constructor({ config, github, level = () => 1, web = 'https://github.com' }) {
    Object.assign(this, { config, github, level, web });
    this.svg = null;        // the latest drawing from the panel
    this.uploading = null;
  }

  get state() {
    const r = this.config.get('prBadge') || {};
    return {
      hash: typeof r.hash === 'string' ? r.hash : null,
      commit: typeof r.commit === 'string' && SHA_RE.test(r.commit) ? r.commit : null,
      login: typeof r.login === 'string' && LOGIN_RE.test(r.login) ? r.login : null,
      error: typeof r.error === 'string' ? r.error.slice(0, 200) : null,
    };
  }

  save(patch) { this.config.set({ prBadge: { ...this.state, ...patch } }); }

  view() {
    const login = this.github.view().login;
    return {
      on: this.github.can('prBadge'),
      error: this.state.error,
      repoUrl: login ? `${this.web}/${login}/${REPO}` : null,
    };
  }

  /** The panel's drawing of him now. Returns whether it was one Shellby would use. */
  setSvg(svgIn) {
    const svg = cleanSvg(svgIn);
    if (svg) this.svg = svg;
    return !!svg;
  }

  /** { commit, login }: the commit with his current look in it, uploading it if it changed. */
  picture() {
    if (this.uploading) return this.uploading;
    this.uploading = this.upload().finally(() => { this.uploading = null; });
    return this.uploading;
  }

  async upload() {
    const login = this.github.view().login;
    if (!LOGIN_RE.test(String(login))) throw new Error('GitHub didn\'t say who you are.');
    const s = this.state;
    const svg = this.svg;
    const gh = this.github.gh();
    // The look already up (or, before the panel draws him, his last one), unless
    // the repository went (you may delete it): then it goes up again.
    const cached = s.commit && s.login === login && (!svg || s.hash === hashOf(svg));
    if (cached && await commitExists(gh, login, s.commit)) return { commit: s.commit, login };
    if (!svg) throw new Error('The panel hasn\'t drawn your crab yet.');
    await ensureRepo(gh, login);
    const commit = await putPicture(gh, login, svg);
    this.save({ hash: hashOf(svg), commit, login, error: null });
    return { commit, login };
  }

  /** The badge for a description now, or null (and the reason saved for Settings). */
  async block() {
    if (!this.github.can('prBadge')) return null;
    try {
      const { commit, login } = await this.picture();
      return badgeBlock({ login, commit, level: this.level(), web: this.web });
    } catch (e) {
      this.save({ error: describe(e, 'Couldn\'t put your crab\'s picture up') });
      return null;
    }
  }

  /** Add the badge to an open pull request. -> { ok, added } | { ok: false, error } */
  async addTo({ repo, number }) {
    if (!this.github.can('prBadge')) return { ok: false, error: 'The pull request badge is off.' };
    if (!REPO_RE.test(String(repo)) || !Number.isInteger(number)) return { ok: false, error: 'That isn\'t a pull request.' };
    const gh = this.github.gh();
    const path = `/repos/${repo}/pulls/${number}`;
    // Only your own pull requests, and only once. Checked before anything is
    // uploaded: a badge on someone else's would be an ad in their words.
    const wanted = pr => !hasBadge(pr?.body) && pr?.user?.login?.toLowerCase() === this.github.view().login?.toLowerCase();
    try {
      if (!wanted(await gh.get(path))) return { ok: true, added: false };
    } catch (e) {
      return this.failed(e, repo, number);
    }
    const block = await this.block();
    if (!block) return { ok: false, error: this.state.error };
    try {
      // Read again just before writing: the upload took a moment, and Claude may have edited it since.
      const pr = await gh.get(path);
      if (!wanted(pr) || !this.github.can('prBadge')) return { ok: true, added: false };
      const body = withBadge(pr.body, block);
      if (body === String(pr.body || '')) return { ok: true, added: false };
      await gh.patch(path, { body });
      this.save({ error: null });
      return { ok: true, added: true };
    } catch (e) {
      return this.failed(e, repo, number);
    }
  }

  failed(e, repo, number) {
    const error = describe(e, `Couldn't add the badge to ${repo}#${number}`, 'a private repository needs "Let Claude tasks push"');
    this.save({ error });
    return { ok: false, error };
  }
}

function describe(e, what, hint) {
  if (e?.status === 401) return 'GitHub signed Shellby out. Sign in again for the pull request badge.';
  if ((e?.status === 404 || e?.status === 403) && hint) return `${what}: GitHub said no (${hint}).`;
  return `${what}: ${clip(e?.message, 150)}`;
}

/** Is this commit still in <you>/shellby-badge? */
async function commitExists(gh, login, sha) {
  try {
    await gh.get(`/repos/${login}/${REPO}/commits/${sha}`);
    return true;
  } catch (e) {
    if (e.status === 404 || e.status === 422) return false;
    throw e;
  }
}

/** <you>/shellby-badge, made public if it isn't there yet. */
async function ensureRepo(gh, login) {
  let repo = null;
  try {
    repo = await gh.get(`/repos/${login}/${REPO}`);
  } catch (e) {
    if (e.status !== 404) throw e;
  }
  if (!repo) {
    repo = await gh.post('/user/repos', {
      name: REPO,
      description: 'My Shellby crab, for the badge on my pull requests. Made by Shellby.',
      homepage: SHELLBY_URL,
      private: false, has_issues: false, has_projects: false, has_wiki: false, auto_init: true,
    });
  }
  if (repo?.private) throw new Error(`${login}/${REPO} is private, so GitHub won't show the picture. Make it public, or delete it and Shellby makes a new one.`);
}

/** Commit the picture; returns the commit's sha. */
async function putPicture(gh, login, svg) {
  const path = `/repos/${login}/${REPO}/contents/${FILE}`;
  const put = async () => {
    let sha;
    try {
      const cur = await gh.get(path);
      sha = typeof cur?.sha === 'string' ? cur.sha : undefined;
    } catch (e) {
      if (e.status !== 404) throw e;
    }
    return gh.put(path, { message: 'Update crab', content: Buffer.from(svg, 'utf8').toString('base64'), ...(sha ? { sha } : {}) });
  };
  let r;
  try {
    r = await put();
  } catch (e) {
    if (e.status !== 409 && e.status !== 422) throw e;
    r = await put(); // a fresh repo still settling, or a change in between: once more
  }
  const commit = r?.commit?.sha;
  if (!SHA_RE.test(String(commit))) throw new Error('GitHub didn\'t say which commit it made.');
  return commit;
}

module.exports = { PrBadge, REPO, FILE, START, END, isPrCreate, prFromOutput, pictureUrl, badgeBlock, withBadge, hasBadge };
