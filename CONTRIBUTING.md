# Contributing to Shellby

Thanks for helping the crab! Skins, fixes, and features are all welcome.

## Setup

```powershell
npm install
npm run setup  # fetches Electron if npm skipped it, builds the panel
npm run dev:crab  # a dev crab on the fake Claude CLI, beside any installed Shellby
npm test       # must pass before a PR
npm run lint   # so must this (CI runs both)
npm run typecheck
```

`npm run dev:crab` needs no Claude account and keeps its own profile. `npm start` runs the app against your real profile and CLI.

**Looking for a first task?** Try an issue labelled [good first issue](https://github.com/x-salmon/shellby/labels/good%20first%20issue), or make a pack: they're data only, and [docs/ADDONS.md](docs/ADDONS.md) walks you through it. Questions go in [Discussions](https://github.com/x-salmon/shellby/discussions). Everyone here follows the [Code of Conduct](CODE_OF_CONDUCT.md).

Every end-to-end and maintenance script, and a map of the code, is in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Guidelines

- **No frameworks in the renderer.** The UI is plain HTML/CSS/JS on purpose: fast to start, easy to read, nothing to audit.
- **Keep the parser pure.** `src/main/stream.js` has no Electron or I/O, and new CLI event shapes get a test in `test/stream.test.js`.
- **Session behaviour gets a fake-CLI test.** Extend `test/fixtures/fake-claude.js` rather than hitting the real CLI in tests.
- **Security-sensitive areas** (preload bridge, IPC handlers, markdown renderer, permission flow) need a test for any change, and a note in the PR. [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md) maps each trust boundary to its code.
- **Never commit personal data.** `npm run screenshots` uses fake account details. Check images before committing.
- **Match the voice.** Shellby's copy is short, friendly and concrete, and he's a crab, not a corporation.

## Licensing your contribution

**You keep the copyright to what you write.** Nothing here asks you to hand it
over. Opening a pull request just means you agree to three things:

1. **It's yours to give.** You wrote it, or you otherwise have the right to
   contribute it, and it isn't copied from code under a licence that clashes
   with GPL-3.0. If your employer owns what you write, check with them first.
2. **It ships under GPL-3.0**, like the rest of Shellby.
3. **x-salmon may also license it under other terms**, including commercially,
   as part of Shellby.

Why point 3? It means the project can offer something like a paid add-on or a
commercial licence later without tracking down every contributor to ask. The
app in this repository stays GPL-3.0 and free either way, and you can use your
own work anywhere else you like. If you're not comfortable with point 3, say so
in your PR and we'll talk it through. Small fixes, docs and skins are still very
welcome.

Art, skins and packs that land **in this repo** are covered by the same three
points. Skins you publish yourself to the [packs site](https://getshellby.com/community/)
stay entirely yours — see [docs/SKINS.md](docs/SKINS.md).

The name and the crab are reserved, which matters if you're forking rather than
contributing: [TRADEMARK.md](TRADEMARK.md).

## Releasing (maintainers)

Branches don't bump the version or edit the top of the CHANGELOG. They add a note in [changes/](changes/README.md), which the release gathers up.

1. Merge into `main`, push it, and let CI run on it. Merging several branches is where they break each other: CI checks them together before anything is cut.
2. Run `npm run release:cut -- X.Y.Z "Title" --wait` (`--dry-run` first to read the entry). It refuses while `main` has unpushed commits, waits for CI on `main` and stops at the first red job. Once CI is green, it writes the notes into a `## X.Y.Z: Title` section of `CHANGELOG.md`, deletes them, bumps `package.json` and the lock, and commits and tags on this PC. Edit the entry, `git commit --amend` and move the tag onto it (`git tag -fa vX.Y.Z -m "X.Y.Z: Title"`) if it needs it.
3. Push `main` and the tag together: `git push --atomic origin main vX.Y.Z`. The release commit only changes the version and the CHANGELOG, so CI's pass on the commit before it counts for it (`npm run release:ready` says so too). The release workflow runs lint and the unit tests, builds and publishes to GitHub Releases, and installed copies update themselves. It skips the e2e checks CI already passed, and runs them itself only when it can't confirm that. It stops at once if CI on that code failed. A tag that fails to release is never moved: the fix goes out as the next patch.
4. While releases are unsigned, submit the new `Shellby-Setup-X.Y.Z.exe` to [Microsoft's file submission form](https://www.microsoft.com/wdsi/filesubmission) as a **software developer**. SmartScreen tracks unsigned builds by file hash, so this has to be redone every release until signing is set up — see [docs/SIGNING.md](docs/SIGNING.md).
5. winget updates itself from the release workflow once the `WINGET_TOKEN` secret is set and the package is live in `microsoft/winget-pkgs`. The very first submission is manual — see [packaging/winget](packaging/winget).
