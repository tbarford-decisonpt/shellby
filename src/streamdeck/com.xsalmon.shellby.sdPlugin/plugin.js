// Shellby's Stream Deck plugin.
//
// Stream Deck starts this with Node 24 and four arguments (-port, -pluginUUID,
// -registerEvent, -info), and it talks to Stream Deck over that websocket. It
// talks to Shellby over 127.0.0.1 (src/main/deck.js): a server-sent event stream
// of what every key should show, and a POST when one is pressed. Where Shellby
// is and the token that lets it in are in shellby.json beside this file, which
// Shellby writes when it packs the plugin (src/main/deck-pack.js).
//
// No packages: Node 24 has WebSocket and fetch, and the keys are drawn as SVG.
// Required by Shellby's tests and by the packer (for the icons), it only exports.
'use strict';
const fs = require('fs');
const path = require('path');

const UUID = 'com.xsalmon.shellby';
const ACTIONS = ['allow', 'deny', 'stop', 'home', 'review'];
const API = '/deck/v1';
const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 15000;

// ------------------------------------------------------------------ drawing

// Pixel art, like him: '#' is a pixel.
const GLYPHS = {
  allow: [
    '..........##',
    '.........###',
    '........###.',
    '##.....###..',
    '###...###...',
    '.###.###....',
    '..#####.....',
    '...###......',
  ],
  deny: [
    '##.....##',
    '###...###',
    '.###.###.',
    '..#####..',
    '...###...',
    '..#####..',
    '.###.###.',
    '###...###',
    '##.....##',
  ],
  stop: [
    '.#######.',
    '#########',
    '#########',
    '#########',
    '#########',
    '#########',
    '#########',
    '.#######.',
  ],
  home: [
    '.....#.....',
    '....###....',
    '...#####...',
    '..#######..',
    '.#########.',
    '###########',
    '.##.....##.',
    '.##.###.##.',
    '.##.###.##.',
    '.##.###.##.',
  ],
  review: [
    '...#####...',
    '.##.....##.',
    '#...###...#',
    '#..#####..#',
    '#...###...#',
    '.##.....##.',
    '...#####...',
  ],
  crab: [
    '#.........#',
    '##.......##',
    '.#.#####.#.',
    '..#######..',
    '.#########.',
    '..#######..',
    '.#.#...#.#.',
    '#..#...#..#',
  ],
};

// Shellby's palette (src/renderer/shared/tokens.css).
const INK = '#0c1719';
const DIM = '#2f4a52';
const SAND = '#f3e6cc';
const SAND_DIM = '#b3a892';
const COLORS = { allow: '#7fd6c2', deny: '#ff7a5c', stop: '#ff5a4a', home: '#ffc15e', review: SAND, look: '#ffc15e' };
const NAMES = { allow: 'Allow', deny: 'Deny', stop: 'Stop', home: 'Home', review: 'Review' };

const SIZE = 144;
const PX = 6;

const escapeXml = s => String(s).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));

function pixels(rows, color, cx, cy) {
  const w = rows[0].length * PX;
  const h = rows.length * PX;
  const x0 = Math.round(cx - w / 2);
  const y0 = Math.round(cy - h / 2);
  const out = [];
  rows.forEach((row, y) => {
    // A run of pixels is one rect: fewer elements, no hairline seams between them.
    for (let x = 0; x < row.length;) {
      if (row[x] !== '#') { x++; continue; }
      let end = x;
      while (row[end] === '#') end++;
      out.push(`<rect x="${x0 + x * PX}" y="${y0 + y * PX}" width="${(end - x) * PX}" height="${PX}"/>`);
      x = end;
    }
  });
  return `<g fill="${color}">${out.join('')}</g>`;
}

/**
 * One key as SVG. key: { mode, count, line } from Shellby (deck.js keys()),
 * or null when Shellby isn't there.
 */
function drawKey(action, key) {
  const offline = !key;
  const mode = offline ? 'off' : key.mode;
  const glyph = offline ? 'crab' : mode === 'look' ? 'review' : action;
  const color = mode === 'ready' ? COLORS[action] : mode === 'look' ? COLORS.look : DIM;
  const line = offline ? 'Shellby?' : key.line || NAMES[action];
  const count = offline ? 0 : Number(key.count) || 0;
  const parts = [
    `<rect width="${SIZE}" height="${SIZE}" fill="${INK}"/>`,
    pixels(GLYPHS[glyph], color, SIZE / 2, 62),
    `<text x="${SIZE / 2}" y="128" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="22" font-weight="700" fill="${mode === 'ready' || mode === 'look' ? SAND : SAND_DIM}">${escapeXml(line)}</text>`,
  ];
  // More than one waiting (or any review): how many, in the corner.
  if (count > 1 || (action === 'review' && count > 0)) {
    const n = count > 99 ? '99+' : String(count);
    parts.push(`<circle cx="122" cy="22" r="18" fill="${COLORS.deny}"/>`,
      `<text x="122" y="29" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="${n.length > 2 ? 14 : 20}" font-weight="700" fill="${INK}">${n}</text>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}" shape-rendering="crispEdges">${parts.join('')}</svg>`;
}

const dataUrl = svg => `data:image/svg+xml;charset=utf8,${encodeURIComponent(svg)}`;

// ------------------------------------------------------------------ Shellby's stream

/** Server-sent events: whole events out of what's arrived so far, and the rest. */
function parseSse(buffer) {
  const events = [];
  const chunks = buffer.replace(/\r\n?/g, '\n').split('\n\n');
  const rest = chunks.pop();
  for (const chunk of chunks) {
    const data = chunk.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).replace(/^ /, ''));
    if (data.length) events.push(data.join('\n'));
  }
  return { events, rest };
}

