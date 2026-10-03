const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const attach = require('../src/main/attachments');
const { ClaudeSession } = require('../src/main/session');

// A stand-in for Electron's nativeImage. "Decoding" reads a tiny JSON spec, so
// a test can say how big a picture is and how many bytes its PNG would be.
function fakeImage(w, h, pngBytes) {
  return {
    getSize: () => ({ width: w, height: h }),
    isEmpty: () => !w,
    resize: ({ width, height }) => fakeImage(width, height, Math.round(pngBytes * (width * height) / (w * h))),
    toPNG: () => Buffer.alloc(pngBytes, 1),
    toJPEG: () => Buffer.alloc(Math.ceil(pngBytes / 5), 2),
    toDataURL: () => `data:image/png;base64,${w}x${h}`,
  };
}
const decode = buf => {
  try { const s = JSON.parse(String(buf)); return fakeImage(s.w, s.h, s.png); } catch { return fakeImage(0, 0, 0); }
};
const nativeImage = { createFromBuffer: decode, createFromPath: p => decode(fs.readFileSync(p)) };
const spec = (w, h, png) => Buffer.from(JSON.stringify({ w, h, png }));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-attach-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('pictures are told apart from other files by extension', () => {
  assert.equal(attach.imageType('C:\\shots\\Bug.PNG'), 'image/png');
  assert.equal(attach.imageType('a.jpeg'), 'image/jpeg');
  assert.equal(attach.imageType('a.webp'), 'image/webp');
  assert.equal(attach.imageType('notes.txt'), null);
  assert.equal(attach.imageType('png'), null);
});

test('without pictures the prompt stays plain text, files listed by path', () => {
  assert.equal(attach.composeContent('hi', [], () => null), 'hi');
  const p = attach.composeContent('', ['C:\\a.txt'], () => null);
  assert.equal(typeof p, 'string');
  assert.match(p, /^Take a look at the attached files\./);
  assert.match(p, /Attached files \(given to Shellby\):\n- C:\\a\.txt$/);
});

test('a screenshot goes inline as an image block, before the text', () => {
  const load = f => (f.endsWith('.png') ? { type: 'image/png', data: 'QUJD' } : null);
  const c = attach.composeContent('The button is cut off', ['C:\\shot.png', 'C:\\log.txt'], load);
  assert.ok(Array.isArray(c));
  assert.deepEqual(c[0], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } });
  assert.equal(c[1].type, 'text');
  assert.match(c[1].text, /^The button is cut off/);
  // Still listed, so Claude can name or open it; marked as already shown.
  assert.match(c[1].text, /- C:\\shot\.png \(picture, shown above\)\n- C:\\log\.txt$/);
});

test('a screenshot on its own gets a prompt of its own', () => {
  const load = () => ({ type: 'image/png', data: 'x' });
  assert.match(attach.composeContent('', ['a.png'], load).at(-1).text, /^Take a look at the attached screenshot\./);
  assert.match(attach.composeContent('', ['a.png', 'b.png'], load).at(-1).text, /^Take a look at the attached screenshots\./);
});

test('a picture that cannot be read is listed by path instead', () => {
  const c = attach.composeContent('see', ['C:\\gone.png'], () => null);
  assert.equal(typeof c, 'string');
  assert.doesNotMatch(c, /shown above/);
});

test('only so many pictures go inline; the rest are listed', () => {
  const files = Array.from({ length: attach.MAX_INLINE_IMAGES + 3 }, (_, i) => `s${i}.png`);
  const c = attach.composeContent('lots', files, () => ({ type: 'image/png', data: 'x' }));
  assert.equal(c.filter(b => b.type === 'image').length, attach.MAX_INLINE_IMAGES);
  assert.equal((c.at(-1).text.match(/shown above/g) || []).length, attach.MAX_INLINE_IMAGES);
});

test('a small picture is sent as it is, untouched', () => {
  const raw = spec(800, 600, 1000);
  const r = attach.loadForClaude('a.png', { nativeImage, readFile: () => raw, statSize: () => raw.length });
  assert.deepEqual(r, { type: 'image/png', data: raw.toString('base64') });
});

test('a 4K snip is shrunk to the long-edge limit', () => {
  let resized;
  const img = fakeImage(3840, 2160, 2000);
  const spy = { ...img, resize: o => { resized = o; return img.resize(o); } };
  const r = attach.loadForClaude('a.png', { nativeImage: { createFromBuffer: () => spy }, readFile: () => Buffer.alloc(10), statSize: () => 10 });
  assert.equal(resized.width, attach.MAX_EDGE);
  assert.equal(resized.height, Math.round(2160 * attach.MAX_EDGE / 3840));
  assert.equal(r.type, 'image/png');
});

test('a picture too heavy for PNG goes as JPEG, and one too heavy for both is listed', () => {
  const big = attach.MAX_INLINE_BYTES + 1;
  // The file itself is heavy too (JSON allows the trailing padding), so it can't go as it is.
  const heavy = (w, h, png) => Buffer.concat([spec(w, h, png), Buffer.alloc(big, ' ')]);
  const asJpeg = attach.loadForClaude('a.png', { nativeImage, readFile: () => heavy(1000, 1000, big), statSize: () => 10 });
  assert.equal(asJpeg.type, 'image/jpeg');
  const none = attach.loadForClaude('a.png', { nativeImage, readFile: () => heavy(1000, 1000, big * 6), statSize: () => 10 });
  assert.equal(none, null);
});

