// Debug mode's receiver (debug-mode.js): where the logging Claude added sends
// its lines while you reproduce a bug. One small HTTP server on 127.0.0.1,
// open only while some conversation is in debug mode, on a port Windows picks.
//
// Each debug session has its own address, /debug/<32 hex characters>: nothing
// else is answered. Browser code posts from your dev server's page, so it
// answers CORS too; only a Host of 127.0.0.1 or localhost is taken (a page
// rebinding its own name to this PC can't reach it). Bodies are capped, and
// what arrives is only ever shown, redacted, and sent to Claude fenced as
// output after you press Send (wiring/debug-mode.js).
const http = require('http');

const MAX_BODY = 16 * 1024;
const PATH = /^\/debug\/([0-9a-f]{32})\/?(?:\?.*)?$/;

class DebugIngest {
  /** onLines(token, body): a POST to a live address. */
  constructor({ onLines, host = '127.0.0.1' } = {}) {
    this.onLines = onLines || (() => {});
    this.host = host;
    this.tokens = new Set();
    this.server = null;
    this.port = 0;
    this.opening = null;
  }

  /** Start taking lines for token. -> the port */
  async open(token) {
    if (!/^[0-9a-f]{32}$/.test(String(token))) throw new Error('bad token');
    this.tokens.add(token);
    if (this.server) return this.port;
    if (!this.opening) {
      this.opening = new Promise((resolve, reject) => {
        const server = http.createServer((req, res) => this.handle(req, res));
        server.on('error', reject);
        server.listen(0, this.host, () => {
          this.server = server;
          this.port = server.address().port;
          resolve(this.port);
        });
      }).finally(() => { this.opening = null; });
    }
    return this.opening;
  }

  /** Stop taking lines for token; the server goes with the last one. */
  close(token) {
    this.tokens.delete(token);
    if (this.tokens.size || !this.server) return;
    this.server.close();
    this.server = null;
    this.port = 0;
  }

  closeAll() {
    this.tokens.clear();
    this.close(null);
  }

  handle(req, res) {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'content-type',
      'Access-Control-Allow-Private-Network': 'true',
    };
    const end = (code, headers = {}) => { res.writeHead(code, { ...headers, 'Content-Length': 0 }); res.end(); };
    const host = String(req.headers.host || '').toLowerCase();
    if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) return end(403);
    const m = PATH.exec(req.url || '');
    if (!m || !this.tokens.has(m[1])) return end(404);
    if (req.method === 'OPTIONS') return end(204, cors);
    if (req.method !== 'POST') return end(405, { ...cors, Allow: 'POST, OPTIONS' });
    let size = 0;
    const parts = [];
    let over = false;
    req.on('data', chunk => {
      if (over) return;
      size += chunk.length;
      // Closed after the answer, and said so, so no client sends its next line down a dead socket.
      if (size > MAX_BODY) { over = true; res.once('finish', () => req.destroy()); end(413, { ...cors, Connection: 'close' }); return; }
      parts.push(chunk);
    });
    req.on('end', () => {
      if (over) return;
      end(204, cors);
      if (this.tokens.has(m[1])) this.onLines(m[1], Buffer.concat(parts).toString('utf8'));
    });
    req.on('error', () => {});
  }
}

module.exports = { DebugIngest, MAX_BODY };
