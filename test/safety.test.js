// Safety flags on permission cards (src/main/safety.js): which files are
// Claude's own configuration. A mod's code runs in every conversation, so a
// write to one is named as that, not as the skill folder it sits in.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { selfConfigTarget, annotatePermission } = require('../src/main/safety');

const MOD = 'a mod, code that runs inside every Claude Code conversation';

test("selfConfigTarget: a mod's hooks and plugin.json inside ~/.claude/skills are a mod", () => {
  assert.equal(selfConfigTarget('C:\\Users\\x\\.claude\\skills\\tidy\\hooks\\register.ts'), MOD);
  assert.equal(selfConfigTarget('C:\\Users\\x\\.claude\\skills\\tidy\\.claude-plugin\\plugin.json'), MOD);
  assert.equal(selfConfigTarget('C:/Users/x/.claude/skills/tidy/hooks/hooks.json'), MOD);
  assert.match(selfConfigTarget('C:\\Users\\x\\.claude\\skills\\tidy\\hooks\\register.ts'), /a mod/);
});

test('selfConfigTarget: the dev-mods folder is a mod', () => {
  assert.equal(selfConfigTarget('C:\\Users\\x\\.claude\\dev-mods\\probe\\register.ts'), MOD);
  assert.equal(selfConfigTarget('/home/x/.claude/dev-mods/probe/hooks/hooks.json'), MOD);
});

test('selfConfigTarget: a plain skill file is still a skill', () => {
  assert.equal(selfConfigTarget('C:\\Users\\x\\.claude\\skills\\foo\\SKILL.md'), 'a skill');
  assert.equal(selfConfigTarget('C:\\Users\\x\\.claude\\skills\\foo\\notes\\hooks.md'), 'a skill');
  assert.equal(selfConfigTarget('C:\\Users\\x\\.claude\\skills\\hooks\\SKILL.md'), 'a skill', 'a skill named hooks is not a mod folder');
});

test('selfConfigTarget: other files are not configuration', () => {
  assert.equal(selfConfigTarget('C:\\Users\\x\\project\\src\\hooks\\register.ts'), null);
  assert.equal(selfConfigTarget(''), null);
  assert.equal(selfConfigTarget(undefined), null);
});

test('annotatePermission: writing a mod flags the card as selfConfig', () => {
  const flags = annotatePermission({ toolName: 'Write', filePath: 'C:\\Users\\x\\.claude\\skills\\tidy\\hooks\\register.ts' });
  assert.equal(flags.selfConfig, MOD);
  const cmd = annotatePermission({ toolName: 'Bash', input: { command: 'echo x > C:\\Users\\x\\.claude\\skills\\tidy\\.claude-plugin\\plugin.json' } });
  assert.equal(cmd.selfConfig, MOD);
});
