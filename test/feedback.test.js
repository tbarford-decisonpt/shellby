// Ideas from inside Shellby (feedback.js): the idea form opens with the version
// filled in, and he asks for one once, when the bond reaches Buddies.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { ISSUES_URL, ASK_FOR_IDEA_AT, ideaUrl, shouldAskForIdea } = require('../src/main/feedback');

test('the idea url opens the idea form with the version filled in', () => {
  const url = new URL(ideaUrl({ version: '1.2.3' }));
  assert.equal(`${url.origin}${url.pathname}`, ISSUES_URL);
  assert.equal(url.searchParams.get('template'), 'idea.yml');
  assert.equal(url.searchParams.get('labels'), 'idea');
  assert.equal(url.searchParams.get('version'), '1.2.3');
});

test('a dev build says so in the version', () => {
  assert.equal(new URL(ideaUrl({ version: '1.2.3', packaged: false })).searchParams.get('version'), '1.2.3 (dev build)');
});

test('the idea form has the fields the url fills in', () => {
  const form = fs.readFileSync(path.join(__dirname, '..', '.github', 'ISSUE_TEMPLATE', 'idea.yml'), 'utf8');
  assert.match(form, /id: version/);
});

test('he asks for an idea at Buddies and above, only if he never has', () => {
  assert.equal(shouldAskForIdea({ asked: false, level: ASK_FOR_IDEA_AT - 1 }), false);
  assert.equal(shouldAskForIdea({ asked: false, level: ASK_FOR_IDEA_AT }), true);
  assert.equal(shouldAskForIdea({ asked: false, level: ASK_FOR_IDEA_AT + 2 }), true);
  assert.equal(shouldAskForIdea({ asked: true, level: ASK_FOR_IDEA_AT }), false);
  assert.equal(shouldAskForIdea({ asked: false, level: undefined }), false);
});
