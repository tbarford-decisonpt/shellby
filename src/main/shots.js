// Before/after pictures of your dev server, either side of a turn.
//
// When a conversation works in a folder Shellby is running a dev server from,
// the page is photographed as the turn starts, and again once it ends if what
// changed looks like UI. The pair sits on the turn's diff, so "made the header
// sticky" can be seen, not just read.
//
// The page is loaded in a window nobody sees: sandboxed, its own in-memory
// partition, no permissions, muted, unable to navigate anywhere but that
// localhost origin or open anything, and destroyed straight after. Pictures
// live under userData, named only by ids Shellby made, and are pruned by count
// and age. The pickers and pruning are pure; capture() takes Electron as a
// dependency and never throws.
const fs = require('fs');
const path = require('path');

const TAB_ID_RE = /^[\w-]{1,64}$/;
const SHOT_ID_RE = /^[0-9a-f-]{8,64}-(before|after)$/;
const LOCAL_URL_RE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d{2,5}(\/[^\s]*)?$/i;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const UI_EXT_RE = /\.(css|scss|sass|less|styl|html?|jsx|tsx|vue|svelte|astro|mdx)$/i;
const UI_DIR_RE = /(^|\/)(components?|pages|app|routes|views|layouts|styles|public|static|ui)\//i;
const CODE_EXT_RE = /\.(js|mjs|cjs|ts|mts)$/i;
const MAX_PER_TAB = 50;
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const CAPTURE_TIMEOUT_MS = 10000;
const SETTLE_MS = 1500;
const RENDER_WAIT_MS = 600;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const WIDTH = 1280;
const HEIGHT = 800;
const PARTITION = 'turn-shots';

/** Does a changed file look like it changes what the page looks like? Pure. */
function isUiFile(file) {
  const p = String(file || '').replace(/\\/g, '/');
  if (!p || /(^|\/)(node_modules|\.git|dist|build|coverage)\//.test(p)) return false;
  if (/(^|\/)(test|tests|__tests__)\/|\.(test|spec)\.[a-z]+$/i.test(p)) return false;
  if (UI_EXT_RE.test(p)) return true;
  return CODE_EXT_RE.test(p) && UI_DIR_RE.test(p);
}

const anyUi = files => (files || []).some(f => isUiFile(f?.path ?? f));

/** A dev server's url, only if it's on this PC: the window never goes anywhere else. Pure. */
function localOrigin(url) {
  const text = String(url || '');
  if (!LOCAL_URL_RE.test(text) || /[\s\\@]/.test(text)) return null;
  let u;
  try { u = new URL(text); } catch { return null; }
  // What the URL parser makes of it is what's loaded, so that's what's checked.
  if (!['http:', 'https:'].includes(u.protocol) || !LOCAL_HOSTS.has(u.hostname) || u.username || u.password) return null;
  const port = Number(u.port);
  return port > 0 && port < 65536 ? u.origin : null;
}

const key = p => path.resolve(p).toLowerCase();

/**
 * The dev server a tab's folder is served by: one that's up, on localhost, run
 * from that folder or a folder it's inside. The deepest match wins. Pure.
 */
function pickServer(servers, cwd) {
  if (typeof cwd !== 'string' || !cwd) return null;
  const here = key(cwd) + path.sep;
  const fits = (servers || []).filter(s => s && s.kind !== 'install' && s.status === 'up' && typeof s.root === 'string'
    && localOrigin(s.url) && here.startsWith(key(s.root) + path.sep));
  fits.sort((a, b) => b.root.length - a.root.length);
  return fits[0] || null;
}

const shotId = (turnId, which) => `${turnId}-${which}`;
const validTab = id => typeof id === 'string' && TAB_ID_RE.test(id);
const validShot = id => typeof id === 'string' && SHOT_ID_RE.test(id);

/** A picture's file, only for ids that could only have come from here. Pure. */
function fileFor(dir, tabId, id) {
  if (!validTab(tabId) || !validShot(id)) return null;
  return path.join(dir, tabId, `${id}.png`);
}

/**
 * Which pictures to delete: anything older than maxAgeMs, then the oldest past
 * maxPerTab. entries: [{ name, mtimeMs }] in one tab's folder. Pure.
 */
function toPrune(entries, { now = Date.now(), maxPerTab = MAX_PER_TAB, maxAgeMs = MAX_AGE_MS } = {}) {
  const pngs = (entries || []).filter(e => e && typeof e.name === 'string' && e.name.endsWith('.png'));
  const old = pngs.filter(e => now - e.mtimeMs > maxAgeMs);
  const kept = pngs.filter(e => !old.includes(e)).sort((a, b) => b.mtimeMs - a.mtimeMs);
  return [...old, ...kept.slice(maxPerTab)].map(e => e.name);
}

/** Tidy one tab's pictures. Never throws. */
function prune(dir, tabId, opts) {
  if (!validTab(tabId)) return;
  const folder = path.join(dir, tabId);
  try {
    const entries = fs.readdirSync(folder).map(name => ({ name, mtimeMs: fs.statSync(path.join(folder, name)).mtimeMs }));
    for (const name of toPrune(entries, opts)) fs.rmSync(path.join(folder, name), { force: true });
  } catch { /* nothing there yet */ }
}

/** Save a picture under its id. -> true | false. Never throws. */
function save(dir, tabId, id, png) {
  const file = fileFor(dir, tabId, id);
  if (!file || !Buffer.isBuffer(png) || !png.length || png.length > MAX_IMAGE_BYTES) return false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, png);
    return true;
  } catch { return false; }
}

