// Moving a conversation between Shellby and a terminal, both ways (pure).
//
// Continue in terminal: a tab's process is stopped and the same conversation
// opens in Windows Terminal (or PowerShell, or cmd) as an interactive
// `claude --resume <id>`, with the same CLI and the same "Always use my Claude
// plan" scrubbing Shellby's own sessions get. Bring into Shellby: a session the
// plugin reported from a terminal or editor (external.js) opens as a tab.
//
// Everything a folder name or an id could smuggle onto a command line is
// decided here, so it's all unit-tested: ids must look like Claude Code's
// UUIDs, and the folder and the CLI's path reach PowerShell only inside an
// -EncodedCommand script, as single-quoted literals.
const path = require('path');

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const MAX_PATH = 1024;
// cmd.exe reads these as its own syntax even inside a quoted program path, so
// the cmd fallback is only offered when the CLI's path has none of them.
const CMD_SPECIAL = /["%^&|<>!]/;
// PowerShell takes the curly single quotes as quote marks too, so all four are
// doubled, not just the ASCII one.
const PS_QUOTES = /['‘’‚‛]/g;

// The names the panel uses for each way of opening one.
const SHELL_NAMES = { wt: 'Windows Terminal', powershell: 'PowerShell', cmd: 'Command Prompt' };

/** Is this a Claude Code session id? (A UUID; anything else is refused.) */
const isSessionId = s => typeof s === 'string' && SESSION_ID.test(s);

// A drive letter: never a UNC or device path (\\host\share, \\?\), which a hook
// on the local port could name to make Shellby reach out to another machine.
const LOCAL_DRIVE = /^[A-Za-z]:[\\/]/;

/** A full local Windows path with nothing odd in it: no control characters, not absurdly long. */
const safePath = p => typeof p === 'string' && p.length > 2 && p.length < MAX_PATH && !CONTROL.test(p) && LOCAL_DRIVE.test(p) && path.win32.isAbsolute(p);

/** A PowerShell single-quoted literal: nothing inside it is ever expanded or run. */
const psQuote = s => `'${String(s).replace(PS_QUOTES, m => m + m)}'`;

/**
 * Where the terminal should open: the conversation's own copy of the repo if it
 * has one that's still there, otherwise its folder. exists(dir) is injected.
 * -> path | null
 */
function terminalCwd({ cwd, worktree = null } = {}, exists = () => true) {
  const candidates = [worktree?.cwd, worktree?.path, cwd];
  return candidates.find(c => safePath(c) && exists(c)) || null;
}

/**
 * The PowerShell that runs in the new window: drop what shouldn't reach Claude
 * Code (Shellby's own marker, and the billing variables if you asked for your
 * plan only), go to the folder, and resume. Removed here rather than only from
 * our own environment, because a Windows Terminal that is already open starts
 * new tabs with its own environment, not ours.
 */
function resumeScript({ exe, cwd, sessionId, scrub = [] }) {
  const drop = ['SHELLBY_OWNED', ...scrub].filter(v => ENV_NAME.test(v));
  return [
    ...[...new Set(drop)].map(v => `Remove-Item -LiteralPath 'Env:${v}' -ErrorAction SilentlyContinue`),
    `Set-Location -LiteralPath ${psQuote(cwd)}`,
    `& ${psQuote(exe)} --resume ${sessionId}`,
  ].join('\n');
}

/** PowerShell's -EncodedCommand form: base64 of UTF-16LE, so nothing needs quoting. */
const encodeScript = script => Buffer.from(script, 'utf16le').toString('base64');

/**
 * Open a console program in a window of its own, through cmd's `start`. Spawned
 * directly, it can't have one: detached (so closing Shellby doesn't close the
 * terminal) means DETACHED_PROCESS on Windows, which runs it with no console at
 * all, started but invisible. The line is passed verbatim: program comes from
 * System32 and rest is only flags, base64 and checked paths and ids.
 */
const viaStart = (cmd, program, rest, options) => ({
  file: cmd,
  args: ['/d', '/c', `start "" "${program}" ${rest.join(' ')}`],
  options: { ...options, windowsVerbatimArguments: true },
});

/**
 * How to open the conversation in a terminal, best first. Each plan is what
 * child_process.spawn takes. wt, powershell, cmd: full paths (wt may be null
 * when Windows Terminal isn't installed). env: the environment for the new
 * window, already scrubbed (claude-cli.js terminalEnv).
 *   -> { ok: true, plans: [{ shell, file, args, options }] } | { ok: false, error }
 */
function launchPlans({ exe, cwd, sessionId, scrub = [], env = undefined, wt = null, powershell = null, cmd = null }) {
  if (!isSessionId(sessionId)) return { ok: false, error: "That conversation's id doesn't look like Claude Code's, so Shellby won't put it on a command line." };
  if (!safePath(exe)) return { ok: false, error: 'Shellby can’t find Claude Code to run in the terminal.' };
  if (!safePath(cwd)) return { ok: false, error: "That conversation's folder has a name Shellby can't safely open a terminal in." };
  const options = { cwd, env, detached: true, stdio: 'ignore', windowsHide: false };
  const encoded = encodeScript(resumeScript({ exe, cwd, sessionId, scrub }));
  const psArgs = ['-NoLogo', '-NoExit', '-EncodedCommand', encoded];
  const plans = [];
  // Windows Terminal reads ; as "and then another tab", even inside -d, so a
  // folder with one in its name is left to the script's Set-Location.
  if (safePath(wt) && safePath(powershell)) {
    plans.push({ shell: 'wt', file: wt, args: ['-w', 'new', ...(cwd.includes(';') ? [] : ['-d', cwd]), powershell, ...psArgs], options });
  }
  // The rest go through cmd's start (viaStart), so cmd and the program must both
  // be free of what cmd would read as its own syntax.
  const startable = p => safePath(p) && !CMD_SPECIAL.test(p);
  if (startable(cmd) && startable(powershell)) plans.push({ shell: 'powershell', ...viaStart(cmd, powershell, psArgs, options) });
  // cmd gets no script: the folder is the process's working directory and the
  // environment is already scrubbed, so only the CLI's path and the id are on its line.
  if (startable(cmd) && startable(exe)) plans.push({ shell: 'cmd', ...viaStart(cmd, cmd, ['/d', '/k', `"${exe}"`, '--resume', sessionId], options) });
  return plans.length ? { ok: true, plans } : { ok: false, error: 'Shellby couldn’t find a terminal to open.' };
}

/**
 * Try each plan until one starts. spawn is child_process.spawn (injected).
 * -> Promise<{ ok: true, shell } | { ok: false, error }>. Never rejects.
 */
async function launch(plans, spawn) {
  for (const plan of plans || []) {
    let child;
    try { child = spawn(plan.file, plan.args, plan.options); } catch { continue; }
    const started = await new Promise(resolve => {
      child.once('spawn', () => resolve(true));
      child.once('error', () => resolve(false));
    });
    if (!started) continue;
    child.unref?.();
    return { ok: true, shell: plan.shell };
  }
  return { ok: false, error: 'Shellby couldn’t open a terminal on this PC.' };
}

/**
 * Can this tab go to a terminal now? tab: { busy, pending, crew, sessionId, resumeAt }.
 * -> { ok: true } | { ok: false, error }
 */
function continueCheck({ busy = false, pending = 0, crew = 0, sessionId = null, resumeAt = null } = {}) {
  if (busy || pending || crew) return { ok: false, error: "He's still working on this one. Let him finish (or stop him), then carry on in a terminal." };
  if (!sessionId) return { ok: false, error: 'Nothing to carry on with yet: send this conversation something first.' };
  if (!isSessionId(sessionId)) return { ok: false, error: "That conversation's id doesn't look like Claude Code's, so Shellby won't put it on a command line." };
  if (resumeAt) return { ok: false, error: 'This conversation was just rewound. Send it one message here first, so the terminal picks up from the right place.' };
  return { ok: true };
}

const normDir = d => String(d || '').replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase();

/**
 * Which outside session `shellby take` means: the one with that id, or else the
 * one in this folder heard from most recently (the one running the command),
 * or else one a level or more above it. sessions: external.js summary rows.
 */
function externalFor(sessions, { id = null, cwd = null } = {}) {
  const list = (Array.isArray(sessions) ? sessions : []).filter(s => isSessionId(s?.id));
  if (id) return list.find(s => s.id === id) || null;
  const here = normDir(cwd);
  if (!here) return null;
  const newest = xs => xs.sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0))[0] || null;
  return newest(list.filter(s => normDir(s.cwd) === here))
    || newest(list.filter(s => s.cwd && here.startsWith(`${normDir(s.cwd)}\\`)));
}

