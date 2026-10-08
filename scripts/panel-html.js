// The panel's page, put together. src/renderer/panel/panel.html is one file
// because the panel loads it as one (its CSP has no connect-src, so it can't
// fetch pieces of itself), but nobody should have to work in 2,500 lines of
// it. So it is built from src/renderer/panel/html/: frame.html (the head, the
// title bar, the menus, the bar, the sheets and the scripts) with a line
//   <!-- @include chat.html -->
// for each screen, and a screen can include its own pieces the same way
// (settings.html includes a file per tab). The built panel.html is committed,
// so `npm start` and every e2e script need no build step, and
// test/panel-html.test.js fails when it's out of date.
//
//   npm run panel:html            rebuild panel.html
//   npm run panel:html -- --check exit 1 if it's out of date
const fs = require('fs');
const path = require('path');

const PANEL = path.join(__dirname, '..', 'src', 'renderer', 'panel');
const SRC = path.join(PANEL, 'html');
const OUT = path.join(PANEL, 'panel.html');
const INCLUDE = /^[ \t]*<!-- @include ([a-z0-9-]+\.html) -->$/;
const NOTE = '<!-- Built from html/ by `npm run panel:html` (scripts/panel-html.js). Edit those files, not this one. -->';

/** One file with its includes filled in. seen: the files on the way here (a loop is an error). */
function expand(name, used, seen = []) {
  if (seen.includes(name)) throw new Error(`${[...seen, name].join(' -> ')}: an include loop`);
  const file = path.join(SRC, name);
  if (!fs.existsSync(file)) throw new Error(`${seen.at(-1) || 'frame.html'} includes ${name}, which isn't in ${path.relative(process.cwd(), SRC)}`);
  if (used.has(name)) throw new Error(`${name} is included twice`);
  used.add(name);
  const text = fs.readFileSync(file, 'utf8').replace(/\n$/, '');
  return text.split('\n').map(line => {
    const m = line.match(INCLUDE);
    return m ? expand(m[1], used, [...seen, name]) : line;
  }).join('\n');
}

/** -> { html, used: the files it took in, unused: files in html/ nothing includes } */
function build() {
  const used = new Set();
  const body = expand('frame.html', used);
  const [first, ...rest] = body.split('\n');
  const html = `${[first, NOTE, ...rest].join('\n')}\n`;
  const unused = fs.readdirSync(SRC).filter(f => f.endsWith('.html') && !used.has(f));
  return { html, used: [...used], unused };
}

if (require.main === module) {
  const { html, unused } = build();
  if (unused.length) console.log(`Not included anywhere: ${unused.join(', ')}`);
  const same = fs.existsSync(OUT) && fs.readFileSync(OUT, 'utf8') === html;
  if (process.argv.includes('--check')) {
    console.log(same ? 'panel.html is up to date.' : 'panel.html is out of date: run npm run panel:html');
    process.exit(same && !unused.length ? 0 : 1);
  }
  if (!same) fs.writeFileSync(OUT, html);
  console.log(same ? 'panel.html was already up to date.' : 'Built panel.html.');
}

module.exports = { build, SRC, OUT, NOTE };
