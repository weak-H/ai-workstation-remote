param(
  [Nullable[int]]$Port = $null
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if ($env:OS -ne "Windows_NT") {
  throw "run.ps1 仅用于 Windows；macOS 请运行 ./run.sh。"
}

$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ProjectRoot

if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) {
  throw "未找到 Node.js，请安装 Node.js 22.5 或更高版本。"
}
if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
  throw "未找到 npm，请重新安装 Node.js 22.5 或更高版本。"
}

$NodeVersion = [version](& node.exe -p "process.versions.node")
if ($NodeVersion -lt [version]"22.5.0") {
  throw "当前 Node.js 版本为 $(& node.exe --version)，需要 22.5 或更高版本。"
}

$LocalBin = Join-Path $ProjectRoot ".tools\bin"
$Architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
if ($Architecture -notin @("X64", "Arm64")) {
  throw "不支持的 Windows 架构：$Architecture"
}
if ($Architecture -eq "Arm64") {
  if ([Environment]::OSVersion.Version.Build -lt 22000) {
    throw "Windows ARM64 需要 Windows 11；Windows 10 仅支持 x64。"
  }
  Write-Host "Windows ARM64 将使用 x64 cloudflared，需要系统提供 x64 兼容层。"
}

$Cloudflared = if ($env:CLOUDFLARED_BIN) {
  $env:CLOUDFLARED_BIN
} else {
  & (Join-Path $ProjectRoot "scripts\ensure-cloudflared.ps1") -ProjectRoot $ProjectRoot
}
if (-not (Test-Path -PathType Leaf $Cloudflared)) {
  throw "工程内的 cloudflared 不存在：$Cloudflared。请确认 vendor\cloudflared 压缩包已完整随仓库获取。"
}
$env:CLOUDFLARED_BIN = (Resolve-Path $Cloudflared).Path
$env:CURSOR_INPUT_HELPER = Join-Path $LocalBin "cursor-input-helper.ps1"

if ($null -ne $Port) {
  $ControlPort = [int]$Port
} elseif ($env:CONTROL_PORT) {
  $ControlPort = 0
  if (-not [int]::TryParse($env:CONTROL_PORT, [ref]$ControlPort)) {
    throw "CONTROL_PORT 必须是 1 到 65535 之间的整数，当前值：$env:CONTROL_PORT"
  }
} else {
  $ControlPort = 8787
}
if ($ControlPort -lt 1 -or $ControlPort -gt 65535) {
  throw "控制端口必须是 1 到 65535 之间的整数，当前值：$ControlPort"
}
$env:CONTROL_PORT = [string]$ControlPort

$Listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $ControlPort)
try {
  $Listener.Start()
} catch {
  throw @"
本地端口 $ControlPort 已被占用，可能已有 AI Workstation Remote 正在运行。
请回到旧实例的终端按 Ctrl+C 停止后再启动。
如需并行运行，请显式指定其他端口，例如：.\run.ps1 -Port 8788
"@
} finally {
  $Listener.Stop()
}

$InstalledLock = Join-Path $ProjectRoot "node_modules\.package-lock.json"
$PackageJson = Join-Path $ProjectRoot "package.json"
$PackageLock = Join-Path $ProjectRoot "package-lock.json"
$InstallDependencies = -not (Test-Path -PathType Leaf $InstalledLock)
if (-not $InstallDependencies) {
  $InstalledAt = (Get-Item $InstalledLock).LastWriteTimeUtc
  $PackageJsonChanged = (Get-Item $PackageJson).LastWriteTimeUtc -gt $InstalledAt
  $PackageLockChanged = (Get-Item $PackageLock).LastWriteTimeUtc -gt $InstalledAt
  $InstallDependencies = $PackageJsonChanged -or $PackageLockChanged
}
if ($InstallDependencies) {
  Write-Host "正在安装或更新 npm 依赖..."
  & npm.cmd install
  if ($LASTEXITCODE -ne 0) { throw "npm install 失败" }
}

Write-Host "正在检查 Cursor 中继扩展和 Windows 输入辅助程序..."
& npm.cmd run setup:cursor-relay
if ($LASTEXITCODE -ne 0) { throw "Cursor 中继初始化失败" }

Write-Host "本地控制端口：$env:CONTROL_PORT"
& npm.cmd --ignore-scripts run remote:quick
exit $LASTEXITCODE
