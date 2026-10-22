param(
  [Parameter(Mandatory = $true)]
  [string]$ProjectRoot
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ExpectedSha256 = "4d2490e74082c5d48dbfedaf92576fa5bd1702379ab88eb7faa0cfbe8dc891b6"
$Target = Join-Path $ProjectRoot "vendor\cloudflared\windows-amd64\cloudflared.exe"
$Archive = "$Target.zip"

function Assert-CloudflaredChecksum {
  param([Parameter(Mandatory = $true)][string]$Path)

  $ActualSha256 = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($ActualSha256 -ne $ExpectedSha256) {
    throw @"
cloudflared 校验失败：$Path
期望 SHA-256：$ExpectedSha256
实际 SHA-256：$ActualSha256
"@
  }
}

if (-not (Test-Path -LiteralPath $Target -PathType Leaf)) {
  if (-not (Test-Path -LiteralPath $Archive -PathType Leaf)) {
    throw "缺少 cloudflared 压缩包：$Archive"
  }

  Write-Host "正在解压当前平台的 cloudflared..."
  $TemporaryDirectory = Join-Path (Split-Path $Target -Parent) (".extract-" + [Guid]::NewGuid().ToString("N"))
  try {
    Expand-Archive -LiteralPath $Archive -DestinationPath $TemporaryDirectory
    $Extracted = Join-Path $TemporaryDirectory "cloudflared.exe"
    if (-not (Test-Path -LiteralPath $Extracted -PathType Leaf)) {
      throw "压缩包内缺少 cloudflared.exe：$Archive"
    }
    Assert-CloudflaredChecksum -Path $Extracted
    Move-Item -LiteralPath $Extracted -Destination $Target -Force
  } finally {
    Remove-Item -LiteralPath $TemporaryDirectory -Recurse -Force -ErrorAction SilentlyContinue
  }
}

Assert-CloudflaredChecksum -Path $Target
(Resolve-Path -LiteralPath $Target).Path
