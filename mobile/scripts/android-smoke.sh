#!/usr/bin/env bash
# Nova for Android in an emulator (CI): start the phone's own server and use it through adb's port forward.
# Usage: android-smoke.sh path/to/app-debug.apk
set -uo pipefail
APK="$1"
PKG=io.github.fmlgamer.nova
URL=http://127.0.0.1:11471

adb install -r "$APK"
adb shell am start -n "$PKG/.MainActivity" --ez novaLocalServer true
adb forward tcp:11471 tcp:11471

ok=""
for _ in $(seq 1 150); do
  if curl -sf "$URL/healthz"; then ok=1; break; fi
  sleep 2
done
echo
echo "---- app log"
adb logcat -d -s NovaLocal:V | tail -n 40
echo "---- server log"
adb shell run-as "$PKG" cat files/nova/logs/server.log | tail -n 80
[ -n "$ok" ] || { echo "FAIL: the server on the phone didn't start"; exit 1; }

set -e
echo "---- config"
curl -sf "$URL/api/config"; echo
KEY=$(adb shell run-as "$PKG" cat files/nova/desktop.key | tr -d '\r\n')
TOKEN=$(curl -sf -X POST -H "X-Nova-Desktop-Key: $KEY" "$URL/api/desktop/session" | node -pe 'JSON.parse(require("fs").readFileSync(0, "utf8")).token')
COOKIE="Cookie: stream_session=$TOKEN"
echo "---- signed in; search (HTTPS to the metadata services)"
curl -sf -H "$COOKIE" "$URL/api/catalog/search?q=frieren" | node -e '
  const j = JSON.parse(require("fs").readFileSync(0, "utf8"));
  const top = j.top || [];
  console.log("results:", top.length, top.slice(0, 3).map((x) => x.title).join(" | "));
  if (!top.length) process.exit(1);'
echo "---- a write and a read back (node:sqlite)"
PROFILE=$(curl -sf -H "$COOKIE" "$URL/api/profiles" | node -pe 'const j = JSON.parse(require("fs").readFileSync(0, "utf8")); (j.profiles || j)[0].id')
curl -sf -H "$COOKIE" -H "X-Profile-Id: $PROFILE" -H 'Content-Type: application/json' -X POST "$URL/api/list" -d '{"mediaId":"anime:154587","mediaType":"anime","title":"Frieren","poster":null}' >/dev/null
curl -sf -H "$COOKIE" -H "X-Profile-Id: $PROFILE" "$URL/api/list" | node -e '
  const j = JSON.parse(require("fs").readFileSync(0, "utf8"));
  console.log("my list:", (j.items || []).map((x) => x.mediaId).join(", "));
  if (!(j.items || []).length) process.exit(1);'
echo "---- the web app"
curl -sf "$URL/" | head -c 120; echo
echo "---- plugin sandbox (child processes with Node's permission model)"
curl -sf -H "$COOKIE" -H "X-Profile-Id: $PROFILE" "$URL/api/admin/overview" | node -pe 'const s = JSON.parse(require("fs").readFileSync(0, "utf8")).server; "sandbox: " + s.sandbox + ", library: " + JSON.stringify(s.library.storage)'
echo "OK: Nova runs on the phone"
