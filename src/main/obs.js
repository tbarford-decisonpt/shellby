// Shellby as an OBS browser source.
//
// He is pixel art on a transparent background, which is exactly what a stream
// overlay wants, and until now the only way to get him on screen was to capture
// the desktop and hope no window covered him. This serves a page on 127.0.0.1
// that OBS (or anything else with a browser source) can point at: just the crab,
// alpha everywhere else, reacting live.
//
// The page reuses the real critter's stylesheet and sprite builder, so the crab
// on the stream is the same crab, with the same outfit and the same animations,
// rather than a second copy that drifts.
//
// Security: localhost only, GET only, and every URL it will answer is in a fixed
// table built at startup. No part of a request ever becomes part of a file path,
// so there is no traversal to get wrong.
const fs = require('fs');
const http = require('http');
const path = require('path');
const { EventEmitter } = require('events');

const DEFAULT_PORT = 47914;      // next door to the hooks port
const MAX_CLIENTS = 8;           // OBS opens one; a few tabs while you set it up
const KEEPALIVE_MS = 20000;      // a comment line, so no proxy or sleep drops the stream

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ttf': 'font/ttf',
  '.png': 'image/png',
};

/**
 * Every URL the overlay needs, mapped to a file. Relative to the repo's src/
 * and assets/ folders, resolved once at startup; anything not in here 404s.
 *
 * fonts.css asks for ../../../assets/fonts/*.ttf, which from /shared/fonts.css
 * resolves to /assets/fonts/*.ttf, so those are the URLs they are served at.
 */
function routeTable(srcDir, assetsDir) {
  const r = {
    '/': path.join(srcDir, 'renderer', 'obs', 'overlay.html'),
    '/obs/overlay.js': path.join(srcDir, 'renderer', 'obs', 'overlay.js'),
    '/obs/overlay.css': path.join(srcDir, 'renderer', 'obs', 'overlay.css'),
    '/shared/sprite.js': path.join(srcDir, 'renderer', 'shared', 'sprite.js'),
    '/shared/effects.js': path.join(srcDir, 'renderer', 'shared', 'effects.js'),
    '/shared/effects.css': path.join(srcDir, 'renderer', 'shared', 'effects.css'),
    '/shared/fonts.css': path.join(srcDir, 'renderer', 'shared', 'fonts.css'),
    '/shared/tokens.css': path.join(srcDir, 'renderer', 'shared', 'tokens.css'),
    '/shared/health.css': path.join(srcDir, 'renderer', 'shared', 'health.css'),
    '/shared/health-fx.js': path.join(srcDir, 'renderer', 'shared', 'health-fx.js'),
    '/critter/critter.css': path.join(srcDir, 'renderer', 'critter', 'critter.css'),
    // what he holds while he works (critter.js uses the same on the desktop)
    '/shared/workposes.js': path.join(srcDir, 'renderer', 'shared', 'workposes.js'),
  };
  for (const font of ['PixelifySans.ttf', 'AtkinsonHyperlegible-Regular.ttf', 'AtkinsonHyperlegible-Bold.ttf', 'MartianMono.ttf']) {
    r[`/assets/fonts/${font}`] = path.join(assetsDir, 'fonts', font);
  }
  return r;
}

/** A browser-source URL a person can read off the screen and type into OBS. */
const urlFor = port => `http://127.0.0.1:${port}/`;

class ObsServer extends EventEmitter {
  /**
   * srcDir/assetsDir: where the renderer and the fonts live.
   * getState: () => { skin, outfit, px, state, ... } -- the first thing a new
   *           client is sent, so it draws the right crab immediately.
   */
  constructor({ srcDir, assetsDir, getState, port = DEFAULT_PORT }) {
    super();
    this.routes = routeTable(srcDir, assetsDir);
    this.getState = getState;
    this.port = port;
    this.server = null;
    this.clients = new Set();
    this.status = 'off';          // 'off' | 'listening' | 'busy' | 'error'
    this.keepalive = null;
    this.lastState = null;
  }

  get url() { return this.status === 'listening' ? urlFor(this.port) : null; }
  get viewers() { return this.clients.size; }

  view() {
    return { status: this.status, port: this.port, url: this.url, viewers: this.viewers };
  }

  start() {
    if (this.server) return;
    const server = http.createServer((req, res) => this.handle(req, res));
    server.headersTimeout = 5000;
    server.on('error', err => {
      clearInterval(this.keepalive);
      this.keepalive = null;
      this.server = null;
      this.status = err.code === 'EADDRINUSE' ? 'busy' : 'error';
      this.emit('status', this.view());
    });
    server.listen(this.port, '127.0.0.1', () => {
      this.port = server.address().port;
      this.status = 'listening';
      // A comment line every so often: OBS keeps the source alive across a
      // laptop sleep, and an idle connection can otherwise be dropped.
      this.keepalive = setInterval(() => this.write(': ping\n\n'), KEEPALIVE_MS);
      this.emit('status', this.view());
    });
    this.server = server;
  }

  stop() {
    clearInterval(this.keepalive);
    this.keepalive = null;
    for (const res of this.clients) res.end();
    this.clients.clear();
    this.server?.close();
    this.server = null;
    this.status = 'off';
    this.emit('status', this.view());
  }

  /** Push the crab's current look and state to every open browser source. */
  broadcast(state) {
    this.lastState = state;
    this.write(`data: ${JSON.stringify(state)}\n\n`);
  }

  write(chunk) {
    for (const res of [...this.clients]) {
      try { res.write(chunk); } catch { this.drop(res); }
    }
  }

  drop(res) {
    if (!this.clients.delete(res)) return;
    try { res.end(); } catch { /* already gone */ }
    this.emit('viewers', this.viewers);
  }

  handle(req, res) {
    // OBS only ever gets; nothing here is writable, so nothing else is allowed.
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }
    // Query strings and fragments are not part of a route (OBS appends neither,
    // but a person pasting a URL might).
    const url = String(req.url || '').split('?')[0].split('#')[0];
    if (url === '/events') { this.subscribe(req, res); return; }
    // Every browser asks for this unprompted; answering "nothing here" keeps a
    // pointless 404 out of OBS's log.
    if (url === '/favicon.ico') { res.writeHead(204).end(); return; }

    const file = Object.prototype.hasOwnProperty.call(this.routes, url) ? this.routes[url] : null;
    if (!file) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not here.'); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not here.'); return; }
      res.writeHead(200, {
        'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
        'Content-Length': data.length,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(req.method === 'HEAD' ? undefined : data);
    });
  }

  subscribe(req, res) {
    if (this.clients.size >= MAX_CLIENTS) { res.writeHead(503).end(); return; }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    this.clients.add(res);
    req.on('close', () => this.drop(res));
    res.on('error', () => this.drop(res));
    // The crab has to appear straight away, not at the next state change.
    let first;
    try { first = this.getState?.(); } catch { first = null; }
    res.write(`retry: 2000\n\ndata: ${JSON.stringify(first ?? this.lastState ?? {})}\n\n`);
    this.emit('viewers', this.viewers);
  }
}

module.exports = { ObsServer, routeTable, urlFor, DEFAULT_PORT, MAX_CLIENTS, TYPES };
