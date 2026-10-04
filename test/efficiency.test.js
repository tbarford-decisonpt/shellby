const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const eff = require('../src/main/efficiency');
const { scanTranscripts } = require('../src/main/usagescan');
const { ClaudeSession } = require('../src/main/session');

const NOW = new Date(2026, 9, 3, 15, 0).getTime();
const MIN = 60 * 1000;
const H = 60 * MIN;
const D = 24 * H;

const assistant = (id, usage, extra = {}) => ({ type: 'assistant', message: { id, model: 'claude-opus-5-5', usage, content: [] }, ...extra });

// ---- the prompt cache

test('a call: cache reads, writes and fresh input, and how long its cache lasts', () => {
  const c = eff.callFrom(assistant('m1', {
    input_tokens: 12, cache_creation_input_tokens: 300, cache_read_input_tokens: 9000, output_tokens: 50,
    cache_creation: { ephemeral_1h_input_tokens: 300, ephemeral_5m_input_tokens: 0 },
  }));
  assert.deepEqual(c, { messageId: 'm1', main: true, ttlMs: H, input: 12, write: 300, read: 9000 });
  assert.equal(eff.callFrom(assistant('m2', { cache_creation: { ephemeral_5m_input_tokens: 5 } })).ttlMs, 5 * MIN);
  assert.equal(eff.callFrom(assistant('m3', { input_tokens: 1 })).ttlMs, null, "a call that wrote nothing doesn't say");
  assert.equal(eff.callFrom(assistant('m4', { input_tokens: 1 }, { parent_tool_use_id: 'toolu_1' })).main, false);
  assert.equal(eff.callFrom({ type: 'user' }), null);
  assert.equal(eff.callFrom(assistant('m5', null)), null);
  assert.deepEqual(eff.callFrom(assistant('m6', { input_tokens: -3, cache_read_input_tokens: 'lots' })), { messageId: 'm6', main: true, ttlMs: null, input: 0, write: 0, read: 0 });
});

test('the daily ledger adds up calls and keeps three weeks', () => {
  let d = {};
  d = eff.recordCall(d, { input: 10, write: 100, read: 900, isNew: true }, NOW);
  d = eff.recordCall(d, { input: 0, write: 0, read: 100, isNew: false }, NOW + MIN);
  d = eff.recordCall(d, { input: 0, write: 0, read: 0, isNew: true }, NOW + MIN);
  assert.deepEqual(d['2026-10-03'], { input: 10, write: 100, read: 1000, calls: 1 });
  for (let i = 1; i <= 30; i++) d = eff.recordCall(d, { read: 1, isNew: true }, NOW - i * D);
  assert.equal(Object.keys(d).length, 21);
  assert.ok(d['2026-10-03'], 'today is kept');
  assert.deepEqual(eff.normalizeDays({ junk: 1, '2026-10-01': { read: 5, calls: 2.7 }, '2026-10-02': { read: -1 } }), { '2026-10-01': { input: 0, write: 0, read: 5, calls: 2 } });
  assert.deepEqual(eff.normalizeDays(null), {});
});

test('the cache summary: hit rate and what the reads saved, this week against last', () => {
  let d = {};
  d = eff.recordCall(d, { input: 100, write: 100, read: 800, isNew: true }, NOW);
  d = eff.recordCall(d, { input: 500, write: 0, read: 500, isNew: true }, NOW - 8 * D);
  const s = eff.cacheSummary(d, NOW);
  assert.equal(s.today.rate, 0.8);
  assert.equal(s.week.rate, 0.8);
  assert.equal(s.week.saved, 720, 'reads cost a tenth, so 90% of them is saved');
  assert.equal(s.lastWeek.rate, 0.5);
  assert.equal(eff.cacheSummary({}, NOW).week.rate, null);
});

test('a tab cache: warm, then cooling in its last fifth, then cold', () => {
  const cache = { at: NOW, ttlMs: 5 * MIN };
  assert.equal(eff.cacheState(cache, NOW + MIN).state, 'warm');
  assert.equal(eff.cacheState(cache, NOW + 4.5 * MIN).state, 'cooling');
  assert.deepEqual(eff.cacheState(cache, NOW + 6 * MIN), { state: 'cold', leftMs: 0, ttlMs: 5 * MIN });
  assert.equal(eff.cacheState({ at: NOW, ttlMs: H }, NOW + 30 * MIN).state, 'warm', 'an hour-long cache');
  assert.equal(eff.cacheState({ at: NOW }, NOW + 6 * MIN).state, 'cold', 'five minutes when unknown');
  assert.equal(eff.cacheState(null, NOW), null);
});

