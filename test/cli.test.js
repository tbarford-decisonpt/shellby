// The `shellby` command. Two things are worth testing hard here:
//
//  - the PATH maths, because getting it wrong is the one thing in Shellby that
//    could really ruin someone's afternoon;
//  - the CLI end to end, run as a real process against a stub Shellby, because
//    argument parsing and exit codes are what a shell actually sees.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  newToken, tokenMatches, cmdShim, shShim, ps1Shim,
  isOnPath, pathWith, pathWithout, parseTaskRequest, parseFlowRequest, settingChangeArgs,
} = require('../src/main/clipath');
const { parseArgs, MODES, MAX_PROMPT, EXIT, INPUT_KEY, MAX_INPUTS, MAX_INPUT_VALUE, MAX_FLOW_NAME } = require('../src/cli/shellby');
const crabtools = require('../src/main/crabtools');

const CLI = path.join(__dirname, '..', 'src', 'cli', 'shellby.js');

// ------------------------------------------------------------------ the token

test('tokens are long, unguessable and single-line', () => {
  const a = newToken();
  const b = newToken();
  assert.notEqual(a, b);
  assert.ok(a.length >= 40, `${a.length} characters`);
  assert.match(a, /^[A-Za-z0-9_-]+$/, 'base64url: safe in a header and in a file');
});

test('tokenMatches is exact, and refuses anything that is not a string', () => {
  const t = newToken();
  assert.equal(tokenMatches(t, t), true);
  assert.equal(tokenMatches(t, `${t}x`), false);
  assert.equal(tokenMatches(t, t.slice(0, -1)), false);
  // Same length, last character definitely different (a token already ending
  // in 'A' would otherwise make this assertion a no-op about once a run).
  assert.equal(tokenMatches(t, t.slice(0, -1) + (t.endsWith('A') ? 'B' : 'A')), false);
  for (const bad of [null, undefined, 0, {}, [], Buffer.from(t)]) assert.equal(tokenMatches(t, bad), false);
  assert.equal(tokenMatches('', ''), false, 'no token means no access, not free access');
  assert.equal(tokenMatches(null, null), false);
});

// ------------------------------------------------------------------ PATH maths

test('isOnPath ignores case, trailing slashes, quotes and slash direction', () => {
  const dir = 'C:\\Users\\jo\\AppData\\Local\\Shellby\\bin';
  assert.equal(isOnPath(`C:\\Windows;${dir}`, dir), true);
  assert.equal(isOnPath(`C:\\Windows;${dir.toUpperCase()}`, dir), true);
  assert.equal(isOnPath(`C:\\Windows;${dir}\\`, dir), true);
  assert.equal(isOnPath(`C:\\Windows;"${dir}"`, dir), true);
  assert.equal(isOnPath(`C:\\Windows;C:/Users/jo/AppData/Local/Shellby/bin`, dir), true);
  assert.equal(isOnPath('C:\\Windows;C:\\Other', dir), false);
  assert.equal(isOnPath('', dir), false);
  assert.equal(isOnPath(null, dir), false);
  // A folder whose name merely starts the same is not the same folder.
  assert.equal(isOnPath(`C:\\Windows;${dir}2`, dir), false);
});

test('pathWith appends once and never twice', () => {
  const dir = 'C:\\S\\bin';
  assert.equal(pathWith('C:\\Windows', dir), `C:\\Windows;${dir}`);
  assert.equal(pathWith(`C:\\Windows;${dir}`, dir), `C:\\Windows;${dir}`, 'already there: untouched');
  assert.equal(pathWith(`C:\\Windows;${dir.toLowerCase()}`, dir), `C:\\Windows;${dir.toLowerCase()}`);
  assert.equal(pathWith('', dir), dir);
  assert.equal(pathWith(null, dir), dir);
  // A trailing semicolon must not become an empty PATH entry.
  assert.equal(pathWith('C:\\Windows;', dir), `C:\\Windows;${dir}`);
  assert.equal(pathWith('C:\\Windows;;', dir), `C:\\Windows;${dir}`);
});

test('pathWith is appended, so it can never shadow an existing command', () => {
  const dir = 'C:\\S\\bin';
  assert.ok(pathWith('C:\\Windows;C:\\nodejs', dir).endsWith(dir));
});

