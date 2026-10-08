// GitLab through the glab CLI: Settings → GitLab turns watching on, lists
// self-managed hosts, and checks what glab can see (wiring/gitlab.js). The
// sign-in stays glab's; nothing here ever handles a token.
// Kept out of main.js, which only wires it up.

/**
 * @param {Pick<import('electron').IpcMain, 'handle' | 'on'>} ipcMain  main's, behind ipc-guard.js
 * @param d  what main shares with its IPC (main.js ipcDeps)
 */
function registerGitlabIpc(ipcMain, d) {
  ipcMain.handle('gitlab:get', () => d.gitlabView());
  ipcMain.handle('gitlab:set', (_e, patch) => {
    const p = patch && typeof patch === 'object' ? patch : {};
    return d.setGitLab({
      ...(typeof p.ci === 'boolean' ? { ci: p.ci } : {}),
      ...(Array.isArray(p.hosts) ? { hosts: p.hosts.filter(h => typeof h === 'string').slice(0, 20).map(h => h.slice(0, 260)) } : {}),
    });
  });
  ipcMain.handle('gitlab:check', () => d.checkGitLab());
}

module.exports = { registerGitlabIpc };
