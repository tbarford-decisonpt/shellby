// Writes bucket/shellby.json, the Scoop manifest, for a release.
//
// The repo doubles as a Scoop bucket (Scoop reads manifests from bucket/), so
//   scoop bucket add shellby https://github.com/x-salmon/shellby
//   scoop install shellby/shellby
// installs from it. The release workflow runs this after publishing and commits
// the result to main, which is what `scoop update` then sees:
//
//   node scripts/scoop-manifest.js <version> <SHA256SUMS.txt>
//
// Scoop takes the NSIS installer apart instead of running it: 7-Zip opens the
// setup exe, and electron-builder keeps the whole app in $PLUGINSDIR\app-64.7z.
// So nothing goes in the registry, and the app finds it's a Scoop install by its
// path and leaves updating to Scoop (installedBy in src/main/updates.js).
//
// The manifest is a pure function, tested in test/scoop-manifest.test.js.
const fs = require('fs');
const path = require('path');

const REPO = 'https://github.com/x-salmon/shellby';
const setupName = version => `Shellby-Setup-${version}.exe`;

/** The setup exe's SHA-256 from a `sha256sum` listing, lowercase. Throws if it isn't there. */
function setupHash(sums, version) {
  const name = setupName(version);
  for (const line of String(sums || '').split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+\*?(\S+)$/i.exec(line.trim());
    if (m && m[2] === name) return m[1].toLowerCase();
  }
  throw new Error(`No SHA-256 for ${name} in the checksums`);
}

/** The manifest for one release, as an object in Scoop's key order. */
function manifest({ version, hash }) {
  if (!/^\d+\.\d+\.\d+$/.test(String(version || ''))) throw new Error(`Not a version: ${version}`);
  if (!/^[0-9a-f]{64}$/.test(String(hash || ''))) throw new Error(`Not a SHA-256: ${hash}`);
  const download = `${REPO}/releases/download/v$version/${setupName('$version')}`;
  return {
    version,
    description: 'A pixel hermit crab that lives on your Windows desktop and runs Claude Code tasks for you.',
    homepage: REPO,
    license: 'MIT',
    notes: 'Shellby runs tasks through Claude Code: npm install -g @anthropic-ai/claude-code, then claude auth login. Scoop keeps him up to date (scoop update shellby).',
    architecture: {
      '64bit': {
        url: `${REPO}/releases/download/v${version}/${setupName(version)}#/dl.7z`,
        hash,
      },
    },
    installer: {
      script: [
        'Expand-7zipArchive "$dir\\`$PLUGINSDIR\\app-64.7z" "$dir"',
        // The installer's own plugins, and its uninstaller ($R0): Scoop uninstalls.
        'Remove-Item "$dir\\`$PLUGINSDIR", "$dir\\`$R0" -Recurse -Force -ErrorAction SilentlyContinue',
      ],
    },
    shortcuts: [['Shellby.exe', 'Shellby']],
    checkver: { github: REPO },
    autoupdate: {
      architecture: {
        '64bit': {
          url: `${download}#/dl.7z`,
          // Named outright: with the #/dl.7z on the url, Scoop's own guess at
          // the file name to look for isn't the setup exe.
          hash: { url: '$baseurl/SHA256SUMS.txt', regex: '$sha256\\s+\\*?Shellby-Setup-$version\\.exe' },
        },
      },
    },
  };
}

/** The file as committed: four-space JSON (Scoop's own style) with a final newline. */
const render = m => `${JSON.stringify(m, null, 4)}\n`;

/** a < b for x.y.z versions. Anything unparseable counts as oldest. */
function olderThan(a, b) {
  const parts = v => (/^\d+\.\d+\.\d+$/.test(String(v)) ? String(v).split('.').map(Number) : [-1, -1, -1]);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i];
  return false;
}

if (require.main === module) {
  const [version, sumsFile] = process.argv.slice(2);
  if (!version || !sumsFile) {
    console.error('usage: node scripts/scoop-manifest.js <version> <SHA256SUMS.txt>');
    process.exit(2);
  }
  const out = path.join(__dirname, '..', 'bucket', 'shellby.json');
  // A re-run of an older tag's release mustn't take the bucket backwards.
  const current = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')).version : null;
  if (current && olderThan(version, current)) {
    console.log(`bucket/shellby.json is already on ${current}; leaving it for ${version}`);
    process.exit(0);
  }
  const hash = setupHash(fs.readFileSync(sumsFile, 'utf8'), version);
  fs.writeFileSync(out, render(manifest({ version, hash })));
  console.log(`bucket/shellby.json -> ${version} (${hash})`);
}

module.exports = { manifest, olderThan, render, setupHash };
