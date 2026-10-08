// The Bugdex's eyes: which kind of bug a failed command printed, and whether
// a command is one that can show one at all. This is the only place the
// Bugdex reads output text, and nothing it reads is kept: what comes out is a
// species id, a short hash and a language. See docs/plans/bugdex.md §3.
//
// Pure: no I/O, no clock. See test/bugdex-detect.test.js.
const crypto = require('crypto');
const { ANSI_RE, cmdKey, masked, normalizeCmd } = require('../flaky/ids');
const { readRun } = require('../flaky/parsers');
const { classifyCommand } = require('../xp');
const { flagsOf } = require('./cheats');

const MAX_TEXT = 64 * 1024;    // only the end of a long output: the error is near the bottom
const MAX_LINES = 200;
const MAX_LINE = 500;

// ------------------------------------------------------------------ commands

// The first word of commands that print other people's errors (a grep through
// a log full of TypeErrors is not a TypeError).
const READERS = new Set(['grep', 'rg', 'ag', 'ack', 'cat', 'type', 'less', 'more', 'head', 'tail', 'awk', 'sed', 'find', 'ls', 'dir', 'tree',
  'echo', 'printf', 'get-content', 'select-string', 'gc', 'sls', 'jq', 'bat', 'wc', 'sort', 'uniq', 'diff', 'file', 'stat', 'get-childitem', 'gci', 'write-output', 'write-host']);
