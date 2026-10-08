// End-to-end check of the Toolbox's skill list against the dev app over CDP:
// a row of sections with that section's kinds as chips below, All grouped by
// where things come from, a search box that says what it searches, long lists
// drawn a page at a time, the "where from" and order pickers, rows that open
// to show the rest, and editing one of your own skills in place (saved to
// disk, the list updated). A throwaway project with 200 skills stands in for
// a big plugin collection.
//   node scripts/e2e-toolbox.js [screenshot.png]   (also writes -all.png and -open.png beside it)
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
  // A home of its own with one skill of "yours": the list has two sources to group, and not this PC's.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-toolbox-home-'));
  fs.mkdirSync(path.join(home, '.claude', 'skills', 'e2e-mine'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'skills', 'e2e-mine', 'SKILL.md'), '---\nname: e2e-mine\ndescription: One of yours\n---\n\nBody.\n');
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ onboarded: true, cwd: project }));
  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, `--remote-debugging-port=${PORT}`], {
    stdio: 'ignore',
    env: { ...process.env, USERPROFILE: home, HOME: home, SHELLBY_USER_DATA: profile, SHELLBY_FAKE_CLAUDE: path.join(ROOT, 'test', 'fixtures', 'fake-claude.js') },
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

    const out = process.argv[2] || path.join(os.tmpdir(), 'shellby-toolbox.png');
    // Screenshots are for a person to look at, not something checked, so one that
    // doesn't come (a hidden or unpainted window on a CI runner) is noted and skipped.
    const shoot = async file => {
      await ev("document.querySelector('#toolboxView .view-head').scrollIntoView()");
      const shot = await Promise.race([call('Page.captureScreenshot', { format: 'png' }), wait(10000)]);
      if (shot?.data) { fs.writeFileSync(file, Buffer.from(shot.data, 'base64')); console.log(`screenshot: ${file}`); }
      else console.log(`(no screenshot for ${path.basename(file)}: Page.captureScreenshot got no answer in 10s)`);
    };
    const chips = () => ev("[...document.querySelectorAll('#toolTabs [role=tab]')].filter(b => !b.hidden).map(b => b.firstChild.textContent.trim()).join()");

    // 1. Sections in one row, that section's kinds below, none of them cut off.
    await ev("SB.showToolbox('tool')");
    check(await until(`SB.state.toolbox?.skills.filter(t => t.source === 'project').length === ${SKILLS}`), `the scan finds the project's ${SKILLS} skills`);
    check(await ev("[...document.querySelectorAll('#toolGroups [role=tab]')].map(b => b.firstChild.textContent.trim()).join()") === 'Tools,Setup,Lean,Team', 'the sections sit in one row');
    check(await chips() === 'All,Skills,Agents,Commands,MCP,Mods,Snippets', 'Tools shows its seven kinds');
    check(await ev("[...document.querySelectorAll('#toolGroups [role=tab], #toolTabs [role=tab]')].filter(b => !b.hidden).every(b => b.scrollWidth <= b.clientWidth + 1)"), 'no tab label is cut off');
    check(await ev("SB.$('toolSearch').placeholder") === 'Search skills, agents and commands…', 'All searches skills, agents and commands');

    // 2. All, A to Z: grouped by where they come from, and a group folds away.
    check(await until("[...document.querySelectorAll('#toolList .tool-group-btn')].some(b => b.textContent === `This project${200}`)"), 'All has a "This project" group of 200');
    const projectRows = "[...document.querySelectorAll('#toolList .tool-row code')].filter(c => c.textContent.startsWith('/e2e-skill-')).length";
    await shoot(out.replace(/\.png$/, '-all.png'));
    await ev("[...document.querySelectorAll('#toolList .tool-group-btn')].find(b => b.textContent.startsWith('This project')).click()");
    check(await until(`${projectRows} === 0`) && await ev("document.activeElement?.classList.contains('tool-group-btn') && document.activeElement.getAttribute('aria-expanded') === 'false'"), 'folding it hides its rows and keeps the keyboard on the heading');
    await ev("document.activeElement.click()");
    check(await until(`${projectRows} > 0`), 'and unfolding brings them back');

    // 3. Setup swaps the chips; the Tools section remembers its kind.
    await ev("document.querySelector('#toolGroups [data-group=\"setup\"]').click()");
    check(await chips() === 'Hooks,Rules,Memory', 'Setup shows Hooks, Rules and Memory');
    await ev("document.querySelector('#toolTabs [data-kind=\"skill\"]').click()");
    await ev("document.querySelector('#toolGroups [data-group=\"lean\"]').click()");
    check(await ev("SB.$('toolTabs').hidden"), 'Lean has no kinds row');
    await ev("document.querySelector('#toolGroups [data-group=\"tools\"]').click()");
    check(await ev("document.querySelector('#toolTabs [aria-selected=true]').dataset.kind") === 'skill', 'back in Tools, Skills is still picked');
    check(await ev("SB.$('toolSearch').placeholder") === 'Search skills…', 'the search box says it searches skills');
    await ev("SB.showToolbox('permissions')");
    check(await ev("document.querySelector('#toolTabs [aria-selected=true]').dataset.kind") === 'rule', '/permissions opens Rules');
    await ev("SB.showToolbox('skill')");

    // 4. Where from: just the project's, a page at a time.
    check(await ev("[...SB.$('toolSource').options].some(o => o.value === 'project' && o.textContent === 'This project (200)')"), 'the picker offers "This project (200)"');
    await pick('#toolSource', 'project');
    check(await until('document.querySelectorAll("#toolList .tool-row").length === 150'), 'the first 150 are drawn');
    check(/Showing 150 of 200/.test(await ev("document.querySelector('#toolList .tool-more')?.textContent || ''")), 'and it says how many there are');
    await ev("[...document.querySelectorAll('#toolList .tool-more button')].find(b => /more/.test(b.textContent)).click()");
    check(await rows() === SKILLS && !(await ev("!!document.querySelector('#toolList .tool-more')")), 'Show more draws the rest');
    check(await ev("document.activeElement?.closest('.tool-row') === document.querySelectorAll('#toolList .tool-row')[150]"), 'and the keyboard carries on at the first new row');

    // 5. Search narrows within the picked source (after its short wait).
    await ev("(i => { i.value = 'e2e-skill-19'; i.dispatchEvent(new Event('input')); })(SB.$('toolSearch'))");
    check(await until('document.querySelectorAll("#toolList .tool-row").length === 10'), 'searching narrows to the ten matches');
    await ev("(i => { i.value = ''; i.dispatchEvent(new Event('input')); })(SB.$('toolSearch'))");

    // 6. Ordering by use: either it's ordered, or it says why not yet.
    await pick('#toolSort', 'used');
    check(await until("document.querySelectorAll('#toolList .tool-row').length > 0"), 'Most used still lists them');

    await shoot(out);
    await pick('#toolSort', 'name');

    // 7. Closed, a row offers Use and the pin; open, it shows where it lives and the rest.
    const row0 = "[...document.querySelectorAll('#toolList .tool-item')].find(r => r.querySelector('code')?.textContent === '/e2e-skill-000')";
    check(await ev(`[...${row0}.querySelectorAll('.tool-actions button')].map(b => b.textContent || b.getAttribute('aria-label')).join()`) === 'Use,Pin e2e-skill-000', 'a closed row offers just Use and the pin');
    await ev(`${row0}.querySelector('.tool-toggle').click()`);
    check(await ev(`${row0}.querySelector('.tool-toggle').getAttribute('aria-expanded') === 'true' && document.activeElement === ${row0}.querySelector('.tool-toggle')`), 'clicking it opens it, keyboard still on it');
    check(await ev(`/This project's/.test(${row0}.querySelector('.tool-where')?.textContent || '')`), 'open, it says where it comes from');
    await shoot(out.replace(/\.png$/, '-open.png'));

    // 8. Editing one of your own: the pickers make way, Ctrl+S saves to disk.
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

    // 9. Another tab's search box says what it searches.
    await ev("document.querySelector('#toolTabs [data-kind=\"hook\"]').click()");
    check(await ev("SB.$('toolSearch').placeholder") === 'Search hooks…', 'on Hooks it searches hooks');

    // 10. Where-from is kept per tab: Agents has no project ones, and that doesn't undo Skills' choice.
    await ev("document.querySelector('#toolTabs [data-kind=\"agent\"]').click()");
    await ev("document.querySelector('#toolTabs [data-kind=\"skill\"]').click()");
    check(await ev("SB.$('toolSource').value") === 'project', 'Skills still shows just the project after a look at Agents');

    // 11. The file going away under the editor: it says so, and won't save.
    await ev("[...document.querySelectorAll('#toolList .tool-item')].find(r => r.querySelector('code')?.textContent === '/e2e-skill-001').querySelector('.tool-toggle').click()");
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
    for (const d of [profile, project, home]) try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
  }
  console.log(fails ? `${fails} failed` : 'all passed');
  process.exit(fails ? 1 : 0);
})();
