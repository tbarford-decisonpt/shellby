// What a project can run (src/main/devservers/scripts.js). package.json is
// written by whoever wrote the repository, so the script name is the only
// thing that may reach a command line, and only a plain one.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scriptsOf, managerOf, frameworkOf, commandFor, read } = require('../src/main/devservers/scripts');

const pkg = scripts => JSON.stringify({ name: 'x', scripts });

test('the lockfile says which package manager', () => {
  assert.equal(managerOf(['package-lock.json']), 'npm');
  assert.equal(managerOf(new Set(['pnpm-lock.yaml', 'package-lock.json'])), 'pnpm');
  assert.equal(managerOf(['yarn.lock']), 'yarn');
  assert.equal(managerOf(['bun.lockb']), 'bun');
  assert.equal(managerOf(['bun.lock']), 'bun');
  assert.equal(managerOf([]), 'npm');
});

test('frameworks are guessed from the script body', () => {
  assert.equal(frameworkOf('vite'), 'vite');
  assert.equal(frameworkOf('vite --port 3000'), 'vite');
  assert.equal(frameworkOf('next dev --turbo'), 'next');
  assert.equal(frameworkOf('astro dev'), 'astro');
  assert.equal(frameworkOf('nuxt dev'), 'nuxt');
  assert.equal(frameworkOf('svelte-kit dev'), 'sveltekit');
  assert.equal(frameworkOf('webpack serve --mode development'), 'webpack');
  assert.equal(frameworkOf('nodemon src/index.js'), 'nodemon');
  assert.equal(frameworkOf('tsx watch src/server.ts'), 'tsx');
  assert.equal(frameworkOf('node server.js'), 'node');
  assert.equal(frameworkOf('eslint .'), null);
});

test('dev servers come first, build and test are not servers', () => {
  const r = scriptsOf(pkg({ build: 'vite build', test: 'vitest', dev: 'vite', preview: 'vite preview', lint: 'eslint .', start: 'node server.js' }), ['package-lock.json']);
  assert.equal(r.manager, 'npm');
  assert.deepEqual(r.scripts.filter(s => s.likely).map(s => s.name), ['dev', 'start', 'preview']);
  assert.equal(r.scripts.find(s => s.name === 'build').likely, false);
  assert.equal(r.scripts.find(s => s.name === 'test').likely, false);
  assert.equal(r.scripts.find(s => s.name === 'dev').framework, 'vite');
});

test('a script with a strange name is never offered', () => {
  const r = scriptsOf(pkg({ dev: 'vite', 'dev && calc': 'x', 'a|b': 'x', '"quoted"': 'x', '%PATH%': 'x', '!x!': 'x', 'dev:api': 'nodemon' }));
  assert.deepEqual(r.scripts.map(s => s.name).sort(), ['dev', 'dev:api']);
});

test('pre and post hooks are not run on their own', () => {
  const r = scriptsOf(pkg({ dev: 'vite', predev: 'echo hi', postinstall: 'x' }));
  assert.deepEqual(r.scripts.map(s => s.name).sort(), ['dev', 'postinstall']);
});

test('preview is a server even when there is a "view" script', () => {
  const r = scriptsOf(pkg({ view: 'open dist', preview: 'vite preview' }));
  assert.ok(r.scripts.some(s => s.name === 'preview' && s.likely));
});

test('no scripts, or not JSON, is nothing to run', () => {
  assert.equal(scriptsOf('not json'), null);
  assert.equal(scriptsOf(JSON.stringify({ name: 'x' })), null);
  assert.equal(scriptsOf(JSON.stringify({ scripts: [] })), null);
  assert.equal(scriptsOf(pkg({ dev: 42 })), null);
});

test('the command line: one of four managers and a plain script name', () => {
  assert.equal(commandFor('npm', 'dev'), 'npm run dev');
  assert.equal(commandFor('pnpm', 'dev:web'), 'pnpm run dev:web');
  assert.equal(commandFor('yarn', null, { install: true }), 'yarn install');
  assert.equal(commandFor('npx', 'dev'), null);
  assert.equal(commandFor('npm', 'dev & calc'), null);
  assert.equal(commandFor('npm', ''), null);
});

test('read() looks at the folder: scripts, manager and whether it is installed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-scripts-'));
  try {
    assert.equal(read(dir), null);
    fs.writeFileSync(path.join(dir, 'package.json'), pkg({ dev: 'vite' }));
    fs.writeFileSync(path.join(dir, 'yarn.lock'), '');
    assert.deepEqual(read(dir), { manager: 'yarn', scripts: [{ name: 'dev', framework: 'vite', likely: true }], installed: false });
    fs.mkdirSync(path.join(dir, 'node_modules'));
    assert.equal(read(dir).installed, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
