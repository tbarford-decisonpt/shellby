// One rule for every web page Shellby ever makes, not just the windows built
// through secureWindow(): no pop-ups, no navigating away, no redirects, no
// <webview>. Shellby's pages are loaded by the main process (loadFile/loadURL,
// which don't fire these events), so a page asking to go somewhere else is
// never something Shellby meant. Links meant for the browser go through
// shell.openExternal after their own checks (ipc/surroundings.js).
const BLOCKED = ['will-navigate', 'will-redirect', 'will-attach-webview'];

function guardWebContents(contents) {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  for (const event of BLOCKED) contents.on(event, e => e.preventDefault());
}

function guardAllWebContents(app) {
  app.on('web-contents-created', (_e, contents) => guardWebContents(contents));
}

module.exports = { guardAllWebContents, guardWebContents, BLOCKED };
