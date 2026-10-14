// Keep warm in the panel: the button has a name and a pressed state, its script
// loads, the feed draws the receipt, and only a receipt that ends a ping ends
// the turn in the panel. The markup and wiring are checked in the sources;
// keepwarm.js itself runs in a vm with a fake page, as panel-core.test.js does for core.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PANEL = path.join(__dirname, '..', 'src', 'renderer', 'panel');
const html = fs.readFileSync(path.join(PANEL, 'panel.html'), 'utf8');
const src = name => fs.readFileSync(path.join(PANEL, name), 'utf8');

test('the Keep warm button sits in the tab strip with a name and a pressed state', () => {
  const btn = /<button[^>]*id="keepWarmBtn"[^>]*>/.exec(html)?.[0];
  assert.ok(btn, 'the button is in panel.html');
  assert.match(btn, /aria-label="Keep warm while you're away"/);
  assert.match(btn, /aria-pressed="false"/);
  const strip = html.slice(html.indexOf('id="tabstrip"'), html.indexOf('id="subbar"'));
  assert.ok(strip.indexOf('id="filesBtn"') < strip.indexOf('id="keepWarmBtn"'), 'after Files');
  assert.match(html, /id="keepWarmLeft"[^>]*hidden/);
});

test('keepwarm.js loads after viewer.js', () => {
  const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map(m => m[1]);
  assert.ok(scripts.indexOf('keepwarm.js') > scripts.indexOf('viewer.js'));
});

test('the feed draws a receipt, and the boot hands it to keepwarm.js', () => {
  assert.match(src('feed.js'), /case 'keepwarm': return SB\.renderKeepWarm\?\.\(this, item\);/);
  assert.match(src('boot.js'), /item\.kind === 'keepwarm'\) SB\.onKeepWarmItem\?\.\(tab, item\)/);
});

test('a queued message going out by itself says so, so Keep warm stays on', () => {
  const has = (text, part, what) => assert.ok(text.includes(part), what);
  const queue = src('tab-queue.js');
  const drain = queue.slice(queue.indexOf('async function drain(tab)'), queue.indexOf('SB.onTurnEnded'));
  has(drain, 'sendNow(tab, next.text, next.attachments, { ...(next.selected ? { selected: next.selected } : {}), fromQueue: true })', 'the drain marks what it sends, beside the file picked in All files');
  has(queue, 'const sendNow = (tab, text, attachments, opts) => SB.sendNow(tab, text, attachments, opts);', 'and the queue passes the mark on');
  has(src('tab-send.js'), 'async function sendNow(tab, text, attachments, opts) {\n    const r = await api.sendTask(tab.id, text, attachments, opts);', 'sendNow hands it to main');
  const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload', 'preload.js'), 'utf8');
  has(preload, "sendTask: (tabId, text, attachments, opts) => ipcRenderer.invoke('task:send', { tabId, text, attachments, selected: opts?.selected, fromQueue: opts?.fromQueue === true }),", 'the preload carries it');
  has(fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'ipc', 'tabs.js'), 'utf8'), 'if (fromQueue !== true) d.keepWarm?.userSent();', 'and task:send heeds it');
});

test('split, the mug moves under the panes with the review and list buttons, so it stays visible', () => {
  assert.match(src('tab-overview.js'), /where\.append\(\$\('keepWarmBtn'\), \$\('reviewBtn'\), allBtn\)/);
  assert.match(src('components.css'), /\.subbar > \.tab-warm \{/);
});

// keepwarm.js in a vm: elements that record what they're given, and a SB with only what it reads.
function load({ now = Date.now() } = {}) {
  const els = new Map();
  const el = () => {
    const classes = new Set();
    return {
      hidden: false, textContent: '', title: '', attrs: {}, listeners: {},
      classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)), contains: c => classes.has(c) },
      setAttribute(k, v) { this.attrs[k] = String(v); },
      addEventListener(type, fn) { this.listeners[type] = fn; },
    };
  };
  const $ = id => { if (!els.has(id)) els.set(id, el()); return els.get(id); };
  const calls = { turnEnded: [], synced: 0, pushed: null };
  const api = {
    onKeepWarm: cb => { calls.pushed = cb; },
    keepWarmGet: () => Promise.resolve(null),
    keepWarmSet: async on => ({ ok: true, on, endsAt: null, tabs: [] }),
  };
  const SB = {
    h: () => ({}), api, $, toast() {},
    onTurnEnded: (tab, r) => calls.turnEnded.push([tab, r]),
    syncBusyUi: () => { calls.synced++; },
  };
  class FixedDate extends Date { static now() { return now; } }
  const context = vm.createContext({ SB, setInterval() {}, Date: FixedDate });
  vm.runInContext(src('keepwarm.js'), context, { filename: 'keepwarm.js' });
  return { SB, $, calls, now };
}

test('a receipt that ends a ping ends the panel turn and drains the queue', () => {
  const { SB, calls } = load();
  const tab = { busy: true };
  SB.onKeepWarmItem(tab, { kind: 'keepwarm', warm: true, endsTurn: true, text: 'kept warm' });
  assert.equal(tab.busy, false);
  assert.equal(calls.turnEnded.length, 1);
  assert.equal(calls.turnEnded[0][0], tab);
  assert.equal(JSON.stringify(calls.turnEnded[0][1]), '{"ok":true}'); // JSON: the vm's object has its own Object
  assert.equal(calls.synced, 1);
});

test('a drop line that does not end a ping leaves a running turn alone', () => {
  const { SB, calls } = load();
  const tab = { busy: true };
  SB.onKeepWarmItem(tab, { kind: 'keepwarm', warm: false, endsTurn: false, text: 'stopped' });
  assert.equal(tab.busy, true);
  assert.equal(calls.turnEnded.length, 0);
  assert.equal(calls.synced, 0);
});

test('a pushed view lights the button, counts down and lists each conversation in the tooltip', () => {
  const now = Date.UTC(2026, 9, 12, 12, 0, 0);
  const { $, calls } = load({ now });
  calls.pushed({ on: true, endsAt: now + (2 * 60 + 41) * 60000, tabs: [{ title: 'A', line: 'next ping 13:55' }] });
  const btn = $('keepWarmBtn');
  assert.equal(btn.attrs['aria-pressed'], 'true');
  assert.ok(btn.classList.contains('on'));
  assert.equal($('keepWarmLeft').hidden, false);
  assert.equal($('keepWarmLeft').textContent, 'Warm · 2h41m');
  assert.match(btn.title, /A · next ping 13:55/);
  calls.pushed({ on: false, endsAt: null, tabs: [] });
  assert.equal(btn.attrs['aria-pressed'], 'false');
  assert.equal($('keepWarmLeft').hidden, true);
  assert.equal(btn.title, "Keep warm while you're away");
});
