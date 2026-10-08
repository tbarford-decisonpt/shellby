// The port and environment doctor: why a dev server can't start, before and
// after it tries. A port someone else holds, the flag that moves a server to
// another one, .env keys the example has and yours doesn't, and the Node
// version a project asks for. Pure: text in, answers out (doctor-io.js does
// the reading, test/devservers-doctor.test.js runs it).
//
// Everything here reads a repository anyone could have written, or a server's
// own output. Only names (an env key, a version) ever come out of it, never a
// value from a .env file.

// ------------------------------------------------------------------ the port

// What servers say when their port is taken. Where the line holds an address
// (127.0.0.1:8080), the port is the number after its last colon.
const IN_USE = [
  /EADDRINUSE[^\n]*[:\s](\d{2,5})\b/i,                                    // node: listen EADDRINUSE: address already in use :::3000
  /\bport\s*:?\s*(\d{2,5})\s+is\s+(?:already\s+)?in\s+use\b(?![^\n]*\btrying\b)/i, // vite --strictPort: Port 5173 is in use; never Next's "trying 3001 instead"
  /address already in use[^\n]*[:\s](\d{2,5})\b/i,                        // python, go, rust
  /\bsomething is already running on port\s+(\d{2,5})\b/i,               // create-react-app
  /\b(?:could not|couldn't|unable to|failed to)\s+(?:bind|listen|start)[^\n]*?\bport\s*:?\s*(\d{2,5})\b/i,
  /\bport\s+(\d{2,5})\s+(?:is\s+)?(?:already\s+)?(?:in use|taken|occupied|unavailable)\b/i,
  /\bWSAEADDRINUSE\b[^\n]*:(\d{2,5})\b/i,
];

/** A server's lines -> the port it couldn't have, or null. The last one said wins. */
function portInUse(lines) {
  let found = null;
  for (const raw of lines || []) {
    const line = String(raw ?? '');
    // "Port 3000 is in use, trying 3001 instead": it moved along by itself.
    if (/\b(?:trying|instead)\b/i.test(line)) continue;
    for (const re of IN_USE) {
      const m = re.exec(line);
      if (!m) continue;
      const port = Number(m[1]);
      if (port >= 1 && port <= 65535) { found = port; break; }
    }
  }
  return found;
}

// How each framework is told which port to use. Every one also gets PORT in
// its environment, which is all create-react-app, plain node servers and most
// others read. null: PORT is the only way.
const PORT_FLAG = {
  vite: '--port', astro: '--port', remix: '--port', sveltekit: '--port', nuxt: '--port', next: '--port',
  angular: '--port', webpack: '--port', gatsby: '--port', expo: '--port', wrangler: '--port', netlify: '--port',
  vercel: '--listen',
  'create-react-app': null, nodemon: null, tsx: null, node: null,
};

/**
 * What starting on `port` takes. -> { args, env, flag }
 * args goes after the script name (npm needs `--` first to pass it on; pnpm,
 * Yarn and Bun pass it as it is). The port is a number and the flag one of a
 * fixed few, so nothing from the repository reaches the command line.
 */
function portArgs(manager, framework, port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { args: '', env: {}, flag: null };
  const flag = PORT_FLAG[framework] || null;
  const args = flag ? `${manager === 'npm' ? '-- ' : ''}${flag} ${port}` : '';
  return { args, env: { PORT: String(port) }, flag };
}

/**
 * netstat -ano's text -> the pids listening on `port` (TCP, either family).
 * The state column is in the PC's language ("LISTENING", "ABHÖREN"...), so a
 * listener is told by its foreign address instead: nobody yet (0.0.0.0:0, [::]:0, *:*).
 */
function listenersOn(netstatText, port) {
  const pids = new Set();
  for (const raw of String(netstatText || '').split(/\r?\n/)) {
    const cols = raw.trim().split(/\s+/);
    if (cols.length < 5 || cols[0].toUpperCase() !== 'TCP') continue;
    const local = cols[1];
    const foreign = cols[2];
    const pid = Number(cols[cols.length - 1]);
    const localPort = Number(local.slice(local.lastIndexOf(':') + 1));
    if (localPort !== port || !Number.isInteger(pid) || pid <= 0) continue;
    if (!/^(?:0\.0\.0\.0:0|\[::\]:0|\*:\*)$/.test(foreign)) continue;
    pids.add(pid);
  }
  return [...pids];
}

// Programs Windows can't do without, or that hold far more than a port:
// never offered as something to stop.
const NEVER_STOP = new Set([
  'system', 'system idle process', 'svchost.exe', 'lsass.exe', 'services.exe', 'wininit.exe', 'winlogon.exe', 'csrss.exe',
  'smss.exe', 'explorer.exe', 'dwm.exe', 'spoolsv.exe', 'searchindexer.exe', 'msmpeng.exe', 'shellby.exe', 'electron.exe',
]);

/** May "Stop it" be offered for this program? name: its lower-case exe ("node.exe"). */
function canStop(pid, name) {
  if (!Number.isInteger(pid) || pid <= 4) return false;
  return !!name && !NEVER_STOP.has(String(name).toLowerCase());
}

// ------------------------------------------------------------------ .env

const MAX_KEYS = 200;
const KEY_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]{0,127})\s*=/;

