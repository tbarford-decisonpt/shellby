// The workflow service is one object built from parts in their own files
// (approvals, run-queue, steps, drafting) mixed onto it. These pin that the
// pieces fit: every part's methods land on the service, none collide, and
// the shared helpers behave.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { same, clean, mixin } = require('../src/main/workflows/util');
const { WorkflowService, MAX_ACTIVE } = require('../src/main/workflows/service');
const { Approvals, MAX_CONFIRM_DETAIL } = require('../src/main/workflows/approvals');
const runQueue = require('../src/main/workflows/run-queue');
const { Steps } = require('../src/main/workflows/steps');
const { Drafting } = require('../src/main/workflows/drafting');

const methodsOf = cls => Object.getOwnPropertyNames(cls.prototype).filter(n => n !== 'constructor');
const parts = [Approvals, runQueue.RunQueue, Steps, Drafting];

test('every part method ends up on WorkflowService as the same function', () => {
  for (const part of parts) {
    for (const name of methodsOf(part)) {
      assert.equal(WorkflowService.prototype[name], part.prototype[name], `${part.name}.${name}`);
    }
  }
});

test('no two parts define the same method', () => {
  const names = parts.flatMap(methodsOf);
  assert.equal(new Set(names).size, names.length);
});

test('the service keeps its public entry points', () => {
  for (const name of ['start', 'shutdown', 'save', 'remove', 'runManual', 'trigger', 'event', 'answer', 'resumeRun', 'stopRun',
    'draft', 'repair', 'chat', 'importText', 'exportText', 'setSecret', 'deleteSecret', 'mcpServerList', 'mcpTools',
    'runFromClaude', 'proposeFromClaude', 'webhook', 'claudeList', 'onTabItem', 'onTabClosed', 'view', 'validate']) {
    assert.equal(typeof WorkflowService.prototype[name], 'function', name);
  }
});

test('run limits are exported from the service as before', () => {
  assert.equal(MAX_ACTIVE, runQueue.MAX_ACTIVE);
  assert.equal(MAX_ACTIVE, 4);
  assert.ok(runQueue.MAX_QUEUED >= runQueue.MAX_QUEUED_EACH);
  assert.equal(MAX_CONFIRM_DETAIL, 12000);
});

test('mixin copies methods but not the constructor, and they share this', () => {
  class Base { constructor() { this.n = 1; } }
  class Part { constructor() { this.n = 99; } bump() { this.n += 1; return this.n; } }
  mixin(Base, Part);
  const b = new Base();
  assert.equal(b.n, 1, 'the target constructor is untouched');
  assert.equal(b.bump(), 2);
  assert.equal(Object.prototype.hasOwnProperty.call(Base.prototype, 'bump'), true);
});

test('mixin keeps getters as getters', () => {
  class Base { constructor() { this.v = 3; } }
  class Part { get double() { return this.v * 2; } }
  mixin(Base, Part);
  assert.equal(new Base().double, 6);
});

test('same compares names ignoring case and surrounding space', () => {
  assert.equal(same(' Deploy ', 'deploy'), true);
  assert.equal(same(null, ''), true);
  assert.equal(same('a', 'b'), false);
});

test('clean turns control characters into spaces and trims', () => {
  const ctrl = String.fromCharCode(0, 7, 27, 127);
  assert.equal(clean(`  hi${ctrl}there\n`), 'hi there');
  assert.equal(clean(undefined), '');
  assert.equal(clean(42), '42');
});
