// Branch: try a conversation again from any turn, in a new tab, without
// touching the original. The other direction from rewind (rewind.js): rewind
// takes this conversation back; a branch leaves it exactly as it is and opens
// a second one that remembers everything up to that point.
//
// Three things make a branch, and this file works out all of them from the
// transcript, without touching anything:
//   - the conversation: Claude Code resumes the original's transcript only as
//     far as the end of the turn before the cut (--resume-session-at, as a
//     fork, so the original is left alone). Each turn's result carries that
//     point as `anchor`, and the session it was written in as `sessionId`.
//   - the files: each turn notes a `checkpoint` (main.js noteTurnChanges): a
//     snapshot of the whole folder as the turn began and as it ended, and the
//     commit checked out. The branch's copy of the repository starts from
//     exactly that state (worktrees.createAt). Transcripts from before
//     checkpoints fall back to the turn's own diff, then to the nearest one.
//   - the fence: a branch works in its own copy, but Claude's memory is full
//     of the original's paths. fenceDenies() keeps its edits out of them.
//
// Two places to branch from:
//   at 'before' a message: everything before it, files as they were when it
//     was sent, and the message back in the box to change and send again.
//   at 'after' a turn: everything up to the end of that reply, files as the
//     turn left them, and an empty box.
//
// All pure. See test/branch.test.js.
const os = require('os');
const path = require('path');
const { onlyLooks } = require('./worktrees');

const TREE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const MARK = '⑂';

const isUser = i => i && i.kind === 'user';
const tagged = i => i && (i.kind === 'changes' || i.kind === 'checkpoint') && typeof i.turnId === 'string';

/**
 * items: a tab's transcript (history.load). turnId: the message to branch at.
 * at: 'before' | 'after'.
 * -> { ok: false, error } |
 *    { ok: true, at, turnId, cut, fresh, conversation, anchor, sessionId,
 *      files: { root, tree, head } | null, approx, items, text, attachments }
 *
 * fresh: nothing before the cut can be resumed into (it was the first message,
 * or the first after a fresh start), so the branch starts a new conversation.
 * conversation: false when the turn before predates anchors: only the files
 * can be branched. files: null when no snapshot says where they stood (not a
 * git project, or an older transcript with no diffs at all). approx: the files
 * came from a neighbouring turn, so they may be a little off. items: the
 * transcript the new tab starts with.
 */
function plan(items, { turnId, at = 'before' } = {}) {
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  if (at !== 'before' && at !== 'after') return { ok: false, error: 'Branch before a message, or after a reply.' };
  const index = typeof turnId === 'string' ? list.findIndex(i => isUser(i) && i.turnId === turnId) : -1;
  if (index < 0) return { ok: false, error: "That message isn't in this conversation any more." };
  const next = list.findIndex((i, n) => n > index && isUser(i));
  const turnEnd = next < 0 ? list.length : next;

  let cut = index;
  if (at === 'after') {
    let last = -1;
    for (let n = index + 1; n < turnEnd; n++) if (list[n].kind === 'result') last = n;
    if (last < 0) return { ok: false, error: "That reply hasn't finished yet. Branch from it once it has." };
    cut = last + 1;
  }

  const kept = list.slice(0, cut);
  const keptTurns = new Set(kept.filter(i => isUser(i) && i.turnId).map(i => i.turnId));
  // A turn's diff and checkpoint are noted once it has been worked out, which
  // can be after the next message went in: they go by their tag.
  const tail = list.slice(cut).filter(i => tagged(i) && keptTurns.has(i.turnId));
  // ...and the ones after the cut that belong to later turns stay behind.
  // The original's notes of its other branches are the original's, not this one's.
  const own = kept.filter(i => (!tagged(i) || keptTurns.has(i.turnId)) && i.kind !== 'branched-off');

  // A fresh start ('fresh') began a new Claude conversation: nothing before it
  // can be resumed into.
  const lastFresh = kept.map(i => i.kind).lastIndexOf('fresh');
  const since = lastFresh >= 0 ? kept.slice(lastFresh + 1) : kept;
  const fresh = !since.some(isUser);
  const anchored = fresh ? null : [...since].reverse().find(i => i.kind === 'result' && typeof i.anchor === 'string') || null;

  const { files, approx } = filesAt(list, { turnId, at, index, turnEnd, cut });
  const msg = list[index];
  return {
    ok: true, at, turnId, cut, fresh,
    conversation: fresh || !!anchored,
    anchor: anchored?.anchor || null,
    sessionId: typeof anchored?.sessionId === 'string' ? anchored.sessionId : null,
    files, approx,
    items: [...own, ...tail],
    text: at === 'before' && typeof msg.text === 'string' ? msg.text : '',
    attachments: at === 'before' && Array.isArray(msg.attachments) ? msg.attachments.filter(a => typeof a === 'string') : [],
  };
}

