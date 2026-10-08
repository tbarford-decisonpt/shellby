// What Claude is doing, in plain words: "Run your tests", "Edit app.js",
// "Search the web for ...". Rules over the tool call, never another Claude call,
// so it costs nothing and says only what the call itself shows. Claude's own
// reasoning is untouched; this only makes it easier to follow.
//
// Each tool call gets { ask, doing }: the permission card's sentence ("Run your
// tests in its own copy") and the Working bar's ("Running your tests"). A call
// asking permission also gets warnings: deletes, paths outside the project,
// installs, going online, pushing, and what's hard to undo.
// Pure. See test/plain-words.test.js; session.js attaches them to items.
const path = require('path');
const { classifyCommand } = require('./xp');
const { commandKind } = require('./bugdex/detect');
const { onlyLooks } = require('./worktrees');

const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const MAX = 120;

const clip = (s, n = MAX) => {
  const t = String(s ?? '').replace(/[\p{Cc}\p{Cf}]+/gu, ' ').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const lower1 = s => (s ? s[0].toLowerCase() + s.slice(1) : s);
const upper1 = s => (s ? s[0].toUpperCase() + s.slice(1) : s);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A path as you'd say it: relative to the project when it's inside, else as given. */
function shortPath(p, cwd) {
  const file = String(p || '');
  if (!file) return 'a file';
  if (cwd && isInside(file, cwd)) return path.win32.relative(cwd, file).replace(/\\/g, '/') || path.win32.basename(file);
  return file;
}

function isInside(file, dir) {
  if (!file || !dir) return false;
  const rel = path.win32.relative(path.win32.resolve(dir), path.win32.resolve(file));
  return rel === '' || (!rel.startsWith('..') && !path.win32.isAbsolute(rel));
}

// The verb pairs: what the card says it wants to do, and what the bar says it's doing.
const say = (ask, doing) => ({ ask, doing });

// Deleting things, in the shells Claude uses here.
const DELETE_RE = /(^|[;&|(]\s*)(rm|rmdir|rd|del|erase|Remove-Item|ri)\b([^;&|]*)/i;
const GIT_CLEAN_RE = /\bgit\s+clean\b/i;
const NET_RE = /\b(curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr|irm|Start-BitsTransfer)\b/i;
const HARD_UNDO_RE = /\bgit\s+(push\b.*\s(--force|-f)\b|reset\s+--hard|clean\s+-[a-z]*f)|\b(--force-with-lease)\b/i;

/** How many things a delete names (its arguments that aren't flags); 0 when it can't tell. */
function deleteCount(command) {
  const m = String(command || '').match(DELETE_RE);
  if (!m) return 0;
  return m[3].trim().split(/\s+/).filter(w => w && !/^[-/]/.test(w) && !/^-[A-Za-z]+$/.test(w)).length;
}

// More than one command: chained, piped, substituted or redirected. Naming the
// first part alone ("Run your tests" for `npm test && curl … | sh`) would hide
// the rest, so a card never does.
// A lone & counts too: cmd's separator, bash's background, PowerShell's call operator.
const CHAINED_RE = /&&|\|\||[;&|\r\n`<>]|\$\(|<\(/;
const SEPARATOR_RE = /&&|\|\||[;&|\r\n]/;
const partsOf = cmd => cmd.split(SEPARATOR_RE).map(s => s.trim()).filter(Boolean);

/**
 * A shell command -> { ask, doing, kind, changes } (changes: it may change files).
 * `ask` is what a permission card leads with, so it only ever comes from the
 * command itself. Claude's own description is model text a prompt injection
 * could word to look harmless: it may name the step in the Working bar
 * (`doing`), never on the card.
 */
function describeCommand(command, description) {
  const cmd = String(command || '').trim();
  const own = clip(description);
  // Only looking means every part only looks, each judged on its own.
  const parts = partsOf(cmd);
  const looks = parts.length > 0 && parts.every(onlyLooks) && onlyLooks(cmd);
  if (CHAINED_RE.test(cmd) && !looks) {
    return { ...say('Run several commands chained together', own ? upper1(own) : 'Running several commands'), kind: 'chain', changes: true };
  }
  const kind = classifyCommand(cmd) || commandKind(cmd);
  if (GIT_CLEAN_RE.test(cmd)) return { ...say('Delete the files git doesn\'t track', 'Deleting untracked files'), kind: 'delete', changes: true };
  if (DELETE_RE.test(cmd)) {
    const n = deleteCount(cmd);
    const what = n ? plural(n, 'file or folder', 'files or folders') : 'files';
    return { ...say(`Delete ${what}`, `Deleting ${what}`), kind: 'delete', changes: true };
  }
  const known = {
    deploy: say('Deploy, putting a new version live', 'Deploying'),
    ship: say('Push your commits to the remote', 'Pushing your commits'),
    tests: say('Run your tests', 'Running your tests'),
    lint: say('Check the code style', 'Checking the code style'),
    typecheck: say('Check the types', 'Checking the types'),
    install: say('Install packages', 'Installing packages'),
    build: say('Build the project', 'Building the project'),
  }[kind];
  if (known) return { ...known, kind, changes: !['tests', 'lint', 'typecheck'].includes(kind) };
  if (kind === 'git') {
    const sub = (cmd.match(/^git\s+(?:-\S+\s+)*(\S+)/i) || [])[1]?.toLowerCase();
    const git = {
      commit: say('Commit the changes', 'Committing the changes'),
      checkout: say('Switch branches', 'Switching branches'),
      switch: say('Switch branches', 'Switching branches'),
      merge: say('Merge a branch', 'Merging a branch'),
      rebase: say('Rebase the branch', 'Rebasing the branch'),
      reset: say('Reset the branch', 'Resetting the branch'),
      stash: say('Stash the changes', 'Stashing the changes'),
      pull: say('Pull from the remote', 'Pulling from the remote'),
      fetch: say('Fetch from the remote', 'Fetching from the remote'),
    }[sub];
    if (git) return { ...git, kind: 'git', changes: true };
    if (onlyLooks(cmd)) return { ...say('Look at the git history', 'Looking at the git history'), kind: 'look', changes: false };
  }
  if (looks) return { ...say('Look through the files', own ? upper1(own) : 'Looking through the files'), kind: 'look', changes: false };
  return { ...say('Run a command', own ? upper1(own) : 'Running a command'), kind: 'run', changes: true };
}

/**
 * One tool call -> { ask, doing } in plain words, or null for one with nothing
 * plainer to say. ctx: { cwd, inCopy } (inCopy: the tab works in its own copy).
 */
function describe(name, input = {}, { cwd = null, inCopy = false } = {}) {
  const i = input && typeof input === 'object' ? input : {};
  const copy = s => (inCopy ? `${s} in its own copy of the repo` : s);
  if (SHELL_TOOLS.has(name)) {
    const c = describeCommand(i.command, i.description);
    return c.changes ? { ask: copy(c.ask), doing: c.doing } : { ask: c.ask, doing: c.doing };
  }
  const file = shortPath(i.file_path || i.notebook_path, cwd);
  const base = path.win32.basename(String(i.file_path || i.notebook_path || '')) || 'a file'; // the bar is narrow
  switch (name) {
    case 'Edit': case 'MultiEdit': return { ask: copy(`Edit ${file}`), doing: `Editing ${base}` };
    case 'Write': return { ask: copy(`Write ${file}`), doing: `Writing ${base}` };
    case 'NotebookEdit': return { ask: copy(`Edit the notebook ${file}`), doing: `Editing ${base}` };
    case 'Read': return say(`Read ${file}`, `Reading ${base}`);
    case 'Glob': return say(`Look for files named ${clip(i.pattern, 60)}`, 'Looking for files');
    case 'Grep': return say(`Search the code for "${clip(i.pattern, 60)}"`, 'Searching the code');
    case 'WebSearch': return say(`Search the web for "${clip(i.query, 80)}"`, 'Searching the web');
    case 'WebFetch': {
      let host = 'a web page';
      try { host = new URL(i.url).host || host; } catch { /* keep the fallback */ }
      return say(`Open ${host}`, `Reading ${host}`);
    }
    case 'Agent': case 'Task': {
      const job = clip(i.description, 80);
      return job ? say(`Send a helper to ${lower1(job)}`, `A helper is ${lower1(job)}`) : say('Send a helper', 'A helper is on it');
    }
    case 'TodoWrite': return say('Update its to-do list', 'Updating its to-do list');
    default: {
      const mcp = String(name || '').match(/^mcp__(.+?)__(.+)$/);
      if (mcp) return say(`Use ${mcp[2]} from ${mcp[1]}`, `Using ${mcp[2]} from ${mcp[1]}`);
      return null;
    }
  }
}

// Absolute Windows paths in a command ("C:\x", "D:/y"), quoted or not.
const ABS_RE = /(?:^|[\s"'=(])([A-Za-z]:[\\/][^\s"'|&;<>)]*)/g;
// Paths that climb out or start from home, which an absolute-path check can't place.
const UP_OR_HOME_RE = /(?:^|[\s"'=(])(\.\.[\\/]|~[\\/]|%[A-Za-z_]+%|\$env:|\$HOME\b|\$\{?HOME\}?)/i;

/**
 * What deserves a second look before saying yes, beyond what the sentence
 * already says -> [string], short, in order of how much they matter.
 */
function warnings(name, input = {}, { cwd = null, originalCwd = null } = {}) {
  const i = input && typeof input === 'object' ? input : {};
  const out = [];
  const inside = p => [cwd, originalCwd].some(dir => dir && isInside(p, dir));
  if (SHELL_TOOLS.has(name)) {
    const cmd = String(i.command || '');
    const c = describeCommand(cmd);
    // Every part of a chain, not just the first: the sentence only says "several commands".
    const kinds = new Set(partsOf(cmd).map(part => classifyCommand(part) || commandKind(part)));
    // A lone delete already says so in its sentence; in a chain it doesn't, and git clean's reach is the surprise.
    if (GIT_CLEAN_RE.test(cmd)) out.push("Deletes every file git doesn't track, including ones never committed");
    else if (c.kind === 'chain' && DELETE_RE.test(cmd)) out.push('Deletes files');
    if (HARD_UNDO_RE.test(cmd)) out.push('Hard to undo');
    if (kinds.has('deploy')) out.push('Changes something live');
    if (kinds.has('ship')) out.push('Sends your commits to the remote');
    if (kinds.has('install')) out.push('Downloads and runs packages from the internet');
    else if (NET_RE.test(cmd)) out.push('Goes online');
    if (c.changes && cwd) {
      const outside = [...cmd.matchAll(ABS_RE)].map(m => m[1]).filter(p => !inside(p));
      if (outside.length) out.push(`Reaches outside the project: ${clip(outside[0], 80)}`);
      else if (UP_OR_HOME_RE.test(cmd)) out.push('May reach outside the project');
    }
  } else if (['Edit', 'MultiEdit', 'Write', 'NotebookEdit'].includes(name)) {
    const file = i.file_path || i.notebook_path;
    if (file && cwd && path.win32.isAbsolute(file) && !inside(file)) out.push(`Outside the project: ${clip(file, 80)}`);
  }
  return out;
}

/** A plan's markdown -> "4 steps · names 3 files", or null when there's nothing to count. */
function planSummary(plan) {
  const text = String(plan || '');
  if (!text.trim()) return null;
  const lines = text.split(/\r?\n/);
  const top = lines.filter(l => /^(\d+[.)]|[-*])\s+\S/.test(l)).length;
  const heads = lines.filter(l => /^#{2,4}\s+\S/.test(l)).length;
  const steps = top || heads;
  const files = new Set([...text.matchAll(/`([^`\s]+\.[A-Za-z0-9]{1,8})`/g)].map(m => m[1]).filter(f => /[\\/]|^[\w.-]+\.\w+$/.test(f) && !/^\d/.test(f)));
  const bits = [];
  if (steps) bits.push(plural(steps, 'step'));
  if (files.size) bits.push(`names ${plural(files.size, 'file')}`);
  return bits.length ? bits.join(' · ') : null;
}

/**
 * What to merge into a permission item: { plain, warnings, planSummary }, each
 * only when there's something to say. ctx: { cwd, inCopy, originalCwd }.
 */
function plainPermission(item, ctx = {}) {
  const out = {};
  if (item.toolName === 'ExitPlanMode') {
    const s = planSummary(item.plan);
    if (s) out.planSummary = s;
    return out;
  }
  if (item.toolName === 'AskUserQuestion') return out;
  const plain = describe(item.toolName, item.input, ctx);
  if (plain) out.plain = plain;
  const w = warnings(item.toolName, item.input, ctx);
  if (w.length) out.warnings = w;
  return out;
}

module.exports = { describe, describeCommand, warnings, planSummary, plainPermission, shortPath, isInside };