const GIT_READ = /^git[ \t]+(log|show|diff|grep|blame|status|reflog|ls-files|ls-tree|cat-file|rev-parse|branch|remote|config|stash[ \t]+list)\b/i;
const GH_READ = /^gh[ \t]+(run[ \t]+(view|list)|pr[ \t]+(view|list|checks|diff)|issue[ \t]+(view|list)|api)\b/i;
// Asking whether something is there: "no" is the answer, not a bug.
const PROBE = /^(test[ \t]+-[a-z]|\[[ \t]+-[a-z]|\[\[|which\b|where(\.exe)?\b|command[ \t]+-v|type[ \t]+-[pPt]|Test-Path|Get-Command|Resolve-Path)/i;

const LINT_CMD = /\b(eslint|(npm|pnpm|yarn|bun)[ \t]+(run[ \t]+)?lint\b|ruff([ \t]+check)?\b|flake8|pylint|golangci-lint|cargo[ \t]+clippy|stylelint|biome[ \t]+(check|lint)|rubocop|prettier[ \t]+--check)/i;
const TYPE_CMD = /\b(tsc|vue-tsc|(npm|pnpm|yarn|bun)[ \t]+(run[ \t]+)?(typecheck|type-check|tsc|check-types)|mypy|pyright|basedpyright)\b/i;
const BUILD_CMD = /\b((npm|pnpm|yarn|bun)[ \t]+(run[ \t]+)?build\b|vite[ \t]+build|next[ \t]+build|webpack\b|esbuild\b|rollup\b|cargo[ \t]+(build|check)\b|go[ \t]+build\b|dotnet[ \t]+build|msbuild\b|gradlew?[ \t]+(build|assemble)|mvn[ \t]+(package|compile|install)|make\b|cmake[ \t]+--build|electron-builder\b)/i;
const INSTALL_CMD = /\b((npm|pnpm|bun)[ \t]+(i|install|ci|add)\b|yarn([ \t]+(install|add)\b|[ \t]*$)|pip3?[ \t]+install|python\d*[ \t]+-m[ \t]+pip[ \t]+install|uv[ \t]+(sync|add|pip[ \t]+install)|poetry[ \t]+(install|add|lock)|cargo[ \t]+(add|update|fetch)|go[ \t]+(get|mod[ \t]+(tidy|download))|bundle([ \t]+install)?[ \t]*$|composer[ \t]+(install|require))/i;
const GIT_CMD = /^git\b/i;
const RUST_CMD = /\b(cargo|rustc)\b/i;

/** What sort of command it is: 'tests' | 'lint' | 'typecheck' | 'build' | 'install' | 'git' | 'run'. */
function commandKind(cmd) {
  const c = normalizeCmd(cmd);
  if (!c) return 'run';
  if (classifyCommand(c) === 'tests') return 'tests';
  if (LINT_CMD.test(c)) return 'lint';
  if (TYPE_CMD.test(c)) return 'typecheck';
  if (INSTALL_CMD.test(c)) return 'install';
  if (BUILD_CMD.test(c)) return 'build';
  if (GIT_CMD.test(c)) return 'git';
  return 'run';
}

/** Why a command can't show a bug ('reader' | 'probe'), or null when it can. */
function gate(cmd) {
  const c = normalizeCmd(cmd);
  if (!c) return 'reader';
  const first = c.split(/[ \t]/)[0].toLowerCase().replace(/\.exe$/, '');
  if (READERS.has(first) || GIT_READ.test(c) || GH_READ.test(c)) return 'reader';
  if (PROBE.test(c)) return 'probe';
  return null;
}

/**
 * Did a finished command fail, pass, or say nothing we can trust?
 *   -> 'fail' | 'pass' | null
 * A test run is read by its own summary (the exit code of `npm test | tail`
 * is tail's). Anything else masked by a pipe or `|| true` says nothing.
 */
function outcomeOf({ cmd, output, isError, background = false, complete = true }) {
  if (background || typeof cmd !== 'string' || gate(cmd)) return null;
  if (commandKind(cmd) === 'tests') {
    const run = readRun({ cmd, output, isError, complete });
    return run ? (run.ok ? 'pass' : 'fail') : null;
  }
  if (masked(cmd)) return null;
  return isError ? 'fail' : 'pass';
}

/**
 * The keys a later command can match this one by: its own, and (for a test,
 * lint, typecheck, build or install command) each shorter run of it, so
 * `npm test -- auth` failing is caught by `npm test` passing. The reverse
 * isn't: a narrower run can't vouch for the rest.
 */
function matchKeys(cmd) {
  const n = normalizeCmd(cmd);
  if (!n) return [];
  const own = cmdKey(n);
  const kind = commandKind(n);
  if (kind === 'run' || kind === 'git') return [own];
  const words = n.split(' ');
  const keys = [];
  for (let i = 2; i < words.length; i++) {
    const shorter = words.slice(0, i).join(' ');
    if (commandKind(shorter) === kind) keys.push(cmdKey(shorter));
  }
  return [...new Set([...keys, own])];
}

// ------------------------------------------------------------------ remedies

// Fixes that aren't code: what a species with `remedies` may be caught by on
// the same tree.
const REMEDY = {
  install: INSTALL_CMD,
  kill: /\b(taskkill\b|kill([ \t]+-9)?[ \t]+%?\d|Stop-Process\b|kill-port\b|fuser[ \t]+-k|pkill\b|killall\b|xargs[ \t]+kill)/i,
  service: /\b(docker([ \t]+compose|-compose)?[ \t]+(up|start)\b|(brew[ \t]+)?services?[ \t]+\S+[ \t]+start\b|brew[ \t]+services[ \t]+start|systemctl[ \t]+start|pg_ctl[ \t]+start|Start-Service\b|redis-server\b|mongod\b|net[ \t]+start\b)/i,
  lock: /\b(rm|del|Remove-Item|erase)\b.*index\.lock\b/i,
  cache: /\b(rm[ \t]+-r?f?r?[ \t]+.*(node_modules[\\/]\.cache|\.next|\.turbo|\.parcel-cache|__pycache__|\.pytest_cache|\.vite|target\b)|Remove-Item\b.*(\.next|\.turbo|\.cache|__pycache__|\.vite)|npm[ \t]+cache[ \t]+clean|yarn[ \t]+cache[ \t]+clean|pnpm[ \t]+store[ \t]+prune|cargo[ \t]+clean|go[ \t]+clean[ \t]+-cache|--no-cache\b|docker[ \t]+system[ \t]+prune)/i,
};

/** Which remedy a command is, or null. Uses the raw command: a kill pipeline (`lsof | xargs kill`) is the point. */
function remedyOf(cmd) {
  if (typeof cmd !== 'string') return null;
  const c = cmd.slice(0, 2000);
  for (const [key, re] of Object.entries(REMEDY)) if (re.test(c)) return key;
  return null;
}

// Settling a merge conflict, and walking away from one.
const RESOLVE = /^git[ \t]+(commit\b|(merge|rebase|cherry-pick|revert|am)[ \t]+--continue\b)/i;
const FLEE = /^git[ \t]+((merge|rebase|cherry-pick|revert|am)[ \t]+--(abort|quit|skip)\b|reset[ \t]+--hard\b|checkout[ \t]+(--[ \t]+)?\.[ \t]*$|restore[ \t]+(--staged[ \t]+)?\.[ \t]*$|stash\b(?![ \t]+(list|show)))/i;
const PUSH = /^git[ \t]+push\b/i;
const FORCE_PUSH = /(^|[ \t])(--force(?!-with-lease)|-f)\b/;
const NO_VERIFY = /(^|[ \t])(--no-verify|-n)\b/;
const COMMIT = /^git[ \t]+commit\b/i;

const isResolve = cmd => RESOLVE.test(normalizeCmd(cmd));
const isFlee = cmd => FLEE.test(normalizeCmd(cmd));
/** A push that counts as a fix for a rejected one: not forced (a lease is fine). */
const isFairPush = cmd => { const c = normalizeCmd(cmd); return PUSH.test(c) && !FORCE_PUSH.test(c); };
/** A commit that went through its hooks. */
const isHookedCommit = cmd => { const c = normalizeCmd(cmd); return COMMIT.test(c) && !NO_VERIFY.test(c); };

// ------------------------------------------------------------------ signatures

// [species, pattern, language, condition?]. Tier 1 is specific, tier 2 a
// family, tier 3 an umbrella; the lowest tier wins, then the last line.
const TIER1 = [
  ['nullfish', /\bTypeError:[ \t]+(Cannot read propert(y|ies) of (undefined|null)|Cannot set propert(y|ies) of (undefined|null)|(undefined|null) is not an object|Cannot destructure property)/, 'js'],
  ['nullfish', /\bAttributeError:[ \t]+'NoneType' object has no attribute/, 'py'],
  ['nullfish', /\bjava\.lang\.NullPointerException\b|\bSystem\.NullReferenceException\b|\bkotlin\.KotlinNullPointerException\b/, 'jvm'],
  ['missingno', /\bTypeError:[ \t]+undefined is not a function\b|^(Uncaught[ \t]+)?(Error:[ \t]+)?\[object Object\][ \t]*$/, 'js'],
  ['wonky-whelk', /\b(IndentationError|TabError):/, 'py'],
  ['ouroboros-eel', /RangeError:[ \t]+Maximum call stack size exceeded|\bRecursionError:|thread '[^']*' has overflowed its stack|java\.lang\.StackOverflowError|fatal error: stack overflow|goroutine stack exceeds/, null],
  ['off-by-one-octopus', /\bIndexError:[ \t]+\w+ index out of range|index out of range \[\d+\]|index out of bounds: the len is|ArrayIndexOutOfBoundsException|IndexOutOfRangeException|RangeError:[ \t]+Invalid array length/, null],
  ['broken-promise-prawn', /UnhandledPromiseRejection|Unhandled promise rejection|unhandledRejection/, 'js'],
  ['heap-leviathan', /JavaScript heap out of memory|FATAL ERROR:.*Allocation failed|\bMemoryError\b|java\.lang\.OutOfMemoryError|fatal error: runtime: out of memory|memory allocation of \d+ bytes failed/, null],
  ['segfault-squid', /Segmentation fault|\bSIGSEGV\b|exit (code|status) (139|-1073741819|3221225477)\b|0xC0000005|Access violation/, null],
  ['nil-gopherfish', /panic: runtime error: invalid memory address or nil pointer dereference/, 'go'],
  ['knotted-eels', /fatal error: all goroutines are asleep - deadlock!|deadlock detected|\bDeadlockError\b/, null],
  ['race-wraith', /WARNING: DATA RACE|ThreadSanitizer: data race/, null],
  ['panicked-prawn', /thread '[^']*' panicked at|called `(Option|Result)::unwrap\(\)` on an? `(None|Err)/, 'rust'],
  ['borrowing-hermit', /error\[E0(499|502|505|506|382|597|716|503|373)\]/, 'rust'],
  ['keyless-krill', /^KeyError:[ \t]/, 'py'],
  ['circular-sea-snake', /ImportError:[ \t]+cannot import name .* \(most likely due to a circular import\)|partially initialized module/, 'py'],
  ['zero-dab', /\bZeroDivisionError:|DivideByZeroException|attempt to divide by zero|integer divide by zero/, null],
  ['stray-module-minnow', /Cannot find module '|Module not found: (Error: )?Can't resolve|ERR_MODULE_NOT_FOUND|ModuleNotFoundError: No module named|ImportError: No module named|Could not resolve "[^"]+"|cannot find package|no required module provides package|unresolved import `|could not find `[\w-]+` in/, null],
  ['tangled-tree-crab', /\bERESOLVE\b|unable to resolve dependency tree|Could not resolve dependency|ResolutionImpossible|conflicting dependencies|failed to select a version for|version solving failed|No matching distribution found/, null],
  ['old-salt', /Unsupported engine|The engine "node" is incompatible|requires (a )?(node|python)( version)? ?[>=]|go: go\.mod requires go >=|rustc [\d.]+ is not supported/i, null],
  ['port-squatter', /\bEADDRINUSE\b|address already in use|Only one usage of each socket address|port \d+ is (already )?in use/i, null],
  ['closed-clam', /\bECONNREFUSED\b|Connection refused|ConnectionRefusedError|actively refused it/, null],
  ['snapped-line', /\bECONNRESET\b|socket hang up|Connection reset by peer|\bEPIPE\b/, null],
  ['nameless-buoy', /\bENOTFOUND\b|getaddrinfo E|Name or service not known|Could not resolve host|No such host is known/, null],
  ['cert-cuttlefish', /UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT|CERT_HAS_EXPIRED|certificate verify failed|x509: certificate/, null],
  ['border-crab', /blocked by CORS policy|No 'Access-Control-Allow-Origin' header/, null],
  ['slowpoke-snail', /\bE?TIMEDOUT\b|\bESOCKETTIMEDOUT\b|Exceeded timeout of \d+ ?ms|\bTimeoutError\b|context deadline exceeded|ReadTimeout(Error)?\b|504 Gateway Time-?out/, null],
  ['meltdown-medusa', /HTTP\/[\d.]+ 5\d\d|\b50[0234] (Internal Server Error|Bad Gateway|Service Unavailable)|Request failed with status code 5\d\d/, null],
  ['lost-parcel-crab', /HTTP\/[\d.]+ 404|\b404 Not Found\b|Request failed with status code 404|The requested URL returned error: 404/, null],
  ['clingy-barnacle', /\bEBUSY\b|being used by another process|resource busy or locked/, null],
  ['locked-limpet', /\bE(ACCES|PERM)\b|Permission denied|PermissionError|Access is denied|UnauthorizedAccessException/, null],
  ['overstuffed-pufferfish', /\bENOSPC\b|No space left on device|\bEMFILE\b|[Tt]oo many open files/, null],
  ['mixed-up-mussel', /\bE(ISDIR|NOTDIR|EXIST)\b|IsADirectoryError|NotADirectoryError|FileExistsError/, null],
  ['shell-less-hermit', /\bENOENT\b|No such file or directory|FileNotFoundError|The system cannot find the (file|path) specified|Cannot find path '.*' because it does not exist/, null],
  ['two-headed-crab', /^CONFLICT \([\w/ -]+\):|Automatic merge failed|^error: could not apply [0-9a-f]{7,}|Pulling is not possible because you have unmerged files/, 'git'],
  ['bounced-bottle', /! \[rejected\]|\(non-fast-forward\)|Updates were rejected because/, 'git'],
  ['gatekeeper-goby', /husky - [\w-]+ hook exited with code|pre-commit hook .*fail|hook declined/i, 'git'],
  ['lockfile-lobster', /index\.lock': File exists|Another git process seems to be running/, 'git'],
  ['mirror-mullet', /\d+ snapshots? failed|Snapshot `[^`]+` mismatched|Snapshot name: `/, null],
  ['assertive-lobster', /\bAssertionError\b|expect\(received\)|assertion failed|assert_eq!|assertion `left == right` failed|^E[ \t]+assert /, null],
  ['mismatched-mantis', /error TS(2322|2345|2741|2739|2740|2769):/, 'ts'],
  ['missing-fin-pipefish', /error TS(2339|2551|2353):/, 'ts'],
  ['undeclared-urchin', /error TS(2307|7016|2305):/, 'ts'],
  ['anything-anemone', /error TS(7006|7005|7031|7053|18046):/, 'ts'],
  ['optional-oarfish', /error TS(2531|2532|2533|18047|18048|18049):/, 'ts'],
  ['hinted-hermit', /: error: .* \[[a-z-]+\]$| - error: /, 'py', ({ kind }) => kind === 'typecheck'],
];
const TIER2 = [
  ['shapeshifter-shrimp', /\bTypeError:[ \t]+\S/, null],
  ['nameless-nudibranch', /\bReferenceError:[ \t]+\S+ is not defined|\bNameError:[ \t]+name '/, null],
  ['syntax-slug', /\bSyntaxError:[ \t]|Unexpected token\b/, null],
  ['attribute-anglerfish', /\bAttributeError:[ \t]/, 'py'],
  ['off-value-oyster', /^ValueError:[ \t]/, 'py'],
  ['type-tangle', /error TS\d{4}:/, 'ts'],
  ['rusty-nautilus', /^error(\[E\d{4}\])?:[ \t]/, 'rust', ({ cmd }) => RUST_CMD.test(cmd)],
];
const TIER3 = [
  ['collapsed-castle', /Build failed with \d+ errors?|Failed to compile|error during build|compiled with \d+ errors?|error: could not compile `|BUILD FAILED|FAILURE: Build failed|make: \*\*\* .* Error \d/, null],
];
const TIERS = [TIER1, TIER2, TIER3];

// What a failing command of each kind is when nothing more specific matched.
const BY_KIND = { tests: 'red-snapper', lint: 'lint-louse', build: 'collapsed-castle' };

/**
 * A tool result's whole output. A long result is its first 8,000 characters,
 * "… (N more characters)" and, separately, its last 8,000: when the two
 * overlap, that's all of it. -> { output, complete }
 */
function fullOutput(item, tail) {
  const text = String(item?.text || '');
  if (!tail) return { output: text, complete: true };
  const m = text.match(/\n… \((\d+) more characters\)$/);
  const head = m ? text.slice(0, m.index) : text;
  const rest = m ? Number(m[1]) : Infinity;
  return rest <= tail.length ? { output: head + tail.slice(-rest), complete: true } : { output: `${head}\n${tail}`, complete: false };
}

/** The lines worth reading: the end of the output, cleaned and clipped. */
function windowOf(output) {
  const raw = typeof output === 'string' ? output.slice(-MAX_TEXT) : '';
  return raw.replace(ANSI_RE, '').replace(/\r\n?/g, '\n').split('\n').slice(-MAX_LINES)
    .map(l => l.replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, ' ').slice(0, MAX_LINE).trimEnd());
}

// ------------------------------------------------------------------ fingerprints

const LIB = /node_modules|site-packages|dist-packages|[\\/]rustc[\\/]|[\\/]go[\\/]src[\\/]|<anonymous>|node:internal|internal[\\/]|[\\/]lib[\\/]python/i;
// A source file in a trace, one whitespace- or bracket-separated token at a
// time: anchored, with one open-ended run, so it's linear on any line (a
// lazy prefix before a greedy name backtracked for seconds on minified junk).
const SOURCE_TOKEN = /^(?:[A-Za-z]:)?[\w.@~/\\-]*\.(?:[cm]?[jt]sx?|py|rs|go|rb|java|kt|cs|php|vue|svelte|swift|c|cc|cpp|h)(?::\d+){0,2}$/;
// ...that a location follows: `:12`, `", line 12` (Python) or `(3,7)` (tsc).
const LOCATED = /^(?::\d|", line \d|\(\d)/;
const basename = p => String(p).split(/[\\/]/).pop();
const MAX_FILE_LINES = 60;

/** The first file of yours in the trace, as a basename ('' when none). */
function fileBase(lines) {
  for (const l of lines.slice(-MAX_FILE_LINES)) {
    let from = 0;
    for (const token of l.split(/[\s"'(),<>[\]]+/)) {
      if (!token) continue;
      const at = l.indexOf(token, from);
      from = at + token.length;
      if (token.length > 300 || !SOURCE_TOKEN.test(token) || LIB.test(token)) continue;
      const located = /:\d+$/.test(token) || LOCATED.test(l.slice(from, from + 10));
      if (located) return basename(token.replace(/(?::\d+)+$/, '')).toLowerCase();
    }
  }
  return '';
}

/** A message as compared: no paths, numbers, hashes or long literals. */
function normMessage(s) {
  return String(s || '').toLowerCase()
    .replace(/(?:[a-z]:)?[\\/][^\s:'"()]+/g, p => basename(p))
    .replace(/0x[0-9a-f]+|\b[0-9a-f]{7,40}\b/g, '#')
    .replace(/\d+/g, '#')
    .replace(/(['"`])[^'"`]{40,}\1/g, '"…"')
    .replace(/\s+/g, ' ').trim().slice(0, 200);
}

/** 12 hex characters: the same bug in the same file, whatever the line number, port or folder. */
function fingerprint(species, line, file = '') {
  return crypto.createHash('sha1').update(`${species}|${normMessage(line)}|${file}`).digest('hex').slice(0, 12);
}

// ------------------------------------------------------------------ classify

/**
 * Which bug a failed output shows, or null.
 *   opts: { cmd, source: 'bash' | 'server' | 'ci', live?: Set of species ids that can be seen now }
 * -> { species, fp, lang, tier }
 */
function classify(output, { cmd = '', source = 'bash', live = null } = {}) {
  const lines = windowOf(output);
  const kind = source === 'bash' ? commandKind(cmd) : 'run';
  const ok = id => !live || live.has(id);
  const ctx = { kind, cmd: normalizeCmd(cmd) };
  for (let t = 0; t < TIERS.length; t++) {
    let hit = null;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      for (const [species, re, lang, when] of TIERS[t]) {
        if (!ok(species) || (when && !when(ctx)) || !re.test(line)) continue;
        hit = { species, lang, line, tier: t + 1 }; // a later line replaces an earlier one
        break;
      }
    }
    if (hit) return { species: hit.species, lang: hit.lang, tier: hit.tier, fp: fingerprint(hit.species, hit.line, fileBase(lines)) };
  }
  // Nothing named it: what the command was decides (a failed lint is a Lint Louse).
  const umbrella = source === 'server' ? 'beached-whale' : BY_KIND[kind];
  if (umbrella && ok(umbrella)) {
    const last = [...lines].reverse().find(l => l.trim()) || '';
    // A test or lint failure is told apart by its command, not its last line (that's a summary).
    const fpLine = source === 'bash' ? `${kind}:${cmdKey(cmd) || ''}` : last;
    return { species: umbrella, lang: null, tier: 3, fp: fingerprint(umbrella, fpLine, fileBase(lines)) };
  }
  return null;
}

/**
 * Whether an output still shows a bug: any signature at all, or the one
 * fingerprint asked about. Used on a pass, where the run succeeding isn't
 * enough if the same error is still printed.
 */
const stillShows = (output, fp, opts = {}) => fingerprintsIn(output, opts).includes(fp);

/** Every bug fingerprint an output shows, whichever tier: a pass still printing one hasn't fixed it. */
function fingerprintsIn(output, { cmd = '', live = null } = {}) {
  const lines = windowOf(output);
  const ctx = { kind: commandKind(cmd), cmd: normalizeCmd(cmd) };
  const file = fileBase(lines);
  const fps = new Set();
  for (const tier of TIERS) {
    for (const line of lines) {
      if (!line) continue;
      for (const [species, re, , when] of tier) {
        if ((live && !live.has(species)) || (when && !when(ctx)) || !re.test(line)) continue;
        fps.add(fingerprint(species, line, file));
      }
    }
  }
  return [...fps].slice(0, 50);
}

/**
 * Everything the Bugdex needs from one finished command, with none of its
 * text: Shellby's tabs and Claude Code sessions outside Shellby
 * (external.js) both hand this over instead of the output.
 * -> null (it can't show anything) | {
 *      outcome: 'fail' | 'pass', key, keys, kind, hit (classify) | null,
 *      fps (on a pass: bugs it still prints), passed, conflictFiles,
 *      remedy, flee, resolve, fairPush, hookedCommit, passFlags }
 */
function read({ cmd, output, isError, background = false, complete = true, live = null }) {
  const outcome = outcomeOf({ cmd, output, isError, background, complete });
  if (!outcome) return null;
  const hit = outcome === 'fail' ? classify(output, { cmd, source: 'bash', live }) : null;
  return {
    outcome, key: cmdKey(cmd), keys: matchKeys(cmd), kind: commandKind(cmd), hit,
    fps: outcome === 'pass' ? fingerprintsIn(output, { cmd, live }) : [],
    passed: passedCount(output),
    conflictFiles: hit?.species === 'two-headed-crab' ? conflictFiles(output) : [],
    remedy: outcome === 'pass' ? remedyOf(cmd) : null,
    flee: outcome === 'pass' && isFlee(cmd),
    resolve: outcome === 'pass' && isResolve(cmd),
    fairPush: outcome === 'pass' && isFairPush(cmd),
    hookedCommit: outcome === 'pass' && isHookedCommit(cmd),
    passFlags: flagsOf(cmd),
  };
}

/** How many tests passed, when the runner says (for the "fewer tests" check), else null. */
function passedCount(output) {
  const text = windowOf(output).join('\n');
  const pats = [/Tests:.*?(\d+) passed/, /(\d+) passed/, /^# pass (\d+)/m, /^ℹ pass (\d+)/m, /test result: \w+\. (\d+) passed/, /(\d+) passing\b/, /Ran (\d+) tests?/];
  for (const re of pats) {
    const m = re.exec(text);
    if (m) return Number(m[1]);
  }
  return null;
}

/** The files a git conflict named, as written (kept in memory only, for the check after). */
function conflictFiles(output) {
  const files = new Set();
  for (const l of windowOf(output)) {
    // The rest of the line is the path, spaces and all ("Merge conflict in my file.txt").
    const m = /^CONFLICT \([\w/ -]+\): .*?(?:Merge conflict in |in )(\S.*)$/.exec(l);
    if (m) files.add(m[1]);
  }
  return [...files].slice(0, 50);
}

module.exports = {
  TIER1, TIER2, TIER3, REMEDY,
  commandKind, gate, outcomeOf, matchKeys, remedyOf, isResolve, isFlee, isFairPush, isHookedCommit,
  classify, stillShows, fingerprintsIn, read, fingerprint, normMessage, fileBase, windowOf, fullOutput, passedCount, conflictFiles,
};
