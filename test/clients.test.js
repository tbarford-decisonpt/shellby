// Naming the app an outside Claude Code session runs in. Two halves are tested
// here: the pure mapping in src/main/clients.js, and the shell that works out
// the token (claude-plugin/hooks/notify.sh), which is run for real with a
// faked environment -- it is the part most likely to be quietly wrong, and a
// hook that misbehaves is a hook that slows every tool call down.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { clientOf, describeClient, parseToken, HOSTS } = require('../src/main/clients');

// ------------------------------------------------------------------ mapping

test('a known host token names the app and says what kind it is', () => {
  assert.deepEqual(clientOf({ host: 'cursor' }), { label: 'Cursor', kind: 'editor' });
  assert.deepEqual(clientOf({ host: 'wt' }), { label: 'Windows Terminal', kind: 'terminal' });
  assert.deepEqual(clientOf({ host: 'jetbrains' }), { label: 'JetBrains', kind: 'editor' });
  assert.deepEqual(clientOf({ host: 'VSCODE' }), { label: 'VS Code', kind: 'editor' }, 'case-insensitive');
});

test('the host token beats the entrypoint, which is only a fallback', () => {
  // Claude Code says "vscode" for every VS Code fork; the token knows better.
  assert.equal(clientOf({ host: 'cursor', entry: 'vscode' }).label, 'Cursor');
  assert.equal(clientOf({ host: '', entry: 'vscode' }).label, 'VS Code');
  assert.deepEqual(clientOf({ entry: 'cli' }), { label: 'the terminal', kind: 'terminal' });
  assert.deepEqual(clientOf({ entry: 'sse-ide' }), { label: 'an editor', kind: 'editor' });
  assert.deepEqual(clientOf({ entry: 'mcp' }), { label: 'an MCP client', kind: null });
});

test('an unknown or hostile token falls back to no label at all', () => {
  for (const host of ['', null, undefined, 'nope', 'a'.repeat(40), 'drop table', '../../etc', '<script>']) {
    assert.deepEqual(clientOf({ host }), { label: null, kind: null }, String(host));
  }
  assert.deepEqual(clientOf(), { label: null, kind: null });
  assert.deepEqual(clientOf({}), { label: null, kind: null });
});

test('parseToken only lets short lowercase words through', () => {
  assert.equal(parseToken('Cursor'), 'cursor');
  assert.equal(parseToken('  wt  '), 'wt');
  assert.equal(parseToken('sse-ide'), 'sse-ide');
  assert.equal(parseToken('has space'), null);
  assert.equal(parseToken('semi;colon'), null);
  assert.equal(parseToken('\u0000'), null);
  assert.equal(parseToken(17), null);
});

test('describeClient reads as a phrase, and degrades to just the folder', () => {
  assert.equal(describeClient('shellby', clientOf({ host: 'cursor' })), 'shellby in Cursor');
  assert.equal(describeClient('shellby', clientOf({ entry: 'cli' })), 'shellby in the terminal');
  assert.equal(describeClient('shellby', clientOf({ host: 'nope' })), 'shellby');
  assert.equal(describeClient('', null), 'Claude Code');
  assert.equal(describeClient('x'.repeat(200), null).length, 60);
});

test('every host token maps to a label and a kind', () => {
  for (const [token, [label, kind]] of Object.entries(HOSTS)) {
    assert.ok(parseToken(token) === token, `${token} is a valid token`);
    assert.ok(label && label.length < 24, `${token} has a short label`);
    assert.ok(kind === 'editor' || kind === 'terminal', `${token} is an editor or a terminal`);
  }
});

// ------------------------------------------------------------------ the hook

const HOOK = path.join(__dirname, '..', 'claude-plugin', 'hooks', 'notify.sh');
const bash = (() => {
  for (const b of ['C:/Program Files/Git/bin/bash.exe', '/usr/bin/bash', '/bin/bash']) {
    if (fs.existsSync(b)) return b;
  }
  return null;
})();

// A sandbox the hook runs in for real: a stub `curl` earlier on PATH than the
// real one, which records the headers it was handed, and the marker file the
// hook checks before it does anything at all.
const SANDBOX = path.join(__dirname, 'clients-sandbox');
const ARGS_FILE = path.join(SANDBOX, 'args.txt');

