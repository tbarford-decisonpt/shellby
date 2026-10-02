# Code signing

Unsigned Windows apps get the SmartScreen "Windows protected your PC" warning. Shellby's release workflow can sign every build automatically once a signing account is connected. Until then, releases are unsigned and still publish `SHA256SUMS.txt` so people can verify downloads.

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

## Recommended: Azure Artifact Signing

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