/** A .env file's text -> the names it sets (never a value). */
function envKeys(text) {
  const out = new Set();
  for (const line of String(text || '').split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    const m = KEY_RE.exec(line);
    if (m) out.add(m[1]);
    if (out.size >= MAX_KEYS) break;
  }
  return [...out];
}

// The files a project's example settings are kept in, and where yours go,
// in the order frameworks read them.
const EXAMPLE_FILES = ['.env.example', '.env.sample', '.env.template', '.env.dist', '.env.defaults', 'example.env'];
const ENV_FILES = ['.env', '.env.local', '.env.development', '.env.development.local'];

/**
 * example: { file, text } | null; present: [{ file, text }]; outside: names set
 * in Shellby's own environment (a key set for the whole PC counts as set).
 * -> { example, missing: [name], noEnv } or null when there's no example.
 */
function missingEnv(example, present, outside = []) {
  if (!example) return null;
  const want = envKeys(example.text);
  const have = new Set([...present.flatMap(p => envKeys(p.text)), ...outside].map(k => k.toUpperCase()));
  return {
    example: example.file,
    missing: want.filter(k => !have.has(k.toUpperCase())),
    noEnv: present.length === 0,
  };
}

// ------------------------------------------------------------------ Node

/**
 * The version a project asks for. files: { nvmrc, nodeVersion, packageJson }
 * (each text or null). -> { range, from } or null. An alias nvm resolves
 * itself (lts/*, node, stable) says nothing checkable, so it's null.
 */