const sh = p => p.replace(/\\/g, '/');
// A PATH entry can't keep its drive letter: PATH is colon-separated, so
// "C:/x/bin" would read as the two entries "C" and "/x/bin". Git Bash wants
// "/c/x/bin" instead.
const msys = p => sh(p).replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`);

function setupSandbox() {
  fs.mkdirSync(path.join(SANDBOX, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(SANDBOX, 'tmp'), { recursive: true });
  // The hook redirects curl's output to /dev/null, so the stub writes to a file.
  fs.writeFileSync(path.join(SANDBOX, 'bin', 'curl'),
    '#!/usr/bin/env bash\nprintf "%s\\n" "$@" > "$SHELLBY_TEST_ARGS"\nexit 0\n');
  fs.chmodSync(path.join(SANDBOX, 'bin', 'curl'), 0o755);
  fs.writeFileSync(path.join(SANDBOX, 'tmp', 'shellby-hooks-47913'), 'test');
}

/**
 * Run notify.sh exactly as shipped, with a chosen environment, and read back
 * the host token it put on the wire.
 */
function tokenFor(env) {
  fs.rmSync(ARGS_FILE, { force: true });
  execFileSync(bash, ['-c', `PATH="${msys(path.join(SANDBOX, 'bin'))}:$PATH" bash ${JSON.stringify(sh(HOOK))} < /dev/null`], {
    env: {
      PATH: process.env.PATH,
      TEMP: path.join(SANDBOX, 'tmp'),
      SHELLBY_TEST_ARGS: sh(ARGS_FILE),
      ...env,
    },
    encoding: 'utf8',
  });
  const args = fs.existsSync(ARGS_FILE) ? fs.readFileSync(ARGS_FILE, 'utf8').split('\n') : [];
  const header = args.find(a => a.startsWith('X-Shellby-Host:'));
  assert.ok(header !== undefined, 'the hook sent an X-Shellby-Host header');
  return header.slice('X-Shellby-Host:'.length).trim();
}

test('the hook recognises the editors and terminals it claims to', { skip: !bash && 'no bash' }, () => {
  setupSandbox();
  const cases = [
    [{ TERM_PROGRAM: 'vscode', VSCODE_GIT_ASKPASS_NODE: 'C:\\Users\\jo\\AppData\\Local\\Programs\\cursor\\Cursor.exe' }, 'cursor'],
    [{ TERM_PROGRAM: 'vscode', VSCODE_GIT_ASKPASS_NODE: 'C:\\Users\\jo\\AppData\\Local\\Programs\\Windsurf\\Windsurf.exe' }, 'windsurf'],
    [{ TERM_PROGRAM: 'vscode', VSCODE_GIT_ASKPASS_NODE: 'C:\\Program Files\\Microsoft VS Code\\Code.exe' }, 'vscode'],
    [{ TERM_PROGRAM: 'vscode' }, 'vscode'],
    [{ TERM_PROGRAM: 'zed' }, 'zed'],
    [{ TERM_PROGRAM: 'Apple_Terminal' }, 'appleterm'],
    [{ TERMINAL_EMULATOR: 'JetBrains-JediTerm' }, 'jetbrains'],
    [{ WT_SESSION: 'de4a1b1e-0000' }, 'wt'],
    [{ ConEmuPID: '4242' }, 'conemu'],
    [{ WEZTERM_PANE: '0' }, 'wezterm'],
    [{ VSAPPIDNAME: 'devenv.exe' }, 'vs'],
    [{}, ''],
  ];
  for (const [env, expected] of cases) {
    assert.equal(tokenFor(env), expected, JSON.stringify(env));
  }
});

test('every token the hook can emit is one the mapping knows', { skip: !bash && 'no bash' }, () => {
  const src = fs.readFileSync(HOOK, 'utf8');
  const assigned = [...src.matchAll(/\bhost=([a-z]+)\b/g)].map(m => m[1]).filter(t => t !== 'host');
  assert.ok(assigned.length > 8, `found ${assigned.length} tokens in the hook`);
  for (const t of new Set(assigned)) {
    assert.ok(HOSTS[t], `the hook can send "${t}" but clients.js has no name for it`);
  }
});

test('the hook prints nothing, calls nothing and exits 0 with nobody listening', { skip: !bash && 'no bash' }, () => {
  setupSandbox();
  fs.rmSync(ARGS_FILE, { force: true });

  // No marker file: the hook must skip before it even reaches curl, because on
  // Windows a refused localhost connection costs about a second per tool call.
  const out = execFileSync(bash, ['-c',
    `PATH="${msys(path.join(SANDBOX, 'bin'))}:$PATH" bash ${JSON.stringify(sh(HOOK))} < /dev/null; echo "exit=$?"`], {
    env: {
      PATH: process.env.PATH,
      TEMP: path.join(SANDBOX, 'no-such-dir'),
      SHELLBY_TEST_ARGS: sh(ARGS_FILE),
      TERM_PROGRAM: 'vscode',
    },
    encoding: 'utf8',
  });
  assert.equal(out.trim(), 'exit=0', 'exits 0 and says nothing else');
  assert.equal(fs.existsSync(ARGS_FILE), false, 'curl was never called');
});

test('a marker a crash left behind is skipped like a missing one', { skip: !bash && 'no bash' }, () => {
  setupSandbox();
  const marker = path.join(SANDBOX, 'tmp', 'shellby-hooks-47913');
  // Shellby touches it every minute; five minutes untouched means he's gone.
  const old = new Date(Date.now() - 5 * 60 * 1000);
  fs.utimesSync(marker, old, old);
  fs.rmSync(ARGS_FILE, { force: true });
  const run = () => execFileSync(bash, ['-c', `PATH="${msys(path.join(SANDBOX, 'bin'))}:$PATH" bash ${JSON.stringify(sh(HOOK))} < /dev/null; echo "exit=$?"`], {
    env: { PATH: process.env.PATH, TEMP: path.join(SANDBOX, 'tmp'), SHELLBY_TEST_ARGS: sh(ARGS_FILE) },
    encoding: 'utf8',
  });
  assert.equal(run().trim(), 'exit=0');
  assert.equal(fs.existsSync(ARGS_FILE), false, 'curl was never called');
  // Touched again (Shellby is back): the hook goes through.
  fs.utimesSync(marker, new Date(), new Date());
  assert.equal(run().trim(), 'exit=0');
  assert.equal(fs.existsSync(ARGS_FILE), true, 'curl was called');
});

test.after(() => fs.rmSync(SANDBOX, { recursive: true, force: true }));
