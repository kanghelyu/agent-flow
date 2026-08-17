# Installation Guide

## 1. Install the CLI and skills

### macOS / Linux

Run this from the AgentFlow source or extracted directory:

```bash
bash install.sh
```

The installer will:

- check Node.js >= 18 and npm;
- copy the CLI, Studio, and desktop pet source to `~/.agent-flow`;
- create `~/.local/bin/af`;
- sync the skill to the usual ZCode, Claude Code, and Codex directories;
- run `af --version` and `af doctor --json`.

If `~/.local/bin` is not on `PATH`:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

Add that line to your shell profile to make it permanent.

### Windows

In PowerShell:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\install.ps1
```

The installer creates `af.cmd` and `af.ps1` in `$HOME\.local\bin`. Add that directory to your user PATH and reopen the terminal. To avoid changing PATH, run directly:

```powershell
node "$HOME\.agent-flow\bin\af.mjs" --version
```

## 2. Verify

```text
af --version
af doctor --json
```

`doctor` reports Node, the AgentFlow root, Studio assets, and which agent skills were discovered. A missing desktop pet must not make the CLI or Studio fail.

## 3. Start Studio

```text
af studio
```

The server binds to local `127.0.0.1`. In headless environments, or when you do not want a browser tab opened automatically:

```text
af studio --no-open
```

On a port conflict:

```text
af studio --port 4320
```

## 4. Install / start the desktop pet

The pet depends on a pinned Electron version; the first launch may download the runtime.

macOS / Linux:

```bash
~/.agent-flow/studio-pet/run-pet.sh
```

Windows:

```powershell
& "$HOME\.agent-flow\studio-pet\run-pet.ps1"
```

If you already have Electron on the system:

```text
AF_ELECTRON=/absolute/path/to/electron ~/.agent-flow/studio-pet/run-pet.sh
```

Windows PowerShell equivalent:

```powershell
$env:AF_ELECTRON = 'C:\Path\to\electron.exe'
& "$HOME\.agent-flow\studio-pet\run-pet.ps1"
```

The Linux pet needs a desktop environment that supports transparent windows and tray icons. Wayland compositors may restrict always-on-top, click-through, or tray display; when in doubt, use an X11 session and verify core functionality with `af studio --no-open`.

## 5. Update and uninstall

To update, run the same install command again from the new source directory. The installer overwrites programs and skills but never deletes `~/.agent-flow/flows` or Electron userData.

To uninstall the CLI/skills: delete `~/.agent-flow`, `~/.local/bin/af`, and the three agent skill directories. Pet settings live in Electron's platform userData directory and are separate from CLI workflow data.
