const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { removalTarget, createSkillRemover } = require('../src/main/skillremove');

const dirs = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-remove-')); dirs.push(d); return d; };
process.on('exit', () => { for (const d of dirs) try { fs.rmSync(d, { recursive: true, force: true }); } catch {} });
function put(file, text = '---\ndescription: x\n---\nbody') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

test("removalTarget: a skill's folder, an agent's or command's file", () => {
  const home = tmp();
  const cwd = tmp();
  const skill = put(path.join(home, '.claude', 'skills', 'mine', 'SKILL.md'));
  const agent = put(path.join(home, '.claude', 'agents', 'team', 'helper.md'));
  const cmd = put(path.join(cwd, '.claude', 'commands', 'deploy.md'));
  assert.deepEqual(removalTarget({ kind: 'skill', name: 'mine', source: 'user', path: skill }, { home, cwd }), { ok: true, target: path.dirname(skill), isDir: true });
  assert.deepEqual(removalTarget({ kind: 'agent', name: 'helper', source: 'user', path: agent }, { home, cwd }), { ok: true, target: agent, isDir: false });
  assert.deepEqual(removalTarget({ kind: 'command', name: 'deploy', source: 'project', path: cmd }, { home, cwd }), { ok: true, target: cmd, isDir: false });
});

test("removalTarget: leaves alone a plugin's, a built-in one, and anything out of place", () => {
  const home = tmp();
  const cwd = tmp();
  const plugin = removalTarget({ kind: 'skill', name: 'ecc:plan', source: 'plugin:ecc', path: path.join(home, 'x', 'SKILL.md') }, { home, cwd });
  assert.equal(plugin.ok, false);
  assert.equal(plugin.plugin, 'ecc');
  assert.match(plugin.error, /Lean tab/);
  assert.equal(removalTarget({ kind: 'skill', name: 'review', source: 'cli', path: null }, { home, cwd }).ok, false);
  assert.equal(removalTarget({ kind: 'mcp', name: 'x', source: 'user' }, { home, cwd }).ok, false);

  // Says it's yours, but isn't where yours are kept (the project's .claude, not the user's).
  const stray = put(path.join(cwd, '.claude', 'skills', 'p', 'SKILL.md'));
  assert.equal(removalTarget({ kind: 'skill', name: 'p', source: 'user', path: stray }, { home, cwd }).ok, false);
  // Nested deeper than a skill folder: removing its parent would take more than the skill.
  const deep = put(path.join(home, '.claude', 'skills', 'a', 'b', 'SKILL.md'));
  assert.equal(removalTarget({ kind: 'skill', name: 'b', source: 'user', path: deep }, { home, cwd }).ok, false);
  // The agents folder itself is never a target.
  assert.equal(removalTarget({ kind: 'agent', name: 'x', source: 'user', path: path.join(home, '.claude', 'agents') }, { home, cwd }).ok, false);
  assert.match(removalTarget({ kind: 'agent', name: 'gone', source: 'user', path: path.join(home, '.claude', 'agents', 'gone.md') }, { home, cwd }).error, /already gone/);
});

test('removalTarget: a linked skill folder is left for you', () => {
  const home = tmp();
  const elsewhere = tmp();
  put(path.join(elsewhere, 'SKILL.md'));
  fs.mkdirSync(path.join(home, '.claude', 'skills'), { recursive: true });
  const link = path.join(home, '.claude', 'skills', 'linked');
  fs.symlinkSync(elsewhere, link, 'junction');
  const r = removalTarget({ kind: 'skill', name: 'linked', source: 'user', path: path.join(link, 'SKILL.md') }, { home });
  assert.equal(r.ok, false);
  assert.match(r.error, /link/);
  assert.ok(fs.existsSync(path.join(elsewhere, 'SKILL.md')));
});

test('removalTarget: a plain file under a linked folder inside .claude is left too', () => {
  const home = tmp();
  const team = tmp();
  const shared = put(path.join(team, 'x.md'));
  fs.mkdirSync(path.join(home, '.claude', 'agents'), { recursive: true });
  fs.symlinkSync(team, path.join(home, '.claude', 'agents', 'shared'), 'junction');
  const r = removalTarget({ kind: 'agent', name: 'x', source: 'user', path: path.join(home, '.claude', 'agents', 'shared', 'x.md') }, { home });
  assert.equal(r.ok, false);
  assert.match(r.error, /linked folder/);

  // A whole linked skills folder: the skill inside looks like a plain folder.
  const skills = tmp();
  put(path.join(skills, 'theirs', 'SKILL.md'));
  fs.symlinkSync(skills, path.join(home, '.claude', 'skills'), 'junction');
  assert.equal(removalTarget({ kind: 'skill', name: 'theirs', source: 'user', path: path.join(home, '.claude', 'skills', 'theirs', 'SKILL.md') }, { home }).ok, false);
  assert.ok(fs.existsSync(shared));
});

function remover({ answer = 0, trash } = {}) {
  const home = tmp();
  const file = put(path.join(home, '.claude', 'skills', 'mine', 'SKILL.md'));
  const calls = { asked: [], trashed: [], unpinned: [], rescans: 0 };
  const current = { skills: [{ kind: 'skill', name: 'mine', source: 'user', path: file, listChars: 400, bodyChars: 4000 }], agents: [], commands: [] };
  const r = createSkillRemover({
    toolbox: () => ({ current, rescan: () => { calls.rescans++; } }),
    where: () => ({ home, cwd: null }),
    askOnce: async spec => { calls.asked.push(spec); return answer; },
    trash: trash || (async p => { calls.trashed.push(p); }),
    usage: async () => ({ tools: { 'skill:mine': { uses: 0, lastUsed: null } } }),
    unpin: (kind, name) => calls.unpinned.push(`${kind}:${name}`),
    log: { warn() {} },
  });
  return { r, calls, dir: path.dirname(file) };
}

test('remove: asks first, then the folder goes to the Recycle Bin and the pin with it', async () => {
  const { r, calls, dir } = remover();
  const res = await r.remove('skill', 'mine');
  assert.equal(res.ok, true);
  assert.deepEqual(calls.trashed, [dir]);
  assert.deepEqual(calls.unpinned, ['skill:mine']);
  assert.equal(calls.rescans, 1);
  assert.match(calls.asked[0].detail, /about 100 tokens in every conversation/);
  assert.match(calls.asked[0].detail, /about 1,000 more each time/);
  assert.match(calls.asked[0].detail, /hasn't seen it used/);
});

test('remove: cancelled, unknown, or Windows saying no: nothing changes', async () => {
  const cancelled = remover({ answer: 1 });
  assert.deepEqual(await cancelled.r.remove('skill', 'mine'), { ok: false, cancelled: true });
  assert.deepEqual(cancelled.calls.trashed, []);

  const busy = remover({ answer: null });
  assert.equal((await busy.r.remove('skill', 'mine')).busy, true, 'another question is already open');

  const unknown = remover();
  assert.equal((await unknown.r.remove('skill', 'not-there')).ok, false);
  assert.equal(unknown.calls.asked.length, 0);

  const refused = remover({ trash: async () => { throw new Error('in use'); } });
  const res = await refused.r.remove('skill', 'mine');
  assert.equal(res.ok, false);
  assert.match(res.error, /Recycle Bin/);
  assert.deepEqual(refused.calls.unpinned, []);
});
