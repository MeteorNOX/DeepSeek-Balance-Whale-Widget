#!/bin/zsh
set -e
cd "$(dirname "$0")"
NODE_BIN=""
for candidate in /opt/homebrew/bin/node /usr/local/bin/node; do
  if [[ -x "$candidate" ]]; then NODE_BIN="$candidate"; break; fi
done
if [[ -z "$NODE_BIN" ]]; then
  echo "未找到 Homebrew Node.js 24+。请先运行：brew install node"
  read -k 1 "?按任意键退出..."
  exit 1
fi
exec "$NODE_BIN" scripts/uninstall-macos.mjs
