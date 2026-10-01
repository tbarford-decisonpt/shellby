#!/usr/bin/env bash
# Forwards this Claude Code hook event (JSON on stdin) to Shellby on this PC, so
# the desktop crab works, asks and celebrates along with your sessions.
# Local only (127.0.0.1). It never prints and always exits 0, so it can't block
# or change anything Claude does.
port="${SHELLBY_PORT:-47913}"
# Shellby leaves this marker while it's listening. Without it, skip instantly:
# on Windows a refused localhost connection would otherwise cost ~1 s per hook.
[ -f "${TEMP:-${TMPDIR:-/tmp}}/shellby-hooks-$port" ] || exit 0
curl -s -m 1 --connect-timeout 0.3 -o /dev/null \
  -H "X-Shellby: 1" \
  -H "X-Shellby-Owned: ${SHELLBY_OWNED:-0}" \
  -H "Content-Type: application/json" \
  --data-binary @- \
  "http://127.0.0.1:$port/v1/hook" >/dev/null 2>&1
exit 0
