// Shellby's look for Windows notifications. Windows draws the toast itself, so
// its colours and font stay Windows'; what we choose is what goes inside: the
// round crab in the corner, a banner across the top in the panel's colours,
// and a button when there's something to do. It is still a real notification,
// so it lands in the notification centre and obeys Do Not Disturb.
const fs = require('fs');
const path = require('path');

const ART = ['logo.png', 'hero-default.png', 'hero-celebrate.png', 'hero-alert.png', 'hero-problem.png'];
const TONES = ['default', 'celebrate', 'alert', 'problem'];

// Characters XML 1.0 can't carry at all: a stray one makes Windows reject the
// whole toast, so they go rather than being escaped.
const INVALID = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;

function esc(s) {
  return String(s ?? '').replace(INVALID, '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
}

/**
 * The toast's XML. A click on the toast or its button reaches Electron as a
 * plain 'click' (any arguments without "type=action" do), so callers keep
 * their usual onClick.
 * @param {{ title: string, body?: string, tone?: string, action?: string, artDir: string }} spec
 * @returns {string}
 */
function xml({ title, body = '', tone = 'default', action = null, artDir }) {
  const hero = path.join(artDir, `hero-${TONES.includes(tone) ? tone : 'default'}.png`);
  const logo = path.join(artDir, 'logo.png');
  const text = body ? `<text>${esc(title)}</text><text>${esc(body)}</text>` : `<text>${esc(title)}</text>`;
  const actions = action ? `<actions><action content="${esc(action)}" arguments="open" activationType="foreground"/></actions>` : '';
  return '<toast activationType="foreground" launch="open">'
    + '<visual><binding template="ToastGeneric">'
    + `<image placement="hero" src="${esc(hero)}"/>`
    + `<image placement="appLogoOverride" hint-crop="circle" src="${esc(logo)}"/>`
    + text
    + '</binding></visual>'
    + actions
    + '</toast>';
}

/**
 * Copies the art somewhere Windows can read it: inside a packaged build it
 * lives in app.asar, which only Electron can open. Returns the folder, or
 * null if it couldn't be done (the caller then posts a plain notification).
 * @param {string} from assets/toast
 * @param {string} to a folder under userData
 * @returns {string|null}
 */
function prepareArt(from, to) {
  try {
    fs.mkdirSync(to, { recursive: true });
    for (const name of ART) fs.writeFileSync(path.join(to, name), fs.readFileSync(path.join(from, name)));
    return to;
  } catch {
    return null;
  }
}

module.exports = { xml, prepareArt, TONES };
