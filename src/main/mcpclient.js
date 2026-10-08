// Just enough of an MCP client to call one tool and leave: start the server
// (or reach it over HTTP), initialize, list or call, and shut it down again.
// A workflow's "MCP tool" step uses it, so "file an issue in Linear" can run
// without a Claude turn.
//
// stdio servers speak newline-delimited JSON-RPC on stdin/stdout. HTTP servers
// use the streamable HTTP transport (each POST answers with JSON or a short
// event stream). The legacy SSE transport and servers that need you to sign in
// (OAuth) aren't supported here: a Claude step can still use those.
//
// Everything is bounded: one deadline for the whole exchange, a cap on what's
// read, and the server's whole process tree ends with the call
// (process-job.js), so nothing is left running.
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { CMD, TASKKILL } = require('./system32');
const processJob = require('./process-job');
const { expandEnv, transportOf } = require('./mcpservers');

const PROTOCOL = '2025-06-18';
const CLIENT = { name: 'shellby', version: '1' };
const DEFAULT_TIMEOUT_MS = 2 * 60 * 1000;
const MAX_LINE = 8 * 1024 * 1024;     // one JSON-RPC message from a stdio server
const MAX_BODY = 8 * 1024 * 1024;     // one HTTP answer
const STDERR_TAIL = 2000;

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const abortError = () => Object.assign(new Error('Stopped.'), { name: 'AbortError' });

class McpError extends Error {}

/**
 * A bare command ("npx", "uvx", "node") -> its full path, from PATH and
 * PATHEXT only. Never the working folder: that's a project, and a program of
 * the same name could be waiting there.
 */
// (A path that can't be stat'ed is one that isn't there: that's the answer, not an error.)
function findCommand(cmd, env = process.env, exists = f => { try { return fs.statSync(f).isFile(); } catch { return false; } }) {
  if (path.isAbsolute(cmd)) return exists(cmd) ? cmd : null;
  if (/[\\/]/.test(cmd)) return null;
  // "python3.11" has a dot but no program extension: only a PATHEXT one counts as given.
  const pathext = String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map(e => e.toLowerCase());
  const given = pathext.includes(path.extname(cmd).toLowerCase());
  const exts = process.platform === 'win32' ? (given ? [''] : pathext) : [''];
  const dirs = String(env.PATH || env.Path || '').split(path.delimiter).filter(d => d && path.isAbsolute(d));
  for (const d of dirs) for (const e of exts) {
    const f = path.join(d, cmd + e.toLowerCase());
    if (exists(f)) return f;
  }
  return null;
}

// A .cmd or .bat can't be started without cmd.exe. Each word is quoted, so a
// space or & in an argument stays part of it.
const cmdQuote = a => `"${String(a).replace(/"/g, '""')}"`;

/** The program and arguments that start a stdio server. -> { file, args, verbatim } */
function launchPlan(def, env, find = findCommand) {
  const command = String(def.command || '').trim();
  if (!command) throw new McpError('This server has no command to start it with.');
  const args = (Array.isArray(def.args) ? def.args : []).map(String);
  const file = find(command, env);
  if (!file) throw new McpError(`Couldn't find “${command}” to start the server. Is it installed and on your PATH?`);
  if (/\.(cmd|bat)$/i.test(file)) {
    return { file: CMD, args: ['/d', '/s', '/c', `"${[file, ...args].map(cmdQuote).join(' ')}"`], verbatim: true };
  }
  return { file, args, verbatim: false };
}

// ---------------------------------------------------------------- stdio

