# 下载 MediaMTX（Windows）
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$MtxDir = Join-Path $Root "mediamtx"
$Exe = Join-Path $MtxDir "mediamtx.exe"

if (Test-Path $Exe) { Write-Host "[OK] mediamtx.exe 已存在"; exit 0 }

$Tmp = Join-Path $env:TEMP ("mediamtx_" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $Tmp | Out-Null

# 获取最新版本号
$Tag = ""
try {
  $Rel = Invoke-RestMethod -Uri "https://api.github.com/repos/bluenviron/mediamtx/releases/latest" -TimeoutSec 15
  $Tag = $Rel.tag_name
} catch {}
if (-not $Tag) { $Tag = "v1.12.0" } # 兜底版本

$Url = "https://github.com/bluenviron/mediamtx/releases/download/$Tag/mediamtx_${Tag}_windows_amd64.zip"
$Zip = Join-Path $Tmp "mediamtx.zip"

Write-Host "[INFO] 下载 $Url"
Invoke-WebRequest -Uri $Url -OutFile $Zip -TimeoutSec 300

Write-Host "[INFO] 解压..."
Expand-Archive -Path $Zip -DestinationPath $Tmp -Force
$Found = Get-ChildItem -Path $Tmp -Recurse -Filter "mediamtx.exe" | Select-Object -First 1
if (-not $Found) { Write-Error "解压后未找到 mediamtx.exe"; exit 1 }
Copy-Item $Found.FullName $Exe -Force

Remove-Item -Recurse -Force $Tmp
Write-Host "[OK] 已安装 $Exe ($Tag)"
