#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="${AGENTFLOW_INSTALL_DIR:-$HOME/.agent-flow}"
BIN_DIR="${AGENTFLOW_BIN_DIR:-$HOME/.local/bin}"

fail() { printf 'AgentFlow install: %s\n' "$1" >&2; exit 1; }
command -v node >/dev/null 2>&1 || fail 'Node.js >= 18 is required.'
command -v npm >/dev/null 2>&1 || fail 'npm is required.'
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' || fail "Node.js >= 18 is required (found $(node --version))."

mkdir -p "$INSTALL_DIR" "$BIN_DIR"
for item in bin lib skills studio studio-pet; do
  rm -rf "$INSTALL_DIR/$item"
  cp -R "$HERE/$item" "$INSTALL_DIR/$item"
done
for item in package.json ATTRIBUTION.md README.md README.zh-CN.md INSTALL.md RUNTIME.md LICENSE; do
  [ -e "$HERE/$item" ] && cp -f "$HERE/$item" "$INSTALL_DIR/$item"
done
if [ -d "$HERE/.zcode-plugin" ]; then
  rm -rf "$INSTALL_DIR/.zcode-plugin"
  cp -R "$HERE/.zcode-plugin" "$INSTALL_DIR/.zcode-plugin"
fi

install_skill() {
  local target="$1"
  mkdir -p "$(dirname "$target")"
  rm -rf "$target"
  cp -R "$HERE/skills/agent-flow" "$target"
}
install_skill "$HOME/.zcode/skills/agent-flow"
install_skill "$HOME/.claude/skills/agent-flow"
CODEX_HOME_DIR="${CODEX_HOME:-$HOME/.codex}"
install_skill "$CODEX_HOME_DIR/skills/agent-flow"

ln -sfn "$INSTALL_DIR/bin/af.mjs" "$BIN_DIR/af"
chmod +x "$INSTALL_DIR/bin/af.mjs" "$INSTALL_DIR/studio-pet/run-pet.sh"

version="$(node -e 'const fs = require("node:fs"); process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).version)' "$INSTALL_DIR/package.json")"
printf 'AgentFlow %s installed at %s\n' "$version" "$INSTALL_DIR"
printf 'CLI: %s\n' "$BIN_DIR/af"
printf 'Run: %s --version && %s doctor\n' "$BIN_DIR/af" "$BIN_DIR/af"
printf 'If %s is not on PATH, add: export PATH="%s:$PATH"\n' "$BIN_DIR" "$BIN_DIR"
printf 'Desktop pet is optional: %s/studio-pet/run-pet.sh\n' "$INSTALL_DIR"
"$BIN_DIR/af" --version
"$BIN_DIR/af" doctor --json
