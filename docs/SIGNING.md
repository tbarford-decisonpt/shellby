# Code signing

Unsigned Windows apps get the SmartScreen "Windows protected your PC" warning. Shellby's release workflow signs every build automatically once a signing account is connected. It uses [Azure Artifact Signing](#current-azure-artifact-signing) (about $10/month), and also supports [SignPath Foundation](#later-signpath-foundation-free) (free for open source, but it needs a project with some exposure first). Until signing is set up, releases are unsigned and still publish `SHA256SUMS.txt` so people can verify downloads.

## What signing does (and doesn't)

- **It does:** puts a verified publisher name on the installer and app ("Verified publisher: …" instead of "Unknown publisher"), proves the file wasn't changed after it was built, and lets SmartScreen build up **reputation** for that publisher. Once there's enough reputation, the warning goes away for every future release. Unsigned builds start over at zero reputation with every new version, because SmartScreen tracks them by file hash.
- **It doesn't:** remove the warning instantly. Even signed apps from new publishers can show it until enough people have installed them. EV certificates used to skip this, but Microsoft stopped giving them special treatment in 2024.

## Current: Azure Artifact Signing

[Azure Artifact Signing](https://learn.microsoft.com/azure/artifact-signing/) (formerly Trusted Signing) is Microsoft's own signing service. It costs about **$10/month** (Basic tier), keys live in Microsoft's HSMs so there's no USB token to lose, and electron-builder supports it directly. Individual developers in the US and Canada can sign up with a government ID; organizations need a few years of verifiable history.

The publisher shown is **your validated name**, and releases need no manual approval.

The alternative is a regular OV certificate from a CA, which costs roughly $200–400 a year. Since 2023 those keys must live on a hardware token or a cloud HSM, which is awkward to use from CI.

### One-time setup

1. **Create the account.** In the [Azure portal](https://portal.azure.com), create an *Artifact Signing* (Trusted Signing) account. Note its **endpoint** (e.g. `https://eus.codesigning.azure.net/`) and the account name.
2. **Verify your identity.** Create an *identity validation* request (Individual, Public Trust). Microsoft checks your ID, which can take a few days.
3. **Create a certificate profile** (Public Trust) tied to that validation. Note the profile name.
4. **Create an app registration** (Microsoft Entra ID → App registrations → New) with a **client secret**, and give it the **Artifact Signing Certificate Profile Signer** role on the signing account. Put a reminder in your calendar for shortly before the secret expires (see [Keep it from lapsing](#keep-it-from-lapsing)).
5. **Add these to the GitHub repo** (Settings → Secrets and variables → Actions):

   | Kind | Name | Value |
   |---|---|---|
   | Secret | `AZURE_TENANT_ID` | Directory (tenant) ID of the app registration |
   | Secret | `AZURE_CLIENT_ID` | Application (client) ID |
   | Secret | `AZURE_CLIENT_SECRET` | The client secret |
   | Variable | `AZURE_SIGN_ENDPOINT` | The account endpoint, e.g. `https://eus.codesigning.azure.net/` |
   | Variable | `AZURE_SIGN_ACCOUNT` | The signing account name |
   | Variable | `AZURE_SIGN_PROFILE` | The certificate profile name |
   | Variable | `AZURE_SIGN_PUBLISHER` | The publisher name exactly as on the certificate (your validated legal name) |

6. **Tag a release.** The workflow notices the credentials, signs the installer, the portable exe and the app inside, and checks that each is validly signed by `AZURE_SIGN_PUBLISHER` before publishing.
7. **Then tidy up the wording.** Drop the "not signed yet" notes from the README's install section and [.github/release-notes.md](../.github/release-notes.md), and the "being set up" note in the README's code signing policy.

Without these settings the workflow builds unsigned and prints a warning. Auto-update keeps working across the switch from unsigned to signed builds.

### Keep it from lapsing

Once a release is signed with Azure, electron-builder writes the publisher name into the app's `app-update.yml`, and from then on that install **only accepts updates signed by exactly that name**. That's a real protection: a forged update would need your signing identity. But an unsigned release after that point (an expired client secret, a cancelled subscription, a deleted variable) would be refused by every signed install, and Shellby would just stop updating without telling anyone.

So the release workflow checks before building (`release-guard.js preflight`). It downloads the latest published installer, reads who signed it, and stops the release if this build would be unsigned (a signing secret or variable is missing) or signed by someone else. A secret that's still set but has expired gets past that check, but then the signing step fails the build, so nothing is published either way. If either happens, fix the secret or variable and push a new patch tag.

The preflight check is best-effort. If it can't reach GitHub or read the signature, it warns and lets the release go on, because a pushed tag can't be moved. The **Check signatures** step still confirms that this build is signed by `AZURE_SIGN_PUBLISHER` before anything is published.

Azure's own certificates are short-lived and renewed automatically; that's fine, because updates are matched on the publisher name, not on one certificate.

### Changing publisher

Only do this deliberately, for example when moving to SignPath. Installs that came from an Azure-signed release check the old name, so you need a **bridge release** first:

1. Release one more version signed by the old publisher, but with both names in its update config, so those installs accept either. electron-builder takes a list for `win.azureSignOptions.publisherName` and writes all of it to `app-update.yml`. `release.yml` passes a single name through a `-c` flag, so for this one release, put the full `azureSignOptions` (endpoint, account, profile and `publisherName: ["Old Name", "New Name"]`) in `package.json`'s `build.win`, and remove the `-c` flags, which would override it. Undo both afterwards. Before you start, check this still holds for your electron-builder version.
2. Give it time to reach most installs.
3. Switch the signing settings, set the repo variable `ALLOW_PUBLISHER_CHANGE` to `true` for the first release under the new publisher, then delete it.

Anyone who skips the bridge release has to download the new version by hand.

## Later: SignPath Foundation (free)

[SignPath Foundation](https://signpath.org) signs open-source projects for free, and the workflow supports it. They also look at a project's **exposure** (users, downloads, community), and Shellby was turned down on that in October 2026. Reapply once the signed releases and winget have built up a user base.

Before reapplying, weigh what you'd give up:

- **The publisher shown becomes "SignPath Foundation"**, not you. Their certificate has a lot of SmartScreen reputation from other projects, but by then yours will have some too.
- **Every release needs approving.** Each signing request waits for an approver to click **Approve** on signpath.io. The release run waits for up to an hour, then fails without publishing anything; re-run it to try again.
- **Only CI builds can be signed.** SignPath fetches the files straight from the release run's artifacts, so a build from your own PC can't be.
- **Only the installer and the portable exe are signed**, not `Shellby.exe` inside the installer. SmartScreen only checks files that came from a browser download, and the installed app doesn't, so it isn't needed.
- **Switching needs a bridge release** (see [Changing publisher](#changing-publisher)).

### What the project has to do

These are SignPath Foundation's [conditions](https://signpath.org/terms):

- A code signing policy in the README, listing who can change code, review it and approve signing. Rewrite the README's current Azure policy in their format, with their attribution line.
- Everyone in those roles uses **two-factor authentication** on both GitHub and SignPath.
- Only Shellby's own files built from this repo get signed. Nothing proprietary goes into the build.
- What Shellby sends over the network stays documented in the [privacy policy](../PRIVACY.md), and it keeps an uninstaller.

### One-time setup

1. **Apply** at [signpath.org/apply](https://signpath.org/apply) with the repo URL. They check the project, which can take a few weeks.
2. **Once accepted**, they set up an organization for you. In it:
   - Connect **GitHub.com** as a *Trusted Build System* to the Shellby project, and install the SignPath GitHub App on the repo when asked.
   - Under the project, create an **artifact configuration** from [packaging/signpath/artifact-configuration.xml](../packaging/signpath/artifact-configuration.xml) and make it the default. It only lets the installer and portable exe be signed, and only when their product name is Shellby and their version is the one being released.
   - Note the **project slug** and the **signing policy slug** (the Foundation calls it `release-signing`).
   - Create an **API token** for a CI user with the *Submitter* role on that policy.
3. **Add these to the GitHub repo** (Settings → Secrets and variables → Actions), and remove the Azure variables:

   | Kind | Name | Value |
   |---|---|---|
   | Secret | `SIGNPATH_API_TOKEN` | The CI user's API token |
   | Variable | `SIGNPATH_ORGANIZATION_ID` | Your SignPath organization ID (a GUID) |
   | Variable | `SIGNPATH_PROJECT_SLUG` | Only if it isn't `shellby` |
   | Variable | `SIGNPATH_POLICY_SLUG` | Only if it isn't `release-signing` |

4. **Tag a release** and approve the request when SignPath emails you. The workflow uploads the signed files, rebuilds `latest.yml` and the blockmap for the signed installer (signing changes its hash, and updaters refuse a hash that doesn't match), and checks that both exes are validly signed by SignPath Foundation before publishing.

Configure SignPath *or* Azure, not both: the workflow stops if it finds both.

## Free stopgaps (no certificate)

Neither of these is a substitute for signing, but both are free and both cut down how
often anyone meets the warning. winget is worth keeping even once releases are signed:
it's an easy way in for new users, which is exactly what builds reputation.

### Ask Microsoft to review the file

Microsoft takes false-positive reports from developers at
[the Security Intelligence submission form](https://www.microsoft.com/wdsi/filesubmission)
— choose **Software developer** and submit the installer, noting that SmartScreen is
flagging it. If the analysis comes back clean, the block is lifted for that file.

The catch is that this is keyed to the **file hash**, so it has to be redone for every
release, and there's no API — it's a manual form each time. That's precisely the
treadmill signing gets you off of.

### Publish to winget

SmartScreen's dialog is triggered by
[Mark-of-the-Web](https://learn.microsoft.com/windows/win32/shell/fa-mark-of-the-web),
the tag a *browser* puts on a downloaded file. `winget` downloads with its own HTTP
client and usually doesn't set it, so `winget install x-salmon.Shellby` typically never
shows the dialog at all, and `winget` verifies the SHA-256 from its manifest instead.
Manifests and submission steps are in [../packaging/winget](../packaging/winget).

This doesn't help people who download from the Releases page, and it doesn't touch the
UAC "Unknown publisher" line.
