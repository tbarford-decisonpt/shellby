// The ready-made hooks in Toolbox → Hooks, and the plain label every hook gets.
// The recipes are real bash, so where Git Bash (or /bin/bash) is around they're
// run here on the details Claude Code would send them.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { RECIPES, GROUPS, describeHook, describeCommand } = require('../src/main/hook-recipes');
const { HOOK_EVENTS, validateHook } = require('../src/main/claude-setup');
const { samplePayload, findBash, runHook } = require('../src/main/hook-test');

const bash = findBash();
const needsBash = { skip: bash ? false : 'no bash on this machine' };

test('every recipe is a hook the form would accept, on a moment that exists', () => {
  const ids = new Set();
  for (const r of RECIPES) {
    assert.ok(!ids.has(r.id), `${r.id} twice`);
    ids.add(r.id);
    assert.ok(GROUPS.some(g => g.id === r.group), r.id);
    assert.ok(HOOK_EVENTS.some(e => e.name === r.event), r.id);
    assert.ok(['user', 'project', 'local'].includes(r.scope), r.id);
    assert.ok(r.title && r.blurb && r.icon, r.id);
    const v = validateHook({ event: r.event, matcher: r.matcher, command: r.command, timeout: r.timeout ?? '' });
    assert.equal(v.error, undefined, `${r.id}: ${v.error}`);
    assert.equal(v.hook.command, r.command, `${r.id} would be changed by validation`);
    assert.match(r.command, /^bash -c '[^']*'$/, `${r.id} is one bash -c '…' with no stray single quotes`);
  }
  for (const g of GROUPS) assert.ok(RECIPES.some(r => r.group === g.id), `${g.id} is empty`);
});

test('describeHook: a recipe by its title, anything else by its command', () => {
  const r = RECIPES[0];
  assert.deepEqual(describeHook({ type: 'command', command: r.command }), { summary: r.title, icon: r.icon, recipe: r.id });
  assert.equal(describeHook({ type: 'command', command: 'node "%USERPROFILE%\\.claude\\hooks\\check.js"' }).summary, 'Runs check.js');
  assert.equal(describeHook({ type: 'prompt', command: 'Is this safe?' }).summary, 'Asks Claude to check something');
  assert.equal(describeHook({ type: 'http', command: 'https://hooks.example.com/x' }).summary, 'Sends the details to hooks.example.com');
});

test('describeCommand: names the program a command really runs', () => {
  const cases = {
    'npx prettier --write x': 'Runs prettier',
    'pnpm exec eslint --fix .': 'Runs eslint',
    'python3 ~/hooks/guard.py': 'Runs guard.py',
    'bash -c \'echo hi\'': 'Runs a shell one-liner',
    'powershell -File C:\\x\\notify.ps1': 'Runs notify.ps1',
    'pwsh -c "Write-Host hi"': 'Runs a PowerShell or Command Prompt line',
    'node -e "console.log(1)"': 'Runs a line of JavaScript',
    'echo done': 'Prints a message',
    '"C:\\Program Files\\Tool\\tool.exe" --check': 'Runs tool',
    '': 'Runs nothing (the command is empty)',
  };
  for (const [command, want] of Object.entries(cases)) assert.equal(describeCommand(command), want, command);
});

// ---- the recipes, run for real

const run = (recipe, payload, cwd = os.tmpdir()) => runHook({ command: recipe.command, payload, cwd, timeout: 30, bash });
const recipe = id => RECIPES.find(r => r.id === id);
const pre = (tool, input) => ({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input });

test('Stop force-pushes: blocks the dangerous git commands and nothing else', needsBash, async () => {
  const r = recipe('guard-git');
  for (const c of ['git push --force origin main', 'git push -f', 'git push origin main --force', 'git push origin +main', 'git  reset --hard HEAD~1', 'git reset  --hard', 'git clean -fd', 'git clean -n --force']) {
    const res = await run(r, pre('Bash', { command: c }));
    assert.equal(res.code, 2, c);
    assert.match(res.stderr, /blocked/, c);
  }
  for (const c of ['git push origin main', 'git push --force-with-lease', 'git status', 'git reset --soft HEAD~1', 'npm run format']) {
    assert.equal((await run(r, pre('Bash', { command: c }))).code, 0, c);
  }
});

test('Keep Claude out of secret files: blocks .env and keys, by the file being edited only', needsBash, async () => {
  const r = recipe('guard-secrets');
  for (const f of ['C:\\proj\\.env', '/home/me/proj/.env.local', 'C:\\Users\\me\\.ssh\\id_rsa', 'certs/server.pem', 'C:\\certs\\api.KEY']) {
    assert.equal((await run(r, pre('Edit', { file_path: f, old_string: 'a', new_string: 'b' }))).code, 2, f);
  }
  // Mentioning .env in the new text isn't touching it.
  assert.equal((await run(r, pre('Edit', { file_path: 'C:\\proj\\README.md', old_string: 'a', new_string: 'copy .env.example to .env' }))).code, 0);
  for (const f of ['/proj/src/environment.js', 'C:\\proj\\config.environment.ts', '/proj/.envrc', '/proj/.env.example', 'C:\\proj\\.env.sample', '/proj/keyboard.js', '/proj/src/monkey.ts']) {
    assert.equal((await run(r, pre('Write', { file_path: f, content: 'x' }))).code, 0, f);
  }
});

test('Run the tests before Claude finishes: never loops, skips folders with no package.json', needsBash, async () => {
  const r = recipe('tests-pass');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-recipe-'));
  try {
    assert.equal((await run(r, { hook_event_name: 'Stop', stop_hook_active: false }, dir)).code, 0, 'no package.json: nothing to run');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(1)"' } }));
    const failing = await run(r, { hook_event_name: 'Stop', stop_hook_active: false }, dir);
    assert.equal(failing.code, 2);
    assert.match(failing.stderr, /tests are failing/);
    assert.equal((await run(r, { hook_event_name: 'Stop', stop_hook_active: true }, dir)).code, 0, 'already kept going once: let it stop');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Tell Claude more: the git status and the reminder are printed for Claude', needsBash, async () => {
  const reminder = await run(recipe('reminder'), { hook_event_name: 'UserPromptSubmit', prompt: 'hi' });
  assert.equal(reminder.code, 0);
  assert.match(reminder.stdout, /^Reminder: /);
  const outside = await run(recipe('git-context'), { hook_event_name: 'SessionStart', source: 'startup' }, fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-nogit-')));
  assert.equal(outside.code, 0);
  assert.equal(outside.stdout, '', 'outside a repo it says nothing');
});

test('the sample for a recipe is the case it is about', () => {
  assert.equal(samplePayload(recipe('guard-git'), 'C:\\proj').tool_input.command, 'git push --force origin main');
  assert.equal(samplePayload(recipe('guard-secrets'), '/proj').tool_input.file_path, '/proj/.env');
});
