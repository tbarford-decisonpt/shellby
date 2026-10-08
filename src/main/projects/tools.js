// The project page's helpers, as prompts: "When did this break?" (git bisect
// in a copy), "Check the docs" (stale docs fixed in a copy, or a weekly report
// that changes nothing) and "Show me around" (a tour, read only). Pure; the
// IPC (ipc/project-tools.js) checks what the panel sent and opens the
// conversation, with the prompt waiting in its box until you send it.

const MAX_WHAT = 2000;
const MAX_TEST = 300;
const MAX_TAGS = 12;

// One line, nothing that closes a fence or opens a tag: these are words
// you typed, but they're quoted into a prompt with its own structure.
const oneLine = (s, n) => String(s || '').replace(/[\r\n]+/g, ' ').replace(/`/g, "'").replace(/<(?=[/!?a-z])/gi, '‹').trim().slice(0, n);
const block = (s, n) => String(s || '').replace(/\r\n?/g, '\n').replace(/```/g, "'''").trim().slice(0, n);
const plain = s => String(s || '').replace(/[`\r\n]+|<(?=[/!?a-z])/gi, ' ').trim().slice(0, 200);

// A ref someone can type for "the last time it worked": a tag, a branch, a
// hash, HEAD~20. Never an option (no leading -), never a range.
const REF_RE = /^(?!.*\.\.)(?!-)[A-Za-z0-9][A-Za-z0-9._/~^+-]{0,99}$/;
const isRef = s => typeof s === 'string' && REF_RE.test(s);

/** `git tag` with dates, newest first -> [{ name, date }]. Lines: "name\x1fISO date". */
function parseTags(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const [name, date] = line.split('\x1f');
    if (!isRef(name?.trim())) continue;
    out.push({ name: name.trim(), date: /^\d{4}-\d{2}-\d{2}/.test(date || '') ? date.slice(0, 10) : null });
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

function where({ branch, base }) {
  return `You are in a fresh copy of the repository on its own branch, ${plain(branch)}, started from ${plain(base)}, so checking out old commits here can't disturb my own checkout. Install the project's dependencies first if they aren't there.`;
}

/**
 * "When did this break?": find the commit that broke something with git bisect.
 * what: what's broken, in your words. test: a command that fails now (optional).
 * good: the last ref you know worked, or null for Claude to find one.
 */
function bisectPrompt({ what, test = '', good = null, project = '' }, copy) {
  const cmd = oneLine(test, MAX_TEST);
  const isGood = isRef(good) ? good : null;
  return [
    `Something in ${plain(project) || 'this project'} that used to work is broken. Find the commit that broke it, using git bisect.`,
    '',
    'What I see:',
    '```',
    block(what, MAX_WHAT),
    '```',
    ...(cmd ? [`A command that shows it: \`${cmd}\` (it fails now).`] : []),
    `The last version I know worked: ${isGood ? `\`${isGood}\`` : "I don't know. Find one."}`,
    '',
    where(copy),
    '',
    `1. Reproduce it at HEAD. ${cmd ? 'Run that command and check it fails for the reason described.' : 'Write the smallest check that fails because of this (a test, or a short script).'} Keep any script you write outside the repository (in the system temp folder), so checking out other commits can't change or delete it, and have it exit 0 when things work, 1 when they're broken, and 125 when a commit can't be tested (it won't build or install).`,
    isGood
      ? `2. Check out \`${isGood}\` and run the check there to confirm it passes. If it fails there too, stop and tell me: that version was already broken.`
      : '2. Find a commit where it passes: try the release tags, newest first, or step back exponentially (HEAD~8, HEAD~16, HEAD~32…). Stop after about 10 tries and tell me what you found if nothing passes.',
    '3. Run `git bisect start <bad> <good>` and then `git bisect run <your check>`. If the dependencies change between commits (a lockfile differs), have the check reinstall them first. Use `git bisect skip` for commits that can\'t be tested.',
    '4. When it names the first bad commit, run `git bisect reset`.',
    '5. Tell me: the commit (hash, subject, author, date), the lines in its diff that cause the break and why, and how sure you are. Then suggest the smallest fix.',
    "Don't change any code, commit or push. If I want the fix, I'll ask for it here.",
  ].join('\n');
}

