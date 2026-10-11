// Claude Code's `auth status` says signed in whenever credentials are saved,
// even ones the server has turned down. After a turn fails as signed out,
// Shellby says so until the credentials change (claude/cli.js).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { signInLapsed, applyLapsed } = require('../src/main/claude/cli');

function setup() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-lapsed-'));
  const creds = path.join(configDir, '.credentials.json');
  fs.writeFileSync(creds, '{}');
  const status = { installed: true, loggedIn: true, authMethod: 'claude.ai', email: 'crab@example.com', configDir };
  return { creds, status };
}

test('a sign-in turned down mid-turn shows as signed out, through later checks', () => {
  const { status } = setup();
  const now = signInLapsed(status);
  assert.equal(now.loggedIn, false);
  assert.equal(now.lapsed, true);
  const later = applyLapsed(status); // `claude auth status` still says signed in
  assert.equal(later.loggedIn, false);
  assert.equal(later.lapsed, true);
});

test('signing in again (the credentials change) clears it', () => {
  const { creds, status } = setup();
  signInLapsed(status);
  const t = new Date(Date.now() + 5000);
  fs.utimesSync(creds, t, t);
  assert.deepEqual(applyLapsed(status), status);
  assert.deepEqual(applyLapsed(status), status, 'and it stays cleared');
});

test('a real sign-out clears it, and an API key is never marked', () => {
  const { status } = setup();
  signInLapsed(status);
  assert.equal(applyLapsed({ ...status, loggedIn: false }).lapsed, undefined);
  assert.deepEqual(applyLapsed(status), status);
  const key = { ...status, authMethod: 'api_key' };
  assert.deepEqual(signInLapsed(key), key);
});
