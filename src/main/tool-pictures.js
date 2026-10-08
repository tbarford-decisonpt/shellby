// Pictures a tool handed back to Claude: a screenshot it read, a browser
// tool's capture. Claude Code sends them as base64 image blocks in the tool's
// result; stream.js picks them out and they're saved here, so the chat can show
// them under the step that made them without carrying megabytes of base64 in
// its history.
//
// Pictures live under userData, one folder per conversation, named only by ids
// Shellby made (the tool call's id and a number), and are pruned by count and
// age. Nothing here throws.
const fs = require('fs');
const path = require('path');

const TAB_ID_RE = /^[\w-]{1,64}$/;
const TOOL_ID_RE = /^[\w-]{1,80}$/;
const PICTURE_ID_RE = /^[\w-]{1,80}-\d{1,2}\.(png|jpg|gif|webp)$/;
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const TYPE = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
const MAX_PER_RESULT = 4;
const MAX_PER_TAB = 100;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const validTab = id => typeof id === 'string' && TAB_ID_RE.test(id);
const validPicture = id => typeof id === 'string' && PICTURE_ID_RE.test(id);

function fileFor(dir, tabId, id) {
  if (!validTab(tabId) || !validPicture(id)) return null;
  return path.join(dir, tabId, id);
}

/**
 * Save a result's pictures ([{ mediaType, data }], data base64). -> their ids,
 * in order, leaving out any that couldn't be saved.
 */
function save(dir, tabId, toolId, images) {
  if (!validTab(tabId) || !TOOL_ID_RE.test(String(toolId || '')) || !Array.isArray(images)) return [];
  const ids = [];
  images.slice(0, MAX_PER_RESULT).forEach((img, i) => {
    const ext = EXT[img?.mediaType];
    if (!ext || typeof img.data !== 'string') return;
    const bytes = Buffer.from(img.data, 'base64');
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) return;
    const id = `${toolId}-${i}.${ext}`;
    try {
      fs.mkdirSync(path.join(dir, tabId), { recursive: true });
      fs.writeFileSync(path.join(dir, tabId, id), bytes);
      ids.push(id);
    } catch { /* full disk, locked folder: no picture */ }
  });
  return ids;
}

/** The names to delete: past MAX_AGE_MS, then the oldest past MAX_PER_TAB. Pure. */
function toPrune(entries, { now = Date.now(), maxPerTab = MAX_PER_TAB, maxAgeMs = MAX_AGE_MS } = {}) {
  const old = entries.filter(e => now - e.mtimeMs > maxAgeMs).map(e => e.name);
  const kept = entries.filter(e => !old.includes(e.name)).sort((a, b) => b.mtimeMs - a.mtimeMs);
  return [...old, ...kept.slice(maxPerTab).map(e => e.name)];
}

function prune(dir, tabId, opts) {
  if (!validTab(tabId)) return;
  const folder = path.join(dir, tabId);
  try {
    const entries = fs.readdirSync(folder).map(name => ({ name, mtimeMs: fs.statSync(path.join(folder, name)).mtimeMs }));
    for (const name of toPrune(entries, opts)) fs.rmSync(path.join(folder, name), { force: true });
  } catch { /* nothing there yet */ }
}

/** A saved picture as a data URL, or null once it's been tidied away. */
function read(dir, tabId, id) {
  const file = fileFor(dir, tabId, id);
  if (!file) return null;
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_IMAGE_BYTES) return null;
    return `data:${TYPE[path.extname(id).slice(1)]};base64,${fs.readFileSync(file).toString('base64')}`;
  } catch { return null; }
}

module.exports = { MAX_PER_RESULT, MAX_PER_TAB, MAX_AGE_MS, validTab, validPicture, save, toPrune, prune, read };