function stdioSession(def, { cwd, env, spawnImpl = spawn, find } = {}) {
  const fullEnv = { ...env, ...expandEnv(isObj(def.env) ? def.env : {}, env) };
  const plan = launchPlan(expandEnv(def, env), fullEnv, find);
  const child = spawnImpl(plan.file, plan.args, {
    cwd, env: fullEnv, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], windowsVerbatimArguments: plan.verbatim,
  });
  const job = child.pid ? processJob.adopt(child.pid) : null;
  const pending = new Map();
  let stderr = '';
  let closed = null;
  let nextId = 1;

  const fail = err => { for (const p of pending.values()) p.reject(err); pending.clear(); };
  child.on('error', e => { closed = e; fail(new McpError(`The server couldn't start: ${e.message}`)); });
  child.on('close', code => {
    closed = closed || new Error('closed');
    const tail = stderr.trim().split('\n').slice(-4).join('\n');
    fail(new McpError(`The server stopped (exit code ${code})${tail ? `:\n${tail}` : '.'}`));
  });
  child.stderr.on('data', d => { stderr = (stderr + d).slice(-STDERR_TAIL); });
  child.stdin.on('error', () => { /* the close handler reports it */ });

  const write = msg => { if (!closed) child.stdin.write(`${JSON.stringify(msg)}\n`); };
  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  // Counted as it arrives, so a server that never sends a newline can't fill memory first.
  let sinceNewline = 0;
  child.stdout.on('data', chunk => {
    const nl = chunk.lastIndexOf(10);
    sinceNewline = nl < 0 ? sinceNewline + chunk.length : chunk.length - nl - 1;
    if (sinceNewline > MAX_LINE) { fail(new McpError('The server sent more than Shellby will read.')); end(); }
  });
  rl.on('line', line => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; } // a stray log line
    handle(msg, write, pending);
  });

  function end() {
    rl.close();
    try { child.stdin.end(); } catch { /* already destroyed: the server is gone, which is the point */ }
    if (processJob.sweep(job)) return;
    // taskkill fails only when the tree has already exited; nothing to report.
    if (child.pid && child.exitCode === null) execFile(TASKKILL, ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
  }

  return {
    request(method, params) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        if (closed) { reject(new McpError('The server isn\'t running.')); return; }
        pending.set(id, { resolve, reject });
        write({ jsonrpc: '2.0', id, method, params });
      });
    },
    notify(method, params) { write({ jsonrpc: '2.0', method, params }); },
    close: end,
  };
}


/**
 * One message from the server: an answer to one of ours, or a request of its
 * own. Shellby offers nothing back (no roots, sampling or questions), so those
 * get "not supported", except ping.
 */
function handle(msg, write, pending) {
  if (!isObj(msg)) return;
  if (msg.method && msg.id !== undefined) {
    write(msg.method === 'ping'
      ? { jsonrpc: '2.0', id: msg.id, result: {} }
      : { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Shellby doesn\'t support that.' } });
    return;
  }
  const p = msg.id !== undefined ? pending.get(msg.id) : null;
  if (!p) return;
  pending.delete(msg.id);
  if (msg.error) p.reject(new McpError(`The server said: ${String(msg.error.message || 'error').slice(0, 500)}`));
  else p.resolve(msg.result);
}

// ---------------------------------------------------------------- streamable HTTP

/** The messages in an event stream's text (the data: lines of each event). */
function sseMessages(text) {
  const out = [];
  for (const block of String(text).split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).replace(/^ /, '')).join('\n');
    if (!data) continue;
    try { out.push(JSON.parse(data)); } catch { /* not a message */ }
  }
  return out;
}

/**
 * An answer's text, at most MAX_BODY. enough(text): true once what's arrived
 * is all that's needed (the answer in an event stream the server keeps open),
 * and reading stops there.
 */
async function readCapped(res, enough = () => false) {
  if (!res.body?.getReader) return (await res.text()).slice(0, MAX_BODY);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += dec.decode(value, { stream: true });
    // Cancelling is only to stop reading; one that fails changes nothing we return or throw.
    if (text.length > MAX_BODY) { reader.cancel().catch(() => {}); throw new McpError('The server sent more than Shellby will read.'); }
    if (enough(text)) { reader.cancel().catch(() => {}); break; }
  }
  return text;
}

