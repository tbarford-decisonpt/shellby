const { test } = require('node:test');
const assert = require('node:assert/strict');
const d = require('../src/main/bugdex/detect');

const NODE_NULL = [
  '/home/me/app/src/user.js:12',
  '  return session.user.name;',
  '                 ^',
  '',
  "TypeError: Cannot read properties of undefined (reading 'name')",
  '    at greet (/home/me/app/src/user.js:12:18)',
  '    at Object.<anonymous> (/home/me/app/node_modules/x/index.js:3:1)',
  '',
  'Node.js v22.13.1',
].join('\n');

test('gate skips readers and probes', () => {
  for (const c of ['grep -rn TypeError src', 'cat log.txt', 'git log --oneline', 'gh run view 123 --log', 'Get-Content x.log', 'rg ENOENT']) assert.equal(d.gate(c), 'reader', c);
  for (const c of ['test -f package.json', 'which node', 'Test-Path C:/x', 'command -v cargo']) assert.equal(d.gate(c), 'probe', c);
  for (const c of ['npm test', 'node app.js', 'git merge main', 'cd app && npm run build']) assert.equal(d.gate(c), null, c);
});

test('outcomeOf trusts a test summary over a piped exit code, and nothing else that is piped', () => {
  assert.equal(d.outcomeOf({ cmd: 'npm test 2>&1 | tail -30', output: 'Tests:       1 failed, 3 passed, 4 total', isError: false }), 'fail');
  assert.equal(d.outcomeOf({ cmd: 'node app.js | tail', output: NODE_NULL, isError: false }), null);
  assert.equal(d.outcomeOf({ cmd: 'node app.js', output: NODE_NULL, isError: true }), 'fail');
  assert.equal(d.outcomeOf({ cmd: 'node app.js', output: 'ok', isError: false }), 'pass');
  assert.equal(d.outcomeOf({ cmd: 'npm run dev', output: '', isError: false, background: true }), null);
  assert.equal(d.outcomeOf({ cmd: 'grep TypeError x', output: 'TypeError: x', isError: false }), null);
});

test('nullfish from a node stack, a python NoneType and a java NPE', () => {
  assert.equal(d.classify(NODE_NULL, { cmd: 'node src/user.js' }).species, 'nullfish');
  assert.equal(d.classify("Traceback (most recent call last):\n  File \"app.py\", line 3, in <module>\nAttributeError: 'NoneType' object has no attribute 'x'", { cmd: 'python app.py' }).species, 'nullfish');
  assert.equal(d.classify('Exception in thread "main" java.lang.NullPointerException', { cmd: 'java Main' }).species, 'nullfish');
});

test('a specific signature beats a family one beats an umbrella', () => {
  const vite = 'error during build:\nCould not resolve "./missing" from "src/main.ts"\nBuild failed with 1 error';
  assert.equal(d.classify(vite, { cmd: 'npm run build' }).species, 'stray-module-minnow');
  assert.equal(d.classify('TypeError: x.map is not a function', { cmd: 'node a.js' }).species, 'shapeshifter-shrimp');
  assert.equal(d.classify('webpack compiled with 2 errors', { cmd: 'npm run build' }).species, 'collapsed-castle');
});

test('on a tie the last line wins', () => {
  const r = d.classify('Error: ENOENT: no such file or directory, open \'a.json\'\nError: listen EADDRINUSE: address already in use :::3000', { cmd: 'node server.js' });
  assert.equal(r.species, 'port-squatter');
});

test('Windows wording for a missing file', () => {
  assert.equal(d.classify('The system cannot find the file specified.', { cmd: 'node a.js' }).species, 'shell-less-hermit');
  assert.equal(d.classify("Get-Item : Cannot find path 'C:\\x\\y.txt' because it does not exist.", { cmd: 'Get-Item C:/x/y.txt' }).species, 'shell-less-hermit');
});

test('tsc output: a known code, or the kelp knot', () => {
  assert.equal(d.classify("src/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.", { cmd: 'npx tsc --noEmit' }).species, 'mismatched-mantis');
  assert.equal(d.classify('src/a.ts(3,7): error TS2554: Expected 1 arguments, but got 2.', { cmd: 'npx tsc --noEmit' }).species, 'type-tangle');
});

test('git conflicts, rejected pushes and stale locks', () => {
  assert.equal(d.classify('Auto-merging a.js\nCONFLICT (content): Merge conflict in src/a.js\nAutomatic merge failed; fix conflicts and then commit the result.', { cmd: 'git merge main' }).species, 'two-headed-crab');
  assert.equal(d.classify('error: could not apply 1a2b3c4... wip', { cmd: 'git rebase main' }).species, 'two-headed-crab');
  assert.equal(d.classify(' ! [rejected]        main -> main (non-fast-forward)', { cmd: 'git push' }).species, 'bounced-bottle');
  assert.deepEqual(d.conflictFiles('CONFLICT (content): Merge conflict in src/a.js\nCONFLICT (content): Merge conflict in b.py'), ['src/a.js', 'b.py']);
});

test('a failed test run with nothing specific is a Red Snapper; a failed lint a Lint Louse', () => {
  assert.equal(d.classify('Tests: 1 failed, 2 passed', { cmd: 'npx jest' }).species, 'red-snapper');
  assert.equal(d.classify('  3:1  error  Unexpected var  no-var\n✖ 1 problem', { cmd: 'npx eslint .' }).species, 'lint-louse');
  assert.equal(d.classify('something odd happened', { cmd: 'node a.js' }), null);
});

