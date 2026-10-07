// A project's next release (src/main/projects/releases.js): commits grouped by
// kind, the version they call for, and a CHANGELOG entry in the file's own style.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const R = require('../src/main/projects/releases');

const commit = (subject, extra = {}) => ({ sha: 'a'.repeat(40), subject, ...extra });

test('a conventional commit gives its type, scope and text; anything else is "other"', () => {
  assert.deepEqual(R.parseCommit('feat(projects): a Releases card'), { type: 'feat', group: 'feat', scope: 'projects', breaking: false, text: 'a Releases card' });
  assert.equal(R.parseCommit('fix: an expired sign-in says so').group, 'fix');
  assert.equal(R.parseCommit('Perf: faster boot').group, 'perf');
  assert.equal(R.parseCommit('chore: scoop manifest for 0.70.1').group, 'chore');
  assert.equal(R.parseCommit('test: e2e waits for the flake').group, 'chore');
  assert.deepEqual(R.parseCommit('Tidy the README'), { type: 'other', group: 'other', scope: null, breaking: false, text: 'Tidy the README' });
  // An unknown type is still a change people might notice.
  assert.equal(R.parseCommit('wip: half a thing').group, 'other');
});

test('a breaking change is read from ! and from a BREAKING CHANGE footer', () => {
  assert.equal(R.parseCommit('feat!: drop Node 20').breaking, true);
  assert.equal(R.parseCommit('refactor(api)!: rename list').breaking, true);
  assert.equal(R.parseCommit('feat: new config', 'Some words\n\nBREAKING CHANGE: old keys go').breaking, true);
  assert.equal(R.parseCommit('feat: new config', 'mentions breaking change in passing').breaking, false);
});

test('release commits of their own ("0.70.2: Title") are behind the scenes', () => {
  assert.equal(R.parseCommit('0.70.2: An expired sign-in says so').group, 'chore');
  assert.equal(R.parseCommit('v1.0.0').group, 'chore');
});

test('commits are grouped in a fixed order, empty groups left out', () => {
  const groups = R.groupCommits([
    commit('chore: bump'), commit('fix: two'), commit('feat: one'), commit('Something else'), commit('fix: three'),
  ]);
  assert.deepEqual(groups.map(g => g.id), ['feat', 'fix', 'other', 'chore']);
  assert.deepEqual(groups.find(g => g.id === 'fix').commits.map(c => c.text), ['two', 'three']);
  assert.equal(groups.find(g => g.id === 'chore').user, false);
  assert.equal(groups[0].commits[0].short, 'aaaaaaa');
});

test('versions compare as semver, a pre-release before its release', () => {
  assert.ok(R.compareVersions('0.10.0', '0.9.9') > 0);
  assert.ok(R.compareVersions('1.0.0-rc.1', '1.0.0') < 0);
  assert.ok(R.compareVersions('1.0.0-rc.10', '1.0.0-rc.2') > 0);
  assert.equal(R.compareVersions('1.2.3', '1.2.3'), 0);
});

test('the latest tag is the highest version, whatever order git lists them in', () => {
  assert.deepEqual(R.latestTag(['v0.9.0', 'v0.10.0', 'nightly', 'v0.10.0-rc.1', '']), { tag: 'v0.10.0', prefix: 'v', version: '0.10.0' });
  assert.equal(R.latestTag(['1.2.0', '1.10.0']).prefix, '');
  assert.equal(R.latestTag(['release-1', 'latest']), null);
});

test('bumps: patch, minor, major, and a pre-release finishes as itself', () => {
  assert.equal(R.bumpVersion('0.70.2', 'patch'), '0.70.3');
  assert.equal(R.bumpVersion('0.70.2', 'minor'), '0.71.0');
  assert.equal(R.bumpVersion('0.70.2', 'major'), '1.0.0');
  assert.equal(R.bumpVersion('1.0.0-rc.2', 'patch'), '1.0.0');
  assert.equal(R.bumpVersion('1.0.0-rc.2', 'major'), '1.0.0');
  assert.equal(R.bumpVersion('1.1.0-beta', 'major'), '2.0.0');
});

test('the suggested bump: breaking is major (minor before 1.0), a feature minor, else patch', () => {
  const g = (...subjects) => R.groupCommits(subjects.map(s => commit(s)));
  assert.equal(R.suggestBump(g('fix: a', 'chore: b'), '1.2.3').bump, 'patch');
  assert.equal(R.suggestBump(g('fix: a', 'feat: b'), '1.2.3').bump, 'minor');
  assert.equal(R.suggestBump(g('feat!: b'), '1.2.3').bump, 'major');
  const early = R.suggestBump(g('feat!: b'), '0.70.2');
  assert.equal(early.bump, 'minor');
  assert.match(early.why, /before 1\.0/);
  assert.match(R.suggestBump(g('feat: a', 'feat: b'), '1.0.0').why, /2 new features/);
});

