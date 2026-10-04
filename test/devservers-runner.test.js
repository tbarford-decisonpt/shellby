// Running a dev server for real (src/main/devservers/runner.js + supervisor.js):
// the fixture server (test/fixtures/devservers/server.js) says where it is like
// Vite does, and dies with code 3 when its flag file appears. Node runs it
// directly, not through npm, so the test is quick and works offline.
//
// Windows only: it's cmd, taskkill and Windows process times all the way down.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const runner = require('../src/main/devservers/runner');
const native = require('../src/main/native-windows');
const out = require('../src/main/devservers/output');

const skip = process.platform !== 'win32' && 'Windows only';
const FIXTURE = path.join(__dirname, 'fixtures', 'devservers', 'server.js');
const started = [];
after(async () => { for (const pid of started) await runner.stop(pid); });

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) return v;
    await sleep(100);
  }
}

function launch(dir, name) {
  const flag = path.join(dir, `${name}.flag`);
  const kid = path.join(dir, `${name}.kid`);
  const log = path.join(dir, `srv-${name}.log`);
  const r = runner.start({ root: dir, command: `"${process.execPath}" "${FIXTURE}" "${flag}" "${kid}"`, logFile: log });
  assert.equal(r.ok, true, r.error);
  started.push(r.pid);
  const createdAt = native.processInfo(r.pid)?.createdAt;
  const tail = new runner.LogTail(log);
  const buf = new out.LineBuffer();
  const read = () => buf.push(tail.read());
  return { ...r, flag, kid, log, createdAt, read, buf };
}

test('up, then a crash: the URL, the output and the exit code all reach the log', { skip }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby runner '));
  const s = launch(dir, 'a');
  const url = await until(() => s.read().map(out.detectUrl).find(Boolean));
  assert.ok(url, `no URL in: ${JSON.stringify(s.buf.all())}`);
  assert.equal(runner.isAlive(s.pid, s.createdAt, native.processInfo), true);
  fs.writeFileSync(s.flag, '');
  const code = await until(() => s.read().map(out.exitOf).find(c => c !== undefined));
  assert.equal(code, 3);
  assert.ok(s.buf.all().includes('Error: something broke'), 'stderr is in the log too');
  await until(() => !runner.isAlive(s.pid, s.createdAt, native.processInfo), 5000);
  assert.equal(runner.isAlive(s.pid, s.createdAt, native.processInfo), false);
});

test('stop ends the whole tree, and leaves no exit marker (it was asked to go)', { skip }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby runner '));
  const s = launch(dir, 'b');
  await until(() => fs.existsSync(s.kid) && fs.readFileSync(s.kid, 'utf8'));
  const kid = Number(fs.readFileSync(s.kid, 'utf8'));
  assert.equal(native.processInfo(kid).alive, true);
  await runner.stop(s.pid);
  await until(() => !native.processInfo(kid).alive, 5000);
  assert.equal(native.processInfo(kid).alive, false, 'the server\'s own child went too');
  assert.equal(runner.isAlive(s.pid, s.createdAt, native.processInfo), false);
  assert.ok(!fs.readFileSync(s.log, 'utf8').includes('[shellby-exit'));
});

test("a project's own npm.cmd is never run in place of the real one", { skip }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby runner '));
  fs.writeFileSync(path.join(dir, 'npm.cmd'), '@echo PLANTED-NPM\r\n');
  fs.writeFileSync(path.join(dir, 'node.cmd'), '@echo PLANTED-NODE\r\n');
  const log = path.join(dir, 'srv-planted.log');
  const r = runner.start({ root: dir, command: 'npm --version', logFile: log });
  started.push(r.pid);
  const tail = new runner.LogTail(log);
  const buf = new out.LineBuffer();
  // Wrapped: an exit code of 0 is falsy, and until() waits for something truthy.
  const ended = await until(() => { const c = buf.push(tail.read()).map(out.exitOf).find(x => x !== undefined); return c === undefined ? null : { c }; });
  assert.equal(ended?.c, 0, buf.all().join('\n'));
  assert.ok(!buf.all().some(l => /PLANTED/.test(l)), buf.all().join('\n'));
  assert.ok(buf.all().some(l => /^\d+\.\d+\.\d+/.test(l)), 'the real npm answered');
});

