// Right-click menu for text: spelling suggestions for the word under the
// pointer, then the usual cut/copy/paste. Chromium underlines misspellings on
// its own but leaves showing the fixes to the app. The panel draws the menu
// itself (textmenu.js) so it looks like the rest of Shellby, not an OS popup;
// main keeps the actions and runs the one picked.

const MAX_SUGGESTIONS = 5;

// Words Shellby should never underline, starting with his own name. Custom
// words get none of the dictionary's suffix rules, so the possessive is listed too.
const KNOWN_WORDS = ['Shellby', "Shellby's"];

// The dictionary belongs to the session and persists, so re-adding is harmless.
function teachKnownWords(session) {
  for (const word of KNOWN_WORDS) session.addWordToSpellCheckerDictionary(word);
}

// Pure: turns Electron's context-menu params into the menu's items. `wc` is the
// webContents the click came from.
function contextTemplate(params, wc) {
  const items = [];
  const word = params.misspelledWord;
  if (word) {
    const fixes = (params.dictionarySuggestions || []).slice(0, MAX_SUGGESTIONS);
    for (const fix of fixes) items.push({ label: fix, fix: true, click: () => wc.replaceMisspelling(fix) });
    if (!fixes.length) items.push({ label: 'No suggestions', enabled: false });
    items.push(
      { label: `Add "${word}" to dictionary`, click: () => wc.session.addWordToSpellCheckerDictionary(word) },
      { type: 'separator' },
    );
  }
  const f = params.editFlags || {};
  if (params.isEditable) {
    items.push(
      { label: 'Cut', role: 'cut', keys: 'Ctrl+X', enabled: !!f.canCut },
      { label: 'Copy', role: 'copy', keys: 'Ctrl+C', enabled: !!f.canCopy },
      { label: 'Paste', role: 'paste', keys: 'Ctrl+V', enabled: !!f.canPaste },
      { type: 'separator' },
      { label: 'Select all', role: 'selectAll', keys: 'Ctrl+A', enabled: !!f.canSelectAll },
    );
  } else if (params.selectionText && params.selectionText.trim()) {
    items.push({ label: 'Copy', role: 'copy', keys: 'Ctrl+C', enabled: !!f.canCopy });
  }
  while (items.length && items[items.length - 1].type === 'separator') items.pop();
  return items;
}

// What the panel gets: labels and states only, no functions.
const toWire = items => items.map(i => (i.type === 'separator' ? { separator: true }
  : { label: i.label, enabled: i.enabled !== false, fix: !!i.fix, keys: i.keys || '' }));

// Runs a picked item: a spelling item has its own click, the edit items name a
// webContents method (cut, copy, paste, selectAll).
function runItem(item, wc) {
  if (!item || item.type === 'separator' || item.enabled === false) return;
  if (item.click) item.click();
  else if (item.role && typeof wc[item.role] === 'function') wc[item.role]();
}

function attachContextMenu(win, ipcMain) {
  const wc = win.webContents;
  teachKnownWords(wc.session);
  let open = []; // the menu on screen, so a pick by index runs the right item
  wc.on('context-menu', (_e, params) => {
    open = contextTemplate(params, wc);
    if (open.length) win.webContents.send('text-menu', { x: params.x, y: params.y, source: params.menuSourceType, items: toWire(open) });
  });
  ipcMain.on('text-menu:pick', (e, index) => {
    if (e.sender !== wc) return;
    const item = Number.isInteger(index) ? open[index] : null;
    open = [];
    runItem(item, wc);
  });
}

module.exports = { contextTemplate, attachContextMenu, teachKnownWords, runItem, toWire, KNOWN_WORDS, MAX_SUGGESTIONS };
