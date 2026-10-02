#!/usr/bin/env bash
# Forwards this Claude Code hook event (JSON on stdin) to Shellby on this PC, so
# the desktop crab works, asks and celebrates along with your sessions.
# Local only (127.0.0.1). It never prints and always exits 0, so it can't block
# or change anything Claude does.
port="${SHELLBY_PORT:-47913}"
# Shellby leaves this marker while it's listening. Without it, skip instantly:
# on Windows a refused localhost connection would otherwise cost ~1 s per hook.
[ -f "${TEMP:-${TMPDIR:-/tmp}}/shellby-hooks-$port" ] || exit 0

# Which app this session is running in, so the crab can say "shellby in Cursor"
# instead of just "Claude Code". Only ever a single word from the list below:
# the paths it is recognised from carry your user name, and those stay here.
host=""
case "${TERM_PROGRAM:-}" in
  vscode)
    # Cursor and Windsurf are VS Code forks and report themselves as vscode;
    # the editor's own helper path is what tells them apart.
    case "${VSCODE_GIT_ASKPASS_NODE:-}${VSCODE_CWD:-}" in
      *[Cc]ursor*)   host=cursor ;;
      *[Ww]indsurf*) host=windsurf ;;
      *)             host=vscode ;;
    esac ;;
  zed) host=zed ;;
  WarpTerminal|WarpTerminal.app) host=warp ;;
  ghostty) host=ghostty ;;
  Apple_Terminal) host=appleterm ;;
  iTerm.app) host=iterm ;;
  Hyper) host=hyper ;;
  Tabby) host=tabby ;;
  WezTerm) host=wezterm ;;
  kitty) host=kitty ;;
esac
if [ -z "$host" ]; then
  case "${TERMINAL_EMULATOR:-}" in *JetBrains*) host=jetbrains ;; esac
fi
if [ -z "$host" ]; then
  if [ -n "${WT_SESSION:-}" ]; then host=wt
  elif [ -n "${ConEmuPID:-}" ]; then host=conemu
  elif [ -n "${ALACRITTY_WINDOW_ID:-}" ]; then host=alacritty
  elif [ -n "${WEZTERM_PANE:-}" ]; then host=wezterm
  elif [ -n "${VSAPPIDNAME:-}" ]; then host=vs
  fi
fi

curl -s -m 1 --connect-timeout 0.3 -o /dev/null \
  -H "X-Shellby: 1" \
  -H "X-Shellby-Owned: ${SHELLBY_OWNED:-0}" \
  -H "X-Shellby-Host: $host" \
  -H "X-Shellby-Entry: ${CLAUDE_CODE_ENTRYPOINT:-}" \
  -H "Content-Type: application/json" \
  --data-binary @- \
  "http://127.0.0.1:$port/v1/hook" >/dev/null 2>&1
exit 0
