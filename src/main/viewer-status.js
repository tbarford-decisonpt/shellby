// The file tree's git status (panel/files-dock.js): each file's mark against HEAD, the branch
// and its upstream, and what a real commit or a git add just touched. main's viewer.js reads it
// for a folder handle only, through its own git(): fixed arguments, nothing fetched, optional
// locks off (so a status never writes the index, never fights a turn's snapshot for its lock and
// never fires a repo's post-index-change hook), a timeout. git is passed in, never required here.
const crypto = require('crypto');
const MAX_FLASH = 200;                       // paths one commit or one git add lights, at most
const MAX_WHOLE = 50;                        // folders git lists whole that are looked inside, at most
const FAILED = "Couldn't read git status."; // never git's own words (as viewer.js PATCH_SAID)
const SHA = /^[0-9a-f]{40,64}$/;
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'; // what a repo with no commits stages against (as viewer.js)
const UNMERGED = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

/** `## main...origin/main [ahead 1, behind 2]` -> { branch, upstream, ahead, behind } */
function parseBranch(line) {
  const s = String(line || '').replace(/^## /, '');
  const none = { branch: null, upstream: null, ahead: 0, behind: 0 };
  const fresh = /^(?:No commits yet on|Initial commit on) (.+)$/.exec(s);
  if (fresh) return { ...none, branch: fresh[1] };
  if (!s || s.startsWith('HEAD (no branch)')) return none;
  const m = /^(.+?)(?:\.\.\.(\S+))?(?: \[([^\]]*)\])?$/.exec(s);
  if (!m) return none;
  const n = re => Number(re.exec(m[3] || '')?.[1]) || 0;
  return { branch: m[1], upstream: m[2] || null, ahead: n(/ahead (\d+)/), behind: n(/behind (\d+)/) };
}

// Two status letters as one mark: a conflict, untracked, renamed, deleted, added, else modified.
function markOf(xy) {
  if (xy === '??') return '?';
  if (UNMERGED.has(xy)) return 'U';
  if (xy.includes('R')) return 'R';
  if (xy.includes('D')) return 'D';
  if (xy[0] === 'A' || xy.includes('C')) return 'A';
  return 'M';
}

/** `git status --porcelain=v1 -b -z` -> { branch, upstream, ahead, behind, files: [{ path, status }] } */
function parseStatus(out) {
  const recs = String(out || '').split('\0');
  const head = parseBranch(recs[0]?.startsWith('## ') ? recs.shift() : '');
  const files = [];
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i];
    if (r.length < 4 || r[2] !== ' ') continue;
    const xy = r.slice(0, 2);
    files.push({ path: r.slice(3), status: markOf(xy) });
    if (/[RC]/.test(xy)) i++; // a rename or copy: its old path is one more field
  }
  return { ...head, files };
}

/** `git diff-index -M --numstat -z HEAD` -> Map(path -> { added, removed }); a binary file counts 0 and 0. */
function parseNumstat(out) {
  const map = new Map();
  const recs = String(out || '').split('\0');
  for (let i = 0; i < recs.length; i++) {
    const m = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(recs[i]);
    if (!m) continue;
    let p = m[3];
    if (!p) { i += 2; p = recs[i]; } // a rename: an empty path, then the old one, then the new one
    if (p) map.set(p, { added: Number(m[1]) || 0, removed: Number(m[2]) || 0 });
  }
  return map;
}

const names = out => String(out || '').split('\0').filter(Boolean);

/**
 * One status read of a folder handle, and what moved since its last one. h: the viewer's handle
 * ({ root, git }); it keeps h.statusHead and h.statusCached (which staleFor never clears) for the
 * next read to compare with. The first read of a handle reports no commit and nothing staged.
 */
async function readStatus(h, git) {
  if (!h.git) return { ok: true, noGit: true, files: [], committed: [], staged: [] };
  const [st, rev] = await Promise.all([
    git(h.root, ['status', '--porcelain=v1', '-b', '-z', '--untracked-files=normal']),
    git(h.root, ['rev-list', '--parents', '-n', '1', 'HEAD']), // null with no commits yet, or when it fails
  ]);
  if (st === null) return { ok: false, error: FAILED };
  const [head = null, ...parents] = String(rev || '').trim().split(/\s+/).filter(x => SHA.test(x));
  // No HEAD in a repo whose branch line doesn't say it has no commits: rev-list failed or timed out.
  // Read as an empty repo, the whole index would light as staged and the next commit pass unseen.
  if (!head && !/^## (?:No commits yet on|Initial commit on) /.test(st)) return { ok: false, error: FAILED };
  // Plumbing, never porcelain `git diff`: that refreshes the index for a file whose timestamp moved
  // but whose content didn't, taking index.lock and firing post-index-change whatever
  // GIT_OPTIONAL_LOCKS says. diff-index reads the index and never writes it.
  const s = parseStatus(st);
  // A folder git lists whole ('?? new/') keeps that one line however many files land in it, so what's
  // inside is listed too (only those folders, names taken literally) and handed on as a digest: the
  // tree reads again when it changes (panel/files-dock.js).
  const whole = s.files.filter(f => f.status === '?' && f.path.endsWith('/')).map(f => f.path).slice(0, MAX_WHOLE);
  const [num, cached, inside] = await Promise.all([
    head ? git(h.root, ['diff-index', '-M', '--numstat', '-z', head]) : '',
    git(h.root, ['diff-index', '--cached', '--name-only', '-z', head || EMPTY_TREE]),
    whole.length ? git(h.root, ['--literal-pathspecs', 'ls-files', '--others', '--exclude-standard', '-z', '--', ...whole]) : null,
  ]);
  if (num === null || cached === null) return { ok: false, error: FAILED };
  const counts = parseNumstat(num);
  const files = s.files.map(f => (f.status === '?' ? { ...f, added: null, removed: null } : { ...f, ...(counts.get(f.path) || { added: 0, removed: 0 }) }));

  const first = h.statusHead === undefined;
  const was = h.statusHead;
  const wasCached = h.statusCached || new Set();
  const nowCached = names(cached);
  h.statusHead = head;
  h.statusCached = new Set(nowCached);
  // A real commit: HEAD moved onto a child of the old head (or the repo's first commit landed).
  // A checkout, reset, rebase or amend moves it some other way and lights nothing.
  let committed = [];
  if (!first && head && head !== was && (was ? parents.includes(was) : parents.length === 0)) {
    const out = await git(h.root, was ? ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', was, head] : ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', '--root', head]);
    committed = names(out).slice(0, MAX_FLASH);
  }
  const staged = first ? [] : nowCached.filter(p => !wasCached.has(p)).slice(0, MAX_FLASH);
  const untrackedIn = inside === null ? undefined : crypto.createHash('sha1').update(inside).digest('hex');
  return { ok: true, branch: s.branch, upstream: s.upstream, ahead: s.ahead, behind: s.behind, head, files, committed, staged, untrackedIn };
}

module.exports = { parseBranch, parseStatus, parseNumstat, readStatus, MAX_FLASH };
