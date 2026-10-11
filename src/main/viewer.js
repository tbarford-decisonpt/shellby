// The file viewer's side of main (renderer/panel/viewer.js): which folders the
// panel may read, what changed in them, and nothing else.
//
// The panel never names a path or a git ref to read. It opens a handle on a
// conversation's folder (or a worktree the Project page listed), and every read
// after that is confined to the handle's root, resolved with links followed
// and 8.3 names expanded, so a junction can't lead out of it. Diffs are served
// only for files on the handle's own changes list, as changeRef does for a turn.
//
// execFile with fixed arguments, timeouts, and never throws to the caller.
const fs = require('fs');
const path = require('path');

const MAX_BYTES = 2 * 1024 * 1024;   // past this, "Open in editor" instead
const SNIFF_BYTES = 8 * 1024;        // a NUL in here: not text

// A path with links followed and 8.3 names expanded, or null when it isn't there.
const longPath = p => { try { return fs.realpathSync.native(p); } catch { return null; } };
// Strictly inside root (root itself isn't). Both already resolved; win32 compares without case.
const isUnder = (root, abs) => {
  const rel = path.relative(root, abs);
  return !!rel && rel.split(path.sep)[0] !== '..' && !path.isAbsolute(rel);
};
const sameDir = (a, b) => {
  const x = typeof a === 'string' ? longPath(a) : null;
  const y = typeof b === 'string' ? longPath(b) : null;
  return !!x && !!y && path.relative(x, y) === '';
};

// A relative path made only of plain names: no drive (C:x), no stream (a.txt:s), no
// UNC or rooted start, no '..'. Checked before anything touches the disk, so a
// network path never makes Windows log in to a host (as filelinks.js refuses too).
const plainRel = rel => typeof rel === 'string' && !!rel && rel.length <= 1000 && !/[\0:]/.test(rel)
  && !/^[\\/]/.test(rel) && !path.isAbsolute(rel) && !rel.split(/[\\/]/).includes('..');

// Outside the folder and not there at all answer alike: the panel learns nothing about other files.
const NOT_HERE = { ok: false, missing: true };

/** A file under root, as text. rel: as git names it (forward slashes) or the OS does. */
async function readInside(root, rel) {
  const top = typeof root === 'string' ? longPath(root) : null;
  if (!top) return { ok: false, gone: true };
  if (!plainRel(rel)) return { ...NOT_HERE };
  const abs = path.resolve(top, rel);
  if (!isUnder(top, abs)) return { ...NOT_HERE };
  const file = longPath(abs); // links followed: a junction out of the folder ends outside it
  if (!file || !isUnder(top, file)) return { ...NOT_HERE };
  let fh;
  try { fh = await fs.promises.open(file, 'r'); } catch { return { ...NOT_HERE }; }
  try {
    // Swapped for a link between the check and the open: the file opened must still be the one inside.
    const st = await fh.stat({ bigint: true });
    const again = longPath(abs);
    if (!again || !isUnder(top, again)) return { ...NOT_HERE };
    const now = await fs.promises.stat(again, { bigint: true });
    if (now.ino !== st.ino || now.dev !== st.dev) return { ...NOT_HERE };
    if (!st.isFile()) return { ok: false, error: 'Not a file.' };
    const size = Number(st.size);
    if (size > MAX_BYTES) return { ok: false, tooBig: true, size };
    const buf = await fh.readFile();
    if (buf.subarray(0, SNIFF_BYTES).includes(0)) return { ok: false, binary: true, size };
    let text = buf.toString('utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return { ok: true, text, size };
  } catch {
    return { ...NOT_HERE };
  } finally {
    await fh.close().catch(() => {});
  }
}

module.exports = { readInside, sameDir, isUnder, longPath, MAX_BYTES, SNIFF_BYTES };
