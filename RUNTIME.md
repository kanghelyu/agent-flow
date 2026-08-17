# Runtime model

AgentFlow has three independent layers:

1. **CLI**: `bin/af.mjs` manages Markdown workflow documents and execution state. Its default root is `~/.agent-flow` or `AF_HOME`.
2. **Studio**: `studio/server.mjs` serves a localhost HTTP/SSE UI. It uses the CLI root and defaults to `127.0.0.1:4317`.
3. **Desktop pet**: `studio-pet` is an optional Electron overlay. Its settings are stored by Electron under the platform-specific `app.getPath('userData')`, usually `~/Library/Application Support/agent-flow-studio-pet` on macOS, `%APPDATA%\agent-flow-studio-pet` on Windows, and `$XDG_CONFIG_HOME/agent-flow-studio-pet` or the Electron Linux default on Linux.

The pet polls Studio on port 4870 first, then falls back to a free local port. It does not own workflow data. You can use CLI and Studio without installing Electron.

## Platform notes

- **macOS**: the overlay hides the Dock icon and uses the primary display. macOS privacy, unsigned-app quarantine, and managed Electron runtimes can affect first launch.
- **Windows**: use `run-pet.ps1` or the generated `af.cmd`. PowerShell may require `Set-ExecutionPolicy -Scope Process Bypass`. The Windows taskbar inset is detected at runtime.
- **Linux**: use `run-pet.sh`. Transparent click-through, tray icons, and always-on-top behavior vary by X11/Wayland compositor and desktop environment. X11 is the recommended troubleshooting baseline.

## Environment variables

- `AF_HOME`: workflow storage root.
- `AF_STUDIO_PORT`: preferred Studio port for the pet bridge or external tooling.
- `AF_ELECTRON`: explicit Electron executable for the desktop pet.
- `CODEX_HOME`: Codex skill installation root.
- `AGENTFLOW_INSTALL_DIR`: installer destination, default `~/.agent-flow`.
- `AGENTFLOW_BIN_DIR`: Unix/Windows launcher destination, default `~/.local/bin`.

## Troubleshooting

Run `af doctor --json` first. If the CLI works but the pet does not, run `af studio --no-open` and check that `127.0.0.1` is reachable. If a port is occupied, pass another `--port` to Studio or set `AF_STUDIO_PORT`. If npm cannot download Electron, install the runtime separately and set `AF_ELECTRON`. Do not treat a pet failure as a workflow or Studio failure.
