// End-to-end check of branching a conversation, against the dev app over CDP
// with the fake Claude CLI (test/fixtures/fake-claude.js):
//   - "Try again from here" on a message: a new tab, resumed up to just before
//     it as a fork, in its own copy with the files as they were then, the
//     message back in the box, and the original untouched
//   - the note Claude gets about where it is now, and the fence that keeps its
//     edits out of the original's folder
//   - "Branch from here" after a reply, and "Run it again" (sent straight away)
//   - comparing two tries, and keeping one (it comes home; the others go)
// No account, no network.
//   node scripts/e2e-branch.js
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 9371;
const wait = ms => new Promise(r => setTimeout(r, ms));

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-e2e-branch-')));
const repo = path.join(base, 'proj');
fs.mkdirSync(repo);
const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true }).trim();
git('init', '-q', '-b', 'main');
git('config', 'user.email', 't@example.com');
git('config', 'user.name', 'T');
git('config', 'core.autocrlf', 'false');
fs.writeFileSync(path.join(repo, 'a.txt'), 'start\n');
git('add', '-A');
git('commit', '-qm', 'init');

(async () => {
  let fails = 0;
  const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };
  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, `--remote-debugging-port=${PORT}`], {
    stdio: 'ignore',
    env: {
      ...process.env, SHELLBY_USER_DATA: path.join(base, 'userdata'), CLAUDE_CONFIG_DIR: path.join(base, 'claude'),
      SHELLBY_FAKE_CLAUDE: path.join(ROOT, 'test', 'fixtures', 'fake-claude.js'), SHELLBY_HOOK_PORT: '47993',
    },
  });
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
    const ev = expr => new Promise(r => { const i = ++id; p.set(i, m => r(m.result?.result?.value)); ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } })); });
    const until = async (expr, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await ev(expr)) return true; await wait(150); } return false; };
    const send = text => ev(`SB.send(${JSON.stringify(text)}).then(() => true)`);
    const idle = () => until('!SB.activeTab().busy', 15000);
    const lastReply = () => ev("[...SB.activeTab().el.querySelectorAll('.msg.assistant')].at(-1)?.textContent || ''");
    const active = () => ev('SB.state.activeTab');
    const menuClick = label => ev(`(b => { if (b) b.click(); return !!b; })([...SB.$('rewindMenu').querySelectorAll('.menu-item')].find(b => b.textContent.includes(${JSON.stringify(label)}) && !b.disabled))`);
    const entry = tabId => ev(`shellby.listSessions().then(l => l.find(s => s.id === ${JSON.stringify(tabId)}) || null)`);
    const read = file => { try { return fs.readFileSync(file, 'utf8').trim(); } catch { return null; } };
    // The confirm window: press one of its buttons.
    const answerDialog = async label => {
      let target = null;
      for (let i = 0; i < 40 && !target; i++) {
        target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(t => t.url.endsWith('dialog.html'));
        if (!target) await wait(250);
      }
      if (!target) return false;
      const dws = new WebSocket(target.webSocketDebuggerUrl);
      await new Promise(r => { dws.onopen = r; });
      let did = 0; const dp = new Map();
      dws.onmessage = e => { const m = JSON.parse(e.data); dp.get(m.id)?.(m); };
      const dev = expr => new Promise(r => { const i = ++did; dp.set(i, m => r(m.result?.result?.value)); dws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } })); });
      for (let i = 0; i < 40 && !(await dev("!!document.querySelector('#actions button')")); i++) await wait(150);
      const text = await dev("document.body.innerText");
      const ok = await dev(`(b => { if (b) b.click(); return !!b; })([...document.querySelectorAll('#actions button')].find(b => b.textContent === ${JSON.stringify(label)}))`);
      dws.close();
      return ok ? text : false;
    };

    await wait(3000);
    await ev("shellby.setSettings({ onboarded: true, worktrees: true }).then(r => { SB.state.settings = r.settings; SB.setView('chat'); })");
    await ev(`shellby.setFolder(${JSON.stringify(repo)}).then(r => SB.folderChanged(r))`);
    await wait(800);

    // ---- the original: a question, then work (it moves into its own copy), then more work
    await send('hello there');
    await idle();
    await send('edit a.txt first');           // held back, named, moved into a copy
    await until("!document.getElementById('branchChip').hidden", 15000);
    await idle();
    await send('edit a.txt first');           // now it happens, in the copy
    await idle();
    await send('edit a.txt second');
    await idle();
    const original = await active();
    const origCopy = (await entry(original))?.worktree?.path;
    check(!!origCopy && read(path.join(origCopy, 'a.txt')) === 'second', 'the original works in its own copy, now at "second"');
    check(read(path.join(repo, 'a.txt')) === 'start', 'your checkout is untouched');
    check(await ev("SB.activeTab().el.querySelectorAll('.msg.user .msg-branch').length") === 4, 'every message offers to try again from there');
    check(await until("SB.activeTab().el.querySelectorAll('.meta .meta-branch').length >= 3"), 'every finished reply offers to branch from there');

    // ---- 1. Try again from just before the last message
    await ev("[...SB.activeTab().el.querySelectorAll('.msg.user .msg-branch')].at(-1).click()");
    check(await until("!SB.$('rewindMenu').hidden && SB.$('rewindMenu').textContent.includes('Change it and try again')"), 'the ⑂ button offers to change it and try again, or run it again');
    await menuClick('Change it and try again');
    check(await until(`SB.state.activeTab !== ${JSON.stringify(original)} && SB.state.tabs.size === 2`, 15000), 'a new tab opens and comes to the front');
    const tryA = await active();
    const a = await entry(tryA);
    check(/^⑂ /.test(a?.title || ''), `it is marked as a branch (${a?.title})`);
    check(a?.branchOf?.id === original && a?.branchOf?.at === 'before', 'History knows where it came from');
    check(await ev("SB.$('input').value") === 'edit a.txt second', 'the message is back in the box, ready to change');
    check(!!a?.worktree?.path && a.worktree.path !== origCopy, `it has a copy of its own (${a?.worktree?.branch})`);
    check(read(path.join(a.worktree.path, 'a.txt')) === 'first', 'with the files exactly as they were before that message');
    check(read(path.join(origCopy, 'a.txt')) === 'second', "the original's files are as they were");
    check(a?.worktree?.base === 'main', 'it comes home to main, like the original would');
    check(await ev("!!SB.activeTab().el.querySelector('.branch-mark')?.textContent.includes('Branched from')"), 'the new tab says where it came from');
    check(await ev("SB.activeTab().el.querySelectorAll('.msg.user').length") === 3, 'and remembers the conversation up to there');
    check(await ev("!document.getElementById('branchChip').hidden"), 'it shows its branch chip');

    // Its first message: Claude hears where it is now, and resumes as a fork.
    await ev("SB.$('input').value = ''");
    await send('hello from the branch');
    await idle();
    const replies = await ev("[...SB.activeTab().el.querySelectorAll('.msg.assistant')].map(e => e.textContent).join('\\n')");
    check(replies.includes('noted: Shellby has branched this conversation') && replies.includes(a.worktree.path), 'Claude is told it is in a new copy, and where, ahead of the message');
    check((await lastReply()).startsWith('echo: hello from the branch ('), '...and gets the message exactly as typed');
    await send('args');
    await idle();
    const args = await lastReply();
    check(/--resume-session-at=uuid-/.test(args) && args.includes('--fork-session'), 'Claude Code resumed up to the branch point, as a fork');
    await send('more');
    await idle();
    check(await ev("![...SB.activeTab().el.querySelectorAll('.msg.assistant')].slice(-1)[0].textContent.includes('noted:')") && (await lastReply()).startsWith('echo: more ('), 'that note only goes once');

    // The fence: its edits can't reach the original's folder; its own copy is fine.
    await send(`editabs ${path.join(origCopy, 'a.txt')} hacked`);
    await idle();
    check((await lastReply()).startsWith('fenced:'), 'an edit to the original\'s folder is refused, with the reason');
    check(read(path.join(origCopy, 'a.txt')) === 'second', "the original's file was not touched");
    await send('edit a.txt branch-take');
    await idle();
    check(read(path.join(a.worktree.path, 'a.txt')) === 'branch-take', 'its own edits land in its own copy');
    check(read(path.join(origCopy, 'a.txt')) === 'second', '...and only there');

    // The original says where its branch went.
    await ev(`SB.activate(${JSON.stringify(original)})`);
    check(await until("!!SB.activeTab().el.querySelector('.branch-mark')?.textContent.includes('Tried again in')"), 'the original notes the branch, with a link to it');

    // ---- 2. Branch from after a reply (the third: files as that turn left them)
    await ev("[...SB.activeTab().el.querySelectorAll('.meta .meta-branch')].at(-2).click()");
    check(await until("!SB.$('rewindMenu').hidden && SB.$('rewindMenu').textContent.includes('Branch from here')"), 'a reply offers to branch from there');
    await menuClick('Branch from here');
    check(await until('SB.state.tabs.size === 3', 15000), 'another tab opens');
    const tryB = await active();
    const b = await entry(tryB);
    check(b?.branchOf?.at === 'after', 'branched after a reply');
    check(await ev("SB.$('input').value") === '', 'with nothing in the box');
    check(read(path.join(b.worktree.path, 'a.txt')) === 'first', 'with the files as that turn left them');

    // ---- 3. Run it again: the same message, sent straight away
    await ev(`SB.activate(${JSON.stringify(original)})`);
    await ev("[...SB.activeTab().el.querySelectorAll('.msg.user .msg-branch')].at(-1).click()");
    await until("!SB.$('rewindMenu').hidden");
    await menuClick('Run it again in a new tab');
    check(await until('SB.state.tabs.size === 4', 15000), 'a third try opens');
    const tryC = await active();
    await idle();
    const c = await entry(tryC);
    check((await lastReply()).includes('edited a.txt'), 'and the message ran again by itself');
    check(read(path.join(c.worktree.path, 'a.txt')) === 'second', 'in its own copy');
    check(await ev("SB.$('input').value") === '', 'nothing left in the box');

    // A whole family of tries.
    const family = await ev(`shellby.branchFamily(${JSON.stringify(tryA)})`);
    check(family?.length === 4 && family[0].id === original && family[0].depth === 0, 'the original and its three tries are one family');

    // ---- 4. Compare two tries, file by file
    await ev(`SB.activate(${JSON.stringify(tryA)})`);
    await ev("document.getElementById('branchChip').click()");
    check(await until("[...SB.$('branchMenu').querySelectorAll('.menu-item')].some(b => b.textContent.includes('Compare with'))"), 'the branch chip lists the other tries to compare with');
    check(await ev("[...SB.$('branchMenu').querySelectorAll('.menu-item')].some(b => b.textContent.includes('Keep this one'))"), '...and offers to keep this one');
    await ev(`[...SB.$('branchMenu').querySelectorAll('.menu-item')].find(b => b.textContent.includes('Compare with') && b.textContent.includes('the original')).click()`);
    check(await until("!!SB.activeTab().el.querySelector('details.compare')", 15000), 'the comparison lands in the feed');
    check(await ev("SB.activeTab().el.querySelector('details.compare .chg-title').textContent.includes('1 file')"), 'one file differs');
    await ev("SB.activeTab().el.querySelector('details.compare .chg-file').click()");
    check(await until("(SB.activeTab().el.querySelector('details.compare .chg-diff')?.textContent || '').includes('branch-take')", 8000), "its diff shows this try's text against the other's");
    const sneaky = await ev(`shellby.compareDiff(${JSON.stringify(tryA)}, ${JSON.stringify(original)}, '../../etc/passwd')`);
    check(!!sneaky?.error, 'a file that is not in the comparison is refused');
    const stranger = await ev(`shellby.compareBranches(${JSON.stringify(tryA)}, 'not-in-the-family')`);
    check(stranger?.ok === false, 'a conversation outside the family cannot be compared');

    // ---- 5. Keep this one: it comes home, the other tries' copies go
    await ev(`SB.activate(${JSON.stringify(tryA)})`);
    const keeping = ev(`shellby.keepBranch(${JSON.stringify(tryA)})`);
    const dialog = await answerDialog('Keep this one');
    check(!!dialog && dialog.includes(b.worktree.branch) && dialog.includes(c.worktree.branch), 'it asks first, listing every copy that would be thrown away');
    const kept = await keeping;
    check(kept?.ok && kept.discarded === 3, `this try came home and the 3 others were thrown away (${JSON.stringify(kept)})`);
    check(read(path.join(repo, 'a.txt')) === 'branch-take', 'the kept try is in your checkout');
    check(git('branch', '--list', 'shellby/*') === '', 'every copy\'s branch is tidied away');
    check(git('worktree', 'list').split('\n').length === 1, '...and every copy');
    check(await until('SB.state.tabs.size <= 1', 10000), 'their tabs closed');
    check(!!(await entry(original)) && !!(await entry(tryB)), 'the conversations are all still in History');
    const [ka, kb] = [await entry(tryA), await entry(tryB)];
    check(!ka.fence && !kb.fence && !ka.worktree && !kb.worktree, 'their fences went with their copies, so reopening one works normally');
  } catch (err) {
    console.error(err);
    fails++;
  } finally {
    app.kill();
    await wait(1500);
    try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* still in use */ }
  }
  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 1 : 0);
})();
