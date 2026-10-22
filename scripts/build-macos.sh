#!/usr/bin/env bash

set -euo pipefail

PROJECT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "macOS 安装包只能在 macOS 上构建。" >&2
  exit 1
fi

for command_name in node npm xcrun codesign ditto pkgbuild; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "缺少构建命令：$command_name" >&2
    exit 1
  fi
done

HOST_ARCH="$(uname -m)"
case "$HOST_ARCH" in
  arm64)
    RELEASE_ARCH="arm64"
    CLOUDFLARED_VENDOR_ARCH="darwin-arm64"
    ;;
  x86_64)
    RELEASE_ARCH="x64"
    CLOUDFLARED_VENDOR_ARCH="darwin-amd64"
    ;;
  *)
    echo "不支持的 Mac 架构：$HOST_ARCH" >&2
    exit 1
    ;;
esac

VERSION="$(node -p 'require("./package.json").version')"
BUILD_NUMBER="${BUILD_NUMBER:-$(date +%Y%m%d%H%M)}"
APP_NAME="AI Workstation Remote"
ARTIFACT_BASENAME="AI-Workstation-Remote-${VERSION}-${RELEASE_ARCH}"
RELEASE_ROOT="$PROJECT_ROOT/release"
WORK_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/ai-workstation-release.XXXXXX")"
APP_PATH="$WORK_ROOT/$APP_NAME.app"
CONTENTS="$APP_PATH/Contents"
APP_RESOURCES="$CONTENTS/Resources/app"
RUNTIME_BIN="$CONTENTS/Resources/runtime/bin"
HELPERS="$CONTENTS/Helpers"
DMG_SOURCE="$WORK_ROOT/dmg"
DMG_PATH="$WORK_ROOT/$ARTIFACT_BASENAME.dmg"
PKG_PATH="$WORK_ROOT/$ARTIFACT_BASENAME.pkg"

cleanup() {
  rm -rf "$WORK_ROOT"
}
trap cleanup EXIT

echo "[1/9] 检查并构建 Web 与 TypeScript 资源"
npm run typecheck
npm run licenses
npm run build -w @ai-workstation/mobile

mkdir -p "$CONTENTS/MacOS" "$APP_RESOURCES/runtime" "$APP_RESOURCES/mobile" "$RUNTIME_BIN" "$HELPERS"
cp packaging/macos/Info.plist "$CONTENTS/Info.plist"
sed -i '' -e "s/__VERSION__/$VERSION/g" -e "s/__BUILD_NUMBER__/$BUILD_NUMBER/g" "$CONTENTS/Info.plist"
cp scripts/start-packaged.mjs "$APP_RESOURCES/start-packaged.mjs"
ditto apps/mobile/dist "$APP_RESOURCES/mobile"
mkdir -p "$APP_RESOURCES/licenses"
cp LICENSE THIRD_PARTY_NOTICES.md "$APP_RESOURCES/licenses/"
cp licenses/npm-dependencies.md licenses/npm-notices.txt "$APP_RESOURCES/licenses/"
cp vendor/cloudflared/LICENSE "$APP_RESOURCES/licenses/cloudflared-APACHE-2.0.txt"

echo "[2/9] 打包 Node 服务"
node_modules/.bin/esbuild services/control-plane/src/index.ts \
  --bundle --platform=node --target=node22 --format=cjs \
  --outfile="$APP_RESOURCES/runtime/control-plane.cjs"
node_modules/.bin/esbuild apps/mac-companion/src/index.ts \
  --bundle --platform=node --target=node22 --format=cjs \
  --outfile="$APP_RESOURCES/runtime/mac-companion.cjs"

echo "[3/9] 准备 Node、cloudflared 与 Cursor 扩展"
NODE_BIN="$(node -p 'require("node:fs").realpathSync(process.execPath)')"
cp "$NODE_BIN" "$RUNTIME_BIN/node"
chmod 755 "$RUNTIME_BIN/node"
NODE_LICENSE=""
for candidate in \
  "$(dirname -- "$NODE_BIN")/../LICENSE" \
  "$(dirname -- "$NODE_BIN")/LICENSE" \
  "$(dirname -- "$NODE_BIN")/../share/doc/node/LICENSE"; do
  if [ -f "$candidate" ]; then
    NODE_LICENSE="$candidate"
    break
  fi