const snap = (root, tree, head) => (typeof root === 'string' && TREE.test(tree || '')
  ? { root, tree, head: TREE.test(head || '') ? head : null }
  : null);

// Where the files stood at the cut. Best first: the turn's own checkpoint,
// then its own diff, then the nearest diff either side of it.
function filesAt(list, { turnId, at, index, turnEnd, cut }) {
  const ofTurn = i => (i.turnId ? i.turnId === turnId : false);
  const inTurn = (i, n) => ofTurn(i) || (!i.turnId && n > index && n < turnEnd);
  const points = list.filter(i => i.kind === 'checkpoint' && ofTurn(i));
  // A turn that moved into its own copy part way has two: the first began it,
  // the last ended it.
  if (points.length) {
    const p = at === 'before' ? points[0] : points[points.length - 1];
    const found = at === 'before' ? snap(p.root, p.start, p.head) : snap(p.root, p.end, p.endHead || p.head);
    if (found) return { files: found, approx: false };
  }
  const diffs = list.map((i, n) => [i, n]).filter(([i, n]) => i.kind === 'changes' && inTurn(i, n)).map(([i]) => i);
  if (diffs.length) {
    const d = at === 'before' ? diffs[0] : diffs[diffs.length - 1];
    const found = snap(d.root, at === 'before' ? d.before : d.after, null);
    if (found) return { files: found, approx: false };
  }
  // The turn changed nothing that was noted: the folder was as the last diff
  // before it left it, or as the next one after it found it.
  const all = list.map((i, n) => [i, n]).filter(([i]) => i.kind === 'changes');
  const earlier = all.filter(([, n]) => n < cut).pop()?.[0];
  if (earlier && snap(earlier.root, earlier.after)) return { files: snap(earlier.root, earlier.after, null), approx: true };
  const later = all.find(([, n]) => n >= cut)?.[0];
  if (later && snap(later.root, later.before)) return { files: snap(later.root, later.before, null), approx: true };
  return { files: null, approx: false };
}

/** The transcript with every diff and checkpoint pointing at the branch's own copy. Pure. */
function reroot(items, root) {
  if (typeof root !== 'string' || !root) return items;
  return items.map(i => (i && (i.kind === 'changes' || i.kind === 'checkpoint') ? { ...i, root } : i));
}

/** "Fix the login" -> "⑂ Fix the login" (never "⑂ ⑂ ..."). Pure. */
function branchTitle(title) {
  const t = String(title || '').replace(new RegExp(`^(\\s*${MARK}\\s*)+`), '').trim() || 'New task';
  return `${MARK} ${t}`;
}

/** A name for the branch's git branch: the original's own, if it had one. Pure. */
function branchSlug(source) {
  const m = /^shellby\/(.+)-[0-9a-f]{6}$/.exec(source?.worktree?.branch || '');
  if (m) return m[1];
  return String(source?.title || '').replace(new RegExp(`^(\\s*${MARK}\\s*)+`), '');
}

