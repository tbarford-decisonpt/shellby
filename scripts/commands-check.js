#!/usr/bin/env node
'use strict';
// npm run commands:check — diffs Shellby's catalogue of Claude Code's slash
// commands (src/main/cli-commands.js) against the installed CLI, so a new,
// renamed or dropped command shows up the day Claude Code ships it.
//
// The CLI has no "list your commands" flag, and print mode only lists them in a
// conversation's init (which costs a message), so this reads the command
// definitions out of the installed CLI itself: the native claude.exe, or an
// npm cli.js. Heuristic, so a name it can't place is listed apart for a look.
//
//   npm run commands:check              the diff; exits 1 when they differ
//   npm run commands:check -- --write   also records the CLI's list as
//                                       test/fixtures/cli-commands.json
//   npm run commands:check -- <path>    check a given claude.exe or cli.js
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { findClaude } = require('../src/main/claude/cli');
const { CATALOGUE } = require('../src/main/cli-commands');

const FIXTURE = path.join(__dirname, '..', 'test', 'fixtures', 'cli-commands.json');
// Names the scan finds that aren't slash commands: bundled skills (they reach
// the menu as skills, from the init), and objects that only look like commands.
const NOT_COMMANDS = new Set([
  'artifact-components', 'batch', 'claude-api', 'claude-in-chrome', 'core', 'debug', 'design',
  'design-sync', 'fewer-permission-prompts', 'loop', 'run', 'run-skill-generator', 'schedule',
  'simplify', 'stub', 'update-config',
]);
const WINDOW = 300;   // how far either side of name:"…" a command's other fields sit

/** The CLI's own code: the native binary, or the npm package's cli.js. */
function cliCode(given) {
  const exe = given || findClaude(process.env);
  if (!exe) throw new Error('No Claude Code found. Install it, or pass the path to claude.exe or cli.js.');
  const real = fs.realpathSync(exe);
  const js = path.join(path.dirname(real), '..', 'cli.js');
  const file = /\.(exe|js|mjs|cjs)$/i.test(real) || !fs.existsSync(js) ? real : js;
  return { file, code: fs.readFileSync(file, 'latin1') };
}

/**
 * Every slash command defined in code: an object with name:"x" and, close by,
 * a command's type (local, local-jsx, prompt) or one of its tell-tale fields.
 */
function scanCommands(code) {
  const found = new Set();
  const re = /name:"([a-z][a-z0-9-]*)"/g;
  let m;
  while ((m = re.exec(code))) {
    const before = code.slice(Math.max(0, m.index - WINDOW), m.index);
    const near = before.slice(before.lastIndexOf('{')) + code.slice(m.index, m.index + WINDOW);
    const isCommand = /type:"(local-jsx|local|prompt)"|progressMessage|argumentHint|supportsNonInteractive|menuDescription/.test(near);
    if (isCommand && /description/i.test(near)) found.add(m[1]);
  }
  return [...found].filter(n => !NOT_COMMANDS.has(n)).sort();
}

function version(file) {
  try { return execFileSync(file, ['--version'], { encoding: 'utf8', timeout: 20000 }).trim().split(/\s/)[0]; } catch { return null; }
}

function main() {
  const args = process.argv.slice(2);
  const { file, code } = cliCode(args.find(a => !a.startsWith('--')));
  const cli = scanCommands(code);
  const ours = new Set(CATALOGUE.map(c => c.name));
  const added = cli.filter(n => !ours.has(n));
  const gone = [...ours].filter(n => !cli.includes(n)).sort();
  const v = /\.exe$/i.test(file) ? version(file) : null;
  console.log(`Claude Code ${v || '(version unknown)'} at ${file}: ${cli.length} commands, catalogue ${ours.size}.`);
  if (added.length) console.log(`\nNew in the CLI (add to src/main/cli-commands.js, or to NOT_COMMANDS here if it isn't one):\n  /${added.join('\n  /')}`);
  if (gone.length) console.log(`\nIn the catalogue, not the CLI (gone or renamed?):\n  /${gone.join('\n  /')}`);
  if (!added.length && !gone.length) console.log('The catalogue matches.');
  if (args.includes('--write')) {
    fs.writeFileSync(FIXTURE, `${JSON.stringify({ version: v, commands: cli }, null, 2)}\n`);
    console.log(`\nRecorded the CLI's list in ${path.relative(process.cwd(), FIXTURE)}.`);
  }
  process.exitCode = added.length || gone.length ? 1 : 0;
}

if (require.main === module) {
  try { main(); } catch (e) { console.error(e.message); process.exitCode = 2; }
}

module.exports = { scanCommands, NOT_COMMANDS };
