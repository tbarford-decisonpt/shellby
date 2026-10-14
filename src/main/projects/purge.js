'use strict';
// "Forget Claude's history here": Claude Code's own `claude purge <path>`,
// which deletes a project's transcripts, tasks, file history, memory and its
// entry in Claude Code's config. Shellby asks `--dry-run` first, shows what it
// listed, and only purges (`--yes`) once you've said so in main's own dialog.
//
// Pure: the CLI runs elsewhere (projects/ipc.js), test/purge.test.js.

const MAX_LINES = 12;

/**
 * What a `claude purge --dry-run` said it would delete.
 * @returns {{ items: number, lines: string[], memory: boolean }}
 *   items: how many it counted (0 when nothing is kept for that folder);
 *   lines: what it would delete, one per line, for the dialog;
 *   memory: whether Claude's memory for the project goes too.
 */
function purgePlan(stdout) {
  const text = String(stdout ?? '').replace(/\r/g, '');
  const m = /Dry run:\s*(\d+)\s+item/i.exec(text);
  const items = m ? Number(m[1]) : 0;
  const lines = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || /^Purge plan for /i.test(line) || /^Dry run:/i.test(line)) continue;
    // The notes about what it leaves alone (shell snapshots, backups) aren't deletions.
    if (/will not be touched|may still contain|rotate out/i.test(line)) continue;
    lines.push(line.replace(/\s+/g, ' '));
  }
  return { items, lines: lines.slice(0, MAX_LINES), memory: /\bmemory\b/i.test(lines.join('\n')) };
}

/** The `claude purge` arguments for a folder: a look first, then the real thing. */
const purgeArgs = (root, { dryRun }) => ['purge', dryRun ? '--dry-run' : '--yes', '--', root];

module.exports = { purgePlan, purgeArgs };