/**
 * Should "Bring it into Shellby" go ahead? session: an external.js row (client
 * is the app's name, "Windows Terminal"), with `live` while it's still open. force: you said it's closed.
 * fromInside: asked for by the session itself (`shellby take`), which is
 * necessarily still open and mid-turn: the reply tells you to /exit.
 *   -> { ok: true, warning? } | { ok: false, error, confirm? }
 */
function bringInCheck(session, { force = false, fromInside = false } = {}) {
  if (!session) return { ok: false, error: "Shellby has lost track of that session. If it's still open, say something in it and try again." };
  if (!isSessionId(session.id)) return { ok: false, error: "That session's id doesn't look like Claude Code's, so Shellby can't pick it up." };
  if (!safePath(session.cwd)) return { ok: false, error: "Shellby doesn't know which folder that session is in." };
  const where = session.client || 'its terminal';
  if (fromInside) return { ok: true, warning: `Type /exit in ${where} before you send anything in Shellby, so the two don't trip over each other.` };
  if (!session.live) return { ok: true };
  if (session.state === 'working' || session.state === 'asking') {
    return { ok: false, error: `It's still working in ${where}. Let it finish, type /exit there, then bring it in.` };
  }
  if (!force) return { ok: false, confirm: true, error: `That session is still open in ${where}, in ${session.cwd}. Type /exit there first: two copies of one conversation trip over each other.` };
  return { ok: true };
}

/**
 * The external → tab mapping: the History entry already holding this Claude
 * Code session (one you sent to a terminal, coming back), newest first.
 */
function entryFor(entries, sessionId) {
  if (!isSessionId(sessionId)) return null;
  return (Array.isArray(entries) ? entries : [])
    .filter(e => e && e.claudeSessionId === sessionId)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0] || null;
}

/** A name for a conversation brought in from outside. */
function titleFor(session) {
  const project = String(session?.project || 'Claude Code').slice(0, 40);
  const from = session?.client || 'a terminal';
  return `${project}, from ${from}`;
}

module.exports = {
  isSessionId, safePath, psQuote, terminalCwd, resumeScript, encodeScript, launchPlans, launch,
  continueCheck, externalFor, bringInCheck, entryFor, titleFor, SHELL_NAMES,
};
