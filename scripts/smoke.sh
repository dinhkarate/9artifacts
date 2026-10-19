#!/bin/sh
# Smoke-test a running 9artifacts after an upgrade or deploy.
#   scripts/smoke.sh https://art.example.com
# Without a token: health, the app shell, and that the API answers below 500.
# With NINEARTIFACTS_TOKEN: also publish, read the content back, add a version,
# share, comment and delete a throwaway artifact.
set -eu
B="${1:?usage: smoke.sh URL}"; B="${B%/}"
T="${NINEARTIFACTS_TOKEN:-}"
fail=0

check() { # name expected actual
  if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1: want $2, got $3"; fail=1; fi
}
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
field() { sed -n "s/.*\"$1\":\"\([^\"]*\)\".*/\1/p" | head -1; }

check health 200 "$(code "$B/health")"
check app 200 "$(code "$B/")"
if [ -n "$T" ]; then api=$(code -H "Authorization: Bearer $T" "$B/api/artifacts"); else api=$(code "$B/api/artifacts"); fi
case "$api" in 5* | 000) echo "FAIL api list: got $api"; fail=1 ;; *) echo "ok   api list ($api)" ;; esac

if [ -n "$T" ]; then
  H="Authorization: Bearer $T"
  body=$(curl -s -H "$H" -H 'content-type: application/json' \
    -d '{"title":"smoke","tags":["smoke"],"files":[{"name":"index.html","content":"<!doctype html><title>smoke</title><p>smoke-v1</p>"}]}' \
    "$B/api/artifacts")
  id=$(printf '%s' "$body" | field id)
  view=$(printf '%s' "$body" | field viewBase)
  if [ -z "$id" ]; then
    echo "FAIL publish: $(printf '%s' "$body" | head -c 300)"; exit 1
  fi
  echo "ok   publish $id"
  check content smoke-v1 "$(curl -s "${view}index.html" | grep -o smoke-v1 || true)"
  check version 201 "$(code -H "$H" -H 'content-type: application/json' \
    -d '{"files":[{"name":"index.html","content":"<p>smoke-v2</p>"}]}' "$B/api/artifacts/$id/versions")"
  share=$(curl -s -H "$H" -H 'content-type: application/json' -d '{"ttl":"1h"}' "$B/api/artifacts/$id/shares" | field url)
  check share 200 "$(code "$share")"
  check comment 201 "$(code -H "$H" -H 'content-type: application/json' -d '{"body":"smoke"}' "$B/api/artifacts/$id/comments")"
  check delete 200 "$(code -X DELETE -H "$H" "$B/api/artifacts/$id")"
fi
exit $fail