test('missing, oversized or undecodable pictures do not go inline', () => {
  const opts = { nativeImage, statSize: () => 10 };
  assert.equal(attach.loadForClaude('a.png', { ...opts, readFile: () => { throw new Error('ENOENT'); } }), null);
  assert.equal(attach.loadForClaude('a.png', { ...opts, statSize: () => attach.MAX_INPUT_BYTES + 1, readFile: () => spec(1, 1, 1) }), null);
  assert.equal(attach.loadForClaude('a.png', { ...opts, readFile: () => Buffer.from('not a picture') }), null);
  assert.equal(attach.loadForClaude('a.txt', { ...opts, readFile: () => spec(1, 1, 1) }), null);
});

test('GIF and WebP go through as they are when they fit', () => {
  const raw = Buffer.from('GIF89a...');
  assert.deepEqual(attach.loadForClaude('a.gif', { nativeImage, readFile: () => raw, statSize: () => raw.length }),
    { type: 'image/gif', data: raw.toString('base64') });
});

test('a pasted snip is saved as a PNG in the screenshots folder', () => {
  const dir = path.join(tmp, 'shots');
  const r = attach.saveImage(new Uint8Array(spec(5000, 1000, 50)), dir, { nativeImage, now: new Date('2026-10-02T09:08:07Z') });
  assert.match(path.basename(r.path), /^screenshot-20261002-090807-[0-9a-f]{4}\.png$/);
  assert.equal(path.dirname(r.path), dir);
  assert.ok(fs.statSync(r.path).size > 0);
});

test('saving refuses empty, oversized and non-picture bytes', () => {
  const dir = path.join(tmp, 'refused');
  assert.match(attach.saveImage(new Uint8Array(0), dir, { nativeImage }).error, /empty/);
  assert.match(attach.saveImage({ length: attach.MAX_INPUT_BYTES + 1 }, dir, { nativeImage }).error, /too big/);
  assert.match(attach.saveImage(new Uint8Array(Buffer.from('nope')), dir, { nativeImage }).error, /PNG and JPEG/);
  assert.match(attach.saveNative(fakeImage(0, 0, 0), dir).error, /no picture/);
  assert.equal(fs.existsSync(dir), false);
});

test('a chip thumbnail is a small data: URL, and nothing for non-pictures', () => {
  const p = path.join(tmp, 'thumb.png');
  fs.writeFileSync(p, spec(1920, 1080, 10));
  assert.equal(attach.thumbnail(p, { nativeImage }), 'data:image/png;base64,96x54');
  assert.equal(attach.thumbnail(path.join(tmp, 'x.txt'), { nativeImage }), null);
  assert.equal(attach.thumbnail(path.join(tmp, 'missing.png'), { nativeImage }), null);
});

test('old saved screenshots are pruned; recent ones and other files stay', () => {
  const dir = path.join(tmp, 'prune');
  fs.mkdirSync(dir);
  const old = path.join(dir, 'screenshot-old.png');
  const fresh = path.join(dir, 'screenshot-new.png');
  const other = path.join(dir, 'notes.png');
  for (const f of [old, fresh, other]) fs.writeFileSync(f, 'x');
  const longAgo = new Date(Date.now() - 40 * 86400000);
  fs.utimesSync(old, longAgo, longAgo);
  fs.utimesSync(other, longAgo, longAgo);
  assert.equal(attach.prune(dir), 1);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['notes.png', 'screenshot-new.png']);
  assert.equal(attach.prune(path.join(tmp, 'never-made')), 0);
});

test('Claude Code receives the picture blocks in the stream-json message', async () => {
  const s = new ClaudeSession({ exe: process.execPath, argsPrefix: [path.join(__dirname, 'fixtures', 'fake-claude.js')], cwd: os.tmpdir(), mode: 'ask' });
  try {
    const reply = new Promise(resolve => s.on('item', i => { if (i.kind === 'text') resolve(i.text); }));
    s.send(attach.composeContent('look at this', ['a.png'], () => ({ type: 'image/png', data: 'QUJD' })));
    assert.equal(await reply, 'saw 1: image/png');
  } finally {
    s.close();
  }
});

test('network shares and device paths are never opened for a thumbnail or for Claude', () => {
  let touched = 0;
  const nativeImage = { createFromPath: () => { touched++; return { isEmpty: () => true }; }, createFromBuffer: () => { touched++; return { isEmpty: () => true }; } };
  const statSize = () => { touched++; return 10; };
  const readFile = () => { touched++; return Buffer.alloc(10); };
  for (const p of ['\\\\attacker\\share\\x.png', '//attacker/share/x.png', '\\\\?\\C:\\x.png', '\\\\.\\pipe\\x.png']) {
    assert.equal(attach.isLocalPath(p), false, p);
    assert.equal(attach.thumbnail(p, { nativeImage, statSize }), null, p);
    assert.equal(attach.loadForClaude(p, { nativeImage, readFile, statSize }), null, p);
  }
  assert.equal(touched, 0, 'not even a stat: that alone reaches the server');
  assert.equal(attach.isLocalPath('C:\\Users\\me\\x.png'), true);
});
