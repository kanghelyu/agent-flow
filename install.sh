#!/usr/bin/env bash
# AgentFlow 安装器：CLI 装到 ~/.agent-flow，技能装进检测到的代理目录。
# 幂等：重复运行只会更新文件。卸载见 README。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AF_HOME="${AF_HOME:-$HOME/.agent-flow}"

echo "==> 安装 af CLI 到 $AF_HOME/bin"
mkdir -p "$AF_HOME/bin" "$AF_HOME/lib" "$AF_HOME/flows" "$AF_HOME/trash"
cp "$HERE"/lib/*.js "$AF_HOME/lib/" 2>/dev/null || true
cp "$HERE"/lib/*.mjs "$AF_HOME/lib/" 2>/dev/null || true
cp "$HERE/bin/af.mjs" "$AF_HOME/bin/af.mjs"
chmod +x "$AF_HOME/bin/af.mjs"
# Studio 可视化画布 + 悬浮窗（Electron 运行时按需探测，见 studio-pet/run-pet.sh）
mkdir -p "$AF_HOME/studio" "$AF_HOME/studio-pet"
cp "$HERE"/studio/* "$AF_HOME/studio/"
cp "$HERE"/studio-pet/main.js "$HERE"/studio-pet/preload.js "$HERE"/studio-pet/package.json \
  "$HERE"/studio-pet/run-pet.sh "$HERE"/studio-pet/run-pet.command "$HERE"/studio-pet/HOST-WITH-CLAWD.md \
  "$AF_HOME/studio-pet/"
chmod +x "$AF_HOME/studio-pet/run-pet.sh" "$AF_HOME/studio-pet/run-pet.command" 2>/dev/null || true

link_bin() {
  local target="$1"
  if [ -w "$(dirname "$target")" ]; then
    ln -sf "$AF_HOME/bin/af.mjs" "$target"
    echo "    链接 $target"
  else
    echo "    跳过 $target（目录不可写，可手动 sudo ln -sf）"
  fi
}
for candidate in /usr/local/bin/af "$HOME/.local/bin/af" /opt/homebrew/bin/af; do
  if [ -d "$(dirname "$candidate")" ] && [ ! -e "$candidate" ]; then
    link_bin "$candidate"
    break
  fi
done
if ! command -v af >/dev/null 2>&1; then
  echo "    提示：把 $AF_HOME/bin 加入 PATH，或执行：ln -sf $AF_HOME/bin/af.mjs /usr/local/bin/af"
fi

install_skill() {
  local dest="$1"
  if [ -d "$(dirname "$dest")" ]; then
    mkdir -p "$dest"
    cp "$HERE/skills/agent-flow/SKILL.md" "$dest/SKILL.md"
    echo "==> 技能已安装：$dest"
  fi
}

# ZCode / Claude Code / Codex CLI（存在哪个装哪个；都没有时给出手动路径）
found=0
for dir in "$HOME/.zcode/skills" "$HOME/.claude/skills" "$HOME/.codex/skills"; do
  if [ -d "$dir" ] || [ -d "$(dirname "$dir")" ]; then
    install_skill "$dir/agent-flow"
    found=1
  fi
done
if [ "$found" -eq 0 ]; then
  echo "==> 未检测到代理技能目录；手动复制："
  echo "    ZCode:        mkdir -p ~/.zcode/skills/agent-flow && cp $HERE/skills/agent-flow/SKILL.md ~/.zcode/skills/agent-flow/"
  echo "    Claude Code:  mkdir -p ~/.claude/skills/agent-flow && cp $HERE/skills/agent-flow/SKILL.md ~/.claude/skills/agent-flow/"
  echo "    Codex CLI:    mkdir -p ~/.codex/skills/agent-flow && cp $HERE/skills/agent-flow/SKILL.md ~/.codex/skills/agent-flow/"
fi

echo "==> 验证"
node "$AF_HOME/bin/af.mjs" --version
echo "完成。试试：af create \"示例\" --steps \"调研;实现;验收\""
