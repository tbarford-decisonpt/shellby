// Ready-made hooks for Toolbox → Hooks, and a plain sentence for any hook.
//
// Every recipe is one line of bash, because that's what Claude Code runs hook
// commands with (Git Bash on Windows), wrapped in `bash -c '…'` the way the
// status line is, so it works whichever shell starts it. They use nothing but
// grep, sed and the like, so there's nothing to install, and they're short
// enough that the confirm window shows all of each one.
//
// Claude Code sends a hook the details as JSON on stdin. A command that exits 2
// blocks the step (where that moment can be blocked) and what it printed to
// stderr goes to Claude; what SessionStart and UserPromptSubmit hooks print to
// stdout is added to what Claude knows. test/hook-recipes.test.js runs them.

// "file_path": "…" out of the JSON on stdin (the first one).
const FILE_PATH = 'grep -oE "\\"file_path\\": *\\"[^\\"]*\\"" | head -n1';

const RECIPES = [
  {
    id: 'sound-done', group: 'notify', icon: '🔔',
    title: 'Play a sound when Claude finishes',
    blurb: "A chime each time Claude finishes replying, so you can look away while it works.",
    event: 'Stop', matcher: '', scope: 'user',
    command: "bash -c 'powershell.exe -NoProfile -Command \"[System.Media.SystemSounds]::Asterisk.Play(); Start-Sleep -Milliseconds 800\"'",
  },
  {
    id: 'sound-ask', group: 'notify', icon: '🙋',
    title: 'Play a sound when Claude needs you',
    blurb: 'A different chime when Claude is waiting for your permission or your reply.',
    event: 'Notification', matcher: '', scope: 'user',
    command: "bash -c 'powershell.exe -NoProfile -Command \"[System.Media.SystemSounds]::Exclamation.Play(); Start-Sleep -Milliseconds 800\"'",
  },
  {
    id: 'guard-git', group: 'guard', icon: '🛑',
    title: 'Stop force-pushes and hard resets',
    blurb: "Catches the usual ways Claude would run git push --force, git reset --hard or git clean ‑f, and tells it to ask you to run them yourself.",
    event: 'PreToolUse', matcher: 'Bash', scope: 'user',
    command: "bash -c 'if grep -qE \"git +push[^\\\"]*--force([^-]|$)|git +push[^\\\"]* (-f\\b|\\+[^ ])|git +reset +--hard|git +clean +(-[a-zA-Z]*f|[^\\\"]*--force)\"; then echo \"A hook blocked this because it can throw away work. Ask the user to run it themselves if they want it.\" >&2; exit 2; fi'",
    sample: { tool_name: 'Bash', tool_input: { command: 'git push --force origin main', description: 'Force-push main' } },
  },
  {
    id: 'guard-secrets', group: 'guard', icon: '🔒',
    title: 'Keep Claude out of secret files',
    blurb: 'Claude\'s Edit and Write tools can\'t change .env files, private keys or .pem certificates.',
    event: 'PreToolUse', matcher: 'Edit|Write|MultiEdit', scope: 'user',
    // The file's own name: .env (and .env.local…, not .env.example), keys and certificates. Not .environment.ts.
    command: String.raw`bash -c 'p=$(${FILE_PATH}); if echo "$p" | grep -qiE "[\\/\"](\.env(\.[a-z0-9_-]+)?|id_rsa|id_ed25519|[^\\/\"]*\.(pem|key))\"$" && ! echo "$p" | grep -qiE "\.(example|sample|template)\"$"; then echo "A hook blocked this: that file holds secrets. Ask the user to change it themselves." >&2; exit 2; fi'`,
    sample: { tool_name: 'Edit', tool_input: { file_path: '{cwd}/.env', old_string: 'API_KEY=old', new_string: 'API_KEY=new' } },
  },
  {
    id: 'log-commands', group: 'guard', icon: '📒',
    title: 'Keep a log of commands Claude runs',
    blurb: 'Adds every shell command Claude is about to run to ~/.claude/command-log.jsonl, one line each.',
    tweak: 'Commands can contain passwords or keys, and the log keeps them as written.',
    event: 'PreToolUse', matcher: 'Bash', scope: 'user',
    command: "bash -c 'f=\"$HOME/.claude/command-log.jsonl\"; mkdir -p \"$HOME/.claude\"; cat >> \"$f\"; echo >> \"$f\"'",
  },
  {
    id: 'prettier', group: 'tidy', icon: '✨',
    title: 'Tidy files with Prettier after edits',
    blurb: 'Formats each file Claude edits. Only does anything in projects that have Prettier installed.',
    event: 'PostToolUse', matcher: 'Edit|Write|MultiEdit', scope: 'project', timeout: 30,
    // A test run shouldn't reformat a real file: this one isn't there.
    sample: { tool_name: 'Edit', tool_input: { file_path: '{cwd}/shellby-test-run/not-a-real-file.js', old_string: 'a', new_string: 'b' } },
    command: `bash -c 'f=$(${FILE_PATH} | sed -E "s/^\\"file_path\\": *\\"//; s/\\"$//; s/\\\\\\\\\\\\\\\\/\\//g"); case "$f" in ""|-*) exit 0;; esac; npx --no-install prettier --write --ignore-unknown "$f" >/dev/null 2>&1; exit 0'`,
  },
  {
    id: 'tests-pass', group: 'tidy', icon: '✅',
    title: 'Run the tests before Claude finishes',
    blurb: 'Runs npm test when Claude is about to stop. If they fail, Claude keeps going and fixes them.',
    tweak: 'Swap npm test for your own test command if the project uses something else.',
    event: 'Stop', matcher: '', scope: 'project', timeout: 300,
    command: "bash -c 'grep -q \"\\\"stop_hook_active\\\": *true\" && exit 0; [ -f package.json ] || exit 0; npm test >/dev/null 2>&1 || { echo \"The tests are failing. Fix them before you finish.\" >&2; exit 2; }'",
  },
  {
    id: 'git-context', group: 'context', icon: '🌿',
    title: 'Tell Claude the git status when a session starts',
    blurb: 'Claude starts each session knowing the branch and which files have changed.',
    event: 'SessionStart', matcher: '', scope: 'user',
    command: "bash -c 'git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0; echo \"Git status when this session started:\"; git status --short --branch | head -n 30'",
  },
  {
    id: 'reminder', group: 'context', icon: '📌',
    title: 'Remind Claude of something with every message',
    blurb: 'Adds a line of your own to each message you send, for a rule Claude keeps forgetting.',
    tweak: 'Change the reminder to whatever Claude should keep in mind.',
    event: 'UserPromptSubmit', matcher: '', scope: 'project',
    command: "bash -c 'echo \"Reminder: keep changes small, and run the tests before saying something works.\"'",
  },
];