test('pathWithout removes only our folder and leaves the rest alone', () => {
  const dir = 'C:\\S\\bin';
  assert.equal(pathWithout(`C:\\Windows;${dir};C:\\nodejs`, dir), 'C:\\Windows;C:\\nodejs');
  assert.equal(pathWithout(`${dir}`, dir), '');
  assert.equal(pathWithout(`C:\\Windows;${dir.toUpperCase()}\\`, dir), 'C:\\Windows');
  assert.equal(pathWithout('C:\\Windows;C:\\nodejs', dir), 'C:\\Windows;C:\\nodejs', 'not there: unchanged');
});

test('adding then removing restores the PATH exactly', () => {
  const dir = 'C:\\Users\\jo\\AppData\\Local\\Shellby\\bin';
  for (const before of [
    'C:\\Windows;C:\\Windows\\System32',
    'C:\\Windows;C:\\Program Files\\nodejs\\;C:\\Users\\jo\\AppData\\Roaming\\npm',
    'C:\\a;;C:\\b',
    '%USERPROFILE%\\.cargo\\bin;C:\\Windows',
  ]) {
    assert.equal(pathWithout(pathWith(before, dir), dir), before, before);
  }
});

test('an empty or missing folder never changes the PATH', () => {
  assert.equal(pathWith('C:\\Windows', ''), 'C:\\Windows');
  assert.equal(pathWith('C:\\Windows', null), 'C:\\Windows');
});

// ------------------------------------------------------------------ the shims

test('the shims call the copy next to themselves, not a baked-in app path', () => {
  for (const text of [cmdShim(), shShim(), ps1Shim()]) {
    assert.match(text, /shellby\.js/);
    assert.ok(!/Program Files|AppData|resources/.test(text), 'no absolute path to the install');
    assert.match(text, /Shellby/i, 'says where it came from');
  }
  assert.match(cmdShim(), /%~dp0shellby\.js/);
  assert.match(cmdShim(), /%\*/, 'passes the arguments through');
  assert.match(shShim(), /"\$@"/, 'quoted, so a task with spaces survives');
  assert.match(ps1Shim(), /@args/);
  assert.ok(cmdShim().includes('\r\n'), 'CRLF: a .cmd with LF endings misbehaves');
});

