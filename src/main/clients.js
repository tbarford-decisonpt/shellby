// Which app a Claude Code session outside Shellby is running in: VS Code,
// Cursor, Windsurf, Zed, a JetBrains IDE, Windows Terminal, or a plain shell.
// Before this, every outside session was just "Claude Code", which is not very
// useful once you have three of them open in different places.
//
// The plugin's hook (claude-plugin/hooks/notify.sh) works out a one-word token
// from its own environment and sends it as a header. It deliberately sends a
// token and not the path it found it in: those paths carry the user's name, and
// Shellby promises to keep only the event, the tool, the folder name and the
// session id. Everything here is pure, so it is all unit-tested.

// token -> what to call it, and whether it's an editor or a terminal.
const HOSTS = Object.freeze({
  vscode: ['VS Code', 'editor'],
  cursor: ['Cursor', 'editor'],
  windsurf: ['Windsurf', 'editor'],
  zed: ['Zed', 'editor'],
  jetbrains: ['JetBrains', 'editor'],
  vs: ['Visual Studio', 'editor'],
  wt: ['Windows Terminal', 'terminal'],
  conemu: ['ConEmu', 'terminal'],
  alacritty: ['Alacritty', 'terminal'],
  wezterm: ['WezTerm', 'terminal'],
  tabby: ['Tabby', 'terminal'],
  hyper: ['Hyper', 'terminal'],
  ghostty: ['Ghostty', 'terminal'],
  warp: ['Warp', 'terminal'],
  kitty: ['kitty', 'terminal'],
  iterm: ['iTerm', 'terminal'],
  appleterm: ['Terminal', 'terminal'],
  powershell: ['PowerShell', 'terminal'],
  cmd: ['Command Prompt', 'terminal'],
});

// Claude Code's own CLAUDE_CODE_ENTRYPOINT, for when the host token says
// nothing. It knows it is talking to an IDE extension but not which one.
const ENTRYPOINTS = Object.freeze({
  vscode: ['VS Code', 'editor'],
  'sse-ide': ['an editor', 'editor'],
  'ws-ide': ['an editor', 'editor'],
  jetbrains: ['JetBrains', 'editor'],
  cli: ['the terminal', 'terminal'],
  mcp: ['an MCP client', null],
  sdk: ['the SDK', null],
  'sdk-ts': ['the SDK', null],
  'sdk-py': ['the SDK', null],
});

const TOKEN_RE = /^[a-z0-9-]{1,16}$/;

/** A header value from the hook -> a known token, or null. */
function parseToken(raw) {
  if (typeof raw !== 'string') return null;   // headers are text; anything else is a mistake
  const t = raw.trim().toLowerCase().slice(0, 16);
  return TOKEN_RE.test(t) ? t : null;
}

/**
 * What to call this session's host.
 *   { label, kind }  kind: 'editor' | 'terminal' | null
 * The host token wins when we have one; otherwise Claude Code's entrypoint is
 * a weaker hint. Unknown on both counts is a null label: the caller then says
 * "Claude Code", exactly as it did before any of this existed.
 */
function clientOf({ host, entry } = {}) {
  const h = parseToken(host);
  if (h && HOSTS[h]) return { label: HOSTS[h][0], kind: HOSTS[h][1] };
  const e = parseToken(entry);
  if (e && ENTRYPOINTS[e]) return { label: ENTRYPOINTS[e][0], kind: ENTRYPOINTS[e][1] };
  return { label: null, kind: null };
}

/**
 * The one-line description the crew lane and the session list show:
 *   "shellby in Cursor", or just "shellby" when we can't tell.
 */
function describeClient(project, client) {
  const name = String(project || 'Claude Code').slice(0, 60);
  const label = client?.label;
  // "the terminal" and "an editor" already read as a phrase; names don't.
  return label ? `${name} in ${label}` : name;
}

module.exports = { clientOf, describeClient, parseToken, HOSTS, ENTRYPOINTS };
