# Contributing to Shellby

Thanks for helping the crab! Skins, fixes, and features are all welcome.

## Setup

```powershell
npm install
npm start      # run the app
npm test       # must pass before a PR
npm run lint   # so must this (CI runs both)
npm run typecheck
```

npm 11 may skip install scripts. If `npm start` says Electron failed to install, run `node node_modules/electron/install.js`.

Every end-to-end and maintenance script, and a map of the code, is in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Guidelines

- **No frameworks in the renderer.** The UI is plain HTML/CSS/JS on purpose: fast to start, easy to read, nothing to audit.
- **Keep the parser pure.** `src/main/stream.js` has no Electron or I/O, and new CLI event shapes get a test in `test/stream.test.js`.
- **Session behaviour gets a fake-CLI test.** Extend `test/fixtures/fake-claude.js` rather than hitting the real CLI in tests.
- **Security-sensitive areas** (preload bridge, IPC handlers, markdown renderer, permission flow) need a test for any change, and a note in the PR.
- **Never commit personal data.** `npm run screenshots` uses fake account details. Check images before committing.
- **Match the voice.** Shellby's copy is short, friendly and concrete, and he's a crab, not a corporation.

## Licensing your contribution

Shellby is [GPL-3.0](LICENSE), and the copyright is held in one place so the
project can be licensed as a whole — today that's GPL-3.0, and one day it may
also mean a paid add-on or a commercial licence alongside the free crab.

So, by opening a pull request you're saying three things:

1. **It's yours to give.** You wrote it, or you otherwise have the right to
   contribute it, and it isn't lifted from code under a licence that clashes with
   GPL-3.0. If your employer owns what you write, check with them first.
2. **It ships under GPL-3.0**, like the rest of Shellby.
3. **x-salmon may also license it under other terms**, including commercially, as
   part of Shellby. You keep your copyright and can use your own work anywhere
   else you like — this is permission granted to the project, not a handover.

Point 3 is the one worth reading twice. It's what lets paid extras exist later
without having to track down every contributor for permission, and it's why the
app in this repository can stay GPL-3.0 and free.

Art, skins and packs that land **in this repo** are covered by the same three
points. Skins you publish yourself to the [packs site](https://x-salmon.github.io/shellby-packs/)
stay entirely yours — see [docs/SKINS.md](docs/SKINS.md).

The name and the crab are reserved, which matters if you're forking rather than
contributing: [TRADEMARK.md](TRADEMARK.md).

## Releasing (maintainers)

Branches don't bump the version or edit the top of the CHANGELOG. They add a note in [changes/](changes/README.md), which the release gathers up.

1. On `main`, run `npm run release:cut -- X.Y.Z "Title"` (`--dry-run` first to read the entry). It writes the notes into a `## X.Y.Z: Title` section of `CHANGELOG.md`, deletes them, bumps `package.json` and the lock, and commits and tags on this PC. Edit the entry, `git commit --amend` and move the tag onto it (`git tag -fa vX.Y.Z -m "X.Y.Z: Title"`) if it needs it, then push `main`.
2. Run `npm run release:ready`. It waits for CI on that commit and says whether it's safe to tag: the version has its CHANGELOG section, the tag isn't taken, and CI finished green. If CI is red, the release would fail the same way, so fix `main` and ship the fix as the next version instead.
3. Push the tag `vX.Y.Z`. The release workflow tests, builds and publishes to GitHub Releases, and installed copies update themselves. It stops at once if CI on that commit has failed. A tag that fails to release is never moved: the fix goes out as the next patch.
4. While releases are unsigned, submit the new `Shellby-Setup-X.Y.Z.exe` to [Microsoft's file submission form](https://www.microsoft.com/wdsi/filesubmission) as a **software developer**. SmartScreen tracks unsigned builds by file hash, so this has to be redone every release until signing is set up — see [docs/SIGNING.md](docs/SIGNING.md).
5. winget updates itself from the release workflow once the `WINGET_TOKEN` secret is set and the package is live in `microsoft/winget-pkgs`. The very first submission is manual — see [packaging/winget](packaging/winget).