done
if [ -z "$NODE_LICENSE" ]; then
  echo "找不到当前 Node.js 运行时附带的 LICENSE：$NODE_BIN" >&2
  exit 1
fi
cp "$NODE_LICENSE" "$APP_RESOURCES/licenses/node-LICENSE.txt"

CLOUDFLARED_SOURCE="${CLOUDFLARED_BIN:-}"
if [ -z "$CLOUDFLARED_SOURCE" ]; then
  CLOUDFLARED_SOURCE="$("$PROJECT_ROOT/scripts/ensure-cloudflared.sh" "$CLOUDFLARED_VENDOR_ARCH")"
fi
if [ ! -x "$CLOUDFLARED_SOURCE" ]; then
  echo "工程内的 cloudflared 不存在或不可执行：$CLOUDFLARED_SOURCE" >&2
  exit 1
fi
cp "$CLOUDFLARED_SOURCE" "$HELPERS/cloudflared"
chmod 755 "$HELPERS/cloudflared"

if ! file "$RUNTIME_BIN/node" | grep -q "$HOST_ARCH"; then
  echo "Node 架构与构建架构不匹配：$(file "$RUNTIME_BIN/node")" >&2
  exit 1
fi
EXPECTED_CLOUDFLARED_ARCH="$HOST_ARCH"
if [ "$HOST_ARCH" = "x86_64" ]; then EXPECTED_CLOUDFLARED_ARCH="x86_64"; fi
if ! file "$HELPERS/cloudflared" | grep -q "$EXPECTED_CLOUDFLARED_ARCH"; then
  echo "cloudflared 架构与构建架构不匹配：$(file "$HELPERS/cloudflared")" >&2
  exit 1
fi

node scripts/package-cursor-relay.mjs "$APP_RESOURCES/cursor-relay.vsix"
CURSOR_EXTENSION_VERSION="$(node -p 'require("./apps/cursor-relay-extension/package.json").version')"
cat > "$APP_RESOURCES/release-manifest.json" <<EOF
{
  "version": "$VERSION",
  "platform": "macos",
  "architecture": "$RELEASE_ARCH",
  "cursorExtensionId": "ai-workstation.ai-workstation-cursor-relay",
  "cursorExtensionVersion": "$CURSOR_EXTENSION_VERSION"
}
EOF

echo "[4/9] 编译 macOS 原生程序"
xcrun swiftc -O apps/mac-companion/native/cursor-input-helper.swift \
  -o "$HELPERS/cursor-input-helper" \
  -framework AppKit -framework ApplicationServices
xcrun swiftc -O packaging/macos/Launcher.swift \
  -o "$CONTENTS/MacOS/ai-workstation-remote" \
  -framework AppKit -framework CoreImage

echo "[5/9] 签名 App Bundle"
SIGN_IDENTITY="${MACOS_SIGN_IDENTITY:--}"
SIGN_ARGS=(--force --options runtime --sign "$SIGN_IDENTITY")
if [ "$SIGN_IDENTITY" != "-" ]; then SIGN_ARGS+=(--timestamp); fi

codesign "${SIGN_ARGS[@]}" --identifier com.aiworkstation.remote.node \
  --entitlements packaging/macos/node-entitlements.plist "$RUNTIME_BIN/node"
codesign "${SIGN_ARGS[@]}" --identifier com.aiworkstation.remote.cloudflared "$HELPERS/cloudflared"
codesign "${SIGN_ARGS[@]}" --identifier com.aiworkstation.remote.cursor-input-helper "$HELPERS/cursor-input-helper"
codesign "${SIGN_ARGS[@]}" --identifier com.aiworkstation.remote.launcher "$CONTENTS/MacOS/ai-workstation-remote"
codesign "${SIGN_ARGS[@]}" "$APP_PATH"
codesign --verify --strict --verbose=2 "$APP_PATH"

