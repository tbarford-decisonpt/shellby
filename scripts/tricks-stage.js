// The backdrop for `npm run tricks` (scripts/record-tricks.js): a plain tidepool
// "desktop" over the primary screen's work area, so the clips show Shellby, a
// Notepad and nothing of yours. Run by electron.exe directly, not the app.
const { app, BrowserWindow, screen } = require('electron');

const PAGE = `<!doctype html><html><body style="margin:0;height:100vh;overflow:hidden;
background:
  radial-gradient(60vw 60vw at 82% 10%, rgba(127,214,194,.16), transparent 70%),
  radial-gradient(70vw 70vw at 10% 100%, rgba(255,122,92,.10), transparent 70%),
  linear-gradient(#0e2e38, #051216)"></body></html>`;

app.whenReady().then(() => {
  const wa = screen.getPrimaryDisplay().workArea;
  const win = new BrowserWindow({ ...wa, frame: false, resizable: false, skipTaskbar: true, show: false, backgroundColor: '#0a2229' });
  win.loadURL(`data:text/html,${encodeURIComponent(PAGE)}`);
  win.once('ready-to-show', () => win.show());
});
