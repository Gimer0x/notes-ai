#!/bin/zsh
# Dev `electron .` uses the host app in node_modules. Name that host Pith and
# install the square icon. Leave Electron's in-app name alone (package.json
# "name") so the existing Keychain item stays "pith-frontend Safe Storage".
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
dist="$root/node_modules/electron/dist"
electron_app="$dist/Electron.app"
pith_app="$dist/Pith.app"
path_txt="$root/node_modules/electron/path.txt"
src="$root/build/icon.icns"

if [[ ! -d "$dist" ]]; then
  echo "electron dist missing; skip dock icon" >&2
  exit 0
fi

if [[ -d "$electron_app" ]]; then
  rm -rf "$pith_app"
  mv "$electron_app" "$pith_app"
elif [[ ! -d "$pith_app" ]]; then
  echo "Electron.app not found; skip dock icon" >&2
  exit 0
fi

plist="$pith_app/Contents/Info.plist"
# Visible name in the Dock and in macOS prompts. The Keychain item name comes
# from package.json ("pith-frontend"), not from these keys.
/usr/libexec/PlistBuddy -c "Set :CFBundleName Pith" "$plist" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Add :CFBundleName string Pith" "$plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName Pith" "$plist" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Add :CFBundleDisplayName string Pith" "$plist"

if [[ -f "$src" ]]; then
  cp "$src" "$pith_app/Contents/Resources/electron.icns"
fi

# electron/index.js does not trim path.txt — a trailing newline makes spawn fail.
printf '%s' 'Pith.app/Contents/MacOS/Electron' > "$path_txt"

codesign --force --deep --sign - "$pith_app" >/dev/null
echo "Dock name is Pith"
