// What a try (tries.js) is given of the message's attachments. Every try gets
// all of them, but each works in its own copy of the project, so a file from
// the project is pointed at that try's own copy of it, never at your checkout:
// a try that edits "the attached file" must not reach past its copy.
//
//   - a file in the project that's in the copy too: the copy's file
//   - a file in the project that isn't (uncommitted, ignored): a snapshot of it
//     for that try alone, under Shellby's data folder
//   - anything else (screenshots, files from elsewhere): as it is. Pictures go
//     to Claude inline, read once per try; the rest are only read.
//
// placeIn is pure; forTry copies. Both are used by wiring/tries.js.
const fs = require('fs');
const path = require('path');
const { isLocalPath, MAX_INPUT_BYTES } = require('./attachments');

const MAX_FILES = 20;              // what one message carries (task:send)
const KEEP_DAYS = 30;              // like saved screenshots: old chats just lose them
const RUN_DIR = /^[0-9a-f-]{8,64}$/i;

const insideOf = (dir, file) => {
  const rel = path.relative(dir, file);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : null;
};

/**
 * Where a file sits in the project: its path relative to the first root that
 * holds it, or null when it isn't in the project at all. roots: the checkout,
 * and the copy the message was typed in, if any. All absolute, already real.
 */
function placeIn(file, roots) {
  for (const root of roots) {
    if (typeof root !== 'string' || !root) continue;
    const rel = insideOf(root, file);
    if (rel) return rel;
  }
  return null;
}

/** The files a message carries, as paths worth looking at: local, absolute, no more than MAX_FILES. */
function clean(files) {
  return (Array.isArray(files) ? files : [])
    .filter(f => typeof f === 'string' && f.length < 1024 && isLocalPath(f) && path.isAbsolute(f) && !f.includes('\0'))
    .slice(0, MAX_FILES);
}

// The real path (8.3 short names expanded, as git reports them), or the path as it is.
const real = f => { try { return fs.realpathSync.native(f); } catch { return path.resolve(f); } };

/**
 * One try's attachments. files: from clean(). roots: see placeIn. copy: the
 * try's worktree record ({ path }). store: a folder of this try's own, for
 * snapshots (made only if one is needed). -> [path]
 */
function forTry(files, { roots, copy, store }) {
  const realRoots = roots.filter(r => typeof r === 'string' && r).map(real);
  return files.map(file => {
    const rel = placeIn(real(file), realRoots);
    if (!rel) return file;
    const mine = path.join(copy.path, rel);
    if (fs.existsSync(mine)) return mine;
    return snapshot(file, store) || file;
  });
}

// A copy of a project file the try's copy doesn't have. Only plain files of a
// sensible size: a folder, or anything bigger, stays where it is.
function snapshot(file, store) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_INPUT_BYTES) return null;
    fs.mkdirSync(store, { recursive: true });
    let to = path.join(store, path.basename(file));
    for (let n = 2; fs.existsSync(to); n++) to = path.join(store, `${n}-${path.basename(file)}`);
    fs.copyFileSync(file, to, fs.constants.COPYFILE_EXCL);
    return to;
  } catch {
    return null;
  }
}

/** Snapshots from runs older than KEEP_DAYS go. dir: the folder every run's snapshots live under. */
function prune(dir, now = Date.now()) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return 0; }
  let gone = 0;
  for (const name of names) {
    if (!RUN_DIR.test(name)) continue;
    const p = path.join(dir, name);
    try {
      if (now - fs.statSync(p).mtimeMs > KEEP_DAYS * 86400000) { fs.rmSync(p, { recursive: true, force: true }); gone++; }
    } catch { /* in use, or gone already: next time */ }
  }
  return gone;
}

module.exports = { placeIn, clean, forTry, prune, MAX_FILES };