function nodeWanted({ nvmrc = null, nodeVersion = null, packageJson = null } = {}) {
  const first = s => String(s || '').split(/\r?\n/).map(l => l.replace(/#.*$/, '').trim()).find(Boolean) || '';
  for (const [text, from] of [[nvmrc, '.nvmrc'], [nodeVersion, '.node-version']]) {
    const v = first(text);
    if (v && parseRange(v)) return { range: v.replace(/^v/i, ''), from };
  }
  let pkg = null;
  try { pkg = JSON.parse(String(packageJson || '')); } catch { /* not JSON */ }
  const engines = pkg && typeof pkg === 'object' && pkg.engines && typeof pkg.engines.node === 'string' ? pkg.engines.node.trim() : '';
  if (engines && engines.length <= 100 && parseRange(engines)) return { range: engines, from: 'package.json engines' };
  return null;
}

// A version, partly given ("20", "20.11") -> [major, minor|null, patch|null] or null.
function partial(v) {
  const m = /^v?(\d{1,6})(?:\.(\d{1,6}|[xX*]))?(?:\.(\d{1,6}|[xX*]))?(?:[-+][0-9A-Za-z.-]*)?$/.exec(String(v).trim());
  if (!m) return null;
  const n = x => (x == null || /[xX*]/.test(x) ? null : Number(x));
  const minor = n(m[2]);
  return [Number(m[1]), minor, minor == null ? null : n(m[3])];
}

const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
const low = p => [p[0], p[1] ?? 0, p[2] ?? 0];
// The first version past everything `p` covers: 20 -> 21.0.0, 20.11 -> 20.12.0.
const past = p => (p[1] == null ? [p[0] + 1, 0, 0] : p[2] == null ? [p[0], p[1] + 1, 0] : [p[0], p[1], p[2] + 1]);

/**
 * A semver range (the forms package.json and .nvmrc use) -> a list of sets of
 * comparators [op, version], any set matching, or null if it can't be read.
 */
function parseRange(range) {
  const text = String(range || '').trim();
  if (!text || text.length > 100) return null;
  if (text === '*' || /^x$/i.test(text)) return [[['>=', [0, 0, 0]]]];
  const sets = [];
  for (const part of text.split('||')) {
    const s = part.trim().replace(/\s*(>=|<=|>|<|=|\^|~)\s*/g, ' $1');
    const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(s);
    if (hyphen) {
      const a = partial(hyphen[1]), b = partial(hyphen[2]);
      if (!a || !b) return null;
      sets.push([['>=', low(a)], b[2] == null ? ['<', past(b)] : ['<=', low(b)]]);
      continue;
    }
    const set = [];
    for (const tok of s.split(/\s+/).filter(Boolean)) {
      const m = /^(>=|<=|>|<|=|\^|~)?(.+)$/.exec(tok);
      const p = partial(m[2]);
      if (!p) return null;
      const op = m[1] || '';
      if (op === '^') {
        const ceil = p[0] > 0 || p[1] == null ? [p[0] + 1, 0, 0] : p[1] > 0 || p[2] == null ? [0, p[1] + 1, 0] : [0, 0, p[2] + 1];
        set.push(['>=', low(p)], ['<', ceil]);
      } else if (op === '~') set.push(['>=', low(p)], ['<', p[1] == null ? [p[0] + 1, 0, 0] : [p[0], p[1] + 1, 0]]);
      else if (op === '' || op === '=') {
        if (p[2] != null) set.push(['=', p]);
        else set.push(['>=', low(p)], ['<', past(p)]);
      } else if (op === '>') set.push(p[2] == null ? ['>=', past(p)] : ['>', p]);
      else if (op === '<=') set.push(p[2] == null ? ['<', past(p)] : ['<=', p]);
      else set.push([op, low(p)]);
    }
    if (!set.length) return null;
    sets.push(set);
  }
  return sets;
}

/** Does `version` ("v20.11.1") fall in `range`? -> true | false | null (can't tell). */
function satisfies(version, range) {
  const v = partial(version);
  const sets = parseRange(range);
  if (!v || v[1] == null || v[2] == null || !sets) return null;
  const ok = ([op, w]) => {
    const c = cmp(v, w);
    return op === '>=' ? c >= 0 : op === '>' ? c > 0 : op === '<=' ? c <= 0 : op === '<' ? c < 0 : c === 0;
  };
  return sets.some(set => set.every(ok));
}

/**
 * What the doctor has to say about a project before it starts, in words for
 * the server card. env: missingEnv's answer; node: { wanted, have } (have:
 * "v20.11.1" or null when Node isn't on PATH). -> [{ kind, text, keys? }]
 */
function notes({ env = null, node = null } = {}) {
  const out = [];
  if (env?.missing.length) {
    const shown = env.missing.slice(0, 6);
    const more = env.missing.length - shown.length;
    out.push({
      kind: env.noEnv ? 'no-env' : 'env',
      keys: env.missing.slice(0, 20),
      text: env.noEnv
        ? `There's a ${env.example} but no .env, so ${env.missing.length === 1 ? 'its setting isn\'t' : `its ${env.missing.length} settings aren't`} set.`
        : `${env.example} has ${env.missing.length === 1 ? 'a setting' : `${env.missing.length} settings`} your .env doesn't: ${shown.join(', ')}${more > 0 ? ` and ${more} more` : ''}.`,
    });
  }
  if (node?.wanted) {
    const fits = node.have ? satisfies(node.have, node.wanted.range) : null;
    if (!node.have) out.push({ kind: 'node-missing', text: `It wants Node ${node.wanted.range} (${node.wanted.from}), and Shellby can't find Node on this PC.` });
    else if (fits === false) out.push({ kind: 'node', text: `It wants Node ${node.wanted.range} (${node.wanted.from}), and this PC has ${node.have.replace(/^v?/, 'v')}.` });
  }
  return out;
}

module.exports = {
  portInUse, portArgs, listenersOn, canStop, envKeys, missingEnv, nodeWanted, parseRange, satisfies, notes,
  EXAMPLE_FILES, ENV_FILES, PORT_FLAG,
};
