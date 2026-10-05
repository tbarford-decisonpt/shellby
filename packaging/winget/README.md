# winget packaging

Manifests for submitting Shellby to [microsoft/winget-pkgs](https://github.com/microsoft/winget-pkgs),
so people can install with `winget install x-salmon.Shellby`.

Why bother: SmartScreen's "Windows protected your PC" dialog is triggered by
[Mark-of-the-Web](https://learn.microsoft.com/windows/win32/shell/fa-mark-of-the-web),
the tag a *browser* attaches to a downloaded file. `winget` fetches installers with its
own HTTP client and usually doesn't set it, so that dialog typically never appears for
a `winget install` — while `winget` still verifies the SHA-256 pinned in the manifest.
It does not change the UAC "Unknown publisher" line; only code signing does that
(see [../../docs/SIGNING.md](../../docs/SIGNING.md)).

## First submission

`wingetcreate update` (used by the release workflow) can only bump a package that
already exists, so the package has to be created once. Everything needed is in this
folder and already validated — `winget validate` passes with no warnings.

Two things only you can do, both in the browser:

1. Create a **classic** personal access token with only the **`public_repo`** scope.
   Fine-grained tokens are [not supported](https://github.com/microsoft/winget-create/issues/595).
2. Add it as the repo secret **`WINGET_TOKEN`** (Settings → Secrets and variables →
   Actions).

Then run the **Submit to winget** workflow from the Actions tab, with version `0.66.0`.
It opens the PR against `microsoft/winget-pkgs` for you, creating the fork if needed.

A first-time package gets reviewed by a human moderator, which can take a few days.
Automated validation runs the installer in a sandbox first. Leave the PR open while it
waits: the first try (0.18.0, [#445454](https://github.com/microsoft/winget-pkgs/pull/445454))
passed validation and was closed before a moderator got to it, so nothing was published.
Releases tagged while it waits don't reach winget (`wingetcreate update` has nothing to
update yet); the first one after the merge does.

Nothing needs installing locally — the workflow runs on a GitHub runner, which matters
because `wingetcreate` requires the .NET 9 runtime.

### Doing it by hand instead

```powershell
winget validate --manifest packaging\winget\0.66.0
winget install  --manifest packaging\winget\0.66.0   # optional local test
```

Then fork `microsoft/winget-pkgs`, copy this version folder to
`manifests/x/x-salmon/Shellby/0.66.0/` in the fork, and open a PR.

## Automatic updates after that

The release workflow's last two steps update winget on every tag, using Microsoft's
[`wingetcreate`](https://github.com/microsoft/winget-create). It reuses the same
`WINGET_TOKEN` secret as the first submission, so once that's set there is nothing
further to do. With the secret unset, the steps are skipped and releases behave exactly
as before.

Notes on how it's wired, in case it needs debugging:

- It runs **after** the release leaves draft, because `wingetcreate` downloads the
  installer from its public URL to hash it, and draft assets aren't reachable.
- It's `continue-on-error`. The release is already published by then, and a winget
  problem shouldn't mark the release failed — fall back to submitting by hand.
- The token goes in via the `WINGET_CREATE_GITHUB_TOKEN` environment variable rather
  than `--token`, which [can end up in logs](https://github.com/microsoft/winget-create/blob/main/doc/token.md).
- `wingetcreate.exe` is published framework-dependent against `net9.0-windows`, so the
  workflow installs the .NET 9 runtime instead of relying on the runner image having it.
- `wingetcreate` carries forward unchanged fields from the previous version's manifest,
  including `ProductCode`, so the hand-written values here keep applying.

## Updating these files by hand

Per release, change in the installer manifest: `PackageVersion`, `InstallerUrl`,
`InstallerSha256` (from the release's `SHA256SUMS.txt`, uppercase) and `ReleaseDate`;
in the locale and version manifests: `PackageVersion` and `ReleaseNotesUrl`.

`ProductCode` (`d01bce7a-6b6a-53c0-9edc-a2fd643590df`) is electron-builder's per-appId
uninstall key. It does **not** change between versions — leave it alone. It's what lets
`winget upgrade` find an existing install, which matters here because electron-builder
writes a version-dependent ARP `DisplayName` ("Shellby 0.18.0") that `winget` can't
match on its own.
