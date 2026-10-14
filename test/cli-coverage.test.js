const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const cov = require('../src/main/cli-coverage');
const contract = require('../src/main/cli-contract');

const HELP = fs.readFileSync(path.join(__dirname, 'fixtures', 'claude-help.txt'), 'utf8');
const TRANSCRIPTS = path.join(__dirname, 'fixtures', 'cli-transcripts');

// The tools every recorded transcript's init listed.
function recordedTools() {
  const tools = new Set();
  for (const f of fs.readdirSync(TRANSCRIPTS)) {
    for (const line of fs.readFileSync(path.join(TRANSCRIPTS, f), 'utf8').split('\n')) {
      if (!line.includes('"init"')) continue;
      const ev = JSON.parse(line);
      if (ev.type === 'system' && ev.subtype === 'init') for (const t of ev.tools || []) tools.add(t);
    }
  }
  return [...tools];
}

test('parseHelp reads options and commands, not description lines', () => {
  const { flags, commands } = cov.parseHelp(HELP);
  assert.ok(flags.includes('--bg'), '--bg, --background counts as --bg');
  assert.ok(flags.includes('--allowedTools'));
  assert.ok(!flags.includes('--allowed-tools'), 'a second long name is the same option');
  assert.ok(!flags.includes('--append-system-prompt-file'), 'a description line is not an option');
  assert.ok(commands.includes('stop') && !commands.includes('kill'));
  assert.ok(!commands.includes('help'));
});

test('every flag, command and tool of the recorded CLI is accounted for', () => {
  const c = cov.coverageOf({ help: HELP, tools: recordedTools() });
  assert.deepEqual(c.unaccounted, { flags: [], commands: [], tools: [] }, 'add them to src/main/cli-coverage.js');
  assert.deepEqual(c.gone.flags, [], 'flags listed that Claude Code no longer has');
  assert.deepEqual(c.gone.commands, []);
});

test('every flag Shellby requires is marked as used', () => {
  const LONG = { '-p': '--print' };
  for (const { flag: given, hidden } of contract.REQUIRED_FLAGS) {
    if (hidden) continue;
    const flag = LONG[given] || given;
    assert.equal(cov.FLAGS[flag]?.status, 'use', `${flag} is in REQUIRED_FLAGS, so cli-coverage.js should say where it's used`);
  }
});

test('every entry is used, skipped with a reason, or a described gap', () => {
  for (const [kind, list] of [['flag', cov.FLAGS], ['command', cov.COMMANDS], ['tool', cov.TOOLS]]) {
    for (const [name, e] of Object.entries(list)) {
      const text = e.status === 'use' ? e.where : e.status === 'skip' ? e.why : e.status === 'gap' ? e.what : null;
      assert.ok(typeof text === 'string' && text.length > 5, `${kind} ${name} needs a where, why or what`);
    }
  }
});

test('a new flag, command or tool is reported, and MCP tools never are', () => {
  const help = HELP.replace('Options:\n', 'Options:\n  --shiny-new <x>                      Something new\n')
    .replace('Commands:\n', 'Commands:\n  sparkle                               Something new\n');
  const c = cov.coverageOf({ help, tools: ['Read', 'BrandNewTool', 'mcp__linear__list'] });
  assert.deepEqual(c.unaccounted, { flags: ['--shiny-new'], commands: ['sparkle'], tools: ['BrandNewTool'] });
  assert.ok(cov.needsAttention(c));
  const md = cov.coverageSummary(c, '9.9.9');
  assert.match(md, /flag `--shiny-new`/);
  assert.match(md, /tool `BrandNewTool`/);
});

test('a dropped flag is reported gone, and a shared gap is listed once', () => {
  const c = cov.coverageOf({ help: HELP.replace(/^ {2}--tmux .*$/m, ''), tools: null });
  assert.deepEqual(c.gone.flags, ['--tmux']);
  const brief = c.gaps.filter(g => g.what.startsWith('SendUserMessage'));
  assert.equal(brief.length, 1, '--brief and SendUserMessage share one gap');
});
