#!/bin/sh
set -eu

repo=/Users/goumin/Services/goumin-work/repo
. "$repo/deploy/macos/runtime-versions.env"

test "$(/Users/goumin/.bun/bin/bun --version)" = "$GOU_MIN_BUN_VERSION"
case "$(/Users/goumin/.local/bin/caddy version)" in
  "$GOU_MIN_CADDY_VERSION "*) ;;
  *) echo "Unexpected Caddy version" >&2; exit 1 ;;
esac
case "$(/Users/goumin/.local/bin/cloudflared --version)" in
  "cloudflared version $GOU_MIN_CLOUDFLARED_VERSION "*) ;;
  *) echo "Unexpected cloudflared version" >&2; exit 1 ;;
esac

curl --fail --silent --show-error --max-time 5 http://127.0.0.1:8080/ >/dev/null
curl --fail --silent --show-error --max-time 5 http://127.0.0.1:8081/studio/login >/dev/null
curl --fail --silent --show-error --max-time 5 \
  -H 'Host: studio.goumin.work' \
  http://127.0.0.1:8081/api/studio/auth/github/start >/dev/null

test -r /Users/goumin/Services/goumin-work/runtime/offsite-backup-state.json
find /Users/goumin/Services/goumin-work/runtime/locks -type d -name '*.stale.*' -mtime +1 -print -quit |
  grep -q . && { echo "Stale runtime lock debris found" >&2; exit 1; } || true
