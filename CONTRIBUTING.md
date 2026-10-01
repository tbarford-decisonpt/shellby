# Contributing to Shellby

Thanks for helping the crab! Skins, fixes, and features are all welcome.

## Setup

```powershell
npm install
npm start      # run the app
npm test       # must pass before a PR
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

## Releasing (maintainers)

1. Bump `version` in `package.json` and commit.
2. Tag `vX.Y.Z` and push the tag. The release workflow tests, builds and publishes to GitHub Releases, and installed copies update themselves.
