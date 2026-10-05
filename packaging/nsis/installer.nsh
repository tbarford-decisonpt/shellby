; Uninstall: ask whether Shellby's data folder (%APPDATA%\Shellby) goes too.
;
; Only when someone is at the screen removing him. Not on an update (the old
; version's uninstaller runs with --updated, silently), and not on a silent
; uninstall (winget, scripts): those keep everything, and a script that wants
; it gone passes electron-builder's own --delete-app-data. No is the default,
; so pressing Enter keeps it.
;
; Yes also removes the shellby command (%LOCALAPPDATA%\Shellby). Pictures\Shellby
; is never touched: those are pictures you saved.
;
; The folder holds Claude's working copies of projects (worktrees), which can
; have changes nobody pushed, so the question says so when there are any.

; app.getPath('userData'): the productName, not the package name.
!define SHELLBY_DATA "$APPDATA\Shellby"

!macro customUnInstall
  ${IfNot} ${isUpdated}
  ${AndIfNot} ${Silent}
    ; Electron keeps app data per user, even for a per-machine install.
    ${If} $installMode == "all"
      SetShellVarContext current
    ${EndIf}

    ; The update cache only ever holds a downloaded installer: always safe to drop.
    RMDir /r "$LOCALAPPDATA\shellby-updater"

    ${If} ${FileExists} "${SHELLBY_DATA}\*.*"
      StrCpy $R8 "That's his settings, history, trophies and wardrobe."
      ${If} ${FileExists} "${SHELLBY_DATA}\worktrees\*.*"
        StrCpy $R8 "$R8$\r$\n$\r$\nIt also holds Claude's working copies of your projects, which may have changes you haven't pushed."
      ${EndIf}
      MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Delete Shellby's data too?$\r$\n$\r$\n$R8$\r$\n$\r$\nChoose No to keep it, so a reinstall picks up where he left off.$\r$\n$\r$\n${SHELLBY_DATA}" /SD IDNO IDNO shellby_keep_data
        RMDir /r "${SHELLBY_DATA}"
        ; The shellby command (clipath.js): no use without him.
        RMDir /r "$LOCALAPPDATA\Shellby"
      shellby_keep_data:
    ${EndIf}

    ${If} $installMode == "all"
      SetShellVarContext all
    ${EndIf}
  ${EndIf}
!macroend
