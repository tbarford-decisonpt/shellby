// When ssh needs a passphrase or a password, Shellby asks you, not a terminal.
//
// Shellby's ssh processes run with no console, so ssh asks through the program
// named in SSH_ASKPASS (SSH_ASKPASS_REQUIRE=force: always, even for the jump
// host of a ProxyJump), with the prompt as its one argument. That prompt can
// come from the other computer (a keyboard-interactive question is the
// server's own text), so the helper is a real program, never a .cmd: cmd.exe
// reads quotes, & and % in its command line as its own syntax, and a server
// could then run commands on this PC. Nor can it be Electron run as Node (a
// release build turns that off), so it's a few lines of C#, compiled once into
// the profile with the C# compiler that comes with Windows' .NET Framework.
// It reads its argument the ordinary way, sends it here as plain text, and
// prints what you typed for ssh to read.
//
// The server listens on 127.0.0.1 only, on a port of its own, and answers only
// a request carrying this run's random token, which is only ever in the
// environment of the ssh processes Shellby starts. Nothing typed is kept: it
// goes back to ssh and is forgotten.
const crypto = require('crypto');
const { execFile } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');

const MAX_BODY = 8 * 1024;
const MAX_PROMPT = 400;

// The helper. Its reply protocol is as plain as the request: "1\n" then the
// answer, or "0" for Cancel.
const SOURCE = `// Shellby's ssh askpass helper (src/main/remote/askpass.js). Built from this file.
using System;
using System.Net;
using System.Text;

static class ShellbyAskpass {
  static int Main(string[] args) {
    try {
      string port = Environment.GetEnvironmentVariable("SHELLBY_ASKPASS_PORT") ?? "";
      string token = Environment.GetEnvironmentVariable("SHELLBY_ASKPASS_TOKEN") ?? "";
      int n;
      if (!int.TryParse(port, out n) || n < 1 || n > 65535 || token.Length == 0) return 1;
      WebClient wc = new WebClient();
      wc.Proxy = null;
      wc.Encoding = new UTF8Encoding(false);
      wc.Headers.Add("X-Shellby-Token", token);
      wc.Headers.Add("Content-Type", "text/plain; charset=utf-8");
      string reply = wc.UploadString("http://127.0.0.1:" + n + "/ask", "POST", args.Length > 0 ? args[0] : "");
      if (!reply.StartsWith("1\\n")) return 1;
      byte[] bytes = new UTF8Encoding(false).GetBytes(reply.Substring(2) + "\\n");
      Console.OpenStandardOutput().Write(bytes, 0, bytes.Length);
      return 0;
    } catch {
      return 1;
    }
  }
}
`;

/** The C# compiler that comes with Windows (.NET Framework 4), 64-bit first. */
function findCompiler(root = process.env.SystemRoot || 'C:\\Windows', exists = fs.existsSync) {
  return ['Framework64', 'Framework']
    .map(f => path.join(root, 'Microsoft.NET', f, 'v4.0.30319', 'csc.exe'))
    .find(p => exists(p)) || null;
}

/** What kind of question ssh is asking, from its prompt. */
function kindOf(prompt) {
  const p = String(prompt || '');
  if (/passphrase/i.test(p)) return 'passphrase';
  if (/\(yes\/no/i.test(p)) return 'confirm';
  if (/password/i.test(p)) return 'password';
  return 'other'; // a one-time code, a PIN
}

/**
 * dir: where the helper goes (the profile's remote folder).
 * ask({ prompt, kind }) -> Promise<string | null>: null when you cancelled.
 * compiler: csc.exe (findCompiler), injectable for tests.
 * -> { env(): Promise<object>, close() }
 * @param {{ dir: string, ask: (q: { prompt: string, kind: string }) => Promise<string | null>, log?: (msg: string) => void, compiler?: string | null }} opts
 */
function createAskpass({ dir, ask, log = () => {}, compiler = findCompiler() }) {
  const token = crypto.randomBytes(24).toString('hex');
  const exe = path.join(dir, 'shellby-askpass.exe');
  const src = path.join(dir, 'shellby-askpass.cs');
  /** @type {import('http').Server | null} */
  let server = null;
  /** @type {Promise<number> | null} */
  let ready = null;

  // Built once, and again only when the source above changes.
  async function buildHelper() {
    fs.mkdirSync(dir, { recursive: true });
    let same = false;
    try { same = fs.readFileSync(src, 'utf8') === SOURCE && fs.existsSync(exe); } catch { /* not built yet */ }
    if (same) return;
    if (!compiler) throw new Error("Windows' C# compiler (.NET Framework 4) isn't on this PC");
    fs.writeFileSync(src, SOURCE);
    try { fs.rmSync(exe, { force: true }); } catch { /* in use: the build says */ }
    await /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
      execFile(compiler, ['/nologo', '/target:exe', '/optimize+', `/out:${exe}`, src], { windowsHide: true, timeout: 60000 }, (err, stdout) => {
        if (err || !fs.existsSync(exe)) { try { fs.rmSync(src, { force: true }); } catch { /* next time */ } reject(new Error(`couldn't build the helper: ${String(stdout || err?.message).trim().slice(0, 300)}`)); } else resolve();
      });
    }));
  }

  function handle(req, res) {
    const done = (status, body) => { res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(body); };
    const given = String(req.headers['x-shellby-token'] || '');
    const okToken = given.length === token.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(token));
    if (req.method !== 'POST' || req.url !== '/ask' || !okToken) { req.resume(); return done(403, '0'); }
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      body += chunk;
      if (body.length > MAX_BODY) req.destroy();
    });
    req.on('end', async () => {
      // Shown as text in the panel, never run: only control characters are taken out.
      const prompt = body.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, MAX_PROMPT);
      /** @type {string | null} */
      let answer = null;
      try { answer = await ask({ prompt, kind: kindOf(prompt) }); } catch (err) { log(`askpass: ${err.message}`); }
      // A line break would end the answer early for ssh: never part of one.
      done(200, typeof answer === 'string' && !/[\r\n]/.test(answer) ? `1\n${answer}` : '0');
    });
  }

  function start() {
    ready ??= (async () => {
      await buildHelper();
      return new Promise((resolve, reject) => {
        server = http.createServer(handle);
        // A question can wait while you find the passphrase: no idle timeout.
        server.requestTimeout = 0;
        server.headersTimeout = 10000;
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => resolve(/** @type {import('net').AddressInfo} */ (/** @type {import('http').Server} */ (server).address()).port));
      });
    })().catch(err => { ready = null; throw err; });
    return ready;
  }

  /** The environment an ssh needs to ask through Shellby. */
  async function env() {
    const port = await start();
    return {
      SSH_ASKPASS: exe,
      SSH_ASKPASS_REQUIRE: 'force',
      DISPLAY: process.env.DISPLAY || 'shellby:0',
      SHELLBY_ASKPASS_PORT: String(port),
      SHELLBY_ASKPASS_TOKEN: token,
    };
  }

  function close() {
    try { server?.close(); } catch { /* already closed */ }
    server = null;
    ready = null;
  }

  return { env, close };
}

module.exports = { createAskpass, kindOf, findCompiler, SOURCE };
