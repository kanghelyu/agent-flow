#!/usr/bin/env bash
# AgentFlow Studio 悬浮窗启动器：优先复用 clawd-on-desk 自带的 Electron（零新增下载）。
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Electron 候选按固定顺序探测：环境变量 > clawd-on-desk 的安装 > 本目录 node_modules > PATH。
ELECTRON="${CLAWD_ELECTRON:-}"
if [ -z "$ELECTRON" ]; then
  for candidate in \
    "$HOME/.clawd/clawd-on-desk/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" \
    "$HOME/.clawd/clawd-on-desk/node_modules/.bin/electron" \
    "$HERE/node_modules/.bin/electron"; do
    if [ -e "$candidate" ]; then ELECTRON="$candidate"; break; fi
  done
fi
if [ -z "$ELECTRON" ] && command -v electron >/dev/null 2>&1; then ELECTRON="$(command -v electron)"; fi
if [ -z "$ELECTRON" ]; then
  echo "未找到 Electron。两种解法："
  echo "  1) 安装 clawd-on-desk（桌面宠物，自带 Electron，本脚本自动复用）"
  echo "  2) 在本目录执行 npm install electron"
  exit 1
fi
echo "使用 Electron：$ELECTRON"
cd "$HERE"
exec "$ELECTRON" .
