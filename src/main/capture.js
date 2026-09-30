// `npm run screenshots` — renders scripted demo states and saves PNGs to docs/.
// Uses fake account details so no personal info ends up in the README.
const fs = require('fs');
const path = require('path');

const DEMO_ITEMS = [
  { kind: 'user', text: 'Tidy my Downloads folder into subfolders by file type', attachments: [] },
  { kind: 'text', text: "On it. I'll take a look at what's in there first." },
  { kind: 'tool', id: 't1', name: 'PowerShell', label: 'Ran', detail: 'Get-ChildItem ~/Downloads -File | Group-Object Extension | Sort Count -Desc' },
  { kind: 'tool_result', id: 't1', isError: false, text: 'Count Name\n----- ----\n   41 .pdf\n   23 .png\n   17 .zip\n   12 .exe\n    9 .docx' },
  { kind: 'text', text: 'You have **102 files**. Here\'s how I\'ll sort them:\n\n- `Documents/` for PDFs and Word files\n- `Images/` for PNGs and JPGs\n- `Archives/` for zips\n- `Installers/` for .exe and .msi files' },
  { kind: 'tool', id: 't2', name: 'PowerShell', label: 'Ran', detail: "New-Item -ItemType Directory Documents, Images, Archives, Installers; Move-Item *.pdf,*.docx Documents" },
  { kind: 'permission', requestId: 'demo-1', toolName: 'PowerShell', label: 'Ran', input: {},
    detail: "New-Item -ItemType Directory Documents, Images, Archives, Installers\nMove-Item *.pdf, *.docx -Destination Documents",
    description: 'Create 4 folders and move 50 documents into Documents/',
    suggestions: [{ type: 'addRules', rules: [{ toolName: 'PowerShell', ruleContent: 'Move-Item:*' }], behavior: 'allow', destination: 'session' }] },
];

const DEMO_USAGE = { kind: 'usage', fiveHour: { pct: 23, resetsAt: Date.now() + 2.5 * 3600e3 }, sevenDay: { pct: 61, resetsAt: Date.now() + 3 * 86400e3 } };

const wait = ms => new Promise(r => setTimeout(r, ms));

async function shot(win, file) {
  const img = await win.webContents.capturePage();
  fs.writeFileSync(file, img.toPNG());
  console.log('wrote', path.relative(process.cwd(), file));
}

async function run({ app, critter, panel, showPanel, send, ROOT }) {
  const out = path.join(ROOT, 'docs');
  fs.mkdirSync(out, { recursive: true });
  try {
    await wait(2500);
    showPanel({ focusInput: false });
    send(panel, 'demo', { items: DEMO_ITEMS, usage: DEMO_USAGE });
    await wait(1500);
    await shot(panel, path.join(out, 'screenshot-approval.png'));

    send(panel, 'demo', { items: [], usage: DEMO_USAGE });
    await wait(900);
    await shot(panel, path.join(out, 'screenshot-empty.png'));

    send(panel, 'demo', { items: [], usage: DEMO_USAGE, view: 'settings' });
    await wait(900);
    await shot(panel, path.join(out, 'screenshot-settings.png'));

    for (const s of ['idle', 'working', 'asking', 'success', 'sleeping']) {
      send(critter, 'critter:state', s);
      await wait(s === 'sleeping' ? 1500 : 700);
      await shot(critter, path.join(out, `critter-${s}.png`));
    }
  } catch (e) {
    console.error('capture failed:', e);
  }
  app.exit(0);
}

const FAKE_STATUS = {
  installed: true, exe: 'claude.exe', version: '2.1.286', loggedIn: true,
  authMethod: 'claude.ai', subscriptionType: 'max', email: 'you@example.com',
};

module.exports = { run, FAKE_STATUS, DEMO_ITEMS };
