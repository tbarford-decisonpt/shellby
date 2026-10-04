// End-to-end check of the Toolbox's skill list against the dev app over CDP:
// the kinds in three labelled rows, a search box that says what it searches,
// long lists drawn a page at a time, the "where from" and order pickers, and
// editing one of your own skills in place (saved to disk, the list updated).
// A throwaway project with 200 skills stands in for a big plugin collection.
//   node scripts/e2e-toolbox.js [screenshot.png]
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 9357;
const SKILLS = 200;
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-test-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-toolbox-project-'));
  for (let i = 0; i < SKILLS; i++) {
    const name = `e2e-skill-${String(i).padStart(3, '0')}`;
    fs.mkdirSync(path.join(project, '.claude', 'skills', name), { recursive: true });
    fs.writeFileSync(path.join(project, '.claude', 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: Number ${i}\n---\n\nBody.\n`);
  }
  const first = path.join(project, '.claude', 'skills', 'e2e-skill-000', 'SKILL.md');
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ onboarded: true, cwd: project }));
  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, `--remote-debugging-port=${PORT}`], {
    stdio: 'ignore',
    env: { ...process.env, SHELLBY_USER_DATA: profile, SHELLBY_FAKE_CLAUDE: path.join(ROOT, 'test', 'fixtures', 'fake-claude.js') },
  });
  let fails = 0;
  const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };
  try {
    let list = [];
    for (let i = 0; i < 40 && !list.some(t => t.url.endsWith('panel.html')); i++) {
      try { list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { /* starting */ }
      await wait(500);
    }
    const ws = new WebSocket(list.find(t => t.url.endsWith('panel.html')).webSocketDebuggerUrl);
    await new Promise(r => { ws.onopen = r; });
    let id = 0; const p = new Map();
    ws.onmessage = e => { const m = JSON.parse(e.data); p.get(m.id)?.(m); };
    const call = (method, params = {}) => new Promise(r => { const i = ++id; p.set(i, m => r(m.result)); ws.send(JSON.stringify({ id: i, method, params })); });
    const ev = async expr => (await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }))?.result?.value;
    const until = async (expr, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await ev(expr)) return true; await wait(150); } return false; };
    const pick = (sel, value) => ev(`(s => { s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event('change')); })(document.querySelector('${sel}'))`);
    const rows = () => ev("document.querySelectorAll('#toolList .tool-row').length");
    await wait(3000);

    // 1. Three labelled rows of kinds, none of them cut off.
    await ev("SB.showToolbox('skill')");
    check(await until(`SB.state.toolbox?.skills.filter(t => t.source === 'project').length === ${SKILLS}`), `the scan finds the project's ${SKILLS} skills`);
    check(await ev("[...document.querySelectorAll('#toolTabs .seg-label')].map(s => s.textContent).join()") === 'Tools,More,Setup', 'the kinds sit in three labelled rows');
    check(await ev("[...document.querySelectorAll('#toolTabs [role=tab]')].every(b => b.scrollWidth <= b.clientWidth + 1)"), 'no tab label is cut off');
    check(await ev("SB.$('toolSearch').placeholder") === 'Search skills…', 'the search box says it searches skills');

    // 2. Where from: just the project's, a page at a time.
    check(await ev("[...SB.$('toolSource').options].some(o => o.value === 'project' && o.textContent === 'This project (200)')"), 'the picker offers "This project (200)"');
    await pick('#toolSource', 'project');
    check(await until('document.querySelectorAll("#toolList .tool-row").length === 150'), 'the first 150 are drawn');
    check(/Showing 150 of 200/.test(await ev("document.querySelector('#toolList .tool-more')?.textContent || ''")), 'and it says how many there are');
    await ev("[...document.querySelectorAll('#toolList .tool-more button')].find(b => /more/.test(b.textContent)).click()");
    check(await rows() === SKILLS && !(await ev("!!document.querySelector('#toolList .tool-more')")), 'Show more draws the rest');
    check(await ev("document.activeElement?.closest('.tool-row') === document.querySelectorAll('#toolList .tool-row')[150]"), 'and the keyboard carries on at the first new row');

    // 3. Search narrows within the picked source (after its short wait).
    await ev("(i => { i.value = 'e2e-skill-19'; i.dispatchEvent(new Event('input')); })(SB.$('toolSearch'))");
    check(await until('document.querySelectorAll("#toolList .tool-row").length === 10'), 'searching narrows to the ten matches');
    await ev("(i => { i.value = ''; i.dispatchEvent(new Event('input')); })(SB.$('toolSearch'))");

    // 4. Ordering by use: either it's ordered, or it says why not yet.
    await pick('#toolSort', 'used');
    check(await until("document.querySelectorAll('#toolList .tool-row').length > 0"), 'Most used still lists them');

    const out = process.argv[2] || path.join(os.tmpdir(), 'shellby-toolbox.png');
    await ev("document.querySelector('#toolboxView .view-head').scrollIntoView()");
    const shot = await call('Page.captureScreenshot', { format: 'png' });
    if (shot?.data) { fs.writeFileSync(out, Buffer.from(shot.data, 'base64')); console.log(`screenshot: ${out}`); }
    await pick('#toolSort', 'name');

    // 5. Editing one of your own: the pickers make way, Ctrl+S saves to disk.
    check(await ev("!!document.querySelector('#toolList .tool-row [aria-label=\"Edit e2e-skill-000\"]')"), 'your own skills have an Edit button');
    await ev("document.querySelector('#toolList [aria-label=\"Edit e2e-skill-000\"]').click()");
    check(await until("!!document.querySelector('#setupPane .mem-text') && SB.$('toolList').hidden"), 'Edit opens the file in place of the list');
    check(await ev("SB.$('toolSource').hidden && SB.$('toolSort').hidden"), 'the pickers are put away while editing');
    await ev(`(a => {
      a.value = a.value.replace('description: Number 0', 'description: Edited in Shellby');
      a.dispatchEvent(new Event('input'));
      a.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }));
    })(document.querySelector('#setupPane .mem-text'))`);
    check(await until(`SB.state.toolbox.skills.some(t => t.name === 'e2e-skill-000' && t.description === 'Edited in Shellby')`), 'Ctrl+S saves, and the Toolbox has the new description');
    check(fs.readFileSync(first, 'utf8').includes('description: Edited in Shellby'), 'the file on disk changed');
    await ev("document.querySelector('#setupPane .back-btn').click()");
    check(await until("!SB.$('toolList').hidden && [...document.querySelectorAll('#toolList .tool-desc')].some(d => d.textContent === 'Edited in Shellby')"), 'Back shows the list, with the new description');

    // 6. Another tab's search box says what it searches.
    await ev("document.querySelector('#toolTabs [data-kind=\"hook\"]').click()");
    check(await ev("SB.$('toolSearch').placeholder") === 'Search hooks…', 'on Hooks it searches hooks');

    // 7. Where-from is kept per tab: Agents has no project ones, and that doesn't undo Skills' choice.
    await ev("document.querySelector('#toolTabs [data-kind=\"agent\"]').click()");
    await ev("document.querySelector('#toolTabs [data-kind=\"skill\"]').click()");
    check(await ev("SB.$('toolSource').value") === 'project', 'Skills still shows just the project after a look at Agents');

    // 8. The file going away under the editor: it says so, and won't save.
    await ev("document.querySelector('#toolList [aria-label=\"Edit e2e-skill-001\"]').click()");
    await until("!!document.querySelector('#setupPane .mem-text')");
    fs.rmSync(path.join(project, '.claude', 'skills', 'e2e-skill-001'), { recursive: true });
    await ev("SB.$('rescanBtn').click()");
    check(await until("/moved or removed/.test(document.querySelector('#setupPane .setup-status')?.textContent || '')"), 'the editor says its file has gone');
    await ev(`(a => { a.value += 'more'; a.dispatchEvent(new Event('input')); })(document.querySelector('#setupPane .mem-text'))`);
    check(await ev("[...document.querySelectorAll('#setupPane button')].find(b => b.textContent === 'Save').disabled"), 'and Save stays off');
  } catch (err) {
    console.log(`FAIL  ${err.message}`);
    fails++;
  } finally {
    app.kill();
    await wait(1000);
    for (const d of [profile, project]) try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
  }
  console.log(fails ? `${fails} failed` : 'all passed');
  process.exit(fails ? 1 : 0);
})();