echo "[6/9] 生成 PKG 安装包"
PKG_ROOT="$WORK_ROOT/pkg-root"
COMPONENT_PLIST="$WORK_ROOT/component.plist"
mkdir -p "$PKG_ROOT"
ditto "$APP_PATH" "$PKG_ROOT/$APP_NAME.app"
cat > "$COMPONENT_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<array>
  <dict>
    <key>BundleHasStrictIdentifier</key>
    <true/>
    <key>BundleIsRelocatable</key>
    <false/>
    <key>BundleIsVersionChecked</key>
    <true/>
    <key>BundleOverwriteAction</key>
    <string>upgrade</string>
    <key>RootRelativeBundlePath</key>
    <string>$APP_NAME.app</string>
  </dict>
</array>
</plist>
EOF
PKG_ARGS=(
  --root "$PKG_ROOT"
  --component-plist "$COMPONENT_PLIST"
  --install-location /Applications
  --identifier com.aiworkstation.remote
  --version "$VERSION"
)
if [ -n "${MACOS_INSTALLER_IDENTITY:-}" ]; then
  PKG_ARGS+=(--sign "$MACOS_INSTALLER_IDENTITY")
fi
pkgbuild "${PKG_ARGS[@]}" "$PKG_PATH"

echo "[7/9] 可选生成 DMG"
DMG_CREATED=0
if [ "${BUILD_DMG:-0}" = "1" ]; then
  if ! command -v hdiutil >/dev/null 2>&1; then
    echo "缺少 hdiutil，无法生成 DMG。" >&2
    exit 1
  fi
  mkdir -p "$DMG_SOURCE"
  ditto "$APP_PATH" "$DMG_SOURCE/$APP_NAME.app"
  ln -s /Applications "$DMG_SOURCE/Applications"
  hdiutil create -quiet -volname "$APP_NAME" -srcfolder "$DMG_SOURCE" -ov -format UDZO "$DMG_PATH"
  if [ "$SIGN_IDENTITY" != "-" ]; then
    codesign --force --timestamp --sign "$SIGN_IDENTITY" "$DMG_PATH"
  fi
  DMG_CREATED=1
else
  echo "未设置 BUILD_DMG=1，跳过 DMG；PKG 是默认安装产物。"
fi

echo "[8/9] 可选 Apple 公证"
if [ -n "${NOTARYTOOL_PROFILE:-}" ]; then
  if [ "$SIGN_IDENTITY" = "-" ] || [ -z "${MACOS_INSTALLER_IDENTITY:-}" ]; then
    echo "公证需要同时设置 MACOS_SIGN_IDENTITY 和 MACOS_INSTALLER_IDENTITY。" >&2
    exit 1
  fi
  xcrun notarytool submit "$PKG_PATH" --keychain-profile "$NOTARYTOOL_PROFILE" --wait
  xcrun stapler staple "$PKG_PATH"
  if [ "$DMG_CREATED" = "1" ]; then
    xcrun notarytool submit "$DMG_PATH" --keychain-profile "$NOTARYTOOL_PROFILE" --wait
    xcrun stapler staple "$DMG_PATH"
  fi
else
  echo "未设置 NOTARYTOOL_PROFILE，跳过公证。"
fi

echo "[9/9] 输出安装产物"
mkdir -p "$RELEASE_ROOT"
rm -rf "$RELEASE_ROOT/$APP_NAME.app"
rm -f "$RELEASE_ROOT/$ARTIFACT_BASENAME.pkg" "$RELEASE_ROOT/$ARTIFACT_BASENAME.dmg"
ditto "$APP_PATH" "$RELEASE_ROOT/$APP_NAME.app"
cp "$PKG_PATH" "$RELEASE_ROOT/$ARTIFACT_BASENAME.pkg"
if [ "$DMG_CREATED" = "1" ]; then
  cp "$DMG_PATH" "$RELEASE_ROOT/$ARTIFACT_BASENAME.dmg"
fi

echo
echo "构建完成："
echo "  App: $RELEASE_ROOT/$APP_NAME.app"
echo "  PKG: $RELEASE_ROOT/$ARTIFACT_BASENAME.pkg"
if [ "$DMG_CREATED" = "1" ]; then
  echo "  DMG: $RELEASE_ROOT/$ARTIFACT_BASENAME.dmg"
fi
if [ "$SIGN_IDENTITY" = "-" ]; then
  echo "  签名: ad-hoc（仅用于本机或内部测试）"
else
  echo "  签名: $SIGN_IDENTITY"
fi
