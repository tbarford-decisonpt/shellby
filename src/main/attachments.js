// Screenshots (and other pictures) for a task. A Win+Shift+S snip, an image
// pasted into the composer, or one dropped on the crab has no file behind it,
// so it's saved under the data folder first: the chip and the transcript need a
// path to point at, and Claude can mention or open it by name later.
//
// Pictures then go to Claude as image blocks in the message itself, not as a
// path it has to Read: it sees the screenshot on the first turn, and a picture
// outside the project folder doesn't stop the task for a permission prompt.
// Everything else that's attached is still listed by path.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
const MAX_EDGE = 2000;                    // a 4K snip is shrunk to this; Claude scales big ones down anyway
const MAX_INLINE_BYTES = 3.75 * 1024 * 1024; // 5 MB once base64'd: the API's per-image ceiling
const MAX_INLINE_IMAGES = 8;              // more than this and the rest are listed by path
const MAX_INPUT_BYTES = 25 * 1024 * 1024; // what we'll read or accept at all
const THUMB_EDGE = 96;
const KEEP_DAYS = 30;

const imageType = file => IMAGE_TYPES[path.extname(String(file)).toLowerCase()] || null;

// Shrink to MAX_EDGE on the long side, never up.
function fit(img, maxEdge = MAX_EDGE) {
  const { width, height } = img.getSize();
  const long = Math.max(width, height);
  if (long <= maxEdge) return img;
  const k = maxEdge / long;
  return img.resize({ width: Math.round(width * k), height: Math.round(height * k), quality: 'best' });
}

// PNG keeps UI text crisp; a photo too big for that goes as JPEG instead.
function encode(img) {
  const png = img.toPNG();
  if (png.length <= MAX_INLINE_BYTES) return { type: 'image/png', data: png };
  const jpg = img.toJPEG(85);
  return jpg.length <= MAX_INLINE_BYTES ? { type: 'image/jpeg', data: jpg } : null;
}

/**
 * Picture bytes from the renderer (a paste, or a drop with no file behind it)
 * saved as a PNG in `dir`. Returns the path, or { error } for anything that
 * isn't a picture Electron can read.
 */
function saveImage(bytes, dir, { nativeImage, now = new Date() }) {
  if (!bytes || typeof bytes.length !== 'number' || !bytes.length) return { error: 'That clipboard item is empty.' };
  if (bytes.length > MAX_INPUT_BYTES) return { error: 'That picture is too big (25 MB at most).' };
  const img = nativeImage.createFromBuffer(Buffer.from(bytes));
  if (img.isEmpty()) return { error: 'Shellby can read PNG and JPEG pictures, not that one.' };
  return saveNative(img, dir, now);
}

/** A nativeImage (say, from the clipboard) saved as a PNG in `dir`. */
function saveNative(img, dir, now = new Date()) {
  if (!img || img.isEmpty()) return { error: 'There is no picture on the clipboard.' };
  const stamp = now.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
  const file = path.join(dir, `screenshot-${stamp}-${crypto.randomBytes(2).toString('hex')}.png`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, fit(img).toPNG());
  return { path: file };
}

/**
 * One attached picture as Claude should get it: { type, data (base64) }, or
 * null when it can't go inline (missing, unreadable, too big), in which case it
 * is still listed by path like any other file.
 */
function loadForClaude(file, { nativeImage, readFile = fs.readFileSync, statSize = f => fs.statSync(f).size }) {
  const type = imageType(file);
  if (!type) return null;
  try {
    if (statSize(file) > MAX_INPUT_BYTES) return null;
    const raw = readFile(file);
    // GIF and WebP aren't decoded here: they go as they are, if they fit.
    if (type === 'image/gif' || type === 'image/webp') return raw.length <= MAX_INLINE_BYTES ? { type, data: raw.toString('base64') } : null;
    const img = nativeImage.createFromBuffer(raw);
    if (img.isEmpty()) return null;
    const fitted = fit(img);
    // Untouched and small enough: send the original bytes rather than re-encoding.
    const out = fitted === img && raw.length <= MAX_INLINE_BYTES ? { type, data: raw } : encode(fitted);
    return out && { type: out.type, data: out.data.toString('base64') };
  } catch {
    return null;
  }
}

/**
 * The message content for a task: the plain prompt when nothing could go inline,
 * otherwise the pictures first (what the API recommends) and then the text.
 * `load(file)` is loadForClaude bound to Electron (injected for tests).
 */
function composeContent(text, files, load) {
  const shown = new Set();
  const blocks = [];
  for (const f of files) {
    if (blocks.length >= MAX_INLINE_IMAGES || !imageType(f)) continue;
    const img = load(f);
    if (!img) continue;
    shown.add(f);
    blocks.push({ type: 'image', source: { type: 'base64', media_type: img.type, data: img.data } });
  }
  const allPictures = files.length > 0 && shown.size === files.length;
  let prompt = text || (allPictures ? `Take a look at the attached ${files.length === 1 ? 'screenshot' : 'screenshots'}.` : 'Take a look at the attached files.');
  if (files.length) {
    const list = files.map(f => `- ${f}${shown.has(f) ? ' (picture, shown above)' : ''}`).join('\n');
    prompt += `\n\nAttached files (given to Shellby):\n${list}`;
  }
  return blocks.length ? [...blocks, { type: 'text', text: prompt }] : prompt;
}

/** A small data: URL for a chip (the panel only loads images from itself or data:). */
function thumbnail(file, { nativeImage, statSize = f => fs.statSync(f).size }) {
  if (!imageType(file)) return null;
  try {
    if (statSize(file) > MAX_INPUT_BYTES) return null;
    const img = nativeImage.createFromPath(file);
    return img.isEmpty() ? null : fit(img, THUMB_EDGE).toDataURL();
  } catch {
    return null;
  }
}

/** Saved screenshots older than KEEP_DAYS go: the chips in old chats just lose their picture. */
function prune(dir, now = Date.now()) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return 0; }
  let gone = 0;
  for (const name of names) {
    if (!/^screenshot-.*\.png$/.test(name)) continue;
    const p = path.join(dir, name);
    try {
      if (now - fs.statSync(p).mtimeMs > KEEP_DAYS * 86400000) { fs.unlinkSync(p); gone++; }
    } catch { /* already gone, or in use: next time */ }
  }
  return gone;
}

module.exports = {
  imageType, fit, saveImage, saveNative, loadForClaude, composeContent, thumbnail, prune,
  MAX_EDGE, MAX_INLINE_BYTES, MAX_INLINE_IMAGES, MAX_INPUT_BYTES,
};
