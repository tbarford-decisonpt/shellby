// The log is what a problem report is made of, so it has to scrub what it
// writes, survive a folder it can't write to, and never throw.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Log } = require('../src/main/log');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-test-'));
const at = n => () => new Date(Date.UTC(2026, 0, 2, 3, 4, n));

test('a line is written to memory and to the file', () => {
  const dir = tmp();
  const log = new Log(dir, { now: at(5) });
  log.info('started', 'version 0.18.0');
  assert.match(log.recent()[0], /^2026-01-02 03:04:05 info {2}started — version 0\.18\.0$/);
  assert.match(fs.readFileSync(path.join(dir, 'shellby.log'), 'utf8'), /started — version 0\.18\.0/);
});

test('an Error keeps its stack', () => {
  const log = new Log(tmp());
  const line = log.error('task blew up', new Error('kaboom'));
  assert.match(line, /ERROR task blew up — kaboom/);
  assert.match(line, /at /, 'the stack comes along');
});

test('the home directory is replaced, whichever separator it arrives with', () => {
  const log = new Log(tmp(), { home: 'C:/Users/jacob' });
  assert.match(log.info('read', 'C:/Users/jacob/Desktop/notes.txt'), /~\/Desktop\/notes\.txt/);
  assert.match(log.info('read', 'C:\\Users\\JACOB\\Desktop\\notes'), /~[\\/]Desktop/);
  assert.doesNotMatch(log.recent().join('\n'), /jacob/i);
});

test('anything shaped like a token is cut short', () => {
  const log = new Log(tmp());
  const line = log.warn('github said no', 'tried with ghu_AbCdEf0123456789abcdef and Bearer sk-abc123');
  assert.match(line, /ghu_AbCdEf…/);
  assert.doesNotMatch(line, /0123456789/);
  assert.match(line, /Bearer …/);
  assert.doesNotMatch(line, /sk-abc123/);
});

test('a folder it cannot write to costs a line, not a throw', () => {
  const dir = tmp();
  // A file where the log folder should be: every write fails.
  const blocked = path.join(dir, 'logs');
  fs.writeFileSync(blocked, 'in the way');
  const log = new Log(blocked);
  assert.doesNotThrow(() => log.error('still works', new Error('x')));
  assert.equal(log.recent().length, 1, 'and the line is still in memory for a report');
});

test('the file is rotated rather than grown forever', () => {
  const dir = tmp();
  const log = new Log(dir, { maxBytes: 200 });
  for (let i = 0; i < 40; i++) log.info(`line ${i}`, 'x'.repeat(20));
  assert.equal(fs.existsSync(path.join(dir, 'shellby.log.1')), true, 'one previous file is kept');
  assert.ok(fs.statSync(path.join(dir, 'shellby.log')).size < 2000);
});

test('only the most recent lines are kept in memory', () => {
  const log = new Log(tmp(), { max: 10 });
  for (let i = 0; i < 50; i++) log.info(`line ${i}`);
  const recent = log.recent(100);
  assert.equal(recent.length, 10);
  assert.match(recent.at(-1), /line 49/);
  assert.match(recent[0], /line 40/);
});

test('recent() is oldest-first, so a report reads in order', () => {
  const log = new Log(tmp());
  log.info('first'); log.info('second'); log.info('third');
  assert.deepEqual(log.recent(2).map(l => l.split('info  ')[1]), ['second', 'third']);
});
