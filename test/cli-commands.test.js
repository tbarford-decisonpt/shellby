// Claude Code's own slash commands (src/main/cli-commands.js): the catalogue,
// how it follows the live CLI, what print mode's "can't run that" becomes, and
// the slash menu showing them.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { CATALOGUE, HANDLING, builtin, builtinCommands, headlessReply } = require('../src/main/cli-commands');
const { scanCommands } = require('../scripts/commands-check');
const { toItems } = require('../src/main/stream');
const L = require('../src/renderer/panel/tab-logic');

const FIXTURE = require(path.join(__dirname, 'fixtures', 'cli-commands.json'));
const names = list => list.map(t => t.name);

test('the catalogue has exactly the commands the recorded CLI has (npm run commands:check to update)', () => {
  const ours = names(CATALOGUE).sort();
  const cli = [...FIXTURE.commands].sort();
  assert.deepEqual(ours.filter(n => !cli.includes(n)), [], 'in the catalogue, not the CLI');
  assert.deepEqual(cli.filter(n => !ours.includes(n)), [], 'new in the CLI: add them to src/main/cli-commands.js');
});

test('every entry has a description and a known handling; terminal ones say why', () => {
  const kinds = new Set(Object.values(HANDLING));
  for (const c of CATALOGUE) {
    assert.ok(c.description, `/${c.name} has a description`);
    assert.ok(kinds.has(c.handling), `/${c.name} handling`);
    if (c.handling === HANDLING.TERMINAL) assert.ok(c.reason, `/${c.name} says why it needs the terminal`);
  }
});

test('names and aliases are unique, and an alias finds its command', () => {
  const all = CATALOGUE.flatMap(c => [c.name, ...(c.aliases || [])]);
  assert.equal(new Set(all).size, all.length);
  assert.equal(builtin('bashes').name, 'tasks');
  assert.equal(builtin('/Settings').name, 'config');
  assert.equal(builtin('nope'), null);
});

test('builtinCommands: the whole catalogue before an init, less hidden ones, with a pill-ready shape', () => {
  const list = builtinCommands(null);
  assert.ok(list.length > 50);
  assert.ok(!list.some(c => c.name === 'heapdump'), 'hidden ones stay out');
  const compact = list.find(c => c.name === 'compact');
  assert.equal(compact.builtin, true);
  assert.equal(compact.handling, 'cli');
  assert.equal(compact.kind, 'command');
});

test('builtinCommands: once an init lists commands, cli ones it dropped are hidden; Shellby and terminal ones stay', () => {
  const list = names(builtinCommands(['compact', 'context']));
  assert.ok(list.includes('compact'));
  assert.ok(!list.includes('insights'), 'a cli command the CLI no longer lists');
  assert.ok(list.includes('resume'), "Shellby's own handling doesn't need the CLI to list it");
  assert.ok(list.includes('theme'));
});

test('builtinCommands: the live description wins over the catalogue one', () => {
  const said = new Map([['compact', 'Squash it all down.']]);
  assert.equal(builtinCommands(['compact'], said).find(c => c.name === 'compact').description, 'Squash it all down.');
});

test('headlessReply: print mode\'s "isn\'t available" and "unknown command" answers become plain words', () => {
  const theme = headlessReply("/theme opens an interactive panel and isn't available in this environment. Run it from the Claude Code terminal instead.");
  assert.match(theme, /\/theme only works in Claude Code's own terminal/);
  assert.match(theme, /Continue this conversation in a terminal/);
  assert.match(headlessReply("<local-command-stderr>/foo isn't available in this environment.</local-command-stderr>"), /\/foo only works/);
  assert.equal(headlessReply('Unknown command: /comapct. Did you mean /compact?'), "Claude Code doesn't have a /comapct command. Did you mean /compact? Type / to see them all.");
  assert.match(headlessReply('Unknown command: /zzz'), /doesn't have a \/zzz command\./);
  assert.equal(headlessReply('All done.'), null);
  assert.equal(headlessReply(null), null);
});

test('stream: a result that is a "can\'t run that here" answer brings a readable reply with it', () => {
  const items = toItems({ type: 'result', subtype: 'success', is_error: false, result: 'Unknown command: /zzz' });
  assert.deepEqual(items.map(i => i.kind), ['text', 'result']);
  assert.match(items[0].text, /\/zzz/);
  assert.deepEqual(toItems({ type: 'result', subtype: 'success', is_error: false, result: 'Done.' }).map(i => i.kind), ['result']);
});

test('scanCommands finds command definitions and skips look-alikes and bundled skills', () => {
  const code = [
    'var a={type:"local-jsx",name:"theme",description:"Change the theme"};',
    'var b={description:"x",name:"rewind",aliases:["undo"],argumentHint:"",type:"local"};',
    'var c={name:"todos",run:()=>1};',
    'var d={type:"prompt",name:"simplify",description:"bundled skill"};',
  ].join(`\n${'x'.repeat(400)}\n`);   // other code between them, as in the CLI
  assert.deepEqual(scanCommands(code), ['rewind', 'theme']);
});

test('slash menu: Claude Code\'s own show with a "claude code" pill, after yours of the same name', () => {
  const builtins = builtinCommands(null);
  const got = L.slashCandidates('comp', { builtins });
  const compact = got.find(t => t.name === 'compact');
  assert.equal(compact.pill, 'claude code');
  assert.match(compact.description, /Summarize/);
  const mine = L.slashCandidates('compact', { commands: [{ name: 'compact', description: 'my own' }], builtins });
  assert.equal(mine.filter(t => t.name === 'compact').length, 1);
  assert.equal(mine[0].description, 'my own');
});