test('next versions: after the tag, or package.json when it was already bumped, or a first release', () => {
  assert.deepEqual(R.nextVersions({ tagVersion: '0.70.2', fileVersion: '0.70.2', bump: 'minor' }),
    { base: '0.70.2', choices: { patch: '0.70.3', minor: '0.71.0', major: '1.0.0' }, suggested: '0.71.0', prepared: false });
  const prepared = R.nextVersions({ tagVersion: '0.70.2', fileVersion: '0.71.0', bump: 'patch' });
  assert.equal(prepared.suggested, '0.71.0');
  assert.equal(prepared.prepared, true);
  assert.equal(R.nextVersions({ tagVersion: null, fileVersion: '1.4.0' }).suggested, '1.4.0');
  assert.equal(R.nextVersions({ tagVersion: null, fileVersion: '0.0.0' }).suggested, '0.1.0');
  assert.equal(R.nextVersions({ tagVersion: null, fileVersion: null }).suggested, '0.1.0');
});

test('the CHANGELOG style is read from its first version heading', () => {
  assert.equal(R.changelogStyle('# Changelog\n\n## 0.70.2: An expired sign-in says so\n'), 'titled');
  assert.equal(R.changelogStyle('# Changelog\n\n## [Unreleased]\n\n## [1.2.0] - 2026-01-02\n'), 'keepachangelog');
  assert.equal(R.changelogStyle('## v1.2.0 (2026-01-02)\n'), 'plain');
  assert.equal(R.changelogStyle(''), 'keepachangelog');
});

test('an existing entry is found in any style, and never mistaken for a longer version', () => {
  assert.ok(R.hasEntry('## 0.71.0: Title\n', '0.71.0'));
  assert.ok(R.hasEntry('## [0.71.0] - 2026-10-06\n', '0.71.0'));
  assert.ok(R.hasEntry('## v0.71.0\n', '0.71.0'));
  assert.ok(!R.hasEntry('## 0.71.0-rc.1\n', '0.71.0'));
  assert.ok(!R.hasEntry('## 0.71.01\n', '0.71.0'));
});