// ---- setup weight

test("setup weight is a new conversation's first call less its prompt", () => {
  assert.equal(eff.promptChars('hello'), 5);
  assert.equal(eff.promptChars([{ type: 'text', text: 'ab' }, { type: 'text', text: 'cd' }]), 4);
  assert.equal(eff.promptChars([{ type: 'text', text: 'ab' }, { type: 'image', source: {} }]), null, "an image can't be sized");
  assert.equal(eff.setupTokens({ input: 3, write: 20000, read: 0 }, 400), 19903);
  assert.equal(eff.setupTokens({ input: 3, write: 20000, read: 0 }, null), null);
  assert.equal(eff.setupTokens({ input: 0, write: 0, read: 0 }, 0), null);
});

test('setup weights are kept per project, newest first', () => {
  let s = {};
  s = eff.recordSetup(s, { key: 'c:\\a', name: 'a' }, 18000, NOW);
  s = eff.recordSetup(s, { key: 'c:\\a', name: 'a' }, 15000, NOW + 1);
  s = eff.recordSetup(s, null, 1, NOW);
  assert.deepEqual(s, { 'c:\\a': { name: 'a', tokens: 15000, at: NOW + 1 } });
  for (let i = 0; i < 40; i++) s = eff.recordSetup(s, { key: `p${i}`, name: `p${i}` }, 100, NOW + 10 + i);
  assert.equal(Object.keys(s).length, 30);
  assert.ok(!s['c:\\a'], 'the oldest go first');
});

test('a session reports each call once, its cache, and a new conversation\'s setup', () => {
  const s = new ClaudeSession({ exe: process.execPath, cwd: os.tmpdir(), mode: 'ask' });
  const calls = [];
  const caches = [];
  s.on('call', c => calls.push(c));
  s.on('cache', c => caches.push(c));
  s.setupChars = 400; // what send() notes for a conversation with no id yet
  const first = { input_tokens: 3, cache_creation_input_tokens: 20000, cache_read_input_tokens: 0, cache_creation: { ephemeral_1h_input_tokens: 20000 } };
  s.countCall(assistant('m1', first));
  s.countCall(assistant('m1', { ...first, output_tokens: 99 })); // the same call, a later block
  s.countCall(assistant('m2', { input_tokens: 5, cache_read_input_tokens: 20100 }));
  s.countCall(assistant('m3', { input_tokens: 1, cache_read_input_tokens: 50 }, { parent_tool_use_id: 'toolu_1' }));
  assert.deepEqual(calls, [
    { input: 3, write: 20000, read: 0, isNew: true, setup: 19903 },
    { input: 5, write: 0, read: 20100, isNew: true, setup: null },
    { input: 1, write: 0, read: 50, isNew: true, setup: null },
  ]);
  assert.equal(caches.length, 2, "once per call, and a subagent's call doesn't touch the conversation's cache");
  assert.equal(s.cache.ttlMs, H, 'the hour-long write is remembered for later calls');
});

test('a session with a conversation already going measures no setup', () => {
  const s = new ClaudeSession({ exe: process.execPath, cwd: os.tmpdir(), mode: 'ask', resumeId: 'abc' });
  const calls = [];
  s.on('call', c => calls.push(c));
  s.countCall(assistant('m1', { input_tokens: 3, cache_read_input_tokens: 9000 }));
  assert.equal(calls[0].setup, null);
});

// ---- what gets used

const line = (content, role = 'assistant', at = '2026-10-01T10:00:00.000Z') => JSON.stringify({ type: role, timestamp: at, message: { role, content } });

