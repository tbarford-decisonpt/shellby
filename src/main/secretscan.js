// A quick look for secrets before anything leaves your PC: API keys, tokens
// and private keys in the lines a push would publish, and files that are
// secrets by nature (.env, id_rsa, *.pem). Asked by every push Shellby makes
// (main.js pushHome) and by "Is it safe to leave?" (leaving.js), whose "Tidy
// up" hands Claude the job of committing and pushing everything.
//
// Two scopes:
//   - outgoing(): the commits a push would send, `HEAD --not --remotes`.
//   - atRisk():   those for every branch, plus what's not committed yet in a
//                 checkout or copy (tracked changes and untracked files that
//                 aren't ignored): what the next commit and push would carry.
//
// Findings name the kind and the place, never the value: they end up in a
// dialog and the log. Patterns are the high-signal ones (a vendor prefix or a
// PEM header), plus `key = "…"` assignments that don't look like placeholders.
// A line containing "secretscan:allow" or "gitleaks:allow" is skipped.
//
// Not devservers/output.js's redact(): that one blanks anything that might be
// a secret before a log line is shown (test keys, PASSWORD=ab), which is right
// there and would cry wolf here, where a hit stops a push.
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const GIT_TIMEOUT_MS = 20000;
const MAX_PATCH_BYTES = 8 * 1024 * 1024;  // past this the scan says it's partial
const MAX_LINE = 4000;                    // of one line, so a minified bundle can't stall it
const MAX_FINDINGS = 25;
const MAX_UNTRACKED = 200;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_UNTRACKED_BYTES = 4 * 1024 * 1024; // read in all, per checkout

