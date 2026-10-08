// A QR code as rows of '1' (dark) and '0' (light), for the panel to draw as
// pixel art. Made here because the panel loads no libraries; qrcode-generator
// is a single dependency-free file.
const qrcode = require('qrcode-generator');

const MAX_TEXT = 300; // a subscribe URL is ~40 characters; anything near this is a mistake

/** text -> ['1010…', …] (square, no quiet zone), or null if it can't be encoded. */
function qrRows(text) {
  const s = String(text ?? '');
  if (!s || s.length > MAX_TEXT) return null;
  try {
    const qr = qrcode(0, 'M'); // version picked to fit; M survives a smudged screen
    qr.addData(s);
    qr.make();
    const n = qr.getModuleCount();
    return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => (qr.isDark(r, c) ? '1' : '0')).join(''));
  } catch {
    return null;
  }
}

module.exports = { qrRows };
