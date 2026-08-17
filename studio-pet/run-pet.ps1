$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$electron = $env:AF_ELECTRON
if (-not $electron) {
  $candidate = Join-Path $here 'node_modules\.bin\electron.cmd'
  if (Test-Path $candidate) { $electron = $candidate }
}
if (-not $electron) {
  $command = Get-Command electron -ErrorAction SilentlyContinue
  if ($command) { $electron = $command.Source }
}
if (-not $electron) {
  if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw 'Electron is missing. Install Node.js/npm first.' }
  Push-Location $here
  try { npm install --no-audit --no-fund } finally { Pop-Location }
  $electron = Join-Path $here 'node_modules\.bin\electron.cmd'
}
if (-not (Test-Path $electron) -and -not (Get-Command $electron -ErrorAction SilentlyContinue)) { throw 'Electron was not found after installation.' }
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
& $electron $here @args
exit $LASTEXITCODE
