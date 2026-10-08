const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const toast = require('../src/main/toast');

const ART = path.join(__dirname, '..', 'assets', 'toast');
const DIR = 'C:\\Users\\me\\AppData\\Roaming\\Shellby\\toast-art';

test('a notification wears the crab and the banner for its tone', () => {
  const x = toast.xml({ title: 'Level up!', body: 'Shellby is level 7', tone: 'celebrate', artDir: DIR });
  assert.match(x, /<image placement="hero" src="[^"]*hero-celebrate\.png"\/>/);
  assert.match(x, /<image placement="appLogoOverride" hint-crop="circle" src="[^"]*logo\.png"\/>/);
  assert.match(x, /<text>Level up!<\/text><text>Shellby is level 7<\/text>/);
  assert.doesNotMatch(x, /<actions>/, 'no button unless asked for');
});

test('an unknown tone falls back to the everyday banner', () => {
  assert.match(toast.xml({ title: 't', tone: 'party', artDir: DIR }), /hero-default\.png/);
});

test('a button reaches Electron as an ordinary click, never a structured action', () => {
  const x = toast.xml({ title: 'Shellby needs your OK', body: 'Bash: rm -rf build', tone: 'alert', action: 'Review', artDir: DIR });
  assert.match(x, /<action content="Review" arguments="open" activationType="foreground"\/>/);
  // Electron routes "type=action" arguments to the 'action' event, which notify() doesn't listen for.
  assert.doesNotMatch(x, /type=action/);
});

test('titles, messages and paths are escaped, and characters XML forbids are dropped', () => {
  const x = toast.xml({ title: 'CI failed on a&b#1', body: 'expected <div> got "x"\u0007 it\'s', action: 'Fix & go', artDir: 'C:\\a&b' });
  assert.match(x, /<text>CI failed on a&amp;b#1<\/text>/);
  assert.match(x, /<text>expected &lt;div&gt; got &quot;x&quot; it&apos;s<\/text>/);
  assert.match(x, /content="Fix &amp; go"/);
  assert.match(x, /src="C:\\a&amp;b/);
  assert.doesNotMatch(x, /\u0007/);
});

test('a title alone makes one line of text', () => {
  assert.match(toast.xml({ title: 'Report copied', artDir: DIR }), /<text>Report copied<\/text><\/binding>/);
});

test('every banner the tones name is in assets/toast', () => {
  for (const tone of toast.TONES) assert.ok(fs.existsSync(path.join(ART, `hero-${tone}.png`)), tone);
});

test('the art is copied out where Windows can read it; a failure means plain notifications', () => {
  const to = fs.mkdtempSync(path.join(os.tmpdir(), 'toast-art-'));
  try {
    assert.equal(toast.prepareArt(ART, to), to);
    assert.ok(fs.existsSync(path.join(to, 'logo.png')));
    assert.equal(toast.prepareArt(path.join(to, 'missing'), path.join(to, 'out')), null);
  } finally {
    fs.rmSync(to, { recursive: true, force: true });
  }
});