test('a transcript line: skills, agents, MCP servers and slash commands', () => {
  const r = eff.usedIn(line([
    { type: 'tool_use', name: 'Skill', input: { skill: 'frontend-design:frontend-design' } },
    { type: 'tool_use', name: 'Agent', input: { subagent_type: 'ecc:planner' } },
    { type: 'tool_use', name: 'mcp__plugin_github_github__get_me', input: {} },
    { type: 'tool_use', name: 'mcp__context7__query-docs', input: {} },
    { type: 'tool_use', name: 'Read', input: { file_path: 'x' } },
  ]));
  assert.equal(r.at, Date.parse('2026-10-01T10:00:00.000Z'));
  assert.deepEqual(r.keys.sort(), ['agent:ecc:planner', 'mcp:context7', 'mcp:plugin_github_github', 'skill:frontend-design:frontend-design']);
  assert.deepEqual(eff.usedIn(line('<command-message>x</command-message>\n<command-name>/ecc:plan</command-name>', 'user')).keys, ['skill:ecc:plan']);
  assert.equal(eff.usedIn(line([{ type: 'text', text: 'no tools here' }])), null);
  assert.equal(eff.usedIn('{"tool_use": broken'), null);
  assert.equal(eff.usedIn(line([{ type: 'tool_use', name: 'Skill', input: { skill: 'x' } }], 'assistant', 'not a date')), null);
});

test('which plugin a used thing belongs to', () => {
  assert.equal(eff.ownerOf('skill:ecc:plan'), 'ecc');
  assert.equal(eff.ownerOf('agent:feature-dev:code-reviewer'), 'feature-dev');
  assert.equal(eff.ownerOf('mcp:plugin_chrome-devtools-mcp_chrome-devtools'), 'chrome-devtools-mcp');
  assert.equal(eff.ownerOf('mcp:context7'), null);
  assert.equal(eff.ownerOf('skill:impeccable'), null, 'your own skill');
  assert.deepEqual(eff.lastUsedByPlugin({ 'skill:ecc:plan': 5, 'agent:ecc:planner': 9, 'skill:mine': 7 }), { ecc: 9 });
});

test('a bare skill or agent name counts for every plugin that brings one by that name', () => {
  const tools = {
    skills: [
      { name: 'frontend-design:frontend-design', source: 'plugin:frontend-design' },
      { name: 'example-skills:frontend-design', source: 'plugin:example-skills' },
      { name: 'impeccable', source: 'user' },
    ],
    commands: [{ name: 'ecc:plan', source: 'plugin:ecc' }],
    agents: [{ name: 'feature-dev:code-reviewer', source: 'plugin:feature-dev' }],
  };
  const used = { 'skill:frontend-design': 50, 'agent:code-reviewer': 40, 'skill:impeccable': 30, 'skill:plan': 20 };
  assert.deepEqual(eff.lastUsedByPlugin(used, tools), { 'frontend-design': 50, 'example-skills': 50, 'feature-dev': 40, ecc: 20 });
  assert.deepEqual(eff.lastUsedByPlugin(used), {}, 'without the Toolbox, bare names belong to nobody');

  const plugins = [plugin('frontend-design'), plugin('example-skills')];
  const r = eff.leanReport({ plugins, tools, used: { 'skill:frontend-design': NOW - D }, watchedSince: NOW - 30 * D, now: NOW });
  assert.ok(r.plugins.every(p => !p.idle), 'a plugin whose skill is called by its bare name is not idle');
});

test('recordUse keeps the latest time for each key', () => {
  let u = eff.recordUse({}, ['skill:a', 'mcp:b'], 10);
  u = eff.recordUse(u, ['skill:a'], 5);
  u = eff.recordUse(u, ['skill:a'], 20);
  assert.deepEqual(u, { 'skill:a': 20, 'mcp:b': 10 });
});

test('a rule with a paths: list loads only for matching files', () => {
  assert.equal(eff.loadsOnDemand('---\npaths:\n  - "**/*.ts"\n---\n# TS rules'), true);
  assert.equal(eff.loadsOnDemand('﻿---\r\ndescription: x\r\npaths: ["**/*.py"]\r\n---\r\nbody'), true);
  assert.equal(eff.loadsOnDemand('---\ndescription: always\n---\n# paths: not frontmatter'), false);
  assert.equal(eff.loadsOnDemand('# Agent Orchestration\npaths: in the body'), false);
  assert.equal(eff.loadsOnDemand(''), false);
  assert.equal(eff.loadsOnDemand('---\npaths:\n  - "**/*.ts"\n---\n', 'project'), false, 'a CLAUDE.md always loads, paths: or not');
  assert.equal(eff.loadsOnDemand('---\npaths:\n  - "**/*.ts"\n---\n', 'project-rule'), true);
});

// ---- the Lean tab

const plugin = (name, extra = {}) => ({ id: `${name}@market`, name, enabled: true, scope: 'user', alwaysOnTokens: 1000, background: false, installedAt: NOW - 60 * D, ...extra });