test('a PATH change is announced, so Start-menu terminals see it without signing out', () => {
  const args = settingChangeArgs();
  assert.deepEqual(args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-EncodedCommand']);
  const script = Buffer.from(args[3], 'base64').toString('utf16le');
  assert.match(script, /SendMessageTimeout\(\[IntPtr\]0xffff, 0x1A,/, 'WM_SETTINGCHANGE to every window');
  assert.match(script, /'Environment'/);
});

// ------------------------------------------------------------------ arguments

test('parseArgs understands the commands', () => {
  assert.deepEqual(parseArgs([]), { usage: true });
  assert.deepEqual(parseArgs(['help']), { usage: true });
  assert.deepEqual(parseArgs(['--help']), { usage: true });
  assert.deepEqual(parseArgs(['status']), { cmd: 'status' });
  assert.deepEqual(parseArgs(['version']), { cmd: 'version' });
  assert.deepEqual(parseArgs(['say', 'all', 'green']), { cmd: 'say', text: 'all green' });
  assert.deepEqual(parseArgs(['do', 'tidy', 'Downloads']),
    { cmd: 'do', quiet: false, dir: null, mode: null, prompt: 'tidy Downloads' });
});

test('parseArgs reads the options for "do"', () => {
  assert.deepEqual(parseArgs(['do', '-q', '-C', 'C:\\x', '-m', 'plan', 'fix', 'the', 'lint']),
    { cmd: 'do', quiet: true, dir: 'C:\\x', mode: 'plan', prompt: 'fix the lint' });
  assert.equal(parseArgs(['do', '--mode', 'smart', 'x']).mode, 'smart');
  assert.equal(parseArgs(['do', '--dir', 'C:\\y', 'x']).dir, 'C:\\y');
  // Everything after -- is the task, even if it looks like an option.
  assert.equal(parseArgs(['do', '--', '-q', 'is', 'part', 'of', 'it']).prompt, '-q is part of it');
});

test('parseArgs reads a snippet as the first word of "do"', () => {
  assert.deepEqual(parseArgs(['do', '@review']),
    { cmd: 'do', quiet: false, dir: null, mode: null, prompt: '', snippet: 'review' });
  assert.deepEqual(parseArgs(['do', '-m', 'plan', '@tests', 'src/app.js']),
    { cmd: 'do', quiet: false, dir: null, mode: 'plan', prompt: 'src/app.js', snippet: 'tests' });
  // File mentions for Claude are left alone: a dot, a slash or a capital means it's not a snippet.
  for (const word of ['@src/app.js', '@README.md', '@Makefile', '@']) {
    const r = parseArgs(['do', word, 'explain']);
    assert.equal(r.snippet, undefined, word);
    assert.equal(r.prompt, `${word} explain`);
  }
  // Only the first word: an @name later on is part of the task.
  assert.equal(parseArgs(['do', 'ask', '@review']).snippet, undefined);
  assert.deepEqual(parseArgs(['snippets']), { cmd: 'snippets' });
  assert.match(parseArgs(['snippets', 'x']).error, /takes nothing/);
});

test('parseArgs refuses what it cannot act on', () => {
  assert.match(parseArgs(['do']).error, /What should he do/);
  assert.match(parseArgs(['say']).error, /Say what/);
  assert.match(parseArgs(['do', '-m', 'autonomous', 'x']).error, /--mode has to be one of/);
  assert.ok(!MODES.includes('autonomous'), 'autonomous is not reachable from a terminal');
  assert.match(parseArgs(['do', '-C']).error, /needs a folder/);
  assert.match(parseArgs(['do', '--nope', 'x']).error, /Unknown option: --nope/);
  assert.match(parseArgs(['frobnicate']).error, /Unknown command: frobnicate/);
  assert.match(parseArgs(['do', 'x'.repeat(MAX_PROMPT + 1)]).error, /longer than/);
});

test('parseArgs reads "flow list" and "flow run"', () => {
  assert.deepEqual(parseArgs(['flow', 'list']), { cmd: 'flow-list' });
  assert.deepEqual(parseArgs(['flow', 'run', 'Deploy']), { cmd: 'flow-run', name: 'Deploy', inputs: {} });
  // Several words before the first key=value are the name; a quoted name arrives as one word.
  assert.deepEqual(parseArgs(['flow', 'run', 'Red', 'build', 'fixer', 'branch=main', 'note=a b=c', 'empty=']),
    { cmd: 'flow-run', name: 'Red build fixer', inputs: { branch: 'main', note: 'a b=c', empty: '' } });
  assert.deepEqual(parseArgs(['flow', 'run', 'Red build fixer', 'branch=main']),
    { cmd: 'flow-run', name: 'Red build fixer', inputs: { branch: 'main' } });
});

test('parseArgs refuses bad "flow" arguments', () => {
  for (const [argv, re] of [
    [['flow'], /Usage: shellby flow/],
    [['flow', 'delete', 'x'], /Unknown flow command: delete/],
    [['flow', 'list', 'extra'], /Usage/],
    [['flow', 'run'], /Which workflow/],
    [['flow', 'run', 'branch=main'], /Which workflow/],
    [['flow', 'run', 'Deploy', 'Branch=main'], /can't be an input name/],
    [['flow', 'run', 'Deploy', '__proto__=x'], /can't be an input name/],
    [['flow', 'run', 'Deploy', '=x'], /can't be an input name/],
    [['flow', 'run', 'Deploy', 'my-key=x'], /can't be an input name/],
    [['flow', 'run', 'Deploy', 'a=1', 'stray'], /Expected key=value/],
    [['flow', 'run', 'Deploy', 'a=1', 'a=2'], /given twice/],
    [['flow', 'run', 'Deploy', `a=${'x'.repeat(MAX_INPUT_VALUE + 1)}`], /longer than/],
    [['flow', 'run', 'Deploy', ...Array.from({ length: MAX_INPUTS + 1 }, (_, i) => `k${i}=v`)], /At most/],
    [['flow', 'run', 'x'.repeat(MAX_FLOW_NAME + 1)], /at most 60/],
  ]) {
    const r = parseArgs(argv);
    assert.match(r.error || '', re, JSON.stringify(argv).slice(0, 80));
  }
});

test('the CLI and the app agree on what an input name is', () => {
  assert.equal(INPUT_KEY.source, crabtools.INPUT_KEY.source);
  assert.equal(MAX_INPUTS, crabtools.MAX_WORKFLOW_INPUTS);
  assert.equal(MAX_INPUT_VALUE, crabtools.MAX_INPUT_VALUE);
  assert.equal(MAX_FLOW_NAME, crabtools.MAX_WORKFLOW_NAME);
});

// ------------------------------------------------------------------ the server side

test('parseFlowRequest checks a flow request the way run_workflow does', () => {
  assert.deepEqual(parseFlowRequest({ action: 'flow-list' }), { ok: true, request: { action: 'flow-list' } });
  assert.deepEqual(parseFlowRequest({ action: 'flow-run', name: ' Deploy‮ ', inputs: { branch: 'main', n: 2 } }),
    { ok: true, request: { action: 'flow-run', name: 'Deploy', inputs: { branch: 'main', n: '2' } } });
  assert.deepEqual(parseFlowRequest({ action: 'flow-run', name: 'Deploy' }).request.inputs, {});
  for (const body of [
    null, 'flow-list', [], {}, { action: 'task' }, { action: 'flow-delete', name: 'x' },
    { action: 'flow-run' }, { action: 'flow-run', name: '' }, { action: 'flow-run', name: 7 },
    { action: 'flow-run', name: 'D', inputs: [] },
    { action: 'flow-run', name: 'D', inputs: JSON.parse('{"__proto__": {"x": 1}}') },
    { action: 'flow-run', name: 'D', inputs: { 'Bad Key': 'x' } },
    { action: 'flow-run', name: 'D', inputs: { a: { b: 1 } } },
    { action: 'flow-run', name: 'D', inputs: { a: 'x'.repeat(MAX_INPUT_VALUE + 1) } },
  ]) {
    const r = parseFlowRequest(body);
    assert.equal(r.ok, false, JSON.stringify(body));
    assert.ok(r.error.length > 4);
  }
  // Same rules, same answers: one helper behind both doors.
  const args = { name: 'D', inputs: { k: 'v⁦' } };
  assert.deepEqual(parseFlowRequest({ action: 'flow-run', ...args }).request.inputs, crabtools.parseRequest({ action: 'run_workflow', args }).intent.inputs);
});

test('parseTaskRequest checks the task before anything is started', () => {
  const ok = parseTaskRequest({ action: 'task', args: { prompt: 'tidy up', cwd: 'C:\\x', mode: 'plan' } });
  assert.deepEqual(ok, { ok: true, task: { prompt: 'tidy up', cwd: 'C:\\x', mode: 'plan', snippet: null } });
  assert.equal(parseTaskRequest({ action: 'task', args: { prompt: 'x', cwd: 'C:\\x' } }).task.mode, null);

  for (const body of [
    null, 'x', { action: 'say' }, { action: 'task' },
    { action: 'task', args: { prompt: '   ', cwd: 'C:\\x' } },
    { action: 'task', args: { prompt: 'x' } },
    { action: 'task', args: { prompt: 'x', cwd: '' } },
    { action: 'task', args: { prompt: 'x', cwd: 'C:\\x', mode: 'autonomous' } },
    { action: 'task', args: { prompt: 'x'.repeat(5000), cwd: 'C:\\x' } },
  ]) {
    assert.equal(parseTaskRequest(body).ok, false, JSON.stringify(body));
  }
  // A folder that isn't there is refused, which is what the app will check.
  assert.equal(parseTaskRequest({ action: 'task', args: { prompt: 'x', cwd: 'C:\\nope' } }, { isDir: () => false }).ok, false);
  assert.equal(parseTaskRequest({ action: 'task', args: { prompt: 'a\u0000b', cwd: 'C:\\x' } }).task.prompt, 'ab');
});

test('parseTaskRequest takes a snippet, with or without words to go with it', () => {
  const bare = parseTaskRequest({ action: 'task', args: { snippet: 'review', cwd: 'C:\\x' } });
  assert.deepEqual(bare, { ok: true, task: { prompt: '', cwd: 'C:\\x', mode: null, snippet: 'review' } });
  assert.equal(parseTaskRequest({ action: 'task', args: { snippet: 'tests', prompt: 'src/a.js', cwd: 'C:\\x' } }).task.prompt, 'src/a.js');
  // The port isn't only the CLI's: a name is checked the same way here.
  for (const snippet of ['', 'Review', '../x', 'a b', 'x'.repeat(33), 7, {}, ['review']]) {
    assert.equal(parseTaskRequest({ action: 'task', args: { snippet, prompt: 'x', cwd: 'C:\\x' } }).ok, false, JSON.stringify(snippet));
  }
});

// ------------------------------------------------------------------ end to end

// A stub Shellby: the marker file the CLI checks, plus a server that records
// what it was asked and answers how the test wants it to.
function stubShellby(handler) {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        let body = null;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* none */ }
        handler({ url: req.url, headers: req.headers, body }, res);
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function runCli(args, { port, env = {}, tmp }) {
  return new Promise(resolve => {
    execFile(process.execPath, [CLI, ...args], {
      env: { ...process.env, SHELLBY_PORT: String(port), TEMP: tmp, TMPDIR: tmp, SHELLBY_TOKEN: '', ...env },
      encoding: 'utf8',
      timeout: 15000,
    }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }));
  });
}

test('the CLI hands a task over, with the folder it was run in', async t => {
  const seen = [];
  const server = await stubShellby((req, res) => {
    seen.push(req);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ text: 'Shellby is on it.' }));
  });
  const port = server.address().port;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-cli-'));
  fs.writeFileSync(path.join(tmp, `shellby-hooks-${port}`), 'x');
  t.after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

  const r = await runCli(['do', 'tidy', 'my', 'Downloads'], { port, tmp, env: { SHELLBY_TOKEN: 'secret-token' } });
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.match(r.stdout, /Shellby is on it\./);
  assert.equal(seen[0].url, '/v1/cli');
  assert.equal(seen[0].headers['x-shellby'], '1');
  assert.equal(seen[0].headers['x-shellby-token'], 'secret-token');
  assert.equal(seen[0].body.action, 'task');
  assert.equal(seen[0].body.args.prompt, 'tidy my Downloads');
  assert.equal(seen[0].body.args.cwd, process.cwd(), 'defaults to the folder you ran it in');
});

test('the CLI prints the status, and says nothing on --quiet', async t => {
  const server = await stubShellby((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ text: req.body.action === 'status' ? 'Shellby: idle.' : 'ok' }));
  });
  const port = server.address().port;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-cli-'));
  fs.writeFileSync(path.join(tmp, `shellby-hooks-${port}`), 'x');
  t.after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

  const status = await runCli(['status'], { port, tmp });
  assert.equal(status.code, EXIT.ok, status.stderr);
  assert.match(status.stdout, /Shellby: idle\./);

  const quiet = await runCli(['do', '-q', 'something'], { port, tmp, env: { SHELLBY_TOKEN: 't' } });
  assert.equal(quiet.code, EXIT.ok, quiet.stderr);
  assert.equal(quiet.stdout, '', '--quiet prints nothing when it worked');
});

