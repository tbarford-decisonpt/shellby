// Claude Code on another computer, over ssh (pure: no Electron, no I/O).
//
// A folder on another computer is a project like any other: it has a local
// stand-in folder under %APPDATA%\Shellby\remote (its "anchor"), which is what
// the tabs, History and the folder menu see as its cwd. When a tab's cwd is an
// anchor, its Claude Code process runs on that computer instead, through
// Windows' own OpenSSH:
//
//   ssh.exe -T <host> exec sh -c 'set -f; IFS=; x=$(printf %s <base64> | base64 -d); eval $x'
//
// Everything the remote end runs is a POSIX sh script, sent base64-encoded so
// that it means the same in whatever login shell the account has (bash, zsh,
// fish, tcsh): the only thing that shell ever parses is the one fixed,
// single-quoted line above, which holds no quote, backslash or double quote.
// stream-json goes over ssh's stdin and stdout exactly as it does locally, so
// permission cards, steering and the crab's own tools all work unchanged.
//
// Everything a host name or a folder could smuggle onto a command line is
// decided here, and unit-tested (test/remote-ssh.test.js).
const path = require('path');

// An ssh destination Shellby will use: a Host alias from ~/.ssh/config, or a
// plain name or address. Never one starting with '-' (ssh would read it as an
// option), and nothing a shell or ssh's own syntax would treat specially.
const HOST = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,62}$/;
// user@host as the add form takes it, and a port.
const USER = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,31}$/;
const ADDRESS = /^(?:[A-Za-z0-9_][A-Za-z0-9.-]{0,252}|\[[0-9A-Fa-f:.]{2,45}\])$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const MAX_DIR = 1024;

const isHost = s => typeof s === 'string' && HOST.test(s);
const isUser = s => typeof s === 'string' && USER.test(s);
const isAddress = s => typeof s === 'string' && ADDRESS.test(s);
const isPort = n => Number.isInteger(n) && n > 0 && n < 65536;

/**
 * A folder on the other computer: absolute (/srv/app) or under its home
 * (~ or ~/code/app), with no control characters and no '..' step.
 */
function isRemoteDir(dir) {
  if (typeof dir !== 'string' || !dir || dir.length > MAX_DIR || CONTROL.test(dir)) return false;
  if (!(dir === '~' || dir.startsWith('~/') || dir.startsWith('/'))) return false;
  return !dir.split('/').some(part => part === '..');
}

/** Tidy a folder the way the panel shows it: no trailing or doubled slashes. */
function cleanDir(dir) {
  const s = String(dir || '').trim().replace(/\/{2,}/g, '/');
  return s.length > 1 ? s.replace(/\/+$/, '') : s;
}

/** A POSIX sh single-quoted literal: nothing inside it is ever expanded. */
const shQuote = s => `'${String(s).replace(/'/g, "'\\''")}'`;

/** A folder as sh should read it: ~ expanded, the rest literal. */
function shDir(dir) {
  if (dir === '~') return '"$HOME"';
  if (dir.startsWith('~/')) return `"$HOME"/${shQuote(dir.slice(2))}`;
  return shQuote(dir);
}

// Where Claude Code's own installer and npm usually put it. A non-interactive
// ssh command doesn't read ~/.profile, so ~/.local/bin is often not on PATH.
const PATH_LINE = [
  'PATH="$HOME/.local/bin:$HOME/.claude/local:$HOME/.npm-global/bin:$HOME/bin:/usr/local/bin:$PATH"',
  'for d in "$HOME"/.nvm/versions/node/*/bin; do [ -d "$d" ] && PATH="$d:$PATH"; done',
  'export PATH',
].join('\n');

/** The one line the remote login shell parses: it decodes and runs `script` with sh. */
function wrap(script) {
  const b64 = Buffer.from(String(script), 'utf8').toString('base64');
  return `exec sh -c 'set -f; IFS=; x=$(printf %s ${b64} | base64 -d); eval $x'`;
}

// Undo wrap()'s set -f and IFS= before anything of ours runs.
const PRELUDE = 'set +f\nunset IFS';

// Stands in for the --mcp-config file in a session's arguments: the remote end
// reads the config from the first line of stdin into a file of its own, so
// tokens in a server's definition never sit on a command line there.
const MCP_FILE = '\u0000mcp-file';

// Environment names Shellby sets for the remote Claude Code.
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;

/**
 * The script a conversation runs on the other computer.
 *   dir: the folder (isRemoteDir); args: claude's arguments, where MCP_FILE
 *   marks the config read from stdin; env: { NAME: value } for Claude Code.
 */
