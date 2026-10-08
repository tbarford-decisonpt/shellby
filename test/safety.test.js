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

test('selfConfigTarget: a relative .claude path in a shell command counts, however it is written', () => {
  const bash = command => annotatePermission({ toolName: 'Bash', input: { command } }).selfConfig ?? null;
  assert.equal(bash('cat > .claude/settings.local.json'), "Claude Code's settings");
  assert.equal(bash('echo x >> .claude/hooks/a.sh'), 'a hook script');
  assert.equal(bash('echo x>.claude/settings.json'), "Claude Code's settings");
  assert.equal(bash('.claude/hooks/a.sh'), 'a hook script', 'at the very start');
  assert.equal(bash('cp a.md ".claude/agents/b.md"'), 'a subagent');
  assert.equal(bash("cp a.md '.claude/commands/b.md'"), 'a slash command');
  assert.equal(bash('FILE=.claude/skills/x/SKILL.md'), 'a skill');
  assert.equal(bash('Set-Content .claude\\settings.json "{}"'), "Claude Code's settings");
  assert.equal(bash('echo {} > .mcp.json'), 'MCP server config');
  assert.equal(bash('echo rule >> CLAUDE.md'), 'CLAUDE.md instructions');
  // Not .claude: a name that only ends in it.
  assert.equal(bash('cat notes.claude/settings.json'), null);
  assert.equal(bash('cat my.claude.json'), null);
});

test('selfConfigTarget: claude mcp add and claude config are self-config', () => {
  const bash = command => annotatePermission({ toolName: 'Bash', input: { command } }).selfConfig ?? null;
  assert.equal(bash('claude mcp add fs -- npx -y @modelcontextprotocol/server-filesystem .'), 'MCP server config');
  assert.equal(bash('npm i && claude mcp add-json x \'{}\''), 'MCP server config');
  assert.equal(bash('"C:\\tools\\claude.exe" mcp add x'), 'MCP server config');
  assert.equal(bash('claude config set -g autoUpdates false'), "Claude Code's config");
  assert.equal(bash('cd x; claude config add allowedTools Bash'), "Claude Code's config");
  assert.equal(bash('claude mcp list'), null, 'listing changes nothing');
  assert.equal(bash('echo claudeconfig'), null);
  assert.equal(bash('npx myclaude config set x'), null);
});

test('annotatePermission: writing a mod flags the card as selfConfig', () => {
  const flags = annotatePermission({ toolName: 'Write', filePath: 'C:\\Users\\x\\.claude\\skills\\tidy\\hooks\\register.ts' });
  assert.equal(flags.selfConfig, MOD);
  const cmd = annotatePermission({ toolName: 'Bash', input: { command: 'echo x > C:\\Users\\x\\.claude\\skills\\tidy\\.claude-plugin\\plugin.json' } });
  assert.equal(cmd.selfConfig, MOD);
});