// ------------------------------------------------------------ the fence

const EDITS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SHELLS = new Set(['Bash', 'PowerShell']);

const norm = p => path.resolve(p).toLowerCase();
const inside = (child, parent) => {
  const c = norm(child);
  const p = norm(parent);
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
};

// Every way a shell might spell a Windows folder: C:\x\y, C:/x/y, /c/x/y,
// C:\\x\\y inside a script's string, and ~/x, $HOME\x, %USERPROFILE%\x when
// it's under your home folder. Lower case: commands are compared that way.
function spellings(dir, home = os.homedir()) {
  const back = path.resolve(dir).toLowerCase();
  const fwd = back.replace(/\\/g, '/');
  const m = /^([a-z]):\/(.*)$/.exec(fwd);
  const out = [back, fwd, back.replace(/\\/g, '\\\\'), ...(m ? [`/${m[1]}/${m[2]}`, `/mnt/${m[1]}/${m[2]}`, `/cygdrive/${m[1]}/${m[2]}`] : [])];
  const h = path.resolve(home || '/').toLowerCase();
  if (home && back.startsWith(h + path.sep)) {
    const rest = back.slice(h.length + 1);
    const restFwd = rest.replace(/\\/g, '/');
    for (const prefix of ['~', '$home', '${home}', '%userprofile%', '$env:userprofile']) out.push(`${prefix}\\${rest}`, `${prefix}/${restFwd}`);
  }
  return [...new Set(out)];
}

