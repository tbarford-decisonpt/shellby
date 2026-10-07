// A project's next release, worked out from its git history: the commits since
// the last version tag grouped by kind (feat, fix, …), the version they call
// for, and a CHANGELOG entry drafted in the style the project's CHANGELOG.md
// already uses. release-git.js reads the repository and cuts the release;
// everything here is pure (test/projects-releases.test.js).
const VERSION_RE = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:-([0-9A-Za-z.-]{1,40}))?$/;
const TAG_RE = /^(v?)(\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,40})?)$/;
// type(scope)!: description
const CONVENTIONAL = /^([a-z]+)(?:\(([^()\r\n]{1,60})\))?(!)?:\s+(.+)$/i;
// A release commit of its own, the way Shellby writes them: "0.70.2: An expired sign-in says so".
const RELEASE_SUBJECT = /^v?\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.-]+)?(?::|$)/;
const TITLE_MAX = 100;
const NOTES_MAX = 20000;

// The groups a release is shown in, in order. `user`: what people who use the
// project would notice, so it goes in the CHANGELOG draft; the rest is listed
// on the card but left out of the draft.
const GROUPS = Object.freeze([
  { id: 'feat', label: 'New', types: ['feat', 'feature'], user: true },
  { id: 'fix', label: 'Fixed', types: ['fix', 'bugfix', 'hotfix'], user: true },
  { id: 'perf', label: 'Faster', types: ['perf'], user: true },
  { id: 'other', label: 'Changed', types: [], user: true },
  { id: 'chore', label: 'Behind the scenes', types: ['chore', 'refactor', 'test', 'tests', 'docs', 'ci', 'build', 'style', 'revert', 'deps', 'release'], user: false },
]);
const GROUP_OF = new Map(GROUPS.flatMap(g => g.types.map(t => [t, g.id])));

// What each style calls the groups that make it into the draft.
const HEADINGS = Object.freeze({
  titled: { feat: 'New', fix: 'Fixed', perf: 'Faster', other: 'Changed' },
  plain: { feat: 'New', fix: 'Fixed', perf: 'Faster', other: 'Changed' },
  keepachangelog: { feat: 'Added', fix: 'Fixed', perf: 'Changed', other: 'Changed' },
});

const clean = s => String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
const upperFirst = s => (s ? s[0].toUpperCase() + s.slice(1) : s);

// ------------------------------------------------------------------ versions

/** '1.2.3' / '1.2.3-beta.1' -> { major, minor, patch, pre } | null */
function parseVersion(v) {
  const m = VERSION_RE.exec(String(v ?? '').trim());
  return m ? { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] || null } : null;
}

const isVersion = v => !!parseVersion(v);

/** a < b -> negative. A pre-release comes before its release (1.0.0-rc.1 < 1.0.0). */
function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return x ? 1 : y ? -1 : 0;
  for (const k of ['major', 'minor', 'patch']) if (x[k] !== y[k]) return x[k] - y[k];
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre.localeCompare(y.pre, undefined, { numeric: true });
}

/** 'v1.2.3' -> { tag, prefix: 'v', version: '1.2.3' } | null (not a version tag). */
function parseTag(tag) {
  const m = TAG_RE.exec(String(tag ?? '').trim());
  return m ? { tag: m[0], prefix: m[1], version: m[2] } : null;
}

/** The highest version tag in a list of tag names, or null. Pre-releases count. */
function latestTag(tags) {
  return (Array.isArray(tags) ? tags : [])
    .map(parseTag)
    .filter(Boolean)
    .reduce((best, t) => (!best || compareVersions(t.version, best.version) > 0 ? t : best), null);
}