const GROUPS = [
  { id: 'notify', title: 'Get a nudge' },
  { id: 'guard', title: 'Keep things safe' },
  { id: 'tidy', title: 'Check and tidy work' },
  { id: 'context', title: 'Tell Claude more' },
];

const BY_COMMAND = new Map(RECIPES.map(r => [r.command, r]));

// Script files worth naming: "Runs check.js".
const SCRIPT = /([\w.-]+\.(?:m?js|cjs|ts|py|ps1|sh|rb|bat|cmd))\b/i;
// Launchers whose next word is the real program: npx prettier -> prettier.
const LAUNCHER = new Set(['npx', 'pnpx', 'bunx', 'uvx', 'pipx', 'dlx', 'exec', 'run', 'pnpm', 'yarn', 'call', 'start']);
const SHELL = /^(?:ba|z|da)?sh$|^(?:cmd|pwsh|powershell)$/i;

const bare = word => word.replace(/^["']|["']$/g, '').replace(/^.*[\\/]/, '').replace(/\.(exe|cmd|bat)$/i, '');

/** What a command does, as far as its first words say. */
function describeCommand(command) {
  const c = String(command || '').trim();
  if (!c) return 'Runs nothing (the command is empty)';
  const script = c.match(SCRIPT);
  if (script) return `Runs ${script[1]}`;
  // A quoted first word is one word, spaces and all ("C:\Program Files\…\tool.exe").
  const quoted = c.match(/^(["'])(.+?)\1/);
  const words = (quoted ? [quoted[2], ...c.slice(quoted[0].length).split(/\s+/)] : c.split(/\s+/)).map(bare).filter(Boolean);
  const first = words[0] || '';
  if (SHELL.test(first)) {
    if (/^(cmd|pwsh|powershell)$/i.test(first)) return 'Runs a PowerShell or Command Prompt line';
    return 'Runs a shell one-liner';
  }
  if (/^node$/i.test(first) && /\s-(e|p)\s/.test(` ${c} `)) return 'Runs a line of JavaScript';
  if (/^(echo|printf)$/i.test(first)) return 'Prints a message';
  let i = 0;
  while (i < words.length - 1 && LAUNCHER.has(words[i].toLowerCase())) i++;
  return `Runs ${words[i] || first}`;
}

/**
 * A short label for one listed hook: the recipe it came from, or a guess from
 * its command. { summary, icon, recipe }
 */
function describeHook(row) {
  const recipe = row && row.type === 'command' ? BY_COMMAND.get(row.command) : null;
  if (recipe) return { summary: recipe.title, icon: recipe.icon, recipe: recipe.id };
  if (row?.type === 'prompt') return { summary: 'Asks Claude to check something', icon: '💬', recipe: null };
  if (row?.type === 'http') {
    let host = '';
    try { host = new URL(row.command).host; } catch { /* not a URL */ }
    return { summary: host ? `Sends the details to ${host}` : 'Sends the details to a web address', icon: '🌐', recipe: null };
  }
  return { summary: describeCommand(row?.command), icon: null, recipe: null };
}

module.exports = { RECIPES, GROUPS, describeHook, describeCommand };
