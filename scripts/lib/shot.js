// One guarded screenshot for the e2e scripts. A window that was never painted
// (covered, or behind the others in the desktop layer, where the crab lives)
// can leave Page.captureScreenshot unanswered for minutes, so every capture is
// raced against a wait and a screenshot that doesn't come is reported, not
// waited for. The app itself stays painted in test runs (src/main/test-desktop.js),
// so in practice the shot arrives; this is the backstop.
const fs = require('fs');

const SHOT_TIMEOUT_MS = 10000;

/**
 * Capture a page over CDP. `send(method, params)` is the script's own CDP caller
 * and resolves to the command's result (`{ data }`). -> the PNG bytes, or null if
 * the window never answered within `ms`.
 */
async function capturePng(send, params = {}, ms = SHOT_TIMEOUT_MS) {
  let timer;
  const late = new Promise(resolve => { timer = setTimeout(() => resolve(null), ms); });
  try {
    const r = await Promise.race([send('Page.captureScreenshot', { format: 'png', ...params }), late]);
    return r && r.data ? Buffer.from(r.data, 'base64') : null;
  } finally {
    clearTimeout(timer);
  }
}

/** capturePng, written to `file`. Says so when there was none. -> true if saved. */
async function savePng(send, file, params = {}, ms = SHOT_TIMEOUT_MS) {
  const png = await capturePng(send, params, ms);
  if (!png) {
    console.log(`(no screenshot for ${file}: Page.captureScreenshot got no answer in ${ms / 1000}s)`);
    return false;
  }
  fs.writeFileSync(file, png);
  return true;
}

module.exports = { SHOT_TIMEOUT_MS, capturePng, savePng };