/** The version after `version` for a 'major' | 'minor' | 'patch' bump. A pre-release finishes as itself. */
function bumpVersion(version, bump) {
  const v = parseVersion(version) || { major: 0, minor: 0, patch: 0, pre: null };
  if (v.pre) {
    // 1.0.0-rc.2 + patch -> 1.0.0: the release it was building up to.
    if (bump === 'patch' || (bump === 'minor' && v.patch === 0) || (bump === 'major' && v.minor === 0 && v.patch === 0)) return `${v.major}.${v.minor}.${v.patch}`;
  }
  if (bump === 'major') return `${v.major + 1}.0.0`;
  if (bump === 'minor') return `${v.major}.${v.minor + 1}.0`;
  return `${v.major}.${v.minor}.${v.patch + 1}`;
}

// ------------------------------------------------------------------ commits

/**
 * One commit subject (and body, for a BREAKING CHANGE footer) ->
 * { type, group, scope, breaking, text }. Anything that isn't a conventional
 * commit is 'other', with its subject as the text.
 */
function parseCommit(subject, body = '') {
  const s = clean(subject);
  const breakingFooter = /^BREAKING[ -]CHANGE:/m.test(String(body || ''));
  if (RELEASE_SUBJECT.test(s)) return { type: 'release', group: 'chore', scope: null, breaking: false, text: s };
  const m = CONVENTIONAL.exec(s);
  if (!m) return { type: 'other', group: 'other', scope: null, breaking: breakingFooter, text: s };
  const type = m[1].toLowerCase();
  return {
    type,
    group: GROUP_OF.get(type) || 'other',
    scope: m[2] ? clean(m[2]) : null,
    breaking: !!m[3] || breakingFooter,
    text: clean(m[4]),
  };
}

/**
 * commits: [{ sha, subject, body?, author?, at? }] (newest first, as git log
 * gives them) -> [{ id, label, user, commits: [{ sha, short, text, scope, type, breaking, author, at }] }]
 * in GROUPS order, empty groups left out.
 */
function groupCommits(commits) {
  const byGroup = new Map(GROUPS.map(g => [g.id, []]));
  for (const c of Array.isArray(commits) ? commits : []) {
    if (!c || typeof c.subject !== 'string') continue;
    const p = parseCommit(c.subject, c.body);
    byGroup.get(p.group).push({
      sha: c.sha, short: String(c.sha || '').slice(0, 7), text: p.text, scope: p.scope, type: p.type,
      breaking: p.breaking, author: c.author || null, at: c.at || null,
    });
  }
  return GROUPS.filter(g => byGroup.get(g.id).length).map(g => ({ id: g.id, label: g.label, user: g.user, commits: byGroup.get(g.id) }));
}

/**
 * The bump the commits call for, and why, in words for the card.
 * Before 1.0.0 a breaking change is a minor bump (semver's "anything may change").
 */
function suggestBump(groups, version) {
  const all = (groups || []).flatMap(g => g.commits);
  const breaking = all.filter(c => c.breaking).length;
  const feats = (groups || []).find(g => g.id === 'feat')?.commits.length || 0;
  const pre1 = (parseVersion(version)?.major ?? 0) === 0;
  if (breaking) return { bump: pre1 ? 'minor' : 'major', why: `${breaking} breaking change${breaking === 1 ? '' : 's'}${pre1 ? ' (before 1.0, that\'s a minor)' : ''}` };
  if (feats) return { bump: 'minor', why: `${feats} new feature${feats === 1 ? '' : 's'}` };
  return { bump: 'patch', why: all.length ? 'fixes and upkeep only' : 'nothing new yet' };
}

/**
 * Which version to offer: the next one after the last release, unless
 * package.json was already bumped past it (a release prepared but never
 * tagged), when it's that one. First release: package.json's, else 0.1.0.
 */