function sessionScript({ dir, args = [], env = {} }) {
  const mcp = args.includes(MCP_FILE);
  const vars = Object.entries(env).filter(([k]) => ENV_NAME.test(k)).map(([k, v]) => `${k}=${shQuote(v)}`);
  const argv = args.map(a => (a === MCP_FILE ? '"$f"' : shQuote(a))).join(' ');
  return [
    PRELUDE,
    PATH_LINE,
    // 97 and 96: our own exit codes, so the panel can say which thing was missing.
    `cd ${shDir(dir)} 2>/dev/null || { echo "shellby: no folder ${dir.replace(/[^\w./~ -]/g, '')}" >&2; exit 97; }`,
    'command -v claude >/dev/null 2>&1 || { echo "shellby: claude: command not found" >&2; exit 96; }',
    ...(mcp ? [
      'f=$(mktemp) || exit 98',
      'IFS= read -r line || exit 98',
      'printf \'%s\\n\' "$line" > "$f"',
      // Claude Code reads it at start: gone a minute later, whatever happens.
      '(sleep 60; rm -f "$f") </dev/null >/dev/null 2>&1 &',
    ] : []),
    `exec env ${vars.join(' ')} claude ${argv}`.replace(/ {2,}/g, ' '),
  ].join('\n');
}

/**
 * What one look at the other computer says, a line per fact:
 * shellby-ok, the system, where claude is, its version and `auth status --json`.
 */
function probeScript() {
  return [
    PRELUDE,
    PATH_LINE,
    'echo "shellby-ok"',
    'echo "os: $(uname -sm 2>/dev/null)"',
    'echo "home: $HOME"',
    'c=$(command -v claude 2>/dev/null)',
    'if [ -n "$c" ]; then',
    '  echo "claude: $c"',
    '  echo "version: $(claude --version 2>/dev/null | head -n 1)"',
    '  echo "auth: $(claude auth status --json 2>/dev/null | tr -d \'\\n\')"',
    'else',
    '  echo "claude:"',
    'fi',
    'echo "git: $(command -v git 2>/dev/null)"',
    'echo "curl: $(command -v curl 2>/dev/null)"',
  ].join('\n');
}

/** Parses probeScript's output. -> { reached, os, home, claude, version, auth, git, curl } */
function parseProbe(text) {
  const lines = String(text || '').split(/\r?\n/);
  const get = key => {
    const line = lines.find(l => l.startsWith(`${key}:`));
    return line ? line.slice(key.length + 1).trim() : '';
  };
  let auth;
  try { auth = get('auth') ? JSON.parse(get('auth')) : null; } catch { auth = null; }
  return {
    reached: lines.some(l => l.trim() === 'shellby-ok'),
    os: get('os') || null,
    home: get('home') || null,
    claude: get('claude') || null,
    version: (get('version').match(/\d+\.\d+\.\d+/) || [null])[0],
    loggedIn: !!auth?.loggedIn,
    email: typeof auth?.email === 'string' ? auth.email : null,
    authMethod: typeof auth?.authMethod === 'string' ? auth.authMethod : null,
    subscriptionType: typeof auth?.subscriptionType === 'string' ? auth.subscriptionType : null,
    git: !!get('git'),
    curl: !!get('curl'),
  };
}

/** Claude Code's own installer, run as you on the other computer. */
function installScript() {
  return [
    PRELUDE,
    'command -v curl >/dev/null 2>&1 || { echo "shellby: curl: command not found" >&2; exit 95; }',
    'curl -fsSL https://claude.ai/install.sh | bash',
  ].join('\n');
}

/** For a terminal on the other computer: sign in to Claude Code there. */
function signInScript() {
  return [PRELUDE, PATH_LINE, 'claude auth login', 'echo', 'echo "Done here? Close this window and press Check again in Shellby."', 'exec "${SHELL:-sh}" -l'].join('\n');
}

/** For a terminal on the other computer: carry a conversation on there. */
function resumeScript({ dir, sessionId }) {
  return [PRELUDE, PATH_LINE, `cd ${shDir(dir)} || exit 97`, `exec claude --resume ${shQuote(sessionId)}`].join('\n');
}

/** Folders worth offering under a folder: its subfolders, git repos marked. Hidden ones are left out (type the path for those). */
function listScript(dir) {
  return [
    PRELUDE,
    `cd ${shDir(dir)} 2>/dev/null || { echo "shellby: no folder" >&2; exit 97; }`,
    'echo "here: $(pwd)"',
    'for d in */; do [ -d "$d" ] || continue; n=${d%/}; if [ -e "$n/.git" ]; then echo "git: $n"; else echo "dir: $n"; fi; done 2>/dev/null | head -n 300',
  ].join('\n');
}

