// Right-click menu for text: spelling suggestions for the word under the
// pointer, then the usual cut/copy/paste. Chromium underlines misspellings on
// its own but leaves showing the fixes to the app.

const MAX_SUGGESTIONS = 5;

// Pure: turns Electron's context-menu params into a Menu template. `wc` is the
// webContents the click came from.
function contextTemplate(params, wc) {
  const items = [];
  const word = params.misspelledWord;
  if (word) {
    const fixes = (params.dictionarySuggestions || []).slice(0, MAX_SUGGESTIONS);
    for (const fix of fixes) items.push({ label: fix, click: () => wc.replaceMisspelling(fix) });
    if (!fixes.length) items.push({ label: 'No suggestions', enabled: false });
    items.push(
      { label: `Add "${word}" to dictionary`, click: () => wc.session.addWordToSpellCheckerDictionary(word) },
      { type: 'separator' },
    );
  }
  const f = params.editFlags || {};
  if (params.isEditable) {
    items.push(
      { label: 'Cut', role: 'cut', enabled: !!f.canCut },
      { label: 'Copy', role: 'copy', enabled: !!f.canCopy },
      { label: 'Paste', role: 'paste', enabled: !!f.canPaste },
      { type: 'separator' },
      { label: 'Select all', role: 'selectAll', enabled: !!f.canSelectAll },
    );
  } else if (params.selectionText && params.selectionText.trim()) {
    items.push({ label: 'Copy', role: 'copy', enabled: !!f.canCopy });
  }
  while (items.length && items[items.length - 1].type === 'separator') items.pop();
  return items;
}

function attachContextMenu(win, Menu) {
  win.webContents.on('context-menu', (_e, params) => {
    const template = contextTemplate(params, win.webContents);
    if (template.length) Menu.buildFromTemplate(template).popup({ window: win });
  });
}

module.exports = { contextTemplate, attachContextMenu, MAX_SUGGESTIONS };
