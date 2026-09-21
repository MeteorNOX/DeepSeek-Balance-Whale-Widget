#!/usr/bin/env sh
# dsh-whale-widget 安装器（macOS / Linux）
# 参数原样传给 installer/install.mjs，例如：./install.sh --no-voice
set -e
HERE=$(cd "$(dirname "$0")" && pwd)

if ! command -v node >/dev/null 2>&1; then
  echo "[x] 没有找到 Node.js（需要 18 以上）：https://nodejs.org"
  exit 1
fi

node "$HERE/installer/install.mjs" "$@"
echo
echo "[ok] 完成。记得重启 dsh web。"