test('a reused pid is not the server, and an unconfirmed one is not either', () => {
  const info = () => ({ alive: true, createdAt: 1000 });
  assert.equal(runner.isAlive(42, 1000, info), true);
  assert.equal(runner.isAlive(42, 1000 + 60000, info), false);
  assert.equal(runner.isAlive(42, 1000, () => ({ alive: false, createdAt: null })), false);
  // Its start time can't be read: not confirmed, so no.
  assert.equal(runner.isAlive(42, 1000, () => ({ alive: true, createdAt: null })), false);
  assert.equal(runner.isAlive(42, null, info), false);
  // No native access at all: only a process this session started is taken on trust.
  assert.equal(runner.isAlive(process.pid, 1000, () => null), false);
  assert.equal(runner.isAlive(process.pid, 1000, () => null, { trustBare: true }), true);
  assert.equal(runner.isAlive(0, 1000, info), false);
});

test('a detached stop runs taskkill on its own and does not wait', async () => {
  const calls = [];
  const spawnImpl = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { unref: () => calls.push('unref') }; };
  await runner.stop(1234, { detached: true, spawnImpl });
  assert.match(calls[0].cmd, /taskkill\.exe$/i);
  assert.deepEqual(calls[0].args, ['/PID', '1234', '/T', '/F']);
  assert.equal(calls[0].opts.detached, true);
  assert.equal(calls[1], 'unref');
});

test('LogTail reads only what is new, a split character included, and copes with a trimmed file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-tail-'));
  const log = path.join(dir, 'x.log');
  fs.writeFileSync(log, 'one\n');
  const t = new runner.LogTail(log);
  assert.equal(t.read(), 'one\n');
  assert.equal(t.read(), '');
  const crab = Buffer.from('🦀\n');
  fs.appendFileSync(log, crab.subarray(0, 2));
  const first = t.read();
  fs.appendFileSync(log, crab.subarray(2));
  assert.equal(first + t.read(), '🦀\n');
  fs.writeFileSync(log, 'x\n'); // shorter than where we were
  assert.equal(t.read(), '');
  fs.appendFileSync(log, 'after\n');
  assert.equal(t.read(), 'after\n');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('fromEnd starts at a line boundary near the end', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-tail-'));
  const log = path.join(dir, 'x.log');
  fs.writeFileSync(log, `${'a'.repeat(100)}\nlast line\n`);
  assert.equal(runner.LogTail.fromEnd(log, 20).read(), 'last line\n');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('trimLog keeps the end of a log that grew too big', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-tail-'));
  const log = path.join(dir, 'x.log');
  fs.writeFileSync(log, `${'x'.repeat(100)}END`);
  assert.equal(runner.trimLog(log, { max: 50, keep: 10 }), true);
  assert.equal(fs.readFileSync(log, 'utf8'), 'xxxxxxxEND');
  assert.equal(runner.trimLog(log, { max: 50, keep: 10 }), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('cleanLogs removes old logs no server uses, and nothing else', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-logs-'));
  const old = path.join(dir, 'srv-aaaaaaaa.log');
  const used = path.join(dir, 'srv-bbbbbbbb.log');
  const other = path.join(dir, 'notes.txt');
  for (const f of [old, used, other]) fs.writeFileSync(f, 'x');
  const now = Date.now() + 8 * 24 * 3600 * 1000;
  assert.equal(runner.cleanLogs(dir, new Set([used]), { now }), 1);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['notes.txt', 'srv-bbbbbbbb.log']);
  fs.rmSync(dir, { recursive: true, force: true });
});
