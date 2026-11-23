#!/usr/bin/env bash
# Builds dist/Hotseat.dmg: the menu bar app with its CLI inside, and a link to
# Applications to drag it onto. Everything is built in a scratch folder, and
# the DMG replaces dist/Hotseat.dmg only once it is complete; dist/hotseat and
# macos/build are left as they are. The release workflow runs it on every push
# to main.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

bun build bin/hotseat.ts --compile --target=bun-darwin-arm64 --outfile "$work/hotseat"
HOTSEAT_CLI="$work/hotseat" HOTSEAT_BUILD_DIR="$work/build" bash macos/build.sh

mkdir -p "$work/image/Hotseat" dist
cp -R "$work/build/Hotseat.app" "$work/image/Hotseat/"
ln -s /Applications "$work/image/Hotseat/Applications"
hdiutil create -volname Hotseat -srcfolder "$work/image/Hotseat" -fs HFS+ -format UDZO -ov "$work/Hotseat.dmg" >/dev/null
mv -f "$work/Hotseat.dmg" dist/Hotseat.dmg
echo "built $root/dist/Hotseat.dmg"