test('the draft lists what people would notice, in the style\'s words', () => {
  const groups = R.groupCommits([commit('feat(projects): a releases card'), commit('fix: crash on boot.'), commit('chore: tidy'), commit('feat!: drop Node 20')]);
  const titled = R.draftBody(groups, 'titled');
  assert.equal(titled, '### New\n- **projects:** A releases card.\n- **Breaking:** Drop Node 20.\n\n### Fixed\n- Crash on boot.');
  assert.doesNotMatch(titled, /tidy/);
  assert.match(R.draftBody(groups, 'keepachangelog'), /^### Added\n/);
});

test('change notes join into one section per heading, in the release\'s order, whatever words they used', () => {
  const sections = R.parseNotes([
    { name: 'a.md', text: '- Loose bullet.\n### Fixed\n- One.\r\n\n### Security\n- Tokens stay put.\n' },
    { name: 'b.md', text: '## Added\n- **New thing.**\n  with a second line\n### Fixes\n- Two.\n' },
  ]);
  assert.deepEqual(sections.map(s => s.id), ['feat', 'fix', 'other', 'own']);
  assert.equal(R.notesBody(sections, 'titled'),
    '### New\n- **New thing.**\n  with a second line\n\n### Fixed\n- One.\n- Two.\n\n### Changed\n- Loose bullet.\n\n### Security\n- Tokens stay put.');
  assert.match(R.notesBody(sections, 'keepachangelog'), /^### Added\n/);
  assert.deepEqual(R.parseNotes([{ name: 'x.md', text: '\n\n' }]), []);
});

test('a note\'s own headings match whatever their case, and its # title is left out', () => {
  const sections = R.parseNotes([
    { text: '# Toast fixes\n### Removed\n- The old toast.' },
    { text: '### removed\n- The older toast.' },
  ]);
  assert.deepEqual(sections, [{ id: 'own', name: 'Removed', lines: ['- The old toast.', '- The older toast.'] }]);
});

test('a note with something new makes a patch a minor, and never lowers a bigger bump', () => {
  const added = R.parseNotes([{ text: '### New\n- A.\n- B.' }]);
  assert.deepEqual(R.withNotesBump({ bump: 'patch', why: 'fixes and upkeep only' }, added), { bump: 'minor', why: '2 new in the change notes' });
  const major = { bump: 'major', why: '1 breaking change' };
  assert.equal(R.withNotesBump(major, added), major);
  const fixes = { bump: 'patch', why: 'x' };
  assert.equal(R.withNotesBump(fixes, R.parseNotes([{ text: '### Fixed\n- A.' }])), fixes);
});

test('headings: titled with a title, Keep a Changelog with the date', () => {
  assert.equal(R.heading({ style: 'titled', version: '0.71.0', title: 'Releases', date: '2026-10-06' }), '## 0.71.0: Releases');
  assert.equal(R.heading({ style: 'titled', version: '0.71.0', title: '  ', date: '2026-10-06' }), '## 0.71.0');
  assert.equal(R.heading({ style: 'keepachangelog', version: '1.0.0', title: 'ignored', date: '2026-10-06' }), '## [1.0.0] - 2026-10-06');
});

test('the entry goes above the last release, keeping the title and an Unreleased section', () => {
  const entry = R.entryText({ style: 'titled', version: '0.71.0', title: 'Releases', date: 'x', notes: '### New\n- A card.' });
  const before = '# Changelog\n\n## 0.70.2: Old\n\n### Fixed\n- A thing.\n';
  assert.equal(R.insertEntry(before, entry), '# Changelog\n\n## 0.71.0: Releases\n\n### New\n- A card.\n\n## 0.70.2: Old\n\n### Fixed\n- A thing.\n');
  const kac = '# Changelog\n\n## [Unreleased]\n\n## [1.0.0] - 2026-01-01\n- First.\n';
  const out = R.insertEntry(kac, '## [1.1.0] - 2026-10-06\n\n### Added\n- B.\n');
  assert.ok(out.indexOf('## [Unreleased]') < out.indexOf('## [1.1.0]'));
  assert.ok(out.indexOf('## [1.1.0]') < out.indexOf('## [1.0.0]'));
});

test('a new or release-less CHANGELOG gets the entry after its title, and CRLF files stay CRLF', () => {
  assert.equal(R.insertEntry('', '## [0.1.0] - d\n'), '# Changelog\n\n## [0.1.0] - d\n');
  assert.equal(R.insertEntry('# Changelog\n\nAll notable changes.\n\n', '## [0.1.0] - d\n'), '# Changelog\n\nAll notable changes.\n\n## [0.1.0] - d\n');
  const crlf = R.insertEntry('# Changelog\r\n\r\n## 1.0.0\r\n- a\r\n', '## 1.1.0\n\n- b\n');
  assert.equal(crlf, '# Changelog\r\n\r\n## 1.1.0\r\n\r\n- b\r\n\r\n## 1.0.0\r\n- a\r\n');
});

test('package.json keeps its formatting; only the version changes', () => {
  const text = '{\n  "name": "x",\n  "version": "0.70.2",\n  "dependencies": {\n    "y": "^1.0.0"\n  }\n}\n';
  assert.equal(R.setPackageVersion(text, '0.71.0'), text.replace('0.70.2', '0.71.0'));
  // A nested "version" (in a dependency's settings) is never the one changed.
  const nested = '{\n  "name": "x",\n  "engines": {\n    "version": "1"\n  },\n  "version": "1.0.0"\n}\n';
  assert.match(R.setPackageVersion(nested, '2.0.0'), /"version": "1"\n[\s\S]*"version": "2.0.0"/);
  assert.equal(R.setPackageVersion('{"name":"x"}', '1.0.0'), null);
  assert.equal(R.setPackageVersion('not json', '1.0.0'), null);
});

test('package-lock.json: its own version, top level and packages[""], nothing else', () => {
  const lock = { name: 'x', version: '0.70.2', lockfileVersion: 3, packages: { '': { name: 'x', version: '0.70.2' }, 'node_modules/y': { version: '0.70.2' } } };
  const out = JSON.parse(R.setLockVersion(JSON.stringify(lock, null, 2) + '\n', '0.71.0'));
  assert.equal(out.version, '0.71.0');
  assert.equal(out.packages[''].version, '0.71.0');
  assert.equal(out.packages['node_modules/y'].version, '0.70.2');
});

test('the commit message is Shellby\'s "0.71.0: Title", or a conventional one without a title', () => {
  assert.equal(R.commitMessage({ version: '0.71.0', tag: 'v0.71.0', title: 'Releases' }), '0.71.0: Releases');
  assert.equal(R.commitMessage({ version: '0.71.0', tag: 'v0.71.0', title: '' }), 'chore: release v0.71.0');
  assert.equal(R.commitMessage({ version: '1.0.0', tag: 'v1.0.0', title: 'line\none' }), '1.0.0: line one');
});

test('the Write-it-with-Claude ask names the file, the heading and every commit, and says not to release', () => {
  const groups = R.groupCommits([commit('feat: a card'), commit('fix!: the thing')]);
  const p = R.polishPrompt({ project: 'shellby', version: '0.71.0', since: 'v0.70.2', groups, changelog: 'CHANGELOG.md', style: 'titled' });
  assert.match(p, /CHANGELOG\.md entry for shellby 0\.71\.0 \(everything since v0\.70\.2\)/);
  assert.match(p, /"## 0\.71\.0: <a short title>"/);
  assert.match(p, /don't change the version, commit, tag or push/);
  assert.match(p, /aaaaaaa \[New\] a card/);
  assert.match(p, /\[Fixed\] BREAKING the thing/);
});
