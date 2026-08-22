#!/bin/zsh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
swift build -c release --package-path "$ROOT/CaptureHelper"
BIN="$ROOT/CaptureHelper/.build/release/CaptureHelper"
APP="$ROOT/CaptureHelper.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/en.lproj" "$APP/Contents/Resources/es.lproj"
cp "$BIN" "$APP/Contents/MacOS/CaptureHelper"
cp "$ROOT/CaptureHelper/Info.plist" "$APP/Contents/Info.plist"
cp "$ROOT/CaptureHelper/en.lproj/InfoPlist.strings" "$APP/Contents/Resources/en.lproj/"
cp "$ROOT/CaptureHelper/es.lproj/InfoPlist.strings" "$APP/Contents/Resources/es.lproj/"
codesign --force --sign - --timestamp=none \
  --entitlements "$ROOT/CaptureHelper/CaptureHelper.entitlements" \
  "$APP"