const PATTERNS = [
  { kind: 'a private key', re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/ },
  { kind: 'an AWS access key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { kind: 'a GitHub token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b/ },
  { kind: 'a GitLab token', re: /\bglpat-[A-Za-z0-9_-]{20,}/ },
  { kind: 'an Anthropic API key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { kind: 'an OpenAI API key', re: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{40,}/ },
  { kind: 'a Slack token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
  { kind: 'a Stripe live key', re: /\b[rs]k_live_[A-Za-z0-9]{20,}/ },
  { kind: 'a Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { kind: 'an npm token', re: /\bnpm_[A-Za-z0-9]{36}\b|_authToken\s*=\s*(?!\$\{)[^\s'"]{16,}/ },
  { kind: 'a password or key in the code', re: /\b(?:api[_-]?key|secret[_-]?key|client[_-]?secret|access[_-]?token|auth[_-]?token|password|passwd)["']?\s*[:=]\s*["']([^"'\s]{12,})["']/i, placeholder: true },
];

// What `key = "…"` holds when it isn't a real secret.
const PLACEHOLDER = /^(?:x+|\*+|\.+)$|your|example|changeme|placeholder|dummy|sample|redacted|<|\$\{|process\.env|\{\{|xxxx/i;
const realValue = v => !PLACEHOLDER.test(v) && /\d/.test(v) && /[A-Za-z]/.test(v);

const ALLOW = /secretscan:allow|gitleaks:allow/;

/** The kind of secret on one line, or null. */
function lineSecret(text) {
  const line = String(text || '').slice(0, MAX_LINE);
  if (!line || ALLOW.test(line)) return null;
  for (const p of PATTERNS) {
    const m = p.re.exec(line);
    if (m && (!p.placeholder || realValue(m[1]))) return p.kind;
  }
  return null;
}

/** Why a file shouldn't be published by its name alone, or null. */
function riskyFile(file) {
  const base = path.posix.basename(String(file || '').replace(/\\/g, '/')).toLowerCase();
  if (/^\.env(?:\.|$)/.test(base) && !/\.(?:example|sample|template|dist|defaults?|schema)$/.test(base)) return 'an environment file';
  if (/^id_(?:rsa|dsa|ecdsa|ed25519)$/.test(base)) return 'an SSH private key';
  if (/\.(?:pem|key|p12|pfx|jks|keystore|ppk)$/.test(base)) return 'a key or certificate file';
  if (['.netrc', '_netrc', '.pgpass', '.git-credentials', 'credentials.json', 'service-account.json'].includes(base)) return 'a credentials file';
  return null;
}

/**
 * A unified diff (as from `git log -p` or `git diff`) -> [{ file, line, kind }]:
 * risky files that are added or changed (not deleted), and secrets on added lines.
 */
function scanPatch(patch, where = 'unpushed') {
  const out = [];
  const seen = new Set();
  const add = f => { const k = `${f.file}\0${f.line || 0}\0${f.kind}`; if (!seen.has(k)) { seen.add(k); out.push({ ...f, where }); } };
  let file = null, lineNo = 0;
  for (const raw of String(patch || '').split('\n')) {
    const l = raw.replace(/\r$/, '');
    if (l.startsWith('diff --git ')) { file = l.slice(l.lastIndexOf(' b/') + 3) || null; lineNo = 0; continue; }
    if (l.startsWith('+++ ')) {
      file = l === '+++ /dev/null' ? null : l.slice(4).replace(/^"?b\//, '').replace(/"$/, '');
      const why = file && riskyFile(file);
      if (why) add({ file, kind: why });
      continue;
    }
    if (l.startsWith('Binary files ') && file && !/ and \/dev\/null differ$/.test(l)) {
      const why = riskyFile(file);
      if (why) add({ file, kind: why });
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(l);
    if (hunk) { lineNo = Number(hunk[1]); continue; }
    if (!file) continue;
    if (l.startsWith('+')) {
      const kind = lineSecret(l.slice(1));
      if (kind) add({ file, line: lineNo, kind });
      lineNo++;
    } else if (l.startsWith(' ')) lineNo++;
  }
  return out;
}

/**
 * An untracked file's findings: by its name, and line by line if it's small
 * text. Async: this runs in the main process, where a blocking read stalls him.
 * -> { found, bytes } (bytes read, for the caller's budget)
 */
async function scanFile(abs, rel) {
  const out = [];
  const why = riskyFile(rel);
  if (why) out.push({ file: rel, kind: why, where: 'uncommitted' });
  let text;
  try {
    const st = await fs.promises.stat(abs);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return { found: out, bytes: 0 };
    text = await fs.promises.readFile(abs, 'utf8');
  } catch { return { found: out, bytes: 0 }; }
  const bytes = text.length;
  if (text.includes('\0')) return { found: out, bytes };
  text.split('\n').forEach((l, i) => {
    const kind = lineSecret(l);
    if (kind) out.push({ file: rel, line: i + 1, kind, where: 'uncommitted' });
  });
  return { found: out, bytes };
}

// git with no shell, no external diff drivers or textconv (a repository's
// config mustn't choose a program for us to run), and a cap on the output:
// past it the scan carries on with what it has and says it's partial.
function git(cwd, args) {
  return new Promise(resolve => {
    execFile('git', ['-c', 'core.fsmonitor=false', '-c', 'core.quotePath=false', '--no-optional-locks', '-C', cwd, ...args],
      { windowsHide: true, timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_PATCH_BYTES },
      (err, stdout) => {
        if (!err) return resolve({ ok: true, out: String(stdout) });
        if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return resolve({ ok: true, out: String(stdout || ''), partial: true });
        resolve({ ok: false, out: '' });
      });
  });
}

const PATCH = ['log', '-p', '--no-color', '--no-ext-diff', '--no-textconv', '-U0', '--format='];

const result = (findings, { partial = false, ok = true } = {}) => ({ ok, partial, findings: findings.slice(0, MAX_FINDINGS), more: Math.max(0, findings.length - MAX_FINDINGS) });

/** What a push of root's checkout would send. -> { ok, partial, findings, more } */
async function outgoing(root, run = git) {
  const r = await run(root, [...PATCH, 'HEAD', '--not', '--remotes']);
  if (!r.ok) return result([], { ok: false });
  return result(scanPatch(r.out, 'unpushed'), { partial: !!r.partial });
}

/** Uncommitted changes in one checkout or copy: tracked edits, and untracked files that aren't ignored. */
async function uncommitted(dir, run = git) {
  const found = [];
  let partial = false;
  const diff = await run(dir, ['diff', 'HEAD', '--no-color', '--no-ext-diff', '--no-textconv', '-U0']);
  if (diff.ok) { found.push(...scanPatch(diff.out, 'uncommitted')); partial ||= !!diff.partial; }
  const others = await run(dir, ['ls-files', '--others', '--exclude-standard', '-z']);
  const files = others.ok ? others.out.split('\0').filter(Boolean) : [];
  if (files.length > MAX_UNTRACKED) partial = true;
  const home = path.resolve(dir) + path.sep;
  let budget = MAX_UNTRACKED_BYTES;
  for (const rel of files.slice(0, MAX_UNTRACKED)) {
    if (budget <= 0) { partial = true; break; }
    const abs = path.resolve(dir, rel);
    if (!abs.startsWith(home)) continue;
    const f = await scanFile(abs, rel);
    found.push(...f.found);
    budget -= f.bytes;
  }
  return { ok: diff.ok && others.ok, partial, found };
}

/**
 * Everything in one repository that could go out with the next commit and push.
 * dirs: its checkout and copies with uncommitted work. unpushed: whether any branch has commits no remote has.
 */
async function atRisk(root, { dirs = [], unpushed = true } = {}, run = git) {
  const found = [];
  let partial = false, ok = true;
  if (unpushed) {
    const r = await run(root, [...PATCH, '--branches', '--not', '--remotes']);
    if (r.ok) { found.push(...scanPatch(r.out, 'unpushed')); partial ||= !!r.partial; } else ok = false;
  }
  for (const dir of dirs) {
    const u = await uncommitted(dir, run);
    found.push(...u.found);
    partial ||= u.partial;
    ok &&= u.ok;
  }
  return result(found, { partial, ok });
}

const where = f => (f.line ? `${f.file}:${f.line}` : f.file);
/** One finding as a line people read: "config.js:12 (an AWS access key)". */
const describe = f => `${where(f)} (${f.kind}${f.where === 'uncommitted' ? ', not committed yet' : ''})`;

module.exports = { lineSecret, riskyFile, scanPatch, scanFile, outgoing, uncommitted, atRisk, describe, git, PATTERNS, MAX_FINDINGS };
