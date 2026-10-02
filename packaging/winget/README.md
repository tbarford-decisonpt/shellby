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

## Submitting a version

1. Fork `microsoft/winget-pkgs`.
2. Copy this version folder to `manifests/x/x-salmon/Shellby/<version>/` in the fork.
3. Validate and test locally:
   ```powershell
   winget validate --manifest manifests\x\x-salmon\Shellby\<version>
   winget install --manifest manifests\x\x-salmon\Shellby\<version>
   ```
4. Open a PR. Automated validation runs the installer in a sandbox; a human moderator
   reviews the first submission for a new package, which can take a few days.

Only the **first** submission is manual. After the package exists in `winget-pkgs`,
every later version is handled by the release workflow (see below) — `wingetcreate
update` looks up the published manifest, so it can't run until there is one.

## Automatic updates after that

The release workflow's last two steps update winget on every tag, using Microsoft's
[`wingetcreate`](https://github.com/microsoft/winget-create). It's opt-in; to enable it:

1. Create a **classic** personal access token with only the **`public_repo`** scope.
   Fine-grained tokens are [not supported](https://github.com/microsoft/winget-create/issues/595).
2. Add it to the repo as the secret **`WINGET_TOKEN`** (Settings → Secrets and
   variables → Actions).

With the secret unset, the steps are skipped and releases behave exactly as before.

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
writes a version-dependent ARP `DisplayName` ("Shellby 0.17.0") that `winget` can't
match on its own.
