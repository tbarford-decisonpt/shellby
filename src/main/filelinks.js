// File links: opening a path Claude mentioned in the editor you already use,
// at the line. (Showing a turn's diff in VS Code is editor.js, which needs
// code.cmd for --diff; a link only needs to open one file.)
//
// VS Code and its forks register a URL scheme (vscode://file/C:/x.js:12:3),
// which is how this works without knowing where any of them are installed and
// without running a .cmd through a shell. With none of them around, a file
// opens in Windows' default app, except anything that would run rather than
// open: those are shown in Explorer instead.
//
// Everything here is pure (the "is it installed" check is passed in), so it is
// all unit-tested; main.js does the opening.
const path = require('path');

// In "auto", the first one installed wins, in this order.
const EDITORS = Object.freeze({
  vscode: { label: 'VS Code', scheme: 'vscode' },
  cursor: { label: 'Cursor', scheme: 'cursor' },
  windsurf: { label: 'Windsurf', scheme: 'windsurf' },
  insiders: { label: 'VS Code Insiders', scheme: 'vscode-insiders' },
});
const CHOICES = ['auto', ...Object.keys(EDITORS), 'system'];

// Opening these would run them (or mount, install or macro-load them), not show
// them. Scripting languages are here because their installers often make
// double-click mean "run".
const RUNS = new Set(['exe', 'com', 'bat', 'cmd', 'ps1', 'psm1', 'psd1', 'ps1xml', 'psc1', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh',
  'msi', 'msp', 'mst', 'scr', 'hta', 'lnk', 'url', 'website', 'pif', 'cpl', 'msc', 'jar', 'reg', 'appx', 'appxbundle', 'msix',
  'msixbundle', 'appref-ms', 'application', 'xbap', 'gadget', 'inf', 'scf', 'sct', 'chm', 'diagcab', 'settingcontent-ms',
  'library-ms', 'search-ms', 'iso', 'img', 'vhd', 'vhdx', 'cab', 'py', 'pyw', 'pyc', 'pyz', 'pyzw', 'rb', 'rbw', 'pl', 'sh',
  'bash', 'ahk', 'au3', 'xll', 'xlam', 'ppam', 'docm', 'dotm', 'xlsm', 'xltm', 'pptm', 'potm']);

/**
 * Which editor to use: an id from EDITORS, or null for "the default app".
 * isInstalled(scheme) -> boolean.
 */
function pickEditor(choice, isInstalled) {
  if (EDITORS[choice]) return isInstalled(EDITORS[choice].scheme) ? choice : null;
  if (choice === 'system') return null;
  return Object.keys(EDITORS).find(id => isInstalled(EDITORS[id].scheme)) || null;
}

/** vscode://file/C:/a%20b/x.js:12:3 for a file (or folder) and an optional line and column. */
function editorUrl(id, file, line = null, col = null) {
  const parts = path.resolve(file).split(/[\\/]+/).filter(Boolean)
    .map((seg, i) => (i === 0 && /^[A-Za-z]:$/.test(seg) ? seg.toUpperCase() : encodeURIComponent(seg)));
  let url = `${EDITORS[id].scheme}://file/${parts.join('/')}`;
  if (line) url += `:${line}${col ? `:${col}` : ''}`;
  return url;
}

/**
 * What someone clicked, as { file, line, col }: an absolute path, or one
 * relative to the conversation's folder, with an optional :line[:col] (or the
 * (12,3) form some tools print). Quotes, backticks and a leading @ go. null
 * for anything that isn't a plausible path.
 */
function parseTarget(raw, cwd) {
  if (typeof raw !== 'string') return null;
  let s = raw.trim().replace(/^[`'"@]+|[`'"]+$/g, '').trim();
  if (!s || s.length > 1000 || /[\u0000-\u001f<>|?*]/.test(s)) return null;
  let line = null, col = null;
  const m = s.match(/(?::(\d+))(?::(\d+))?$/) || s.match(/\((\d+)(?:,\s*(\d+))?\)$/);
  if (m && !/^[A-Za-z]:$/.test(s.slice(0, m.index))) {
    line = Number(m[1]) || null;
    col = m[2] ? Number(m[2]) || null : null;
    s = s.slice(0, m.index);
  }
  if (/^~[\\/]/.test(s)) s = path.join(process.env.USERPROFILE || '', s.slice(2));
  if (!path.isAbsolute(s)) {
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return null;
    s = path.join(cwd, s);
  }
  return { file: path.resolve(s), line, col };
}

/** Would opening this with its default app run it? */
function runsWhenOpened(file) {
  const ext = path.extname(file).slice(1).toLowerCase();
  return RUNS.has(ext);
}

module.exports = { EDITORS, CHOICES, pickEditor, editorUrl, parseTarget, runsWhenOpened };
