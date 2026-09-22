#!/bin/bash
# Boot an AVD, install the example Debug APK, reverse Metro to localhost:8081.
# Usage: scripts/perf/android/boot-install.sh <emulatorLogFile>
# Env: ANDROID_SDK_ROOT, DND_AVD (defaults to Medium_Phone).
set -u
SDK="${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}"
ADB="$SDK/platform-tools/adb"
EMU="$SDK/emulator/emulator"
AVD="${DND_AVD:-Medium_Phone}"
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
APK="$REPO/example/android/app/build/outputs/apk/debug/app-debug.apk"
LOG="$1"
if ! "$ADB" devices | grep -q "emulator-"; then
  nohup "$EMU" -avd "$AVD" -no-snapshot-save -no-boot-anim -netdelay none -netspeed full -gpu swiftshader_indirect > "$LOG" 2>&1 &
  echo "emulator launched pid=$!"
fi
"$ADB" wait-for-device
for i in $(seq 1 90); do
  if [ "$("$ADB" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; then break; fi
  sleep 2
done
echo "boot_completed=$("$ADB" shell getprop sys.boot_completed | tr -d '\r') after ~$((i*2))s"
"$ADB" reverse tcp:8081 tcp:8081
"$ADB" install -r "$APK" 2>&1 | tail -1
"$ADB" shell am start -n layoutdnd.example/.MainActivity 2>&1 | tail -1
sleep 8
"$ADB" shell dumpsys window 2>/dev/null | grep -m1 "mCurrentFocus"
curl -s http://localhost:8081/json/list | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const t of JSON.parse(s)) console.log(t.title, "|", t.description||"", "|", t.deviceName||"")})'
