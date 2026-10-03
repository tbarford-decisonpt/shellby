# Code signing

Unsigned Windows apps get the SmartScreen "Windows protected your PC" warning. Shellby's release workflow can sign every build automatically once a signing account is connected: [SignPath Foundation](#recommended-signpath-foundation-free) (free for open source) or [Azure Artifact Signing](#paid-azure-artifact-signing) (about $10/month). Until then, releases are unsigned and still publish `SHA256SUMS.txt` so people can verify downloads.

## What signing does (and doesn't)

- **It does:** puts a verified publisher name on the installer and app ("Verified publisher: …" instead of "Unknown publisher"), proves the file wasn't changed after it was built, and lets SmartScreen build up **reputation** for that publisher. Once there's enough reputation, the warning goes away for every future release. Unsigned builds start over at zero reputation with every new version, because SmartScreen tracks them by file hash.
- **It doesn't:** remove the warning instantly. Even signed apps from new publishers can show it until enough people have installed them. EV certificates used to skip this, but Microsoft stopped giving them special treatment in 2024.

## Free stopgaps (no certificate)

Neither of these is a substitute for signing, but both are free and both cut down how
often anyone meets the warning.

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

## Recommended: SignPath Foundation (free)

[SignPath Foundation](https://signpath.org) signs open-source projects for free. Shellby qualifies: the repo is public, it's GPL-3.0 (OSI-approved, not dual-licensed), and releases are already built by GitHub Actions from the tagged commit.

The trade-offs, compared with Azure:

- **The publisher shown is "SignPath Foundation"**, not you. Their certificate already has a lot of SmartScreen reputation from other projects, which is the part that makes the warning go away.
- **Every release needs approving.** Each signing request waits for an approver to click **Approve** on signpath.io. The release run waits for up to an hour, then fails without publishing anything; re-run it to try again.
- **Only CI builds can be signed.** SignPath fetches the files straight from the release run's artifacts, so a build from your own PC can't be.
- **Only the installer and the portable exe are signed**, not `Shellby.exe` inside the installer. SmartScreen only checks files that came from a browser download, and the installed app doesn't, so it isn't needed.

### What the project has to do

These are SignPath Foundation's [conditions](https://signpath.org/terms). Shellby already meets them, as long as these stay true:

- The [code signing policy](../README.md#code-signing-policy) stays in the README, listing who can change code, review it and approve signing.
- Everyone in those roles uses **two-factor authentication** on both GitHub and SignPath.
- Only Shellby's own files built from this repo get signed. Nothing proprietary goes into the build.
- What Shellby sends over the network stays documented ([Privacy](../README.md#privacy)), and it keeps an uninstaller.

### One-time setup

1. **Apply** at [signpath.org/apply](https://signpath.org/apply) with the repo URL. They check the project, which can take a few weeks.
2. **Once accepted**, they set up an organization for you. In it:
   - Connect **GitHub.com** as a *Trusted Build System* to the Shellby project, and install the SignPath GitHub App on the repo when asked.
   - Under the project, create an **artifact configuration** from [packaging/signpath/artifact-configuration.xml](../packaging/signpath/artifact-configuration.xml) and make it the default. It only lets the installer and portable exe be signed, and only when their product name is Shellby and their version is the one being released.
   - Note the **project slug** and the **signing policy slug** (the Foundation calls it `release-signing`).
   - Create an **API token** for a CI user with the *Submitter* role on that policy.
3. **Add these to the GitHub repo** (Settings → Secrets and variables → Actions):

   | Kind | Name | Value |
   |---|---|---|
   | Secret | `SIGNPATH_API_TOKEN` | The CI user's API token |
   | Variable | `SIGNPATH_ORGANIZATION_ID` | Your SignPath organization ID (a GUID) |
   | Variable | `SIGNPATH_PROJECT_SLUG` | Only if it isn't `shellby` |
   | Variable | `SIGNPATH_POLICY_SLUG` | Only if it isn't `release-signing` |

4. **Tag a release** and approve the request when SignPath emails you. The workflow uploads the signed files, rebuilds `latest.yml` and the blockmap for the signed installer (signing changes its hash, and updaters refuse a hash that doesn't match), and checks that both exes are validly signed by SignPath Foundation before publishing.
5. **Then tidy up the wording.** Drop the "not signed yet" notes from the README's install section and [.github/release-notes.md](../.github/release-notes.md), and the "applying for this" note in the code signing policy.

Configure SignPath *or* Azure, not both: the workflow stops if it finds both.

## Paid: Azure Artifact Signing

[Azure Artifact Signing](https://learn.microsoft.com/azure/artifact-signing/) (formerly Trusted Signing) is Microsoft's own signing service. It costs about **$10/month** (Basic tier), keys live in Microsoft's HSMs so there's no USB token to lose, and electron-builder supports it directly. Individual developers in the US and Canada can sign up with a government ID; organizations need a few years of verifiable history.

The alternative is a regular OV certificate from a CA, which costs roughly $200–400 a year. Since 2023 those keys must live on a hardware token or a cloud HSM, which is awkward to use from CI.

### One-time setup

1. **Create the account.** In the [Azure portal](https://portal.azure.com), create an *Artifact Signing* (Trusted Signing) account. Note its **endpoint** (e.g. `https://eus.codesigning.azure.net/`) and the account name.
2. **Verify your identity.** Create an *identity validation* request (Individual, Public Trust). Microsoft checks your ID, which can take a few days.
3. **Create a certificate profile** (Public Trust) tied to that validation. Note the profile name.
4. **Create an app registration** (Microsoft Entra ID → App registrations → New) with a **client secret**, and give it the **Artifact Signing Certificate Profile Signer** role on the signing account.
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

6. **Tag a release.** The workflow notices the credentials, signs the installer and the app, and checks that both signatures are valid before publishing.

Without these settings the workflow builds unsigned and prints a warning; nothing else changes. Auto-update keeps working across the switch from unsigned to signed builds.