test('idle needs three weeks of history, and three weeks installed', () => {
  const plugins = [plugin('used'), plugin('quiet', { alwaysOnTokens: 3000 }), plugin('new', { installedAt: NOW - 2 * D }), plugin('off', { enabled: false }),
    plugin('hooks', { alwaysOnTokens: 10, background: true }), plugin('unknown', { alwaysOnTokens: null, background: null })];
  const used = { 'skill:used:go': NOW - 3 * D, 'mcp:context7': NOW - 40 * D };
  const mcp = [{ name: 'context7', status: 'connected' }, { name: 'plugin:github:github' }];
  const r = eff.leanReport({ plugins, mcp, mcpSeen: { context7: NOW - 30 * D }, used, watchedSince: NOW - 30 * D, now: NOW });
  assert.equal(r.watched, true);
  assert.deepEqual(r.plugins.map(p => [p.name, p.idle]), [['quiet', true], ['new', false], ['used', false], ['hooks', false], ['unknown', false]],
    'hooks and plugins Claude Code would not describe work out of sight: never idle');
  assert.equal(r.plugins.find(p => p.name === 'used').lastUsed, NOW - 3 * D);
  assert.deepEqual(r.mcp.map(s => [s.name, s.idle]), [['context7', true]], "a plugin's server counts with its plugin");
  assert.deepEqual([r.totals.plugins, r.totals.idlePlugins, r.totals.idleCount], [5010, 3000, 2]);

  const early = eff.leanReport({ plugins, mcp, used, watchedSince: NOW - 5 * D, now: NOW });
  assert.equal(early.watched, false);
  assert.ok(early.plugins.every(p => !p.idle), "too little history: nothing's idle");
  assert.ok(eff.leanReport({ plugins, used: {}, watchedSince: null, now: NOW }).plugins.every(p => !p.idle));
});

test('nothing is idle that only lately arrived, came back, or has no known start', () => {
  const watched = { used: {}, watchedSince: NOW - 30 * D, now: NOW };
  const mcp = [{ name: 'fresh' }, { name: 'old' }, { name: 'unknown' }];
  const r = eff.leanReport({ ...watched, mcp, mcpSeen: { fresh: NOW - 2 * D, old: NOW - 25 * D } });
  assert.deepEqual(r.mcp.map(s => [s.name, s.idle]), [['old', true], ['fresh', false], ['unknown', false]], 'a server added yesterday is not idle');
  const plugins = [plugin('back', { enabledAt: NOW - 3 * D }), plugin('nodate', { installedAt: null })];
  assert.ok(eff.leanReport({ ...watched, plugins }).plugins.every(p => !p.idle), 'turned back on lately, or no install date: not idle');
});

test("a plugin's MCP server finds its plugin even with underscores in the name", () => {
  assert.equal(eff.ownerOf('mcp:plugin_my_tools_server', ['my', 'my_tools']), 'my_tools', 'the longest name that fits');
  assert.equal(eff.ownerOf('mcp:plugin_my_tools_server', ['other']), 'my', 'unknown plugins: the first part');
  assert.deepEqual(eff.lastUsedByPlugin({ 'mcp:plugin_my_tools_server': 5 }, null, ['my_tools']), { my_tools: 5 });
});

test('the Lean tab: setup for this project, memory sizes, the cache', () => {
  const setups = { 'c:\\a': { name: 'a', tokens: 18000, at: NOW - H }, 'c:\\b': { name: 'b', tokens: 12000, at: NOW } };
  const memory = [{ path: 'C:\\CLAUDE.md', scope: 'user', exists: true, size: 4000 }, { path: 'C:\\x\\CLAUDE.md', scope: 'project', exists: false, size: 0 },
    { path: 'C:\\rules\\ts.md', scope: 'user-rule', exists: true, size: 8000, onDemand: true }];
  const days = eff.recordCall({}, { input: 1, write: 1, read: 8, isNew: true }, NOW);
  const r = eff.leanReport({ setups, projectKey: 'c:\\a', memory, days, now: NOW });
  assert.equal(r.setup.name, 'a');
  assert.equal(eff.leanReport({ setups, projectKey: 'c:\\zzz', now: NOW }).setup.name, 'b', 'the newest when this project has none');
  assert.deepEqual(r.memory.map(m => [m.tokens, m.onDemand]), [[1000, false], [2000, true]], 'always-loaded files first');
  assert.deepEqual([r.totals.memory, r.totals.memoryOnDemand], [1000, 2000], 'path-scoped rules are not carried every time');
  assert.equal(r.cache.week.rate, 0.8);
  assert.equal(eff.leanReport({ now: NOW }).setup, null);
});