// What "out of date" means, for both the fix and the report.
const DOC_CHECKS = [
  'setup and run commands: every command in the docs still exists (package.json scripts, Makefile targets, CLI entry points) and still does what the docs say',
  'environment variables: every one the code reads is in the example env file and the docs, and every one documented is still read somewhere',
  'command-line flags, options and config keys: the names and defaults in the docs match the code',
  "file and folder paths, and links to files in the repository: they're still there",
  "versions: the language and tool versions the docs ask for match the project's own (engines, .nvmrc, lockfiles, CI)",
  'API docs and examples: function names, parameters and return values still match the code',
];
const DOC_FILES = 'the README, CONTRIBUTING, anything under docs/, the example env file (.env.example or similar), and the help text the code prints';

/** "Check the docs": fix what's out of date, in a copy, and leave it for me to look at. */
function docsPrompt({ project = '' }, copy) {
  return [
    `Check that the documentation in ${plain(project) || 'this project'} still matches the code, and fix what doesn't.`,
    '',
    where(copy),
    '',
    `1. Read ${DOC_FILES}. Check each against the code:`,
    ...DOC_CHECKS.map(c => `   - ${c}`),
    '2. Fix the docs to match the code. Never change code to match the docs: if the code looks wrong instead, leave it and list it for me.',
    "3. Don't rewrite anything that's still right, don't restyle, and don't add new sections.",
    "4. Commit on this branch with a message saying what was out of date. Don't push or open a pull request: I'll look at the branch first.",
    '5. Finish with a list of each change and the evidence for it (the file and line in the code that shows it), and anything you think the code gets wrong.',
  ].join('\n');
}

/** The weekly routine: the same check, as a report. It runs in your checkout, so it changes nothing. */
function docsRoutinePrompt({ project = '' } = {}) {
  return [
    `Check that the documentation in ${plain(project) || 'this project'} still matches the code. Report only: don't edit, create or delete any file, and don't commit.`,
    `Read ${DOC_FILES}. Check each against the code:`,
    ...DOC_CHECKS.map(c => `- ${c}`),
    'List what is out of date, most misleading first: the doc file and line, what it says, what the code does (with its file and line), and the fix in one line.',
    "If everything matches, say so in one line. To fix them, I'll press Check the docs on the project's page in Shellby.",
  ].join('\n');
}

/** "Show me around": a tour of the repository, changing nothing. */
function tourPrompt({ project = '' } = {}) {
  return [
    `Show me around ${plain(project) || 'this repository'}: I'm new to it. Read whatever you need, but don't change, install or run anything except read-only commands (git log, listing files).`,
    '',
    'Give me a tour in this order, short and concrete:',
    '1. What it is: two or three sentences on what it does and who uses it.',
    '2. How to run it: the exact commands to install, start and test it, from its own scripts and docs, and anything it needs first (versions, env settings, services).',
    '3. The map: the top-level folders and the few files that matter, one line each.',
    '4. Where it starts: the entry points, and one real path through the code (a request, a command or a screen) from start to finish.',
    '5. Tests and checks: where they live, how to run one, and what CI runs.',
    '6. Careful here: generated files, secrets, migrations, fragile or surprising parts, and conventions the code expects.',
    '7. A good first change: somewhere small to start, and the files it would touch.',
    '',
    'Name files with their path from the repository root, and a line number where it helps (src/server.js:42), so I can open them.',
  ].join('\n');
}

/** The routine the editor opens with for "Make it automatic…". Saved only from the editor. */
function docsRoutine({ project, cwd }) {
  return {
    name: `Docs check: ${plain(project)}`.slice(0, 60),
    prompt: docsRoutinePrompt({ project }),
    cwd, mode: 'ask',
    schedule: { type: 'weekly', time: '10:00', days: [1] },
    note: 'It only reports and changes nothing. Once you save it, it runs every Monday and uses your Claude usage each time.',
  };
}

module.exports = { bisectPrompt, docsPrompt, docsRoutinePrompt, docsRoutine, tourPrompt, parseTags, isRef, MAX_WHAT, MAX_TEST };
