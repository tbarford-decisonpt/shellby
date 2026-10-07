// The profile card: an SVG of your crab, level, streak and latest stickers in
// a public gist ("shellby-profile.svg"), for your GitHub profile README.
// GitHub won't show an image straight from a gist (raw gist files come back as
// text/plain), so a small Action in your profile repo copies it in on a
// schedule, the way stats cards work. The panel draws the SVG
// (profile-card.js there); this side checks it, publishes it when it changed,
// and writes the Action and the README line for you to paste.
const crypto = require('crypto');
const { findGist } = require('./gists');

const PROFILE_FILE = 'shellby-profile.svg';
const MAX_BYTES = 256 * 1024;
// Once a day anyway. The card shows its date, so in practice each new day is a
// change: the Action then commits daily, which also stops GitHub pausing its
// schedule after 60 quiet days.
const REPUBLISH_MS = 24 * 3600 * 1000;
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const GIST_ID_RE = /^[a-f0-9]{20,40}$/;
// Nothing in the card needs any of these. GitHub sanitises SVGs it serves as
// images, but the gist is public under your name, so keep it plain anyway.
const UNSAFE_RE = /<\s*(script|foreignObject|iframe|object|embed|image|use|a)\b|\bon[a-z]+\s*=|(?:href|src)\s*=|javascript:|@import|url\s*\(\s*['"]?\s*(?!#)/i;

/** The SVG if it's one Shellby would publish, else null. */
function cleanSvg(svg) {
  if (typeof svg !== 'string') return null;
  const s = svg.trim();
  if (!s || Buffer.byteLength(s, 'utf8') > MAX_BYTES) return null;
  if (!/^<svg\s[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/.test(s) || !/<\/svg>$/.test(s)) return null;
  if (UNSAFE_RE.test(s)) return null;
  return s;
}

const hashOf = svg => crypto.createHash('sha256').update(svg).digest('hex');

/** Create or update the card gist; returns its id. */
async function publishProfile(gh, svg, knownId) {
  const files = { [PROFILE_FILE]: { content: svg } };
  const id = await findGist(gh, knownId, PROFILE_FILE);
  if (id) {
    await gh.patch(`/gists/${encodeURIComponent(id)}`, { files });
    return id;
  }
  const created = await gh.post('/gists', { public: true, description: 'Shellby profile card (copied into your profile README by a GitHub Action)', files });
  return created.id;
}

/** Take the card down. One that's already gone is fine. */
async function deleteProfile(gh, knownId) {
  const id = await findGist(gh, knownId, PROFILE_FILE);
  if (!id) return false;
  try { await gh.delete(`/gists/${encodeURIComponent(id)}`); } catch (e) { if (e.status !== 404) throw e; }
  return true;
}

/** The newest revision of the card, always (no commit sha in the path). */
function rawUrl(login, gistId) {
  if (!LOGIN_RE.test(String(login)) || !GIST_ID_RE.test(String(gistId))) return null;
  return `https://gist.githubusercontent.com/${login}/${gistId}/raw/${PROFILE_FILE}`;
}

/** The Action for your profile repo (github.com/<you>/<you>). */
function workflowYaml(login, gistId) {
  const url = rawUrl(login, gistId);
  if (!url) return null;
  return `# Copies your Shellby card into this repo so your profile README can show it.
# Shellby updates the gist; this picks it up every six hours.
name: Shellby card
on:
  schedule:
    - cron: '23 */6 * * *'
  workflow_dispatch:
permissions:
  contents: write
jobs:
  card:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Fetch the crab
        run: |
          curl -fsSL "${url}?t=$(date +%s)" -o ${PROFILE_FILE}.new
          head -c 300 ${PROFILE_FILE}.new | grep -q '<svg' || { echo "Not an SVG"; exit 1; }
          mv ${PROFILE_FILE}.new ${PROFILE_FILE}
      - name: Commit if he changed
        run: |
          git add ${PROFILE_FILE}
          git diff --cached --quiet && exit 0
          git -c user.name="shellby-card[bot]" -c user.email="41898282+github-actions[bot]@users.noreply.github.com" commit -m "chore: update Shellby card"
          git push
`;
}

const README_LINE = `<a href="https://github.com/x-salmon/shellby"><img src="./${PROFILE_FILE}" alt="My Shellby: a pixel hermit crab with my level, streak and latest stickers" width="480"></a>`;
const WORKFLOW_PATH = '.github/workflows/shellby-card.yml';

const enc = encodeURIComponent;
const encPath = p => String(p).split('/').map(enc).join('/');

/**
 * Where each setup step happens on github.com, prefilled so it's one click
 * plus Commit. Shellby still never writes to the repo itself.
 *   progress: what setupProgress found ({ branch, readmePath })
 */
function setupLinks(login, gistId, progress = {}) {
  if (!LOGIN_RE.test(String(login))) return null;
  const repo = `https://github.com/${login}/${login}`;
  const branch = encPath(progress.branch || 'main');
  const yaml = workflowYaml(login, gistId);
  const newFile = (name, value) => `${repo}/new/${branch}?filename=${enc(name)}&value=${enc(value)}`;
  return {
    repo,
    profile: `https://github.com/${login}`,
    createRepo: `https://github.com/new?name=${enc(login)}&visibility=public&description=${enc('My GitHub profile')}`,
    settings: `${repo}/settings`,
    addAction: yaml ? newFile(WORKFLOW_PATH, yaml) : null,
    runAction: `${repo}/actions/workflows/shellby-card.yml`,
    readme: progress.readmePath ? `${repo}/edit/${branch}/${encPath(progress.readmePath)}` : newFile('README.md', `${README_LINE}\n`),
  };
}

/**
 * A read-only look at github.com/<you>/<you>: which setup steps are done.
 * Throws when GitHub can't answer (rate limit, offline); a 404 just means "not yet".
 */
async function setupProgress(gh, login) {
  if (!LOGIN_RE.test(String(login))) return null;
  const base = `/repos/${enc(login)}/${enc(login)}`;
  const find = path => gh.get(path).catch(e => { if (e.status === 404) return null; throw e; });
  const repo = await find(base);
  if (!repo) return { repo: false, isPublic: false, branch: null, action: false, card: false, readme: false, readmePath: null };
  const [action, card, readme] = await Promise.all([
    find(`${base}/contents/${encPath(WORKFLOW_PATH)}`),
    find(`${base}/contents/${PROFILE_FILE}`),
    find(`${base}/readme`),
  ]);
  const readmeText = typeof readme?.content === 'string' ? Buffer.from(readme.content, 'base64').toString('utf8') : '';
  return {
    repo: true,
    isPublic: repo.private !== true,
    branch: typeof repo.default_branch === 'string' ? repo.default_branch : 'main',
    action: !!action,
    card: !!card,
    readme: readmeText.includes(PROFILE_FILE),
    readmePath: typeof readme?.path === 'string' ? readme.path : null,
  };
}

/**
 * Keeps the card gist in step with what the panel draws.
 *   config: Shellby's Config ('profileCard' holds { gistId, hash, publishedAt, error })
 *   github: GitHubService (can('profileCard'), gh(), view().login)
 */
class ProfileCard {
  constructor({ config, github, now = () => Date.now() }) {
    this.config = config; this.github = github; this.now = now;
    this.publishing = null;
    this.closing = false; // taking the card down: nothing may put it back up meanwhile
  }

  get state() {
    const r = this.config.get('profileCard') || {};
    return {
      gistId: typeof r.gistId === 'string' && GIST_ID_RE.test(r.gistId) ? r.gistId : null,
      hash: typeof r.hash === 'string' ? r.hash : null,
      publishedAt: Number.isFinite(r.publishedAt) ? r.publishedAt : 0,
      error: typeof r.error === 'string' ? r.error.slice(0, 200) : null,
    };
  }

  save(patch) { this.config.set({ profileCard: { ...this.state, ...patch } }); }

  view() {
    const s = this.state;
    const login = this.github.view().login;
    const on = this.github.can('profileCard');
    return {
      on, gistId: s.gistId, publishedAt: s.publishedAt, error: s.error,
      profileRepo: login ? `https://github.com/${login}/${login}` : null,
      gistUrl: login && s.gistId ? `https://gist.github.com/${login}/${s.gistId}` : null,
      workflow: on && s.gistId ? workflowYaml(login, s.gistId) : null,
      readme: on && s.gistId ? README_LINE : null,
    };
  }

  /** The setup checklist: what's done in your profile repository, and links for what isn't. */
  async setup() {
    const login = this.github.view().login;
    if (!this.github.can('profileCard') || !login) return { ok: false, error: 'The profile card is off.' };
    try {
      const progress = await setupProgress(this.github.gh(), login);
      return { ok: true, progress, links: setupLinks(login, this.state.gistId, progress || {}) };
    } catch (e) {
      const error = e.status === 401 ? 'GitHub signed Shellby out. Sign in again to check your profile.' : `Couldn't check your profile repository: ${String(e.message).slice(0, 150)}`;
      return { ok: false, error, links: setupLinks(login, this.state.gistId) };
    }
  }

  /** Publish the panel's drawing if it changed (or a day went by). force: publish regardless. */
  publish(svgIn, { force = false } = {}) {
    if (this.closing || !this.github.can('profileCard')) return Promise.resolve({ ok: false, error: 'The profile card is off.' });
    const svg = cleanSvg(svgIn);
    if (!svg) return Promise.resolve({ ok: false, error: "That card didn't look right, so it wasn't published." });
    if (this.publishing) return this.publishing;
    const s = this.state;
    const hash = hashOf(svg);
    if (!force && s.gistId && s.hash === hash && this.now() - s.publishedAt < REPUBLISH_MS) return Promise.resolve({ ok: true, published: false });
    this.publishing = (async () => {
      try {
        const gistId = await publishProfile(this.github.gh(), svg, s.gistId);
        this.save({ gistId, hash, publishedAt: this.now(), error: null });
        return { ok: true, published: true };
      } catch (e) {
        const error = e.status === 401 ? 'GitHub signed Shellby out. Sign in again to keep the card fresh.' : `Couldn't update the card: ${String(e.message).slice(0, 150)}`;
        this.save({ error });
        return { ok: false, error };
      } finally {
        this.publishing = null;
      }
    })();
    return this.publishing;
  }

  /** Turned off (or signing out): delete the gist so it isn't public any more. */
  async takeDown() {
    this.closing = true;
    try {
      await this.publishing?.catch(() => {});
      if (!this.github.signedIn) return { ok: true };
      try {
        await deleteProfile(this.github.gh(), this.state.gistId);
      } catch (e) {
        return { ok: false, error: `Couldn't delete your profile card gist: ${String(e.message).slice(0, 150)}. You can delete it on gist.github.com.` };
      }
      this.save({ gistId: null, hash: null, publishedAt: 0, error: null });
      return { ok: true };
    } finally {
      this.closing = false;
    }
  }

  /** A card is (or may still be) up: sign-out should try to take it down. */
  get isUp() { return !!this.state.gistId; }
}

module.exports = { PROFILE_FILE, WORKFLOW_PATH, ProfileCard, cleanSvg, publishProfile, deleteProfile, rawUrl, workflowYaml, setupLinks, setupProgress, README_LINE };