test('the CLI sends a snippet by name, and lists them', async t => {
  const seen = [];
  const server = await stubShellby((req, res) => {
    seen.push(req);
    if (req.body.args?.snippet === 'nope') { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'No snippet called @nope.' })); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ text: req.body.action === 'snippets' ? 'Your snippets: @review' : 'Shellby is on it.' }));
  });
  const port = server.address().port;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-cli-'));
  fs.writeFileSync(path.join(tmp, `shellby-hooks-${port}`), 'x');
  t.after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
  const env = { SHELLBY_TOKEN: 't' };

  const r = await runCli(['do', '@tests', 'src/app.js'], { port, tmp, env });
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.deepEqual(seen[0].body.args, { prompt: 'src/app.js', cwd: process.cwd(), mode: null, snippet: 'tests' });

  const list = await runCli(['snippets'], { port, tmp, env });
  assert.equal(list.code, EXIT.ok, list.stderr);
  assert.deepEqual(seen[1].body, { action: 'snippets' });
  assert.match(list.stdout, /@review/);

  const missing = await runCli(['do', '@nope'], { port, tmp, env });
  assert.equal(missing.code, EXIT.error);
  assert.match(missing.stderr, /No snippet called @nope/);
});

test('with Shellby closed the CLI says so and exits 3, without waiting', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-cli-'));
  try {
    const started = Date.now();
    const r = await runCli(['status'], { port: 1, tmp });
    assert.equal(r.code, EXIT.notRunning);
    assert.match(r.stderr, /Shellby is not running/);
    assert.ok(Date.now() - started < 5000, 'no connection timeout: the marker file is checked first');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('the CLI lists and runs workflows over /v1/cli with the token', async t => {
  const seen = [];
  const server = await stubShellby((req, res) => {
    seen.push(req);
    if (req.body.action === 'flow-run' && req.body.name === 'Locked') {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '"Locked" doesn\'t have the Claude Code trigger.' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ text: req.body.action === 'flow-list' ? '2 workflows.' : 'Started "Red build fixer".' }));
  });
  const port = server.address().port;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-cli-'));
  fs.writeFileSync(path.join(tmp, `shellby-hooks-${port}`), 'x');
  t.after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

  const list = await runCli(['flow', 'list'], { port, tmp, env: { SHELLBY_TOKEN: 'tok' } });
  assert.equal(list.code, EXIT.ok, list.stderr);
  assert.match(list.stdout, /2 workflows\./);
  assert.deepEqual(seen[0].body, { action: 'flow-list' });
  assert.equal(seen[0].url, '/v1/cli');
  assert.equal(seen[0].headers['x-shellby-token'], 'tok');

  const run = await runCli(['flow', 'run', 'Red', 'build', 'fixer', 'branch=main'], { port, tmp, env: { SHELLBY_TOKEN: 'tok' } });
  assert.equal(run.code, EXIT.ok, run.stderr);
  assert.match(run.stdout, /Started "Red build fixer"\./);
  assert.deepEqual(seen[1].body, { action: 'flow-run', name: 'Red build fixer', inputs: { branch: 'main' } });

  // A refusal that says why is passed on, not blamed on the token.
  const locked = await runCli(['flow', 'run', 'Locked'], { port, tmp, env: { SHELLBY_TOKEN: 'tok' } });
  assert.equal(locked.code, EXIT.denied);
  assert.match(locked.stderr, /doesn't have the Claude Code trigger/);

  const bad = await runCli(['flow', 'run', 'Deploy', 'Bad=x'], { port, tmp, env: { SHELLBY_TOKEN: 'tok' } });
  assert.equal(bad.code, EXIT.usage);
  assert.equal(seen.length, 3, 'a usage error never reaches Shellby');
});

test('a refused token is reported as something the user can fix', async t => {
  const server = await stubShellby((_req, res) => { res.writeHead(401).end('{}'); });
  const port = server.address().port;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-cli-'));
  fs.writeFileSync(path.join(tmp, `shellby-hooks-${port}`), 'x');
  t.after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

  const r = await runCli(['do', 'something'], { port, tmp, env: { SHELLBY_TOKEN: 'stale' } });
  assert.equal(r.code, EXIT.denied);
  assert.match(r.stderr, /Turn it off and on again/);
});

test('without a token the CLI explains how to switch the command on', async t => {
  const server = await stubShellby((_req, res) => { res.writeHead(200).end('{}'); });
  const port = server.address().port;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-cli-'));
  fs.writeFileSync(path.join(tmp, `shellby-hooks-${port}`), 'x');
  t.after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

  // No SHELLBY_TOKEN and no token file anywhere it looks.
  const r = await runCli(['do', 'x'], { port, tmp, env: { APPDATA: tmp, XDG_CONFIG_HOME: tmp, USERPROFILE: tmp, HOME: tmp } });
  assert.equal(r.code, EXIT.denied);
  assert.match(r.stderr, /Settings > Claude Code everywhere/);
});

test('help and version work with no Shellby running at all', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-cli-'));
  try {
    const help = await runCli(['help'], { port: 1, tmp });
    assert.equal(help.code, EXIT.ok);
    assert.match(help.stdout, /shellby do <task\.\.\.>/);
    assert.match(help.stdout, /shellby flow run <name\.\.\.> \[key=value \.\.\.\]/);
    const version = await runCli(['version'], { port: 1, tmp });
    assert.equal(version.code, EXIT.ok);
    assert.match(version.stdout, /^shellby /);
    const bad = await runCli(['frobnicate'], { port: 1, tmp });
    assert.equal(bad.code, EXIT.usage);
    assert.match(bad.stderr, /Unknown command/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
