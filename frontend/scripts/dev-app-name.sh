#!/bin/zsh
# Dev only: the Dock label is the .app file name, so the unpacked host must be
# Pith.app. Do not codesign it (that exits SIGTRAP) and do not call app.setName
# (that creates a new Keychain item).
set -e
[[ "$(uname)" == "Darwin" ]] || exit 0
cd "${0:A:h}/.."
dist="node_modules/electron/dist"
if [[ -d "$dist/Electron.app" ]]; then
  rm -rf "$dist/Pith.app"
  mv "$dist/Electron.app" "$dist/Pith.app"
fi
bundle="$dist/Pith.app"
plist="$bundle/Contents/Info.plist"
[[ -f "$plist" ]] || exit 0
name="Pith"
if [[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleName' "$plist")" != "$name" ]]; then
  /usr/libexec/PlistBuddy -c "Set :CFBundleName $name" "$plist"
  /usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName $name" "$plist"
fi
# No trailing newline: the Electron launcher treats the whole file as the path.
printf '%s' 'Pith.app/Contents/MacOS/Electron' > node_modules/electron/path.txt
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$bundle" >/dev/null 2>&1 || true
