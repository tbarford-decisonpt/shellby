// End-to-end check of Visiting crabs against the dev app over CDP, with a mock
// GitHub (test/fixtures/mock-github.js) and an isolated profile: turning it on
// (through the confirm window) publishes a public calling card, a friend is
// added by username, their crab visits the desktop and signs the guestbook,
// waves go both ways, and turning it off deletes the card.
//   node scripts/e2e-friends.js [settings.png] [desktop.png] [together.png]
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { savePng } = require('./lib/shot');
const { startMockGitHub } = require('../test/fixtures/mock-github');
const { formatWave } = require('../src/main/github/mail');
const { TEMPERAMENTS } = require('../src/main/banter');

const ROOT = path.join(__dirname, '..');
const PORT = 9361;
const wait = ms => new Promise(r => setTimeout(r, ms));

async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise(r => { ws.onopen = r; });
  let id = 0; const p = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); p.get(m.id)?.(m); };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; p.set(i, m => r(m.result)); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }))?.result?.value;
  return { send, ev, close: () => ws.close() };
}

(async () => {
  let fails = 0;
  const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };
  const mock = await startMockGitHub({ autoApprove: true });
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-test-'));
  // A friend who already has Visiting crabs on, in a crown and the Teacup shell.
  // Two stickers on their shell, and one they share by name for swaps (stickers.js forCard).
  const patch = c => ({ palette: { a: c, b: '#fffaf0' }, pixels: ['bab', 'aaa', 'bab'] });
  const stickers = {
    shell: [{ slot: 0, nudge: [0, 0], tier: 'holo', ...patch('#ff006e') }, { slot: 1, nudge: [0, 0], tier: 'paper', ...patch('#3a86ff') }],
    trade: [{ name: 'coral-reef', tier: 'vinyl', palette: { a: '#ff7a5c', b: '#fffaf0' }, pixels: ['bbbb', 'baab', 'baab', 'bbbb'] }],
  };
  const friendCard = JSON.stringify({ format: 1, login: 'reefbuddy', name: 'Reef Buddy', skin: 'classic', home: 'teacup', level: 12, outfit: { hat: 'crown', held: 'coffee-mug' }, stickers, updatedAt: Date.now() });
  const friendGist = mock.othersGist('reefbuddy', { 'shellby-card.json': friendCard });

  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(GH_TOKEN|GITHUB_TOKEN|GITHUB_PERSONAL_ACCESS_TOKEN|GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+))$/.test(k)));
  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT, `--remote-debugging-port=${PORT}`], {
    stdio: 'ignore',
    env: {
      ...env, SHELLBY_USER_DATA: data, SHELLBY_FAKE_CLAUDE: path.join(ROOT, 'test', 'fixtures', 'fake-claude.js'),
      SHELLBY_GITHUB_WEB: mock.base, SHELLBY_GITHUB_API: mock.base, SHELLBY_GITHUB_CLIENT_ID: 'e2e-client',
    },
  });
  const until = async (ev, expr, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await ev(expr)) return true; await wait(200); } return false; };
  const waitFor = (fn, ms = 8000) => until(async () => fn(), null, ms); // a check on the mock, not the page
  const targets = async () => (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json());
  async function answer(button, titleRe) {
    let d = null;
    for (let i = 0; i < 40 && !d; i++) { d = (await targets()).find(t => t.url.includes('dialog.html')); if (!d) await wait(200); }
    if (!d) return check(false, `confirm window for ${titleRe}`);
    const dlg = await connect(d.webSocketDebuggerUrl);
    await wait(500);
    const title = await dlg.ev("document.querySelector('h1, h2, .title')?.textContent || ''");
    check(titleRe.test(title), `asks first: "${title}"`);
    await dlg.ev(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(button)}).click()`);
    dlg.close();
  }
  const shot = async (target, file) => { if (file) await savePng((m, p) => target.send(m, p), file); };
  const myCard = () => [...mock.state.gists.values()].find(g => g.owner?.login === 'crabfan' && g.files['shellby-card.json']);
  try {
    let list = [];
    for (let i = 0; i < 40 && !list.some(t => t.url.endsWith('panel.html')); i++) {
      try { list = await targets(); } catch { /* starting */ }
      await wait(500);
    }
    const panel = await connect(list.find(t => t.url.endsWith('panel.html')).webSocketDebuggerUrl);
    const critter = await connect(list.find(t => t.url.endsWith('critter.html')).webSocketDebuggerUrl);
    const ev = panel.ev;
    await wait(3000);
    await ev("shellby.setSettings({ onboarded: true }).then(r => { SB.state.settings = r.settings; })");

    // 1. Signed out: visits wait for a sign-in, and a first sign-in never turns them on.
    await ev("SB.setView('settings')");
    await wait(700);
    check(await ev("document.getElementById('ghFriends').disabled"), 'Visiting crabs needs a sign-in first');
    await ev("document.getElementById('ghSignIn').click()");
    check(await until(ev, "document.getElementById('ghLogin').textContent === '@crabfan'"), 'signed in as @crabfan');
    check(await ev("document.getElementById('ghFriendsRow').hidden && !document.getElementById('ghFriends').checked"), 'visits stay off after sign-in');
    check(!myCard(), 'no calling card yet');

    // 2. Turning it on asks first, then publishes a public card.
    ev("document.getElementById('ghFriends').click()");
    await answer('Turn on', /friends' crabs visit/);
    check(await until(ev, "!document.getElementById('ghFriendsRow').hidden"), 'the friends section opens');
    check(await waitFor(() => !!myCard()), 'calling card published');
    const card = myCard();
    check(card?.public === true, 'the card is a public gist');
    const body = JSON.parse(card.files['shellby-card.json'].content);
    check(body.login === 'crabfan' && 'outfit' in body && !('stats' in body) && !('xp' in body), 'the card holds the look and nothing else');
    check(body.stickers === null, 'nothing about his stickers goes on it until you choose');
    check(TEMPERAMENTS.includes(body.temperament), `his temperament is on it, for the crabs to chat about (${body.temperament})`);
    await ev("shellby.setStickerOptions({ card: 'names' })"); // so a visit can swap

    // 3. Add a friend by username: their crab shows in the list.
    await ev("document.getElementById('frAddInput').value = '@reefbuddy'; document.getElementById('frAddForm').requestSubmit()");
    check(await until(ev, "[...document.querySelectorAll('#frList .fr-friend')].some(li => li.textContent.includes('@reefbuddy') && li.querySelector('svg.fr-crab'))"), 'friend listed with their crab');
    check(await ev("/Level 12/.test(document.getElementById('frList').textContent)"), 'shows their level');

    // 4. Invite them over: the crab appears next to Shellby, and the guestbook is signed.
    await ev("[...document.querySelectorAll('#frList button')].find(b => b.textContent === 'Invite over').click()");
    check(await until(critter.ev, "!!document.querySelector('#crew .visitor svg') && document.querySelector('#crew .visitor .tag').textContent === '@reefbuddy'"), 'the visitor stands on the desktop');
    check(await critter.ev("document.querySelectorAll('#crew .visitor .acc').length >= 2"), 'wearing their own outfit');
    check(await critter.ev("document.querySelectorAll('#crew .visitor [data-sticker]').length === 2"), 'with the stickers on their shell');
    check(await until(critter.ev, "/reefbuddy dropped by/.test(document.getElementById('bubbleText').textContent)"), 'Shellby says who dropped by');
    // ...and then the two of them talk (src/main/banter.js): his hello, and the visitor's back.
    check(await until(critter.ev, "document.querySelector('#crew .visitor .vbubble.on')?.textContent.length > 0", 9000), 'the visitor says hello back');
    console.log(`      (visitor: "${await critter.ev("document.querySelector('#crew .visitor .vbubble').textContent")}")`);
    check(await until(ev, "/@reefbuddy dropped by and left/.test(document.getElementById('frGuestbook').textContent) && !!document.querySelector('#frSouvenirs .fr-souvenir')"), 'guestbook signed, souvenir kept');
    check(await until(ev, "shellby.wardrobeView().then(v => v.achievements.find(a => a.id === 'open-house').done)", 4000), 'Open House trophy');
    await wait(1300); // let the visitor finish walking in
    await shot(critter, process.argv[3]);

    // 4b. A few seconds in, the two of them do something together.
    check(await until(critter.ev, "/together-(dance|party|highfive|sing)/.test(document.body.className)", 14000), 'they do something together');
    check(await critter.ev("getComputedStyle(document.querySelector('#crew .visitor svg')).animationName.startsWith('together-')"), 'the visitor joins in');
    check(await critter.ev("document.querySelectorAll('.together-bit').length > 0"), 'notes or sparks float up');
    await wait(1200);
    await shot(critter, process.argv[4]);

    console.log(`      (${await critter.ev("document.body.className.match(/together-\\w+/)[0]")}: "${await critter.ev("document.getElementById('bubbleText').textContent")}")`);

    // 4c. A friend who shares their stickers' names leaves one: a swap.
    check(await until(ev, "shellby.getStickers().then(v => v.projects.some(p => p.from === 'reefbuddy' && p.name === 'coral-reef'))", 26000), 'their crab leaves a sticker swap in the book');
    check(await until(ev, "shellby.wardrobeView().then(v => v.achievements.find(a => a.id === 'swap-meet').done)", 4000), 'Swap Meet trophy');
    check(await ev("shellby.getStickers().then(v => !v.shells.some(s => s.stickers.length))"), "it waits in the book instead of going on his shell unasked");

    // 5. Waving: a comment on their card.
    await ev("[...document.querySelectorAll('#frList select')][0].value = 'outfit'");
    await ev("[...document.querySelectorAll('#frList button')].find(b => b.textContent === 'Wave').click()");
    check(await waitFor(() => mock.state.gists.get(friendGist).comments.some(c => /shellby-wave:outfit/.test(c.body) && c.user.login === 'crabfan')), 'wave sent as a comment on their card');

    // 6. Their wave back reaches the bubble and the inbox; a stranger's doesn't.
    await ev('shellby.friendsRefresh()'); // the first look only marks where things are
    mock.comment(card.id, 'reefbuddy', formatWave('ship', 'reefbuddy'));
    mock.comment(card.id, 'stranger', formatWave('sleep', 'stranger'));
    await ev('shellby.friendsRefresh()');
    check(await until(ev, "/@reefbuddy says go ship it!/.test(document.getElementById('frInbox').textContent)"), 'their wave in the inbox');
    check(!(await ev("document.getElementById('frInbox').textContent.includes('stranger')")), 'a stranger\'s wave is ignored');
    await ev("document.querySelectorAll('.cel-close').forEach(b => b.click()); document.getElementById('setTab-connect').click()");
    await wait(600);
    await ev("document.getElementById('githubGroup').scrollIntoView({ block: 'start' })");
    await ev("document.getElementById('frList').scrollIntoView({ block: 'start' })");
    await wait(400);
    await shot(panel, process.argv[2]);

    // 7. Off again: the card is deleted.
    ev("document.getElementById('ghFriends').click()");
    check(await until(ev, "document.getElementById('ghFriendsRow').hidden"), 'the friends section closes');
    check(await waitFor(() => !myCard()), 'the calling card gist is deleted');
  } catch (e) {
    check(false, e.message);
  } finally {
    app.kill();
    await mock.close();
  }
  console.log(fails ? `${fails} FAILED` : 'all passed');
  process.exit(fails ? 1 : 0);
})();
