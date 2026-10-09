// "Include this project" for the Council: a few KB about the project, gathered
// here once and handed to every advisor on stdin, so no advisor spends tokens
// (or tools) looking around. Pure apart from the read and git it's handed.

const path = require('path');

const MAX_README = 1500;
const MAX_HEADINGS = 600;
const MAX_LOG = 800;
const MAX_STAT = 800;
const MAX_TOTAL = 4096;

const trimTo = (s, max) => {
  const t = String(s || '').replace(/\r\n?/g, '\n').trim();
  return t.length > max ? `${t.slice(0, max)}\n…` : t;
};

/**
 * root: the project folder. read(file) -> text or throws. git(args) -> Promise<{ ok, stdout }>.
 * -> the context text, or '' when there's nothing to say.
 */
async function gather(root, { read, git }) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) return '';
  const tryRead = name => { try { return read(path.join(root, name)); } catch { return ''; } };
  const gitOut = async args => {
    try { const r = await git(args); return r && r.ok ? r.stdout : ''; } catch { return ''; }
  };
  const readme = tryRead('README.md');
  const headings = tryRead('CLAUDE.md').split(/\r?\n/).filter(l => /^#{1,3} /.test(l)).join('\n');
  const [log, stat] = await Promise.all([
    gitOut(['log', '--oneline', '-8']),
    gitOut(['diff', '--stat', '--no-ext-diff', '--no-textconv', 'HEAD']),
  ]);
  const parts = [`Project: ${path.basename(root)}`];
  if (readme) parts.push(`README (start):\n${trimTo(readme, MAX_README)}`);
  if (headings) parts.push(`CLAUDE.md sections:\n${trimTo(headings, MAX_HEADINGS)}`);
  if (log) parts.push(`Recent commits:\n${trimTo(log, MAX_LOG)}`);
  if (stat) parts.push(`Uncommitted changes:\n${trimTo(stat, MAX_STAT)}`);
  return parts.length > 1 ? trimTo(parts.join('\n\n'), MAX_TOTAL) : '';
}

module.exports = { gather, MAX_TOTAL };