/** Delete one picture. Never throws. */
function remove(dir, tabId, id) {
  const file = fileFor(dir, tabId, id);
  if (file) try { fs.rmSync(file, { force: true }); } catch { /* gone */ }
}

/** A saved picture as a data URL, or null. Never throws. */
function read(dir, tabId, id) {
  const file = fileFor(dir, tabId, id);
  if (!file) return null;
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_IMAGE_BYTES) return null;
    return `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`;
  } catch { return null; }
}

const wait = ms => new Promise(r => setTimeout(r, ms));

/**
 * Photograph a localhost page. -> PNG Buffer | null. Never throws, never takes
 * longer than timeoutMs: an unpainted window's capturePage can hang for ever.
 * electron: { BrowserWindow, session }.
 */
async function capture(url, { electron, timeoutMs = CAPTURE_TIMEOUT_MS } = {}) {
  const origin = localOrigin(url);
  if (!origin || !electron?.BrowserWindow) return null;
  let win = null;
  let timer = null;
  const work = (async () => {
    const ses = electron.session.fromPartition(PARTITION, { cache: false });
    lockSession(ses, origin);
    win = new electron.BrowserWindow({
      show: false, width: WIDTH, height: HEIGHT, paintWhenInitiallyHidden: true,
      webPreferences: {
        offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false,
        spellcheck: false, backgroundThrottling: false, session: ses, webSecurity: true,
      },
    });
    const wc = win.webContents;
    wc.setAudioMuted(true);
    const sameOrigin = target => { try { return new URL(target).origin === origin; } catch { return false; } };
    for (const ev of ['will-navigate', 'will-redirect']) wc.on(ev, (e, target) => { if (!sameOrigin(target ?? e?.url)) e.preventDefault(); });
    wc.on('will-attach-webview', e => e.preventDefault());
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    await wc.loadURL(url);
    await wait(RENDER_WAIT_MS);
    if (win.isDestroyed()) return null;
    const image = await wc.capturePage();
    if (!image || image.isEmpty()) return null;
    const png = image.toPNG();
    return png.length && png.length <= MAX_IMAGE_BYTES ? png : null;
  })().catch(() => null);
  const late = new Promise(r => { timer = setTimeout(() => r(null), timeoutMs); });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
    try { if (win && !win.isDestroyed()) win.destroy(); } catch { /* gone */ }
  }
}

// One capture at a time (wiring/shots.js queues them), so the partition's
// rules read the origin of the one in hand.
let allowedOrigin = null;
let lockedSession = null;
// The partition asks for nothing, downloads nothing, and fetches only from the
// server's own origin (plus https, data and blob, for a page's fonts and CDN
// scripts): never a file, another port on this PC, or the local network.
function lockSession(ses, origin) {
  allowedOrigin = origin;
  if (!ses || lockedSession === ses) return;
  lockedSession = ses;
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);
  ses.on('will-download', e => e.preventDefault());
  ses.webRequest.onBeforeRequest((details, cb) => cb({ cancel: !requestAllowed(details.url, allowedOrigin) }));
}

/** May the hidden page fetch this? Pure. */
function requestAllowed(url, origin) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.origin === origin) return true;
  if (u.protocol === 'data:' || u.protocol === 'blob:') return true;
  if (u.protocol === 'devtools:') return false;
  if (u.protocol !== 'https:') return false;
  return !/^(localhost|0\.|127\.|10\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[)/i.test(u.hostname) && !/\.local$/i.test(u.hostname);
}

module.exports = {
  MAX_PER_TAB, MAX_AGE_MS, SETTLE_MS, CAPTURE_TIMEOUT_MS, PARTITION,
  isUiFile, anyUi, localOrigin, pickServer, shotId, validTab, validShot, fileFor,
  toPrune, prune, save, remove, read, capture, requestAllowed,
};