// Does this text name one of the fenced folders (as a whole name: C:\proj, not C:\project)?
function names(text, fence) {
  const t = String(text || '').toLowerCase();
  return fence.paths.some(p => spellings(p).some(s => {
    let at = t.indexOf(s);
    while (at >= 0) {
      const after = t[at + s.length];
      if (after === undefined || /[\\/\s"'`;|&),]/.test(after)) return true;
      at = t.indexOf(s, at + 1);
    }
    return false;
  }));
}

/**
 * The folders (and the git branch) a branch must keep out of: its original's,
 * minus any that hold its own copy. Pure.
 */
function makeFence(paths, home, refs = []) {
  const seen = new Set();
  const out = [];
  for (const p of paths || []) {
    if (typeof p !== 'string' || !path.isAbsolute(p)) continue;
    if (home && (inside(home, p) || inside(p, home))) continue; // never fence itself in
    const key = norm(p);
    if (!seen.has(key)) { seen.add(key); out.push(path.resolve(p)); }
  }
  const branches = [...new Set((refs || []).filter(r => typeof r === 'string' && /^shellby\/[a-z0-9-]+$/.test(r)))];
  return out.length && home ? { paths: out, home: path.resolve(home), ...(branches.length ? { refs: branches } : {}) } : null;
}

const COPIES = /^(cp|copy|xcopy|robocopy|rsync|copy-item|cpi)$/;
// Commands that change the folder the rest of a chain runs in.
const MOVES = /^(cd|chdir|pushd|set-location|sl|push-location)$/;
// git commands that move, rename or delete a branch.
const REF_CHANGES = /\bgit(\.exe)?\s+(-\S+\s+)*(branch|update-ref|push|symbolic-ref|replace)\b/;
const SWITCH = /^(-|\/[a-z?]{1,4}(:\S*)?$)/i;
const unquote = w => w.replace(/^["']|["']$/g, '');

// A copy whose destination isn't the original: bringing something across from
// it (a .env, node_modules) into the branch's own copy.
function copiesIn(segment, fence) {
  const words = segment.trim().split(/\s+/).filter(Boolean).map(unquote);
  const name = path.basename(words[0] || '').toLowerCase().replace(/\.exe$/, '');
  if (!COPIES.test(name)) return false;
  const named = words.findIndex(w => /^-dest(ination)?$/i.test(w));
  const dest = named > 0 ? words[named + 1]
    : name === 'robocopy' ? words[2]
      : [...words.slice(1)].reverse().find(w => !SWITCH.test(w));
  return !!dest && !names(dest, fence);
}

/**
 * Would this tool call change the original's files? (PreToolUse hook input.)
 * -> the reason to give Claude, or null to let it run. Pure.
 *
 * A guard against Claude's own confusion (its memory is full of the original's
 * paths), not a sandbox: a script can still reach anywhere. So it stays out of
 * the way of what's fair: commands that only look may read the original, a
 * copy may bring files across from it, and edits in its own copy always go.
 */
function fenceDenies(fence, toolName, input) {
  if (!fence?.paths?.length || !fence.home) return null;
  const why = `That folder belongs to the conversation this one was branched from, and a branch never changes it. `
    + `This branch works in its own copy at ${fence.home}: make the change under that path instead `
    + '(copying files from the original into this copy is fine).';
  if (EDITS.has(toolName)) {
    const file = input?.file_path || input?.notebook_path;
    // A relative path is relative to the branch's own folder.
    if (typeof file !== 'string' || !path.isAbsolute(file)) return null;
    return fence.paths.some(p => inside(file, p)) && !inside(file, fence.home) ? why : null;
  }
  if (SHELLS.has(toolName)) {
    const cmd = String(input?.command || '');
    if (!cmd.trim() || onlyLooks(cmd)) return null;
    const refs = fence.refs || [];
    // Where the chain is working: after `cd <the original>`, the rest of it
    // runs there, whether or not it names the folder again.
    let there = false;
    for (const segment of cmd.split(/&&|\|\||[;|\n]/)) {
      if (!segment.trim()) continue;
      const first = segment.trim().split(/\s+/)[0].toLowerCase();
      if (MOVES.test(first)) { there = names(segment, fence); continue; }
      if (onlyLooks(segment)) continue;
      const lower = segment.toLowerCase();
      if (there || (names(segment, fence) && !copiesIn(segment, fence))) return why;
      // Moving or deleting the original's branch. Merging it in is fine.
      if (refs.some(r => lower.includes(r)) && REF_CHANGES.test(lower)) {
        return `${refs.join(', ')} is the branch of the conversation this one was branched from, and a branch never changes it. This one works on its own branch.`;
      }
    }
  }
  return null;
}

// ------------------------------------------------------------ families

/**
 * Every conversation in the same family as `id`: the one it all started from
 * and every branch of it (and of its branches). entries: History's index.
 * -> [{ ...entry, depth }], the original first. Pure.
 */
function family(entries, id) {
  const list = Array.isArray(entries) ? entries.filter(e => e && typeof e.id === 'string') : [];
  const byId = new Map(list.map(e => [e.id, e]));
  const parentOf = e => (e?.branchOf && byId.has(e.branchOf.id) ? byId.get(e.branchOf.id) : null);
  // A loop (only a hand-edited index makes one) has no top: every member of
  // it agrees on the same one, so the family still holds together.
  const origin = e => {
    const seen = new Map();
    while (parentOf(e)) {
      if (seen.has(e.id)) return [...seen.values()].slice([...seen.keys()].indexOf(e.id)).sort((a, b) => (a.id < b.id ? -1 : 1))[0];
      seen.set(e.id, e);
      e = parentOf(e);
    }
    return e;
  };
  const me = byId.get(id);
  if (!me) return [];
  const top = origin(me);
  const depth = e => {
    let d = 0;
    const seen = new Set();
    while (parentOf(e) && !seen.has(e.id)) { seen.add(e.id); e = parentOf(e); d++; }
    return d;
  };
  return list.filter(e => origin(e).id === top.id)
    .map(e => ({ ...e, depth: depth(e) }))
    .sort((a, b) => a.depth - b.depth || (a.createdAt || 0) - (b.createdAt || 0));
}

module.exports = { plan, reroot, branchTitle, branchSlug, makeFence, fenceDenies, family, spellings, MARK };