function nextVersions({ tagVersion = null, fileVersion = null, bump = 'patch' }) {
  const base = tagVersion || null;
  const choices = base ? {
    patch: bumpVersion(base, 'patch'), minor: bumpVersion(base, 'minor'), major: bumpVersion(base, 'major'),
  } : { patch: null, minor: null, major: null };
  let suggested;
  let prepared = false;
  if (!base) {
    suggested = isVersion(fileVersion) && compareVersions(fileVersion, '0.0.0') > 0 ? fileVersion : '0.1.0';
    prepared = suggested === fileVersion;
  } else if (isVersion(fileVersion) && compareVersions(fileVersion, base) > 0) {
    suggested = fileVersion;
    prepared = true;
  } else {
    suggested = choices[bump] || bumpVersion(base, 'patch');
  }
  return { base, choices, suggested, prepared };
}

// ------------------------------------------------------------------ CHANGELOG

/**
 * The heading style a CHANGELOG already uses, read from its first version heading:
 *   'titled'          ## 0.70.2: An expired sign-in says so
 *   'keepachangelog'  ## [0.70.2] - 2026-10-06
 *   'plain'           ## 0.70.2  (or ## v0.70.2 (2026-10-06))
 * No file, or no version heading yet: keepachangelog, the common one.
 */
