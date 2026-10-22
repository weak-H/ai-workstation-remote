param()

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if ($env:OS -ne "Windows_NT") {
  throw "Windows 发行包必须在 Windows x64 或 arm64 主机上构建。"
}

$ProjectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $ProjectRoot

foreach ($CommandName in @("node.exe", "npm.cmd")) {
  if (-not (Get-Command $CommandName -ErrorAction SilentlyContinue)) {
    throw "缺少构建命令：$CommandName"
  }
}

$Architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
$ReleaseArchitecture = switch ($Architecture) {
  "X64" { "x64" }
  "Arm64" { "arm64" }
  default { throw "不支持的 Windows 架构：$Architecture" }
}
if ($Architecture -eq "Arm64" -and [Environment]::OSVersion.Version.Build -lt 22000) {
  throw "Windows ARM64 构建需要 Windows 11；Windows 10 仅支持 x64。"
}
$Version = & node.exe -p "require('./package.json').version"
$ArtifactName = "AI-Workstation-Remote-$Version-windows-$ReleaseArchitecture"
$ReleaseRoot = Join-Path $ProjectRoot "release"
$WorkRoot = Join-Path ([IO.Path]::GetTempPath()) ("ai-workstation-windows-" + [Guid]::NewGuid().ToString("N"))
$BundleRoot = Join-Path $WorkRoot $ArtifactName
$AppRoot = Join-Path $BundleRoot "app"
$RuntimeRoot = Join-Path $BundleRoot "runtime"
$RuntimeBin = Join-Path $RuntimeRoot "bin"
$Helpers = Join-Path $BundleRoot "helpers"

try {
  Write-Host "[1/6] 检查并构建 Web 与 TypeScript 资源"
  & npm.cmd run typecheck
  if ($LASTEXITCODE -ne 0) { throw "TypeScript 检查失败" }
  & npm.cmd run licenses
  if ($LASTEXITCODE -ne 0) { throw "第三方许可证清单生成失败" }
  & npm.cmd run build -w '@ai-workstation/mobile'
  if ($LASTEXITCODE -ne 0) { throw "移动端构建失败" }

  New-Item -ItemType Directory -Force -Path $AppRoot, (Join-Path $AppRoot "runtime"), (Join-Path $AppRoot "mobile"), $RuntimeBin, $Helpers | Out-Null
  Copy-Item "scripts\start-packaged.mjs" (Join-Path $AppRoot "start-packaged.mjs")
  Copy-Item "apps\mobile\dist\*" (Join-Path $AppRoot "mobile") -Recurse -Force
  $LicenseRoot = Join-Path $AppRoot "licenses"
  New-Item -ItemType Directory -Force -Path $LicenseRoot | Out-Null
  Copy-Item -Path @("LICENSE", "THIRD_PARTY_NOTICES.md", "licenses\npm-dependencies.md", "licenses\npm-notices.txt") -Destination $LicenseRoot
  Copy-Item "vendor\cloudflared\LICENSE" (Join-Path $LicenseRoot "cloudflared-APACHE-2.0.txt")

  Write-Host "[2/6] 打包 Node 服务"
  & "node_modules\.bin\esbuild.cmd" "services\control-plane\src\index.ts" --bundle --platform=node --target=node22 --format=cjs --outfile="$AppRoot\runtime\control-plane.cjs"
  if ($LASTEXITCODE -ne 0) { throw "Control Plane 打包失败" }
  & "node_modules\.bin\esbuild.cmd" "apps\mac-companion\src\index.ts" --bundle --platform=node --target=node22 --format=cjs --outfile="$AppRoot\runtime\mac-companion.cjs"
  if ($LASTEXITCODE -ne 0) { throw "Companion 打包失败" }

  Write-Host "[3/6] 准备 Node、cloudflared 与 Cursor 中继"
  $NodePath = (& node.exe -p "process.execPath").Trim()
  Copy-Item $NodePath (Join-Path $RuntimeBin "node.exe")
  $NodeDirectory = Split-Path $NodePath -Parent
  $NodeLicenseCandidates = @(
    (Join-Path $NodeDirectory "LICENSE"),
    (Join-Path (Split-Path $NodeDirectory -Parent) "LICENSE"),
    (Join-Path (Split-Path $NodeDirectory -Parent) "share\doc\node\LICENSE")
  )
  $NodeLicense = $NodeLicenseCandidates | Where-Object { Test-Path -PathType Leaf $_ } | Select-Object -First 1
  if (-not $NodeLicense) {
    throw "找不到当前 Node.js 运行时附带的 LICENSE：$NodePath"
  }
  Copy-Item $NodeLicense (Join-Path $LicenseRoot "node-LICENSE.txt")
  $CloudflaredSource = if ($env:CLOUDFLARED_BIN) {
    $env:CLOUDFLARED_BIN
  } else {
    & (Join-Path $ProjectRoot "scripts\ensure-cloudflared.ps1") -ProjectRoot $ProjectRoot
  }
  if (-not (Test-Path -PathType Leaf $CloudflaredSource)) {
    throw "工程内的 cloudflared 不存在：$CloudflaredSource"
  }
  Copy-Item $CloudflaredSource (Join-Path $Helpers "cloudflared.exe")
  Copy-Item "apps\mac-companion\native\cursor-input-helper.ps1" (Join-Path $Helpers "cursor-input-helper.ps1")
  & node.exe "scripts\package-cursor-relay.mjs" (Join-Path $AppRoot "cursor-relay.vsix")
  if ($LASTEXITCODE -ne 0) { throw "Cursor 中继打包失败" }

  $CursorExtensionVersion = & node.exe -p "require('./apps/cursor-relay-extension/package.json').version"
  $Manifest = [ordered]@{
    version = $Version
    platform = "windows"
    architecture = $ReleaseArchitecture
    cursorExtensionId = "ai-workstation.ai-workstation-cursor-relay"
    cursorExtensionVersion = $CursorExtensionVersion
  } | ConvertTo-Json
  [IO.File]::WriteAllText((Join-Path $AppRoot "release-manifest.json"), $Manifest, [Text.UTF8Encoding]::new($false))

  Write-Host "[4/6] 写入 Windows 启动器"
  Copy-Item "packaging\windows\AI-Workstation-Remote.cmd" (Join-Path $BundleRoot "AI-Workstation-Remote.cmd")
  Copy-Item "packaging\windows\README.txt" (Join-Path $BundleRoot "README.txt")

  Write-Host "[5/6] 生成便携 ZIP"
  New-Item -ItemType Directory -Force -Path $ReleaseRoot | Out-Null
  $ReleaseDirectory = Join-Path $ReleaseRoot $ArtifactName
  $ZipPath = Join-Path $ReleaseRoot "$ArtifactName.zip"
  Remove-Item $ReleaseDirectory -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item $ZipPath -Force -ErrorAction SilentlyContinue
  Copy-Item $BundleRoot $ReleaseDirectory -Recurse
  Compress-Archive -Path $BundleRoot -DestinationPath $ZipPath -CompressionLevel Optimal

  Write-Host "[6/6] 构建完成"
  Write-Host "  目录：$ReleaseDirectory"
  Write-Host "  ZIP： $ZipPath"
  Write-Host "  启动：解压后双击 AI-Workstation-Remote.cmd"
} finally {
  Remove-Item $WorkRoot -Recurse -Force -ErrorAction SilentlyContinue
}
