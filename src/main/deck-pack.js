// Packing Shellby's Stream Deck plugin (src/streamdeck/) for Stream Deck to install.
//
// A .streamDeckPlugin file is a zip with the plugin's folder in it. Opened, it
// goes to Stream Deck's own installer, which asks first and copes with Stream
// Deck already running, so that's the whole install: Shellby writes one and
// opens it.
//
// What's packed: the manifest and plugin.js as they are, the icons drawn by the
// plugin's own drawKey (so the keys in Stream Deck's list are the keys you get),
// the app icon as the plugin's PNG, and shellby.json: the port and the token the
// plugin needs to get in (deck.js). The token is only ever in that file and in
// Shellby's settings, encrypted.
//
// Pure apart from reading the plugin's files: the zip is built in memory.
const fs = require('fs');
const path = require('path');

const FOLDER = 'com.xsalmon.shellby.sdPlugin';
const FILE_NAME = 'Shellby.streamDeckPlugin';

// ------------------------------------------------------------------ zip, stored

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// 1 January 2026, 00:00, in DOS's packed date: every build packs the same bytes.
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

/** [{ name, data }] -> a zip, every file stored (they're small, and it's one less thing to get wrong). */
function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const body = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    const fileName = Buffer.from(name, 'utf8');
    const crc = crc32(body);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);           // version needed
    local.writeUInt16LE(0x0800, 6);       // names are UTF-8
    local.writeUInt16LE(0, 8);            // stored
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(fileName.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);         // made by
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(fileName.length, 28);
    central.writeUInt32LE(offset, 42);    // the rest (extra, comment, disk, attributes) is 0
    locals.push(local, fileName, body);
    centrals.push(central, fileName);
    offset += local.length + fileName.length + body.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

// ------------------------------------------------------------------ the plugin

// The small icons in Stream Deck's action list: the glyph alone, white on
// nothing, as Stream Deck's own are.
function listIcon(rows) {
  const w = rows[0].length;
  const h = rows.length;
  const size = Math.max(w, h) + 2;
  const rects = [];
  rows.forEach((row, y) => [...row].forEach((c, x) => {
    if (c === '#') rects.push(`<rect x="${x + (size - w) / 2}" y="${y + (size - h) / 2}" width="1" height="1"/>`);
  }));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="40" height="40" shape-rendering="crispEdges"><g fill="#ffffff">${rects.join('')}</g></svg>`;
}

/**
 * Every file in the plugin, as zip entries under its folder.
 *   srcDir: the plugin's folder in the repo. icon: the app's PNG.
 *   pair:   { port, token }
 */
function pluginEntries({ srcDir, icon, pair }) {
  const { drawKey, GLYPHS, ACTIONS } = require(path.join(srcDir, 'plugin.js'));
  const files = [
    ['manifest.json', fs.readFileSync(path.join(srcDir, 'manifest.json'))],
    ['plugin.js', fs.readFileSync(path.join(srcDir, 'plugin.js'))],
    ['shellby.json', JSON.stringify({ port: pair.port, token: pair.token })],
    ['imgs/plugin.png', fs.readFileSync(icon)],
    ['imgs/plugin@2x.png', fs.readFileSync(icon)],
    ['imgs/category.svg', listIcon(GLYPHS.crab)],
  ];
  for (const action of ACTIONS) {
    files.push([`imgs/${action}-icon.svg`, listIcon(GLYPHS[action])]);
    // What a key shows before the plugin has heard from Shellby.
    files.push([`imgs/${action}.svg`, drawKey(action, null)]);
  }
  return files.map(([name, data]) => ({ name: `${FOLDER}/${name}`, data }));
}

/** The .streamDeckPlugin file's bytes. */
const pack = opts => zip(pluginEntries(opts));

module.exports = { pack, pluginEntries, zip, crc32, listIcon, FOLDER, FILE_NAME };
