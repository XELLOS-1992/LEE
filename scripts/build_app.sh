#!/bin/bash
# Build 회의노트.app (a native window around the local engine) into ~/Applications.
# Usage: scripts/build_app.sh [destination-folder]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${1:-$HOME/Applications}"
APP="$DEST/회의노트.app"
BUILD="$(mktemp -d)"
trap 'rm -rf "$BUILD"' EXIT

[ "$(uname)" = "Darwin" ] || { echo "macOS에서만 앱을 만들 수 있습니다."; exit 1; }
[ -x "$ROOT/.venv/bin/python" ] || { echo "먼저 scripts/install.sh 를 실행하세요."; exit 1; }

echo "▸ 앱 아이콘 만드는 중"
ICONSET="$BUILD/AppIcon.iconset"
mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  sips -z $s $s "$ROOT/scripts/icon-1024.png" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  d=$((s * 2))
  sips -z $d $d "$ROOT/scripts/icon-1024.png" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$BUILD/AppIcon.icns"

ROOT_XML="$(printf '%s' "$ROOT" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g')"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BUILD/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>회의노트</string>
  <key>CFBundleDisplayName</key><string>회의노트</string>
  <key>CFBundleIdentifier</key><string>app.meetnote.local</string>
  <key>CFBundleVersion</key><string>1.0.0</string>
  <key>CFBundleShortVersionString</key><string>1.0.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>MeetNote</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundleDevelopmentRegion</key><string>ko</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.productivity</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSSupportsAutomaticGraphicsSwitching</key><true/>
  <key>NSMicrophoneUsageDescription</key><string>회의를 녹음하고 받아쓰기 위해 마이크를 사용합니다. 녹음은 이 Mac에만 저장됩니다.</string>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
  <key>MeetNoteRoot</key><string>$ROOT_XML</string>
</dict>
</plist>
PLIST

if command -v swiftc >/dev/null 2>&1; then
  echo "▸ 네이티브 앱 컴파일 중 (swiftc)"
  cp "$ROOT/scripts/MeetNoteApp.swift" "$BUILD/main.swift"
  ARCH="$(uname -m)"
  if swiftc -O -target "$ARCH-apple-macos12.0" -framework Cocoa -framework WebKit \
       "$BUILD/main.swift" -o "$APP/Contents/MacOS/MeetNote" 2>"$BUILD/swift.log"; then
    NATIVE=1
  else
    echo "  (컴파일 실패 — 브라우저 창 방식으로 만듭니다. 자세한 내용: $ROOT/build-swift.log)"
    cp "$BUILD/swift.log" "$ROOT/build-swift.log"
    NATIVE=0
  fi
else
  echo "  (swiftc 없음 — 'xcode-select --install' 후 다시 실행하면 네이티브 창으로 만듭니다)"
  NATIVE=0
fi

if [ "$NATIVE" = 0 ]; then
  # Fallback: start the engine and open the UI in a Chromium app window / the default browser.
  cat > "$APP/Contents/MacOS/MeetNote" <<SH
#!/bin/bash
cd "$ROOT"
exec "$ROOT/.venv/bin/python" -m meetnote
SH
  chmod +x "$APP/Contents/MacOS/MeetNote"
fi

codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || true
touch "$APP"
echo "✓ 만들었습니다: $APP"
