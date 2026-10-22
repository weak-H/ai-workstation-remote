#!/usr/bin/env bash

set -euo pipefail

PROJECT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_ROOT"

if ! command -v node >/dev/null 2>&1; then
  echo "未找到 Node.js，请安装 Node.js 22.5 或更高版本。" >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "未找到 npm，请先安装 Node.js 22.5 或更高版本。" >&2
  exit 1
fi

node_supported="$(node -p 'const [major, minor] = process.versions.node.split(".").map(Number); major > 22 || (major === 22 && minor >= 5) ? "yes" : "no"')"
if [ "$node_supported" != "yes" ]; then
  echo "当前 Node.js 版本为 $(node --version)，需要 22.5 或更高版本。" >&2
  exit 1
fi

if [ "$(uname -s)" != "Darwin" ]; then
  echo "run.sh 仅支持 macOS；Windows 请运行 .\\run.ps1。" >&2
  exit 1
fi

case "$(uname -m)" in
  arm64) cloudflared_vendor_arch="darwin-arm64" ;;
  x86_64) cloudflared_vendor_arch="darwin-amd64" ;;
  *)
    echo "不支持的 Mac 架构：$(uname -m)" >&2
    exit 1
    ;;
esac

if [ -z "${CLOUDFLARED_BIN:-}" ]; then
  CLOUDFLARED_BIN="$("$PROJECT_ROOT/scripts/ensure-cloudflared.sh" "$cloudflared_vendor_arch")"
fi
export CLOUDFLARED_BIN
if [ ! -x "$CLOUDFLARED_BIN" ]; then
  echo "工程内的 cloudflared 不存在或不可执行：$CLOUDFLARED_BIN" >&2
  echo "请确认 vendor/cloudflared 压缩包已完整随仓库获取。" >&2
  exit 1
fi

control_port="${CONTROL_PORT:-8787}"
if [[ ! "$control_port" =~ ^[0-9]+$ ]] \
  || [ "${#control_port}" -gt 5 ] \
  || [ "$control_port" -lt 1 ] \
  || [ "$control_port" -gt 65535 ]; then
  echo "CONTROL_PORT 必须是 1 到 65535 之间的整数，当前值：$control_port" >&2
  exit 1
fi
export CONTROL_PORT="$control_port"

if ! node -e '
  const net = require("node:net");
  const server = net.createServer();
  server.once("error", () => process.exit(1));
  server.listen({ host: "127.0.0.1", port: Number(process.argv[1]) }, () => server.close());
' "$CONTROL_PORT"; then
  echo "本地端口 ${CONTROL_PORT} 已被占用，可能已有 AI Workstation Remote 正在运行。" >&2
  echo "请回到旧实例的终端按 Ctrl+C 停止后再启动。" >&2
  echo "如需并行运行，请显式指定其他端口，例如：CONTROL_PORT=8788 caffeinate -i ./run.sh" >&2
  exit 1
fi

if [ ! -f node_modules/.package-lock.json ] \
  || [ package.json -nt node_modules/.package-lock.json ] \
  || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  echo "正在安装或更新 npm 依赖..."
  npm install
fi

echo "正在检查 Cursor 中继扩展和本机输入辅助程序..."
npm run setup:cursor-relay

# run.sh has completed the Cursor setup explicitly above. Keep the npm pre-hook
# for users who invoke remote:quick directly, but do not run it twice here.
exec npm --ignore-scripts run remote:quick
