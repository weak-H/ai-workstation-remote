#!/usr/bin/env bash

set -euo pipefail

PROJECT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
vendor_arch="${1:-}"

case "$vendor_arch" in
  darwin-amd64)
    expected_sha256="8ccc6383aef109c8d88965937649a796febbb166dab4b73345e820623aee1ede"
    ;;
  darwin-arm64)
    expected_sha256="35b7e34c9a3f214d80d859c4223450c69e583c7668d228c45771026fe376cab9"
    ;;
  *)
    echo "不支持的 cloudflared 平台：$vendor_arch" >&2
    exit 1
    ;;
esac

target="$PROJECT_ROOT/vendor/cloudflared/$vendor_arch/cloudflared"
archive="$target.zip"

verify_binary() {
  local binary_path="$1"
  local actual_sha256
  actual_sha256="$(shasum -a 256 "$binary_path" | awk '{print $1}')"
  if [ "$actual_sha256" != "$expected_sha256" ]; then
    echo "cloudflared 校验失败：$binary_path" >&2
    echo "期望 SHA-256：$expected_sha256" >&2
    echo "实际 SHA-256：$actual_sha256" >&2
    return 1
  fi
}

if [ ! -f "$target" ]; then
  if [ ! -f "$archive" ]; then
    echo "缺少 cloudflared 压缩包：$archive" >&2
    exit 1
  fi
  if ! command -v unzip >/dev/null 2>&1; then
    echo "缺少解压命令 unzip，无法读取：$archive" >&2
    exit 1
  fi

  echo "正在解压当前平台的 cloudflared..." >&2
  temporary_path="$(mktemp "$target.tmp.XXXXXX")"
  cleanup() {
    if [ -n "${temporary_path:-}" ]; then rm -f -- "$temporary_path"; fi
  }
  trap cleanup EXIT HUP INT TERM

  unzip -p "$archive" cloudflared > "$temporary_path"
  verify_binary "$temporary_path"
  chmod 755 "$temporary_path"
  mv -f -- "$temporary_path" "$target"
  temporary_path=""
fi

verify_binary "$target"
chmod 755 "$target"
printf '%s\n' "$target"
