#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

find_electron() {
  if [ -n "${AF_ELECTRON:-}" ] && [ -x "${AF_ELECTRON}" ]; then printf '%s\n' "$AF_ELECTRON"; return 0; fi
  for candidate in \
    "$HERE/node_modules/.bin/electron" \
    "$HERE/node_modules/.bin/electron.cmd" \
    "$HERE/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" \
    "$HERE/node_modules/electron/dist/electron" \
    "$HERE/node_modules/electron/dist/electron.exe" \
    "$HOME/.clawd/clawd-on-desk/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"; do
    if [ -x "$candidate" ]; then printf '%s\n' "$candidate"; return 0; fi
  done
  command -v electron 2>/dev/null || true
}

ELECTRON="$(find_electron)"
if [ -z "$ELECTRON" ]; then
  echo "首次启动：未找到 Electron，正在为小宠安装本地运行时…"
  command -v npm >/dev/null 2>&1 || { echo "错误：需要 Node.js/npm 才能首次安装 Electron。"; exit 1; }
  (cd "$HERE" && npm install --no-audit --no-fund)
  ELECTRON="$(find_electron)"
fi

[ -n "$ELECTRON" ] || { echo "错误：Electron 安装后仍未找到可执行文件。"; exit 1; }
unset ELECTRON_RUN_AS_NODE
cd "$HERE"
exec "$ELECTRON" .