const actionOf = uuid => (typeof uuid === 'string' && uuid.startsWith(`${UUID}.`) ? uuid.slice(UUID.length + 1) : null);

/**
 * The plugin, without its sockets: Stream Deck's messages in, what to send out.
 *   send(msg)         to Stream Deck
 *   pair:             { port, token } from shellby.json
 *   fetchImpl:        fetch, for Shellby
 */
class Plugin {
  constructor({ send, pair, fetchImpl = fetch, log = () => {} }) {
    Object.assign(this, { send, pair, fetchImpl, log });
    this.contexts = new Map();   // context -> action
    this.keys = null;            // the last keys Shellby sent; null while he isn't there
    this.drawn = new Map();      // context -> the image last sent, so an unchanged key isn't resent
    this.closed = false;
    this.retryMs = RETRY_MIN_MS;
    this.abort = null;
  }

  get base() { return `http://127.0.0.1:${this.pair.port}${API}`; }
  get headers() { return { Authorization: `Bearer ${this.pair.token}` }; }

  onMessage(msg) {
    const action = actionOf(msg?.action);
    if (msg?.event === 'willAppear' && ACTIONS.includes(action)) {
      this.contexts.set(msg.context, action);
      this.drawn.delete(msg.context);
      this.draw(msg.context);
    } else if (msg?.event === 'willDisappear') {
      this.contexts.delete(msg.context);
      this.drawn.delete(msg.context);
    } else if (msg?.event === 'keyDown' && ACTIONS.includes(action)) {
      return this.press(msg.context, action);
    }
    return null;
  }

  draw(context) {
    const action = this.contexts.get(context);
    if (!action) return;
    const image = dataUrl(drawKey(action, this.keys ? this.keys[action] : null));
    if (this.drawn.get(context) === image) return;
    this.drawn.set(context, image);
    this.send({ event: 'setImage', context, payload: { image, target: 0 } });
  }

  drawAll() { for (const context of this.contexts.keys()) this.draw(context); }

  setKeys(keys) {
    this.keys = keys && typeof keys === 'object' ? keys : null;
    this.drawAll();
  }

  async press(context, action) {
    const ref = this.keys?.[action]?.ref || '';
    try {
      const res = await this.fetchImpl(`${this.base}/press`, {
        method: 'POST',
        headers: { ...this.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ref }),
      });
      const r = await res.json().catch(() => ({ ok: false }));
      this.send({ event: r.ok ? 'showOk' : 'showAlert', context });
      return r;
    } catch {
      this.send({ event: 'showAlert', context });
      return { ok: false };
    }
  }

  /** Listen to Shellby until closed, coming back after he restarts. */
  async listen() {
    while (!this.closed) {
      try {
        this.abort = new AbortController();
        const res = await this.fetchImpl(`${this.base}/keys`, { headers: this.headers, signal: this.abort.signal });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        this.retryMs = RETRY_MIN_MS;
        const decoder = new TextDecoder();
        let buffer = '';
        for await (const chunk of res.body) {
          buffer += decoder.decode(chunk, { stream: true });
          const { events, rest } = parseSse(buffer);
          buffer = rest;
          for (const data of events) {
            try { this.setKeys(JSON.parse(data).keys); } catch { /* a garbled event: the next one will do */ }
          }
        }
      } catch (err) {
        if (this.closed) return;
        this.log(`shellby: ${err.message}`);
      }
      this.setKeys(null);
      await new Promise(r => setTimeout(r, this.retryMs));
      this.retryMs = Math.min(RETRY_MAX_MS, this.retryMs * 2);
    }
  }

  close() {
    this.closed = true;
    this.abort?.abort();
  }
}

// ------------------------------------------------------------------ started by Stream Deck

function argsOf(argv) {
  const out = {};
  for (let i = 0; i < argv.length - 1; i++) if (argv[i].startsWith('-')) out[argv[i].replace(/^-+/, '')] = argv[i + 1];
  return out;
}

function main() {
  const args = argsOf(process.argv.slice(2));
  let pair;
  try { pair = JSON.parse(fs.readFileSync(path.join(__dirname, 'shellby.json'), 'utf8')); } catch { pair = null; }
  const ws = new WebSocket(`ws://127.0.0.1:${args.port}`);
  const send = msg => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); };
  const plugin = new Plugin({ send, pair: pair || { port: 0, token: '' }, log: m => send({ event: 'logMessage', payload: { message: m } }) });
  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ event: args.registerEvent, uuid: args.pluginUUID }));
    // Never paired: there is nobody to listen to, and every key says so.
    if (pair?.port && pair?.token) plugin.listen();
  });
  ws.addEventListener('message', e => {
    let msg;
    try { msg = JSON.parse(String(e.data)); } catch { return; }
    plugin.onMessage(msg);
  });
  ws.addEventListener('close', () => { plugin.close(); process.exit(0); });
}

if (require.main === module) main();

module.exports = { Plugin, drawKey, dataUrl, parseSse, actionOf, argsOf, GLYPHS, ACTIONS, UUID };
