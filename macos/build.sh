#!/usr/bin/env bash
# Builds the menu bar app into macos/build/Hotseat.app.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(dirname "$here")"
final_app="$here/build/Hotseat.app"
# Build beside the current app and swap at the end, so a failed build leaves
# the previous app in place rather than nothing at all.
app="$here/build/Hotseat.app.building"
macos_dir="$app/Contents/MacOS"
resources_dir="$app/Contents/Resources"

rm -rf "$app"
mkdir -p "$macos_dir" "$resources_dir"

# The icon is drawn from code so it is reviewable and reproducible.
if [ ! -f "$here/Icon/Hotseat.icns" ] || [ "$here/Icon/MakeIcon.swift" -nt "$here/Icon/Hotseat.icns" ]; then
	iconset="$(mktemp -d)/hotseat.iconset"
	mkdir -p "$iconset"
	swiftc -target arm64-apple-macos14.0 -framework AppKit -o "$iconset/../makeicon" "$here/Icon/MakeIcon.swift"
	"$iconset/../makeicon" "$iconset"
	iconutil -c icns "$iconset" -o "$here/Icon/Hotseat.icns"
	cp "$iconset/icon_512x512.png" "$here/Icon/icon.png"
fi
cp "$here/Icon/Hotseat.icns" "$resources_dir/Hotseat.icns"
cp "$here"/Logos/*.svg "$resources_dir/"

cat > "$app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleName</key><string>Hotseat</string>
	<key>CFBundleDisplayName</key><string>Hotseat</string>
	<key>CFBundleIdentifier</key><string>dev.hotseat.menubar</string>
	<key>CFBundleExecutable</key><string>Hotseat</string>
	<key>CFBundleIconFile</key><string>Hotseat</string>
	<key>CFBundlePackageType</key><string>APPL</string>
	<key>CFBundleShortVersionString</key><string>0.1.0</string>
	<key>CFBundleVersion</key><string>1</string>
	<key>LSMinimumSystemVersion</key><string>14.0</string>
	<key>LSUIElement</key><true/>
	<key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

# The launch agent the app registers for itself to start at login
# (hotseat menubar install).
agents_dir="$app/Contents/Library/LaunchAgents"
mkdir -p "$agents_dir"
cat > "$agents_dir/dev.hotseat.login.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>dev.hotseat.login</string>
	<key>BundleProgram</key><string>Contents/MacOS/Hotseat</string>
	<key>ProgramArguments</key>
	<array>
		<string>Hotseat</string>
	</array>
	<key>RunAtLoad</key><true/>
	<key>KeepAlive</key><false/>
	<key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
PLIST
plutil -lint -s "$agents_dir/dev.hotseat.login.plist"

swiftc \
	-O -whole-module-optimization \
	-target arm64-apple-macos14.0 \
	-framework AppKit \
	-o "$macos_dir/Hotseat" \
	"$here/Sources/Model.swift" \
	"$here/Sources/Logo.swift" \
	"$here/Sources/Runner.swift" \
	"$here/Sources/AccountRowView.swift" \
	"$here/Sources/LoginItem.swift" \
	"$here/Sources/main.swift"

# Render check: a highlight added as a subview paints over the row, which only
# shows up on screen. This catches it at build time.
tmp="$(mktemp -d)"
cp "$here/Tests/RenderCheck.swift" "$tmp/main.swift"
swiftc -target arm64-apple-macos14.0 -framework AppKit -o "$tmp/rendercheck" \
	"$here/Sources/Model.swift" "$here/Sources/Logo.swift" "$here/Sources/Runner.swift" "$here/Sources/AccountRowView.swift" "$tmp/main.swift"
HOTSEAT_LOGOS="$here/Logos" "$tmp/rendercheck"
rm -rf "$tmp"

# Signs with this Mac's Apple Development certificate when there is one,
# otherwise ad hoc.
identity="$(security find-identity -v -p codesigning | awk '/"Apple Development/ { print $2; exit }')"
if [ -z "$identity" ]; then
	identity="-"
	echo "note: no Apple Development certificate on this Mac, so the app is signed ad hoc and" >&2
	echo "      starting at login stops working after each rebuild. Add your Apple ID in" >&2
	echo "      Xcode > Settings > Accounts, then Manage Certificates > + > Apple Development." >&2
fi
codesign --force --sign "$identity" "$app"
rm -rf "$final_app"
mv "$app" "$final_app"

# A login item that was on is registered again for the new build.
if [ "$("$final_app/Contents/MacOS/Hotseat" --login-item status 2>/dev/null)" = "enabled" ]; then
	"$final_app/Contents/MacOS/Hotseat" --login-item on >/dev/null
fi

echo "built $final_app"
echo "run: hotseat menubar"
