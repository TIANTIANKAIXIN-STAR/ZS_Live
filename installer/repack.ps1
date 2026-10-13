# ZS Live 一键重打包脚本
# 用法：
#   powershell -ExecutionPolicy Bypass -File repack.ps1              # 用当前 .iss 里的版本号
#   powershell -ExecutionPolicy Bypass -File repack.ps1 -Version 1.1.0   # 顺带升版本号
#   powershell -ExecutionPolicy Bypass -File repack.ps1 -SkipUE     # UE 包没变时跳过 2GB 拷贝
param(
    [string]$Version = "",
    [switch]$SkipUE
)

$ErrorActionPreference = 'Stop'
$root   = 'F:\streamming\ZS_Live'
$stage  = Join-Path $root 'dist\stage'
$iscc   = 'C:\Program Files\Inno Setup 7\ISCC.exe'
$iss    = Join-Path $root 'installer\ZSLive.iss'

if (-not (Test-Path $iscc)) { throw "ISCC.exe not found: $iscc" }

# ---------- 1. 可选：更新版本号 ----------
if ($Version -ne '') {
    (Get-Content $iss -Raw -Encoding UTF8) `
        -replace '#define MyAppVersion "[\d.]+"', ("#define MyAppVersion `"$Version`"") |
        Set-Content $iss -Encoding UTF8
    Write-Host "[1/3] version -> $Version"
} else {
    $v = (Select-String -Path $iss -Pattern 'MyAppVersion "([\d.]+)"').Matches[0].Groups[1].Value
    $Version = $v
    Write-Host "[1/3] version stays $Version"
}

# ---------- 2. 刷新暂存目录（robocopy 增量，只拷变化的文件） ----------
function Sync($src, $dst) {
    robocopy $src $dst /MIR /NFL /NDL /NJH /NJS /NP /R:2 /W:2 | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy FAILED: $src -> $dst (code $LASTEXITCODE)" }
}

Write-Host "[2/3] refreshing staging ..."
New-Item -ItemType Directory -Force -Path `    "$stage\core\server", "$stage\core\mediamtx", "$stage\core\runtime", `
    "$stage\core\launcher", "$stage\core\scripts", "$stage\core\docs" | Out-Null

Sync "$root\server\src"           "$stage\core\server\src"
Sync "$root\server\node_modules"  "$stage\core\server\node_modules"
foreach ($f in 'package.json','package-lock.json','.env.example','install-init.js') {
    Copy-Item (Join-Path $root "server\$f") (Join-Path $stage "core\server\$f") -Force
}
foreach ($f in 'mediamtx.exe','mediamtx.template.yml') {
    Copy-Item (Join-Path $root "mediamtx\$f") (Join-Path $stage "core\mediamtx\$f") -Force
}
Copy-Item 'C:\Program Files\nodejs\node.exe' "$stage\core\runtime\node.exe" -Force

# 启动器：优先用自包含单文件（publish-selfcontained），退回开发目录版本
$lx = Join-Path $root 'launcher\publish-selfcontained\ZSLiveLauncher.exe'
if (-not (Test-Path $lx)) { $lx = Join-Path $root 'launcher\ZSLiveLauncher.exe' }
Copy-Item $lx "$stage\core\launcher\ZSLiveLauncher.exe" -Force
foreach ($f in 'start-windows.bat','stop-windows.bat','start-linux.sh','stop-linux.sh',
               'launcher.config.example.bat','launcher.config.example.sh','README.md') {
    $p = Join-Path $root "launcher\$f"
    if (Test-Path $p) { Copy-Item $p "$stage\core\launcher\$f" -Force }
}
Sync "$root\scripts" "$stage\core\scripts"
Sync "$root\docs"    "$stage\core\docs"
Sync "$root\web"     "$stage\core\web"
Sync "$root\ue-plugin" "$stage\core\ue-plugin"
Copy-Item (Join-Path $root 'README.md') "$stage\core\README.md" -Force

if (-not $SkipUE) {
    New-Item -ItemType Directory -Force -Path "$stage\winpkg", "$stage\linuxpkg" | Out-Null
    Sync "$root\UETest\Package\Windows" "$stage\winpkg"
    Sync "$root\UETest\Package\Linux"   "$stage\linuxpkg"
} else {
    Write-Host "       (skip UE packages refresh)"
}

# ---------- 3. 编译 ----------
Write-Host "[3/3] compiling (LZMA2 max, ~4-5 min) ..."
$t0 = Get-Date
& $iscc $iss | Out-Null
if ($LASTEXITCODE -ne 0) { throw "ISCC failed, see dist\iscc_build*.log" }

$out = Join-Path $root ("dist\ZSLive-Setup-$Version.exe")
$mb  = [math]::Round((Get-Item $out).Length / 1MB)
Write-Host ""
Write-Host "DONE: $out  ($mb MB, elapsed $([int]((Get-Date)-$t0).TotalSeconds)s)"
Write-Host "verify: dist\e2e-installed.sh  (E2E 回归脚本)"