function httpSession(def, { env, fetchImpl = fetch, signal } = {}) {
  const d = expandEnv(def, env);
  let url;
  try { url = new URL(String(d.url || '')); } catch { throw new McpError('This server\'s address isn\'t a URL.'); }
  if (!/^https?:$/.test(url.protocol)) throw new McpError('This server\'s address must start with https:// (or http://).');
  const base = { ...(isObj(d.headers) ? d.headers : {}) };
  let session = null;
  let protocol = null;
  let nextId = 1;

  async function post(msg) {
    const headers = { ...base, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    if (session) headers['Mcp-Session-Id'] = session;
    if (protocol) headers['MCP-Protocol-Version'] = protocol;
    const res = await fetchImpl(url.href, { method: 'POST', headers, body: JSON.stringify(msg), signal, redirect: 'error' });
    if (res.status === 401 || res.status === 403) {
      throw new McpError('This server needs you to sign in, which Shellby can\'t do for it. A Claude step can use it instead.');
    }
    session = res.headers.get('mcp-session-id') || session;
    return res;
  }

  return {
    async request(method, params) {
      const id = nextId++;
      const res = await post({ jsonrpc: '2.0', id, method, params });
      if (!res.ok) throw new McpError(`The server answered ${res.status}.`);
      const isAnswer = m => isObj(m) && m.id === id && (m.result !== undefined || m.error);
      const sse = /text\/event-stream/i.test(res.headers.get('content-type') || '');
      const text = await readCapped(res, sse ? t => sseMessages(t).some(isAnswer) : undefined);
      // A body that isn't JSON has no answer in it: reported just below as "didn't answer".
      const msgs = sse ? sseMessages(text) : (() => { try { const j = JSON.parse(text); return Array.isArray(j) ? j : [j]; } catch { return []; } })();
      const answer = msgs.find(isAnswer);
      if (!answer) throw new McpError('The server didn\'t answer.');
      if (answer.error) throw new McpError(`The server said: ${String(answer.error.message || 'error').slice(0, 500)}`);
      if (method === 'initialize') protocol = typeof answer.result?.protocolVersion === 'string' ? answer.result.protocolVersion : PROTOCOL;
      return answer.result;
    },
    // A notification has no answer to wait for; if the server is unreachable
    // the request that follows fails with the reason, so this one stays quiet.
    notify(method, params) {
      post({ jsonrpc: '2.0', method, params }).then(r => r.body?.cancel?.()).catch(() => {});
    },
    // Ending the session is a courtesy: the server times it out anyway.
    close() {
      if (!session) return;
      fetchImpl(url.href, { method: 'DELETE', headers: { ...base, 'Mcp-Session-Id': session }, signal: AbortSignal.timeout(5000) }).catch(() => {});
    },
  };
}

// ---------------------------------------------------------------- the one call

/**
 * Start (or reach) the server, initialize, run fn(session), and always shut it
 * down. opts: { cwd, env, timeoutMs, signal, spawnImpl, fetchImpl, find }.
 */
async function withServer(def, fn, opts = {}) {
  const transport = transportOf(def);
  if (transport === 'sse') throw new McpError('This server uses the older SSE connection, which Shellby can\'t call directly. A Claude step can use it.');
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  if (opts.signal?.aborted) throw abortError();
  const controller = new AbortController();
  const env = opts.env || process.env;
  let s = null;
  let timer;
  let onAbort = null;
  // Settle first, then abort: the first reason given is the one that counts.
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => { reject(new McpError(`The server took longer than ${Math.round(timeoutMs / 1000)} seconds.`)); controller.abort(); }, timeoutMs);
    onAbort = () => { reject(abortError()); controller.abort(); };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
  });
  deadline.catch(() => {}); // handled by the race below; this only keeps a late one from going unhandled
  try {
    s = transport === 'stdio'
      ? stdioSession(def, { cwd: opts.cwd, env, spawnImpl: opts.spawnImpl, find: opts.find })
      : httpSession(def, { env, fetchImpl: opts.fetchImpl, signal: controller.signal });
    const work = (async () => {
      await s.request('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: CLIENT });
      s.notify('notifications/initialized');
      return fn(s);
    })();
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
    // The call's own result or error is what the caller needs; a failed shutdown
    // mustn't replace it (process-job still ends the tree with Shellby).
    try { s?.close(); } catch { /* see above */ }
  }
}

/** -> [{ name, description, inputSchema, readOnly }] (at most 200). */
async function listTools(def, opts) {
  return withServer(def, async s => {
    const tools = [];
    let cursor;
    for (let page = 0; page < 10 && tools.length < 200; page++) {
      const r = await s.request('tools/list', cursor ? { cursor } : {});
      for (const t of Array.isArray(r?.tools) ? r.tools : []) {
        if (typeof t?.name !== 'string') continue;
        tools.push({
          name: t.name.slice(0, 128), description: typeof t.description === 'string' ? t.description.slice(0, 500) : '', inputSchema: isObj(t.inputSchema) ? t.inputSchema : null,
          // The server's own word that it only reads (Next up's Linear and Jira lists allow only those).
          readOnly: t.annotations?.readOnlyHint === true,
        });
      }
      cursor = typeof r?.nextCursor === 'string' && r.nextCursor ? r.nextCursor : null;
      if (!cursor) break;
    }
    return tools.slice(0, 200);
  }, opts);
}

/**
 * A tool's answer -> { text, json, isError }: its text parts joined, and its
 * structured content (or the text, if that's JSON).
 */
function readResult(r) {
  const parts = Array.isArray(r?.content) ? r.content : [];
  const text = parts.filter(p => p?.type === 'text' && typeof p.text === 'string').map(p => p.text).join('\n');
  let json = isObj(r?.structuredContent) ? r.structuredContent : null;
  if (json === null && /^\s*[[{]/.test(text)) { try { json = JSON.parse(text); } catch { json = null; /* text that only looks like JSON: the text stands */ } }
  return { text, json, isError: r?.isError === true };
}

async function callTool(def, tool, args, opts) {
  return withServer(def, async s => readResult(await s.request('tools/call', { name: tool, arguments: args || {} })), opts);
}

module.exports = { listTools, callTool, readResult, sseMessages, findCommand, launchPlan, McpError, PROTOCOL };
