#!/bin/bash
# Build LidAwake.app (a menu-bar-only bundle) from the SwiftPM executable.
# Usage: ./scripts/make-app.sh   → produces ./dist/LidAwake.app
set -euo pipefail

cd "$(dirname "$0")/.."

APP_NAME="LidAwake"
DIST_DIR="dist"
APP_DIR="${DIST_DIR}/${APP_NAME}.app"

swift build -c release

rm -rf "${APP_DIR}"
mkdir -p "${APP_DIR}/Contents/MacOS"

BIN_PATH="$(swift build -c release --show-bin-path)/${APP_NAME}"
cp "${BIN_PATH}" "${APP_DIR}/Contents/MacOS/${APP_NAME}"

cat > "${APP_DIR}/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key>
    <string>LidAwake</string>
    <key>CFBundleIdentifier</key>
    <string>com.mulmoclaude.lidawake</string>
    <key>CFBundleName</key>
    <string>LidAwake</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>1.0.0</string>
    <key>CFBundleVersion</key>
    <string>1</string>
    <key>LSMinimumSystemVersion</key>
    <string>13.0</string>
    <key>LSUIElement</key>
    <true/>
    <key>NSHumanReadableCopyright</key>
    <string>MIT License</string>
</dict>
</plist>
PLIST

# Ad-hoc signature so Gatekeeper allows the locally built bundle to run.
codesign --force --sign - "${APP_DIR}"

echo "Built ${APP_DIR}"
echo "Run it with: open ${APP_DIR}"
