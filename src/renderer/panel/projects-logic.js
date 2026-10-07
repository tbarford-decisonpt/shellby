// The Projects page's decisions and words (projects.js and the files beside it
// draw them): a dev server's status line, which projects the list shows and
// in what order, a clone's git facts, what the row's play button does, and
// the scan's lines. Pure, no DOM. Works in the browser and in Node (for tests).
(function (root) {
  const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

  // ------------------------------------------------------------ dev servers

  const isLive = s => s.status === 'starting' || s.status === 'up';

  // relTime: SB.relTime, for when it ended.
  function statusText(s, relTime) {
    const ago = t => (t ? relTime(t) : '');
    const code = Number.isInteger(s.exitCode) ? ` · exit code ${s.exitCode}` : '';
    switch (s.status) {
      case 'starting': return s.kind === 'install' ? 'Installing…' : 'Starting…';
      case 'up': return s.port ? `Up on :${s.port}` : 'Up';
      // Ended while Shellby was closed with no exit code: it may well have been stopped on purpose.
      case 'crashed': return s.missed && !Number.isInteger(s.exitCode) ? `Stopped while Shellby was closed · ${ago(s.endedAt)}`
        : `${s.neverUp ? "Didn't start" : 'Crashed'} ${ago(s.endedAt)}${code}${s.missed ? ' · while Shellby was closed' : ''}`;
      case 'failed': return `Install failed ${ago(s.endedAt)}${code}`;
      default: return s.status;
    }
  }

  // The row's play button for a project's main clone: open the server that's
  // up, else start the script you ran last (or the likeliest). serversIn(root)
  // lists the servers in a folder. -> { open: server } | { start: script } | null.
  function devChoice(c, serversIn) {
    if (!c) return null;
    const up = serversIn(c.root).find(s => s.status === 'up' && s.url && s.kind === 'server');
    if (up) return { open: up };
    if (serversIn(c.root).some(isLive)) return null;
    const script = c.scripts.find(s => s.name === c.lastScript) || c.scripts.find(s => s.likely);
    if (!script || c.installed === false) return null;
    return { start: script };
  }

  // ------------------------------------------------------------ the list

  const SORTS = {
    recent: () => 0, // main's order: worked on lately, running, on this PC, last push
    attention: (a, b) => (b.insights?.attention || 0) - (a.insights?.attention || 0),
    name: (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
  };

  // The rows to show, in order. q: the search, lower case and trimmed; scope:
  // all, local, running or github; running(p): whether a server of its is live.
  // Archived repos only show when looked for; "needs you" shows only those that do.
  function visible(projects, { q, scope, sort, running }) {
    const inScope = p => (scope === 'local' ? p.local.length > 0 : scope === 'github' ? !p.local.length : scope === 'running' ? running(p) : true);
    const shown = projects.filter(p => {
      if (q && !`${p.name} ${p.github?.repo || ''}`.toLowerCase().includes(q)) return false;
      if (!inScope(p)) return false;
      if (sort === 'attention' && !q) return (p.insights?.attention || 0) > 0 || running(p);
      return scope !== 'all' || !p.github?.archived || q;
    });
    return shown.map((p, i) => [p, i]).sort(([a, i], [b, j]) => SORTS[sort](a, b) || i - j).map(([p]) => p);
  }

  // What the list says when it shows nothing. none: there are no projects at all.
  function emptyText({ none, scope, sort, q }) {
    if (none) return "No projects yet. Shellby lists the repos he's seen you work in. Scan the folder you keep them in and tick the ones you want, or add one.";
    if (scope === 'running') return 'Nothing running right now.';
    if (sort === 'attention' && !q) return 'Nothing needs you. Every project is pushed, passing and up to date as far as Shellby knows. 🐚';
    return 'Nothing matches.';
  }

  // ------------------------------------------------------------ a clone

  // "on main · 2 uncommitted changes · 1 unpushed · 1 stash", and whether any
  // of that work is only on this PC.
  function cloneFacts(c) {
    const git = c.git;
    const text = [
      c.branch && `on ${c.branch}`,
      git && (git.dirty ? plural(git.dirty, 'uncommitted change') : 'nothing uncommitted'),
      git?.unpushed && `${git.unpushed} unpushed`,
      git?.stashes && plural(git.stashes, 'stash', 'stashes'),
    ].filter(Boolean).join(' · ');
    return { text, atRisk: !!(git && (git.dirty || git.unpushed)) };
  }

  // The same ask as "Is it safe to leave?" → Tidy up, put in the box for you to read and send.
  const tidyPrompt = name => `In ${name}: commit any uncommitted work with clear messages, push every branch that has commits the remote doesn't, and tell me what's in any stashes. Never commit or push a .env file, a key file or anything that looks like a password or API key. Ask me before anything destructive.`;

  // The fold over Shellby's copies of a repo (worktrees.js).
  function copiesSummary(list) {
    const changed = list.filter(w => w.changed).length;
    return `${plural(list.length, 'copy', 'copies')} Shellby made${changed ? ` · ${changed} with changes` : ''}`;
  }

  // ------------------------------------------------------------ adding

  const repositories = n => plural(n, 'repository', 'repositories');

  // What a scan found. shortPath: SB.shortPath.
  function scanLede({ candidates, parent, truncated }, shortPath) {
    return candidates.length
      ? `Found ${repositories(candidates.length)} in ${shortPath(parent, 40)}${truncated ? ' (stopped looking after the first 200)' : ''}. Tick the ones to add; nothing is added until you do.`
      : `No git repositories in ${shortPath(parent, 40)}, two folders deep.`;
  }

  const addedLine = added => (added ? `Added ${repositories(added)}` : 'Nothing added.');

  const api = { isLive, statusText, devChoice, visible, emptyText, cloneFacts, tidyPrompt, copiesSummary, scanLede, addedLine };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ShellbyProjectsLogic = api;
})(typeof window !== 'undefined' ? window : globalThis);
