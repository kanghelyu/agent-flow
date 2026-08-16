# AgentFlow Windows 安装器（PowerShell）
# 用法：powershell -ExecutionPolicy Bypass -File install.ps1
# 等价于 install.sh：CLI -> %USERPROFILE%\.agent-flow，技能 -> 检测到的代理目录。
$ErrorActionPreference = "Stop"

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$afHome = if ($env:AF_HOME) { $env:AF_HOME } else { Join-Path $env:USERPROFILE ".agent-flow" }

Write-Host "==> 安装 af CLI 到 $afHome"
foreach ($sub in @("bin", "lib", "flows", "trash")) {
  New-Item -ItemType Directory -Force -Path (Join-Path $afHome $sub) | Out-Null
}
Copy-Item "$here\lib\*.js" (Join-Path $afHome "lib") -Force -ErrorAction SilentlyContinue
Copy-Item "$here\lib\*.mjs" (Join-Path $afHome "lib") -Force -ErrorAction SilentlyContinue
Copy-Item "$here\bin\af.mjs" (Join-Path $afHome "bin") -Force

# Studio 可视化画布（Windows 下用 af studio 在浏览器打开；悬浮窗依赖 Electron，可选）
New-Item -ItemType Directory -Force -Path (Join-Path $afHome "studio") | Out-Null
Copy-Item "$here\studio\*" (Join-Path $afHome "studio") -Force
New-Item -ItemType Directory -Force -Path (Join-Path $afHome "studio-pet") | Out-Null
Copy-Item "$here\studio-pet\main.js", "$here\studio-pet\preload.js", "$here\studio-pet\package.json" (Join-Path $afHome "studio-pet") -Force

# af.cmd shim：让 `af` 直接可用（放在 $afHome\bin，把它加入 PATH 即可）
$shim = "@echo off`r`nnode ""$afHome\bin\af.mjs"" %*"
Set-Content -Path (Join-Path $afHome "bin\af.cmd") -Value $shim -Encoding ASCII

# 尽量把 shim 放进已在 PATH 的用户目录
$shimDest = $null
if (Test-Path "$env:USERPROFILE\.local\bin") { $shimDest = "$env:USERPROFILE\.local\bin" }
elseif (Test-Path "$env:LOCALAPPDATA\Microsoft\WindowsApps") { $shimDest = "$env:LOCALAPPDATA\Microsoft\WindowsApps" }
if ($shimDest) {
  Copy-Item (Join-Path $afHome "bin\af.cmd") $shimDest -Force
  Write-Host "    已放置 $shimDest\af.cmd"
} else {
  Write-Host "    提示：把 $afHome\bin 加入 PATH，或手动复制 af.cmd 到 PATH 中的目录"
}

# 技能安装：存在哪个代理目录装哪个
$skillSource = "$here\skills\agent-flow\SKILL.md"
$found = $false
foreach ($dir in @("$env:USERPROFILE\.zcode\skills", "$env:USERPROFILE\.claude\skills", "$env:USERPROFILE\.codex\skills")) {
  $parent = Split-Path -Parent $dir
  if ((Test-Path $dir) -or (Test-Path $parent)) {
    New-Item -ItemType Directory -Force -Path "$dir\agent-flow" | Out-Null
    Copy-Item $skillSource "$dir\agent-flow\SKILL.md" -Force
    Write-Host "==> 技能已安装：$dir\agent-flow"
    $found = $true
  }
}
if (-not $found) {
  Write-Host "==> 未检测到代理技能目录；手动复制 skills\agent-flow\SKILL.md 到 ~/.zcode/skills/ 等"
}

Write-Host "==> 验证"
node (Join-Path $afHome "bin\af.mjs") --version
Write-Host "完成。试试：af create `"示例`" --steps `"调研;实现;验收`""
