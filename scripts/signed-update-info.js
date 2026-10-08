// After SignPath signs the installer, brings the auto-update files back in line
// with it.
//
// Why: with SignPath, signing happens after electron-builder has finished, so
// the signature changes the installer's bytes after latest.yml (sha512, size)
// and the .blockmap were written. Updaters check the download against
// latest.yml's sha512 and refuse a mismatch, so every existing install would
// fail to update. This rebuilds the blockmap from the signed file and rewrites
// latest.yml to match. (Azure signing doesn't need this: electron-builder signs
// mid-build, before it hashes anything.)
//
//   node scripts/signed-update-info.js     in the release workflow, with the
//                                          signed exes already back in dist/
//
// The latest.yml rewrite is a pure function, tested in
// test/signed-update-info.test.js.
const fs = require('fs');
const path = require('path');

/**
 * latest.yml with `fileName`'s sha512 and size replaced, both in its `files:`
 * entry and in the top-level sha512 that goes with `path:`. Throws if either
 * isn't there, rather than publishing a latest.yml that still describes the
 * unsigned file.
 */
function updateLatestYml(text, fileName, { sha512, size }) {
  const lines = String(text || '').split('\n');
  let inEntry = false;
  let topLevelIsFile = false;
  let entryHash = false;
  let entrySize = false;
  let topHash = false;

  const out = lines.map(line => {
    const entryStart = line.match(/^\s*-\s+url:\s*['"]?([^'"\s]+)/);
    if (entryStart) { inEntry = entryStart[1] === fileName; return line; }
    if (/^\S/.test(line)) inEntry = false; // back at the top level
    const pathLine = line.match(/^path:\s*['"]?([^'"\s]+)/);
    if (pathLine) topLevelIsFile = pathLine[1] === fileName;

    if (inEntry && /^\s+sha512:/.test(line)) { entryHash = true; return line.replace(/sha512:.*/, `sha512: ${sha512}`); }
    if (inEntry && /^\s+size:/.test(line)) { entrySize = true; return line.replace(/size:.*/, `size: ${size}`); }
    if (/^sha512:/.test(line)) { topHash = true; return `sha512: ${sha512}`; }
    return line;
  });

  if (!entryHash || !entrySize) throw new Error(`latest.yml has no files entry with a sha512 and size for ${fileName}.`);
  if (!topHash || !topLevelIsFile) throw new Error(`latest.yml's top-level path/sha512 isn't ${fileName}.`);
  return out.join('\n');
}

// ------------------------------------------------------------------ running it

async function main() {
  const dist = path.join(__dirname, '..', 'dist');
  const version = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version;
  const installer = `Shellby-Setup-${version}.exe`;
  const installerPath = path.join(dist, installer);
  const ymlPath = path.join(dist, 'latest.yml');

  // electron-builder's own blockmap writer, so the format is exactly what
  // electron-updater expects. It also returns the file's sha512 and size.
  // An internal path: if a future electron-builder moves it, this fails loudly.
  const { buildBlockMap } = require('app-builder-lib/out/targets/blockmap/blockmap');
  const info = await buildBlockMap(installerPath, 'gzip', `${installerPath}.blockmap`);

  fs.writeFileSync(ymlPath, updateLatestYml(fs.readFileSync(ymlPath, 'utf8'), installer, info));
  console.log(`${installer}: rebuilt blockmap and latest.yml for the signed file (${info.size} bytes).`);
}

if (require.main === module) {
  main().catch(e => { console.log(`::error::${e.message}`); process.exit(1); });
}

module.exports = { updateLatestYml };