/** Parses listScript. -> { here, folders: [{ name, git }] } */
function parseList(text) {
  const lines = String(text || '').split(/\r?\n/);
  const here = (lines.find(l => l.startsWith('here: ')) || '').slice(6).trim() || null;
  const folders = lines
    .map(l => /^(git|dir): (.+)$/.exec(l))
    .filter(Boolean)
    .map(/** @param {RegExpExecArray} m */ m => ({ name: m[2], git: m[1] === 'git' }))
    .filter(f => !CONTROL.test(f.name) && !f.name.includes('/'));
  return { here, folders };
}

/** Appends a public key to ~/.ssh/authorized_keys on the other computer (the key comes on stdin). */
function authorizeScript() {
  return [
    PRELUDE,
    'umask 077',
    'mkdir -p "$HOME/.ssh" || exit 1',
    'IFS= read -r key || exit 1',
    'touch "$HOME/.ssh/authorized_keys"',
    'grep -qxF "$key" "$HOME/.ssh/authorized_keys" || printf \'%s\\n\' "$key" >> "$HOME/.ssh/authorized_keys"',
    'echo "shellby-ok"',
  ].join('\n');
}

// Keepalives, so a connection that dropped (a sleeping laptop, a lost Wi-Fi)
// is noticed in two minutes rather than hanging a tab for ever.
const KEEPALIVE = ['-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=4'];

/**
 * ssh's arguments for a command on `host`. tty: an interactive terminal (sign
 * in, carry on there). batch: never ask for anything (status checks while
 * you're not looking). acceptNew: trust a computer seen for the first time
 * (only after you pressed Connect on it).
 */
function sshArgs(host, script, { tty = false, batch = false, acceptNew = false, timeout = 20, extra = /** @type {string[]} */ ([]) } = {}) {
  if (!isHost(host)) throw new Error('bad host');
  return [
    tty ? '-t' : '-T',
    ...KEEPALIVE,
    '-o', `ConnectTimeout=${Math.max(1, Math.min(120, Math.round(timeout)))}`,
    ...(batch ? ['-o', 'BatchMode=yes'] : []),
    ...(acceptNew ? ['-o', 'StrictHostKeyChecking=accept-new'] : []),
    ...extra,
    '--', host, wrap(script),
  ];
}

/**
 * `ssh -G host`: ssh's own reading of ~/.ssh/config for that host, with every
 * Include, Match and default applied. -> { hostname, user, port, proxyjump, identityfiles }
 */
function parseResolved(text) {
  /** @type {{ hostname: string | null, user: string | null, port: number, proxyjump: string | null, identityfiles: string[] }} */
  const out = { hostname: null, user: null, port: 22, proxyjump: null, identityfiles: [] };
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^(\S+)\s+(.*)$/.exec(line.trim());
    if (!m) continue;
    const [, key, value] = m;
    if (key === 'hostname') out.hostname = value;
    else if (key === 'user') out.user = value;
    else if (key === 'port') out.port = Number(value) || 22;
    else if (key === 'proxyjump' && value !== 'none') out.proxyjump = value;
    else if (key === 'identityfile') out.identityfiles.push(value);
  }
  return out;
}

/**
 * The Host aliases in an ssh config file you could pick: no wildcards or
 * negations, and only names Shellby would put on a command line. Includes are
 * not followed (ssh -G does that once one is picked). -> [{ alias, hostName, user, port, proxyJump, shellby }]
 */
function parseConfig(text) {
  const hosts = [];
  let current = [];
  let shellby = false;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (line === MARK) { shellby = true; continue; }
    if (!line || line.startsWith('#')) continue;
    const m = /^(\S+?)(?:\s*=\s*|\s+)(.+)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].replace(/^"(.*)"$/, '$1');
    if (key === 'host') {
      current = value.split(/\s+/).filter(a => isHost(a)).map(alias => ({ alias, hostName: null, user: null, port: null, proxyJump: null, shellby }));
      hosts.push(...current);
      shellby = false;
    } else if (key === 'match') {
      current = [];
    } else {
      for (const h of current) {
        if (key === 'hostname') h.hostName = value;
        else if (key === 'user') h.user = value;
        else if (key === 'port') h.port = Number(value) || null;
        else if (key === 'proxyjump') h.proxyJump = value;
      }
    }
  }
  const seen = new Set();
  return hosts.filter(h => !seen.has(h.alias.toLowerCase()) && seen.add(h.alias.toLowerCase()));
}

// The comment above every block Shellby writes, so it can tell its own apart.
const MARK = '# Added by Shellby';

/**
 * A Host block for ~/.ssh/config, from the add form. Every value is checked:
 * this file is read by every ssh on the PC.
 *   -> { ok: true, text } | { ok: false, error }
 * @param {{ alias: string, address: string, user?: string | null, port?: number | null, jump?: string | null, identityFile?: string | null }} opts
 */
