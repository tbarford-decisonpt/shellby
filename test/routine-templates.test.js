const { test } = require('node:test');
const assert = require('node:assert/strict');
const { TEMPLATES, checkupPrompt } = require('../src/main/routines/templates');
const { validateRoutine } = require('../src/main/routines');
const { checkupOf } = require('../src/main/checkup');

test('every template is a routine the editor can save as it is', () => {
  for (const t of TEMPLATES) {
    const { routine, errors } = validateRoutine({ name: t.name, prompt: t.prompt, schedule: t.schedule, mode: t.mode });
    assert.deepEqual(errors, [], t.name);
    assert.ok(routine, t.name);
  }
});

test('the dependency checkup asks for results Shellby can read', () => {
  const t = TEMPLATES.find(x => x.name === 'Dependency checkup');
  assert.ok(t, 'the template is offered');
  assert.notEqual(t.mode, 'autonomous');
  for (const p of [checkupPrompt(), checkupPrompt({ single: true })]) {
    assert.match(p, /Don't pipe the output/);
    assert.match(p, /Don't install, upgrade or change anything/);
    // Every command it names is one checkup.js recognises.
    const named = [...p.matchAll(/`([^`]+)`/g)].map(m => m[1]).filter(c => !c.includes('<project>'));
    for (const c of named) assert.ok(checkupOf(c), `checkup.js doesn't recognise \`${c}\``);
  }
  assert.match(checkupPrompt(), /cd <project> && npm audit/);
  assert.doesNotMatch(checkupPrompt({ single: true }), /<project>/);
});
