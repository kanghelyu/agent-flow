# AgentFlow

> Note: this filename (`README.zh-CN.md`) is retained for compatibility with earlier links. The content is now the same English documentation as `README.md`.

AgentFlow is a Markdown-first workflow CLI and local Studio for coding agents. It supports ZCode, Claude Code, Codex CLI, or a plain terminal.

## Quick start

Requirements: Node.js 18 or newer and npm.

macOS/Linux:

```bash
bash install.sh
af --version
af doctor
```

Windows PowerShell:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\install.ps1
af --version
af doctor
```

Start the browser Studio without opening a browser automatically:

```bash
af studio --no-open
```

The default data directory is `~/.agent-flow`. Set `AF_HOME` or pass `--root <directory>` to use another location. Studio binds to `127.0.0.1:4317`; use `--port` or `AF_STUDIO_PORT` when another service owns that port.

## Desktop pet

The desktop pet is optional. The CLI and browser Studio work without Electron.

macOS/Linux:

```bash
~/.agent-flow/studio-pet/run-pet.sh
```

Windows PowerShell:

```powershell
& "$HOME\.agent-flow\studio-pet\run-pet.ps1"
```

The first launch downloads the pinned Electron runtime into `studio-pet/node_modules`. Set `AF_ELECTRON` to an existing Electron executable to use a system or managed runtime. The pet uses the primary display. Linux transparency, tray icons, and always-on-top behavior depend on the desktop environment; X11 is generally more predictable than Wayland.

The right-click menu provides size, coat, play area, low-power mode, always-on-top, language, open, and quit. The "rest corner" button was removed as it had no practical value; an existing `restSide` setting in old configuration is still honored internally, but there is no longer a UI for it.

## Skills

The installer synchronizes `skills/agent-flow` to:

- `~/.zcode/skills/agent-flow`
- `~/.claude/skills/agent-flow`
- `$CODEX_HOME/skills/agent-flow` (or `~/.codex/skills/agent-flow`)

If `af` is not on `PATH`, run it directly:

```bash
node ~/.agent-flow/bin/af.mjs --version
```

See [INSTALL.md](INSTALL.md), [RUNTIME.md](RUNTIME.md), and [README.md](README.md) for platform details.