// ---- reading the transcripts

test('scanTranscripts reads new and changed transcripts only', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-lean-'));
  const dir = path.join(root, 'projects', 'C--x');
  fs.mkdirSync(path.join(dir, 'abc', 'subagents'), { recursive: true });
  const a = path.join(dir, 'abc.jsonl');
  const sub = path.join(dir, 'abc', 'subagents', 'agent-1.jsonl');
  fs.writeFileSync(a, [
    line([{ type: 'tool_use', name: 'Skill', input: { skill: 'ecc:plan' } }], 'assistant', '2026-09-20T10:00:00.000Z'),
    '{"type":"user","message":{"content":"hi"}}',
    'not json at all',
  ].join('\n'));
  fs.writeFileSync(sub, line([{ type: 'tool_use', name: 'mcp__context7__query-docs', input: {} }], 'assistant', '2026-09-25T10:00:00.000Z'));
  try {
    const r = await scanTranscripts({ configDir: root, since: 0 });
    assert.deepEqual(r.used, { 'skill:ecc:plan': Date.parse('2026-09-20T10:00:00.000Z'), 'mcp:context7': Date.parse('2026-09-25T10:00:00.000Z') });
    assert.ok(r.from <= Date.parse('2026-09-20T10:00:00.000Z'));
    assert.equal(Object.keys(r.seen).length, 2);

    // Unchanged files are skipped; one that grew is read again.
    fs.appendFileSync(a, `\n${line([{ type: 'tool_use', name: 'Agent', input: { subagent_type: 'ecc:planner' } }], 'assistant', '2026-10-01T10:00:00.000Z')}`);
    const again = await scanTranscripts({ configDir: root, since: 0, used: r.used, from: r.from, seen: r.seen });
    assert.equal(again.used['agent:ecc:planner'], Date.parse('2026-10-01T10:00:00.000Z'));
    assert.equal(again.used['mcp:context7'], r.used['mcp:context7']);

    // A scan that stops short can't vouch for anything before the files it left out.
    const old = path.join(dir, 'old.jsonl');
    fs.writeFileSync(old, `${line([{ type: 'tool_use', name: 'Skill', input: { skill: 'ecc:only-in-old' } }], 'assistant', '2026-08-01T10:00:00.000Z')}\n${'x'.repeat(5000)}`);
    const oldTime = new Date('2026-09-10T10:00:00.000Z');
    fs.utimesSync(old, oldTime, oldTime);
    const capped = await scanTranscripts({ configDir: root, since: 0, maxBytes: 3000 });
    assert.equal(capped.used['skill:ecc:only-in-old'], undefined, 'the big old file went unread');
    assert.ok(capped.from >= oldTime.getTime(), "so the scan doesn't claim the weeks it held");
    const whole = await scanTranscripts({ configDir: root, since: 0 });
    assert.equal(whole.from, Date.parse('2026-08-01T10:00:00.000Z'), 'read in full, it reaches back to its first use');

    const none = await scanTranscripts({ configDir: path.join(root, 'missing'), since: 0 });
    assert.deepEqual([none.used, none.from], [{}, null]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a plugin that works without being called is never idle: hooks, styles, a status line, bin/", () => {
  const { worksQuietly } = require('../src/main/lean');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-plugin-'));
  const make = (name, files) => {
    const dir = path.join(root, name);
    for (const [f, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.writeFileSync(path.join(dir, f), text);
    }
    return dir;
  };
  try {
    assert.equal(worksQuietly(make('skills-only', { 'skills/a/SKILL.md': '---\nname: a\n---\n', '.claude-plugin/plugin.json': '{"name":"x"}' })), false);
    assert.equal(worksQuietly(make('styled', { 'output-styles/terse.md': '# x' })), true);
    assert.equal(worksQuietly(make('tools', { 'bin/run': '#!/bin/sh' })), true);
    assert.equal(worksQuietly(make('main-agent', { 'settings.json': '{"agent":"x"}' })), true);
    assert.equal(worksQuietly(make('status', { '.claude-plugin/plugin.json': '{"statusLine":{"command":"x"}}' })), true);
    assert.equal(worksQuietly(make('broken', { '.claude-plugin/plugin.json': '{not json' })), true, "can't tell: assume it works");
    assert.equal(worksQuietly(path.join(root, 'no-such-plugin')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
