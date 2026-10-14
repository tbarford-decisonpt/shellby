// Ideas and problem reports both end up as GitHub issue drafts: nothing is sent
// until the user reads the draft and presses submit. wiring/tray.js builds the
// problem report (it needs the log); this file has the parts with no Electron in
// them, so tests can check them as they are.

const ISSUES_URL = 'https://github.com/x-salmon/shellby/issues/new';

// He asks for an idea once, when the bond first reaches this level (bond.js
// LEVELS: 2 is Buddies). By then the user knows him well enough to have one.
const ASK_FOR_IDEA_AT = 2;

/** The idea form (.github/ISSUE_TEMPLATE/idea.yml) with the version filled in. */
function ideaUrl({ version, packaged = true } = {}) {
  const params = new URLSearchParams({ template: 'idea.yml', labels: 'idea' });
  if (version) params.set('version', `${version}${packaged ? '' : ' (dev build)'}`);
  return `${ISSUES_URL}?${params}`;
}

/** Whether a bond level-up should bring the one-time "Got an idea?" ask. */
function shouldAskForIdea({ asked, level }) {
  return !asked && Number.isInteger(level) && level >= ASK_FOR_IDEA_AT;
}

module.exports = { ISSUES_URL, ASK_FOR_IDEA_AT, ideaUrl, shouldAskForIdea };