test('a server log with no signature is a Beached Whale', () => {
  assert.equal(d.classify('Killed', { source: 'server' }).species, 'beached-whale');
  assert.equal(d.classify('Error: listen EADDRINUSE: address already in use :::5173', { source: 'server' }).species, 'port-squatter');
});

test('rust and python type checkers only by their own commands', () => {
  assert.equal(d.classify('error: expected one of `;`', { cmd: 'cargo build' }).species, 'rusty-nautilus');
  assert.equal(d.classify('error: expected one of `;`', { cmd: 'node a.js' }), null);
  assert.equal(d.classify('app.py:3: error: Incompatible types in assignment [assignment]', { cmd: 'mypy .' }).species, 'hinted-hermit');
});

test('the live set limits what can be seen', () => {
  const live = new Set(['shapeshifter-shrimp']);
  assert.equal(d.classify(NODE_NULL, { cmd: 'node a.js', live }).species, 'shapeshifter-shrimp');
  assert.equal(d.classify('Error: ENOENT', { cmd: 'node a.js', live }), null);
});

test('fingerprints ignore line numbers, ports, hex and folders, but not the file', () => {
  const a = d.classify("TypeError: Cannot read properties of undefined (reading 'x')\n    at f (/a/b/src/user.js:12:3)", { cmd: 'node a' });
  const b = d.classify("TypeError: Cannot read properties of undefined (reading 'x')\n    at f (C:\\work\\src\\user.js:99:7)", { cmd: 'node a' });
  const c = d.classify("TypeError: Cannot read properties of undefined (reading 'x')\n    at f (/a/b/src/order.js:12:3)", { cmd: 'node a' });
  assert.equal(a.fp, b.fp);
  assert.notEqual(a.fp, c.fp);
  assert.match(a.fp, /^[0-9a-f]{12}$/);
  assert.equal(d.normMessage('listen EADDRINUSE :::3000 at 0xdeadbeef'), d.normMessage('listen EADDRINUSE :::8080 at 0xabc'));
  assert.equal(d.fileBase(['    at x (/repo/node_modules/lib/a.js:1:1)', '    at y (/repo/src/b.ts:2:2)']), 'b.ts');
});

test('stillShows finds the same bug in a later output', () => {
  const r = d.classify(NODE_NULL, { cmd: 'node src/user.js' });
  assert.equal(d.stillShows(NODE_NULL, r.fp, { cmd: 'node src/user.js' }), true);
  assert.equal(d.stillShows('hello', r.fp, { cmd: 'node src/user.js' }), false);
});

test('matchKeys lets a broader run catch a narrower failure, never the reverse', () => {
  const narrow = d.matchKeys('npm test -- auth');
  const broad = d.matchKeys('npm test');
  assert.ok(narrow.includes(broad[broad.length - 1]));
  assert.ok(!broad.includes(narrow[narrow.length - 1]));
  assert.deepEqual(d.matchKeys('node a.js --x'), [d.matchKeys('node a.js --x')[0]]);
  assert.equal(d.matchKeys('node a.js --x').length, 1);
});

test('remedies, resolves and flights', () => {
  assert.equal(d.remedyOf('npm install'), 'install');
  assert.equal(d.remedyOf('taskkill /F /PID 4242'), 'kill');
  assert.equal(d.remedyOf('lsof -ti:3000 | xargs kill'), 'kill');
  assert.equal(d.remedyOf('docker compose up -d'), 'service');
  assert.equal(d.remedyOf('rm -f .git/index.lock'), 'lock');
  assert.equal(d.remedyOf('rm -rf .next'), 'cache');
  assert.equal(d.remedyOf('node app.js'), null);
  assert.ok(d.isResolve('git commit -m "merge"') && d.isResolve('git rebase --continue'));
  assert.ok(d.isFlee('git merge --abort') && d.isFlee('git reset --hard HEAD'));
  assert.ok(!d.isFlee('git stash list'));
  assert.ok(d.isFairPush('git push --force-with-lease') && !d.isFairPush('git push -f'));
  assert.ok(d.isHookedCommit('git commit -m x') && !d.isHookedCommit('git commit --no-verify -m x'));
});

test('passedCount reads the runner summary', () => {
  assert.equal(d.passedCount('Tests:       1 failed, 41 passed, 42 total'), 41);
  assert.equal(d.passedCount('ℹ tests 10\nℹ pass 9\nℹ fail 1'), 9);
  assert.equal(d.passedCount('nothing'), null);
});

test('huge and hostile output stays fast and yields only an id', () => {
  const big = `${'\n'.repeat(5000)}${'x'.repeat(1024 * 1024)}\nTypeError: <script>\`alert(1)\`</script>`;
  const t = process.hrtime.bigint();
  const r = d.classify(big, { cmd: 'node a.js' });
  const ms = Number(process.hrtime.bigint() - t) / 1e6;
  // Generous for a busy CI runner; a runaway regex takes seconds.
  assert.ok(ms < 400, `${ms} ms`);
  assert.deepEqual(Object.keys(r).sort(), ['fp', 'lang', 'species', 'tier']);
  assert.equal(r.species, 'shapeshifter-shrimp');
});