function changelogStyle(text) {
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!/^##\s/.test(line)) continue;
    if (/^##\s+\[(?!unreleased\])[^\]]+\]/i.test(line)) return 'keepachangelog';
    if (/^##\s+v?\d+\.\d+\.\d+\S*\s*:\s*\S/.test(line)) return 'titled';
    if (/^##\s+v?\d+\.\d+\.\d+/.test(line)) return 'plain';
  }
  return 'keepachangelog';
}

const escapeRe = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Does the CHANGELOG already have a heading for this version (any style)? */
function hasEntry(text, version) {
  return new RegExp(`^##\\s+\\[?v?${escapeRe(version)}(?![\\d.\\w-])`, 'm').test(String(text || ''));
}

/** The version's heading in a style. date: 'YYYY-MM-DD'. */
function heading({ style, version, title, date }) {
  const t = clean(title).slice(0, TITLE_MAX);
  // Keep a Changelog has no titles: the title only names the commit.
  if (style === 'keepachangelog') return `## [${version}] - ${date}`;
  return `## ${version}${t ? `: ${t}` : ''}`;
}

/** The body of a draft entry: the user-facing groups as ### sections, one bullet per commit. */
function draftBody(groups, style) {
  const names = HEADINGS[style] || HEADINGS.plain;
  const sections = new Map();
  for (const g of groups || []) {
    if (!g.user) continue;
    const name = names[g.id];
    const lines = sections.get(name) || [];
    for (const c of g.commits) {
      const scope = c.scope ? `**${c.scope}:** ` : '';
      lines.push(`- ${c.breaking ? '**Breaking:** ' : ''}${scope}${upperFirst(c.text)}${/[.!?]$/.test(c.text) ? '' : '.'}`);
    }
    sections.set(name, lines);
  }
  return [...sections].map(([name, lines]) => `### ${name}\n${lines.join('\n')}`).join('\n\n');
}

// ------------------------------------------------------------------ change notes
//
// A project can keep what's coming in the next release as one small file per
// branch (changes/<name>.md) rather than in the CHANGELOG itself. Branches that
// each add a note never touch the same lines, where branches that each edit the
// top of the CHANGELOG all clash. A release gathers the notes into its entry
// and deletes them.

// What a note's headings mean, whichever CHANGELOG style it was written in.
const NOTE_HEADINGS = new Map([
  ['new', 'feat'], ['added', 'feat'], ['features', 'feat'],
  ['fixed', 'fix'], ['fixes', 'fix'],
  ['faster', 'perf'], ['performance', 'perf'],
  ['changed', 'other'], ['other', 'other'],
]);
const BUMP_RANK = { patch: 0, minor: 1, major: 2 };

/**
 * notes: [{ name, text }] -> [{ id, name?, lines }]: the sections every note's
 * bullets go in, in GROUPS order, then any heading of a note's own (Removed,
 * Security…) in the order first seen. Lines before a note's first heading are
 * "Changed". Blank lines go, so each section is one list. Pure.
 */
function parseNotes(notes) {
  const known = new Map(GROUPS.filter(g => g.user).map(g => [g.id, []]));
  const own = new Map();
  for (const note of Array.isArray(notes) ? notes : []) {
    let into = known.get('other');
    for (const raw of String(note?.text || '').replace(/\r\n/g, '\n').split('\n')) {
      if (/^#\s/.test(raw)) continue; // a note's own title: the release has its own
      const h = /^#{2,4}\s+(.+?)\s*$/.exec(raw);
      if (h) {
        const key = h[1].toLowerCase();
        const id = NOTE_HEADINGS.get(key);
        if (id) into = known.get(id);
        else { if (!own.has(key)) own.set(key, { name: h[1], lines: [] }); into = own.get(key).lines; }
        continue;
      }
      if (raw.trim()) into.push(raw.trimEnd());
    }
  }
  return [
    ...[...known].filter(([, lines]) => lines.length).map(([id, lines]) => ({ id, lines })),
    ...[...own.values()].filter(s => s.lines.length).map(({ name, lines }) => ({ id: 'own', name, lines })),
  ];
}

/** parseNotes' sections as a CHANGELOG body in a style. Pure. */
function notesBody(sections, style) {
  const names = HEADINGS[style] || HEADINGS.plain;
  const byName = new Map();
  for (const s of sections || []) {
    const name = s.id === 'own' ? s.name : names[s.id];
    byName.set(name, [...(byName.get(name) || []), ...s.lines]);
  }
  return [...byName].map(([name, lines]) => `### ${name}\n${lines.join('\n')}`).join('\n\n');
}

/** The bigger of two bumps: what the commits call for, and "minor" if the notes have something new. Pure. */
function withNotesBump(suggested, sections) {
  const added = (sections || []).find(s => s.id === 'feat')?.lines.filter(l => /^\s*[-*]\s/.test(l)).length || 0;
  if (!added || BUMP_RANK[suggested.bump] >= BUMP_RANK.minor) return suggested;
  return { bump: 'minor', why: `${added} new in the change notes` };
}

/** The whole entry: heading, then the notes as you left them. */
function entryText({ style, version, title, date, notes }) {
  const body = String(notes || '').replace(/\r\n/g, '\n').trim().slice(0, NOTES_MAX);
  return `${heading({ style, version, title, date })}\n${body ? `\n${body}\n` : ''}`;
}

/**
 * The CHANGELOG with `entry` added as the newest release: above the first
 * version heading, under an "## [Unreleased]" section's heading if there is
 * one (which keeps its place for the next round), else after the title.
 * Keeps the file's line endings.
 */
function insertEntry(text, entry) {
  const src = String(text || '');
  const eol = /\r\n/.test(src) ? '\r\n' : '\n';
  const add = entry.replace(/\r?\n/g, '\n').trimEnd().split('\n');
  if (!src.trim()) return ['# Changelog', '', ...add, ''].join(eol);
  const lines = src.split(/\r?\n/);
  const isRelease = l => /^##\s/.test(l) && !/^##\s+\[?unreleased\]?\s*$/i.test(l);
  let at = lines.findIndex(isRelease);
  if (at === -1) {
    // No releases yet: after the title and whatever it says about itself (and an empty Unreleased).
    at = lines.length;
    while (at > 0 && !lines[at - 1].trim()) at--;
  }
  const before = lines.slice(0, at);
  while (before.length && !before[before.length - 1].trim()) before.pop();
  const after = lines.slice(at);
  return [...before, ...(before.length ? [''] : []), ...add, '', ...after].join(eol).replace(/(\r?\n)*$/, eol);
}

// ------------------------------------------------------------------ the files a release changes

/** package.json's text with its "version" set, everything else as it was. null: no top-level version to set. */
function setPackageVersion(text, version) {
  let data;
  try { data = JSON.parse(String(text)); } catch { return null; }
  if (!data || typeof data !== 'object' || typeof data.version !== 'string') return null;
  // The "version" key at the top level: indented exactly as the first key is, so a nested one never matches.
  const indent = /^\{\r?\n([ \t]{1,8})"/.exec(String(text))?.[1];
  if (!indent) return null;
  const re = new RegExp(`^(${indent}"version"\\s*:\\s*")([^"]*)(")`, 'm');
  if (!re.test(text)) return null;
  return String(text).replace(re, `$1${version}$3`);
}

/** package-lock.json's text with its own version (top level and packages[""]) set. */
function setLockVersion(text, version) {
  let data;
  try { data = JSON.parse(String(text)); } catch { return null; }
  if (!data || typeof data !== 'object') return null;
  const eol = /\r\n/.test(text) ? '\r\n' : '\n';
  const indent = /^\{\r?\n(\s+)"/.exec(text)?.[1] || '  ';
  const next = { ...data, version };
  if (data.packages?.['']) next.packages = { ...data.packages, '': { ...data.packages[''], version } };
  return JSON.stringify(next, null, indent).replace(/\n/g, eol) + eol;
}

/** "YYYY-MM-DD" in local time. */
function dayOf(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** The release commit's message: Shellby's "0.71.0: Title", or a conventional one without a title. */
function commitMessage({ version, tag, title }) {
  const t = clean(title).slice(0, TITLE_MAX);
  return t ? `${version}: ${t}` : `chore: release ${tag}`;
}

/** A title from the panel: one line, short. */
const cleanTitle = t => clean(t).slice(0, TITLE_MAX);

const MAX_PROMPT_COMMITS = 120;

/**
 * "Write it with Claude": the ask that goes in a new conversation's box, for
 * you to read and send. Claude writes the entry; the card cuts the release.
 */
function polishPrompt({ project, version, since, groups, changelog, style, notes = '' }) {
  const all = (groups || []).flatMap(g => g.commits.map(c => ({ ...c, group: g.label })));
  const listed = all.slice(0, MAX_PROMPT_COMMITS)
    .map(c => `- ${c.short} [${c.group}]${c.breaking ? ' BREAKING' : ''} ${c.scope ? `${c.scope}: ` : ''}${c.text}`);
  const more = all.length - listed.length;
  const how = style === 'keepachangelog' ? `"## [${version}] - YYYY-MM-DD" with today's date`
    : style === 'titled' ? `"## ${version}: <a short title>"` : `"## ${version}"`;
  return [
    `Write the ${changelog} entry for ${project} ${version}${since ? ` (everything since ${since})` : ''}.`,
    '',
    `Read the last few entries in ${changelog} first and match their voice, layout and level of detail. Write for the people who use ${project}, not for its developers: what they'll notice, in plain words, grouped the way earlier entries group things. Leave out work they'd never see (tests, CI, refactors, chores) unless it changes something for them. Read a commit's diff when its subject doesn't say enough.`,
    '',
    `Put the entry at the top of ${changelog}, above the previous release, under ${how}. Only edit ${changelog}: don't change the version, commit, tag or push. Shellby's Releases card does that once I've read it.`,
    '',
    'The commits:',
    ...listed,
    ...(more > 0 ? [`- …and ${more} more (git log ${since ? `${since}..HEAD` : 'HEAD'})`] : []),
    ...(String(notes).trim() ? ['', 'The change notes written alongside the work (start from these; the card deletes them when it cuts the release):', String(notes).trim()] : []),
  ].join('\n');
}

module.exports = {
  GROUPS, TITLE_MAX, NOTES_MAX,
  parseVersion, isVersion, compareVersions, parseTag, latestTag, bumpVersion,
  parseCommit, groupCommits, suggestBump, nextVersions,
  changelogStyle, hasEntry, heading, draftBody, entryText, insertEntry, parseNotes, notesBody, withNotesBump,
  setPackageVersion, setLockVersion, dayOf, commitMessage, cleanTitle, polishPrompt,
};
