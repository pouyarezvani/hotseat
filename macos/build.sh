#!/usr/bin/env bash
# Builds the menu bar app into macos/build/Hotseat.app.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(dirname "$here")"
app="$here/build/Hotseat.app"
macos_dir="$app/Contents/MacOS"

rm -rf "$app"
mkdir -p "$macos_dir"

cat > "$app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleName</key><string>Hotseat</string>
	<key>CFBundleDisplayName</key><string>Hotseat</string>
	<key>CFBundleIdentifier</key><string>dev.hotseat.menubar</string>
	<key>CFBundleExecutable</key><string>Hotseat</string>
	<key>CFBundlePackageType</key><string>APPL</string>
	<key>CFBundleShortVersionString</key><string>0.1.0</string>
	<key>CFBundleVersion</key><string>1</string>
	<key>LSMinimumSystemVersion</key><string>13.0</string>
	<key>LSUIElement</key><true/>
	<key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

swiftc \
	-O -whole-module-optimization \
	-target arm64-apple-macos13.0 \
	-framework AppKit \
	-o "$macos_dir/Hotseat" \
	"$here/Sources/Model.swift" \
	"$here/Sources/Runner.swift" \
	"$here/Sources/AccountRowView.swift" \
	"$here/Sources/main.swift"

# Render check: a highlight added as a subview paints over the row, which only
# shows up on screen. This catches it at build time.
tmp="$(mktemp -d)"
cp "$here/Tests/RenderCheck.swift" "$tmp/main.swift"
swiftc -target arm64-apple-macos13.0 -framework AppKit -o "$tmp/rendercheck" \
	"$here/Sources/Model.swift" "$here/Sources/AccountRowView.swift" "$tmp/main.swift"
"$tmp/rendercheck"
rm -rf "$tmp"

codesign --force --sign - "$app" >/dev/null 2>&1 || true

echo "built $app"
echo "run: HOTSEAT_BIN=$root/dist/hotseat open $app"