function hostBlock({ alias, address, user = null, port = null, jump = null, identityFile = null }) {
  if (!isHost(alias)) return { ok: false, error: 'A name with letters, numbers, dots, dashes or underscores, like homebox.' };
  if (!isAddress(address)) return { ok: false, error: "That address doesn't look like a computer name or IP address." };
  if (user !== null && !isUser(user)) return { ok: false, error: "That user name has characters ssh won't take." };
  if (port !== null && !isPort(port)) return { ok: false, error: 'The port is a number from 1 to 65535.' };
  if (jump !== null && (!isHost(jump) || jump.toLowerCase() === alias.toLowerCase())) return { ok: false, error: "Pick another computer to go through, or none." };
  if (identityFile !== null && (typeof identityFile !== 'string' || CONTROL.test(identityFile) || /["\s]/.test(identityFile))) return { ok: false, error: 'bad key file' };
  const lines = [MARK, `Host ${alias}`, `    HostName ${address.replace(/^\[(.*)\]$/, '$1')}`];
  if (user) lines.push(`    User ${user}`);
  if (port && port !== 22) lines.push(`    Port ${port}`);
  if (jump) lines.push(`    ProxyJump ${jump}`);
  if (identityFile) lines.push(`    IdentityFile ${identityFile}`);
  return { ok: true, text: lines.join('\n') };
}

/** `text` with `block` appended, a blank line between them and a newline at the end. */
function appendBlock(text, block) {
  const body = String(text || '').replace(/\s+$/, '');
  const nl = /\r\n/.test(String(text || '')) ? '\r\n' : '\n';
  return `${body ? body + nl + nl : ''}${block.split('\n').join(nl)}${nl}`;
}

// ---- anchors: a remote folder's stand-in on this PC

/** A file-name-safe piece of a remote folder: the readable end of it, plus a short hash. */
function anchorName(dir, hash) {
  const tail = cleanDir(dir).split('/').filter(p => p && !['~', '.', '..'].includes(p)).pop() || 'home';
  const safe = tail.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '').slice(0, 40) || 'folder';
  return `${safe}-${String(hash).slice(0, 6)}`;
}

/** The anchor for host:dir under root (%APPDATA%\Shellby\remote). hash: of `${host}:${dir}`. */
function anchorFor(root, host, dir, hash) {
  return path.join(root, host, anchorName(dir, hash));
}

/** How the panel names a remote folder: "sandbox: ~/code/app". */
const placeLabel = (host, dir) => `${host}: ${dir}`;

// ---- what went wrong, in plain words

// ssh and our own scripts fail in their own words; each becomes a sentence for
// the panel (session errors, the setup card). Most specific first.
const TROUBLES = [
  { kind: 'remote-no-claude', test: /shellby: claude: command not found|claude: (command )?not found/i, message: "Claude Code isn't installed on that computer yet." },
  { kind: 'remote-no-folder', test: /shellby: no folder/i, message: "That folder isn't on the other computer any more." },
  { kind: 'remote-host-key', test: /REMOTE HOST IDENTIFICATION HAS CHANGED|host key verification failed|host key for .* has changed/i, message: "That computer's identity changed since Shellby last connected, so ssh refused to trust it. If you reinstalled it, remove its line from known_hosts and connect again." },
  { kind: 'remote-auth', test: /permission denied \((?:publickey|password|keyboard-interactive|gssapi)|too many authentication failures|no supported authentication methods available/i, message: "That computer didn't accept the sign-in. Set up sign-in for it in Settings, under Other computers." },
  { kind: 'remote-name', test: /could not resolve hostname|name or service not known|no such host/i, message: "Shellby couldn't find that computer by name. Check its address under Other computers." },
  { kind: 'remote-unreachable', test: /ssh: connect to host|connection timed out during banner|connection closed by \S+ port \d+|connection reset by \S+ port \d+|kex_exchange_identification|no route to host|network is unreachable/i, message: "Shellby couldn't reach that computer. Is it on, and is the network up?" },
];

/** -> { kind, message } | null */
function troubleOf(text) {
  const t = String(text || '');
  const hit = TROUBLES.find(k => k.test.test(t));
  return hit ? { kind: hit.kind, message: hit.message } : null;
}

module.exports = {
  MARK, MCP_FILE,
  isHost, isUser, isAddress, isPort, isRemoteDir, cleanDir,
  shQuote, shDir, wrap,
  sessionScript, probeScript, parseProbe, installScript, signInScript, resumeScript, listScript, parseList, authorizeScript,
  sshArgs, parseResolved, parseConfig, hostBlock, appendBlock,
  anchorName, anchorFor, placeLabel, troubleOf,
};
