// Next up on a project's page (wiring/backlog.js).
//
// The panel only names things: a project by a root the Projects page listed or
// a repository it listed, an item by the id the last list gave it, a task line
// by the number it was shown at. Main looks each one up before using it.
// No . or .. as an owner or name (as github/prwork.js): GitHub has neither, and they'd walk an API path.
const ID_RE = /^(?:t:[0-9a-f]{10}(?:~\d{1,3})?|tk:[A-Z][A-Z0-9_]{0,9}-\d{1,7}|gh:(?!\.{1,2}\/)[A-Za-z0-9_.-]{1,100}\/(?!\.{1,2}#)[A-Za-z0-9_.-]{1,100}#\d{1,9}|todo:[^\0\r\n]{1,1100}:\d{1,7}|se:\d{1,20})$/;
const REPO_RE = /^(?!\.{1,2}\/)[A-Za-z0-9_.-]{1,100}\/(?!\.{1,2}$)[A-Za-z0-9_.-]{1,100}$/;
const WORKFLOW_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const TO = new Set(['now', 'next', 'later']);
const SENTRY_OPS = new Set(['connect', 'link', 'unlink', 'snooze', 'disconnect']);
const SLUG_RE = /^[a-z0-9][a-z0-9_.-]{0,99}$/i;

const isRoot = r => typeof r === 'string' && r.length > 0 && r.length < 1000;
const isId = id => typeof id === 'string' && ID_RE.test(id);
const isLine = n => Number.isInteger(n) && n > 0 && n < 1e7;
const title = t => (typeof t === 'string' ? t.slice(0, 1000) : '');
const isStr = s => typeof s === 'string' && s.length > 0 && s.length < 200;

/** { root } or { repo }, whichever the panel named. */
function project(raw) {
  if (isRoot(raw?.root)) return { root: raw.root };
  if (typeof raw?.repo === 'string' && REPO_RE.test(raw.repo)) return { repo: raw.repo };
  return null;
}

/**
 * @param {Pick<import('electron').IpcMain, 'handle' | 'on'>} ipcMain  main's, behind ipc-guard.js
 * @param d  what main shares with its IPC (main.js ipcDeps)
 */
function registerBacklogIpc(ipcMain, d) {
  const no = { ok: false, error: 'That isn\'t something on Next up.' };
  const withItem = (raw, fn) => {
    const p = project(raw);
    return p && isId(raw?.id) ? fn({ ...p, id: raw.id }) : no;
  };

  ipcMain.handle('backlog:view', (_e, raw = {}) => {
    const p = project(raw);
    return p ? d.backlogView({ ...p, fresh: raw.fresh === true }) : no;
  });
  ipcMain.handle('backlog:edit', (_e, raw = {}) => {
    if (!isRoot(raw.root) || typeof raw.op !== 'string') return no;
    const to = TO.has(raw.to) ? raw.to : undefined;
    if (raw.op === 'add') return d.backlogEdit({ root: raw.root, op: 'add', title: title(raw.title), to });
    if (!isId(raw.id) || !String(raw.id).startsWith('t:') || !isLine(raw.line)) return no;
    return d.backlogEdit({ root: raw.root, op: raw.op, id: raw.id, line: raw.line, title: title(raw.title), to });
  });
  ipcMain.handle('backlog:add-issue', (_e, raw = {}) => (isRoot(raw.root) && isId(raw.id) ? d.backlogAddIssue({ root: raw.root, id: raw.id }) : no));
  ipcMain.handle('backlog:do', (_e, raw = {}) => withItem(raw, d.backlogDo));
  ipcMain.handle('backlog:open-doing', (_e, raw = {}) => withItem(raw, d.backlogOpenDoing));
  ipcMain.handle('backlog:open-todo', (_e, raw = {}) => (isRoot(raw.root) && isId(raw.id) ? d.backlogOpenTodo({ root: raw.root, id: raw.id }) : no));
  ipcMain.handle('backlog:open-issue', (_e, raw = {}) => withItem(raw, d.backlogOpenIssue));
  ipcMain.handle('backlog:hide', (_e, raw = {}) => {
    const p = project(raw);
    if (!p) return no;
    if (raw.show === true) return d.backlogHide({ ...p, show: true });
    return isId(raw.id) ? d.backlogHide({ ...p, id: raw.id }) : no;
  });
  // Sentry: the token only ever goes this way (panel to main), and never back.
  ipcMain.handle('backlog:sentry', (_e, raw = {}) => {
    if (!SENTRY_OPS.has(raw.op)) return no;
    if (raw.op === 'disconnect') return d.backlogSentry({ op: 'disconnect' });
    if (raw.op === 'connect') {
      return typeof raw.token === 'string' && raw.token.length < 600 && (raw.url === undefined || (typeof raw.url === 'string' && raw.url.length < 300))
        ? d.backlogSentry({ op: 'connect', token: raw.token.trim(), url: raw.url || '' }) : no;
    }
    if (!isRoot(raw.root)) return no;
    if (raw.op !== 'link') return d.backlogSentry({ root: raw.root, op: raw.op });
    if (raw.slug === null) return d.backlogSentry({ root: raw.root, op: 'link', slug: null });
    const isSlug = s => typeof s === 'string' && SLUG_RE.test(s);
    return isSlug(raw.org) && isSlug(raw.slug) ? d.backlogSentry({ root: raw.root, op: 'link', org: raw.org, slug: raw.slug }) : no;
  });
  ipcMain.handle('backlog:commit', (_e, raw = {}) => (isRoot(raw.root) ? d.backlogCommit({ root: raw.root }) : no));
  ipcMain.handle('backlog:hand', (_e, raw = {}) => (typeof raw.workflowId === 'string' && WORKFLOW_ID_RE.test(raw.workflowId)
    ? withItem(raw, x => d.backlogHand({ ...x, workflowId: raw.workflowId })) : no));
  // A conversation's copy menu: is it from Next up, and can it open a pull request?
  ipcMain.handle('backlog:tab', (_e, tabId) => (isStr(tabId) ? d.backlogTabInfo(tabId) : { linked: false }));
  ipcMain.handle('backlog:open-pr', (_e, tabId) => (isStr(tabId) ? d.backlogOpenPr(tabId) : no));
  ipcMain.handle('backlog:tick-linked', (_e, tabId) => (isStr(tabId) ? d.backlogTick(tabId) : no));
  // Linear or Jira on a project's list, through one of your MCP servers. Main checks the server is yours.
  ipcMain.handle('backlog:tracker-choices', (_e, raw = {}) => {
    const p = project(raw);
    return p ? d.backlogTrackerChoices(p) : no;
  });
  ipcMain.handle('backlog:tracker-set', (_e, raw = {}) => {
    const p = project(raw);
    if (!p) return no;
    if (raw.off === true) return d.backlogTrackerSet({ ...p, off: true });
    if (![raw.server, raw.kind, raw.scope].every(v => typeof v === 'string' && v.length <= 400)) return no;
    return d.backlogTrackerSet({ ...p, server: raw.server, kind: raw.kind, scope: raw.scope });
  });
}

module.exports = { registerBacklogIpc, ID_RE };
