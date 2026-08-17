param(
  [string]$InstallDir = $(if ($env:AGENTFLOW_INSTALL_DIR) { $env:AGENTFLOW_INSTALL_DIR } else { Join-Path $HOME '.agent-flow' }),
  [string]$BinDir = $(if ($env:AGENTFLOW_BIN_DIR) { $env:AGENTFLOW_BIN_DIR } else { Join-Path $HOME '.local\bin' })
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

$node = Get-Command node -ErrorAction SilentlyContinue
$npm = Get-Command npm -ErrorAction SilentlyContinue
if (-not $node) { throw 'Node.js >= 18 is required.' }
if (-not $npm) { throw 'npm is required.' }
$nodeMajor = [int]((& $node.Source -p 'process.versions.node.split(".")[0]'))
if ($nodeMajor -lt 18) { throw "Node.js >= 18 is required (found $((& $node.Source --version)))." }

New-Item -ItemType Directory -Force -Path $InstallDir, $BinDir | Out-Null
foreach ($item in @('bin', 'lib', 'skills', 'studio', 'studio-pet')) {
  $destination = Join-Path $InstallDir $item
  if (Test-Path $destination) { Remove-Item -Recurse -Force $destination }
  Copy-Item -Recurse -Force (Join-Path $root $item) $destination
}
foreach ($item in @('package.json', 'ATTRIBUTION.md', 'README.md', 'README.zh-CN.md', 'INSTALL.md', 'RUNTIME.md', 'LICENSE')) {
  $source = Join-Path $root $item
  if (Test-Path $source) { Copy-Item -Force $source (Join-Path $InstallDir $item) }
}
$manifest = Join-Path $root '.zcode-plugin'
if (Test-Path $manifest) {
  $destination = Join-Path $InstallDir '.zcode-plugin'
  if (Test-Path $destination) { Remove-Item -Recurse -Force $destination }
  Copy-Item -Recurse -Force $manifest $destination
}

function Install-Skill([string]$target) {
  $parent = Split-Path -Parent $target
  New-Item -ItemType Directory -Force -Path $parent | Out-Null
  if (Test-Path $target) { Remove-Item -Recurse -Force $target }
  Copy-Item -Recurse -Force (Join-Path $root 'skills\agent-flow') $target
}
Install-Skill (Join-Path $HOME '.zcode\skills\agent-flow')
Install-Skill (Join-Path $HOME '.claude\skills\agent-flow')
$codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME '.codex' }
Install-Skill (Join-Path $codexHome 'skills\agent-flow')

$launcher = Join-Path $BinDir 'af.cmd'
$launcherContent = "@echo off`r`nnode `"$InstallDir\bin\af.mjs`" %*`r`n"
Set-Content -LiteralPath $launcher -Value $launcherContent -Encoding ASCII
$psLauncher = Join-Path $BinDir 'af.ps1'
Set-Content -LiteralPath $psLauncher -Value "& node `"$InstallDir\bin\af.mjs`" @args" -Encoding UTF8

$version = Get-Content (Join-Path $InstallDir 'package.json') -Raw | ConvertFrom-Json
Write-Host "AgentFlow $($version.version) installed at $InstallDir"
Write-Host "CLI: $launcher"
Write-Host "If $BinDir is not on PATH, add it in Windows Environment Variables."
Write-Host "Desktop pet is optional: $InstallDir\studio-pet\run-pet.ps1"
& $launcher --version
& $launcher doctor --json
