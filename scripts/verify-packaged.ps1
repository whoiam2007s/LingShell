# 灵壳 LingShell 打包版安装后自检（只读，不改应用数据）
#
# 用法（在仓库根目录）：
#   powershell -ExecutionPolicy Bypass -File scripts\verify-packaged.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\verify-packaged.ps1 -AppPath "D:\LingShell\LingShell.exe"
#   powershell -ExecutionPolicy Bypass -File scripts\verify-packaged.ps1 -Installer "D:\packages\LingShell-0.1.0-win-x64.exe" -ExpectedSha256 "263A6598..."
#   powershell -ExecutionPolicy Bypass -File scripts\verify-packaged.ps1 -MakeTestFiles
#
# -MakeTestFiles 只在 %TEMP%\lingshell-verify 生成预览 / 传输用的测试文件，不检查安装。
param(
  [string]$AppPath = '',
  [string]$Installer = '',
  [string]$ExpectedSha256 = '',
  [switch]$MakeTestFiles
)

$ErrorActionPreference = 'Stop'
$script:fail = 0
function Ok([string]$m) { Write-Host "[ OK ] $m" -ForegroundColor Green }
function Warn([string]$m) { Write-Host "[WARN] $m" -ForegroundColor Yellow }
function Bad([string]$m) { Write-Host "[FAIL] $m" -ForegroundColor Red; $script:fail++ }

function New-SizedFile([string]$Path, [int64]$Bytes) {
  $fs = [IO.File]::Open($Path, [IO.FileMode]::Create, [IO.FileAccess]::Write)
  try { $fs.SetLength($Bytes) } finally { $fs.Dispose() }
}

if ($MakeTestFiles) {
  $dir = Join-Path $env:TEMP 'lingshell-verify'
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $mb = 1MB
  $line = ('a' * 200) + [Environment]::NewLine
  [IO.File]::WriteAllText((Join-Path $dir 'ok-1m.md'), ('# 预览测试' + [Environment]::NewLine + ($line * 5000)))
  [IO.File]::WriteAllText((Join-Path $dir 'big-3m.md'), ('# 超过 Markdown 2MB 上限' + [Environment]::NewLine + ('a' * (3 * $mb))))
  $csv = New-Object System.Text.StringBuilder
  [void]$csv.AppendLine('id,value')
  for ($i = 0; $i -lt 120000; $i++) { [void]$csv.AppendLine("$i,value-$i") }
  [IO.File]::WriteAllText((Join-Path $dir 'big-3m.csv'), $csv.ToString())
  $csv6 = New-Object System.Text.StringBuilder
  [void]$csv6.AppendLine('id,value')
  for ($i = 0; $i -lt 340000; $i++) { [void]$csv6.AppendLine("$i,value-$i") }
  [IO.File]::WriteAllText((Join-Path $dir 'big-6m.csv'), $csv6.ToString())
  New-SizedFile (Join-Path $dir 'big-21m.png') (21 * $mb)
  New-SizedFile (Join-Path $dir 'big-31m.pdf') (31 * $mb)
  New-SizedFile (Join-Path $dir 'transfer-60m.bin') (60 * $mb)
  Ok "测试文件已生成：$dir"
  Get-ChildItem $dir | Select-Object Name, Length | Format-Table -AutoSize
  Write-Host '用法：资源管理器打开这个目录，按验收清单双击 / 上传对应文件。'
  exit 0
}

function Find-App {
  $candidates = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\LingShell\LingShell.exe'),
    (Join-Path $env:ProgramFiles 'LingShell\LingShell.exe')
  )
  if (${env:ProgramFiles(x86)}) { $candidates += (Join-Path ${env:ProgramFiles(x86)} 'LingShell\LingShell.exe') }
  foreach ($p in $candidates) { if (Test-Path $p) { return $p } }
  return ''
}

if (-not $Installer) { $Installer = Join-Path (Split-Path $PSScriptRoot -Parent) 'release\LingShell-0.1.0-win-x64.exe' }
if (Test-Path $Installer) {
  $it = Get-Item $Installer
  Ok ("安装包：{0}（{1:N1} MB）" -f $it.FullName, ($it.Length / 1MB))
  $hash = (Get-FileHash $Installer -Algorithm SHA256).Hash
  Ok "安装包 SHA256：$hash"
  if ($ExpectedSha256) {
    if ($hash -eq $ExpectedSha256.ToUpperInvariant()) { Ok '安装包哈希匹配' } else { Bad "安装包哈希不匹配（期望 $ExpectedSha256）" }
  }
} else {
  Warn "没找到安装包：$Installer（可用 -Installer 指定）"
}

if (-not $AppPath) { $AppPath = Find-App }
if (-not $AppPath -or -not (Test-Path $AppPath)) {
  Bad '没找到已安装的 LingShell.exe（先安装；或用 -AppPath 指定）'
} else {
  $app = Get-Item $AppPath
  $vi = $app.VersionInfo
  Ok "安装位置：$($app.FullName)"
  Ok "版本：$($vi.FileVersion) / 产品：$($vi.ProductName)"
  if ($vi.ProductName -notlike '*LingShell*') { Bad "产品名不是 LingShell（$($vi.ProductName)）" }

  $res = Join-Path (Split-Path $AppPath -Parent) 'resources'
  $required = @(
    'app.asar',
    'ui\index.html',
    'splash.html',
    'icon.ico',
    'app.asar.unpacked\node_modules\node-pty\prebuilds\win32-x64\pty.node',
    'app.asar.unpacked\node_modules\node-pty\prebuilds\win32-x64\conpty.node',
    'app.asar.unpacked\node_modules\node-pty\prebuilds\win32-x64\winpty-agent.exe',
    'app.asar.unpacked\node_modules\@koromix\koffi-win32-x64\win32_x64\koffi.node'
  )
  foreach ($rel in $required) {
    $p = Join-Path $res $rel
    if (Test-Path $p) { Ok "资源存在：$rel" } else { Bad "缺少资源：$p" }
  }
  $upd = Join-Path $res 'app-update.yml'
  if (Test-Path $upd) { Warn "发现 app-update.yml：这个包配置了自动更新源（$((Get-Content $upd -Raw).Trim())）" }
  else { Ok '未配置更新源（本机构建预期；关于页应显示「未配置更新源」）' }

  $data = Join-Path $env:USERPROFILE '.lingshell'
  if (Test-Path $data) {
    Ok "数据目录：$data"
    $cfg = Join-Path $data 'config'
    if (Test-Path $cfg) { Ok ("配置文件：{0} 个" -f (Get-ChildItem $cfg -File -ErrorAction SilentlyContinue).Count) }
    $logs = Join-Path $data 'logs'
    if (Test-Path $logs) {
      $latest = Get-ChildItem $logs -Directory | Sort-Object Name -Descending | Select-Object -First 1
      if ($latest) {
        $main = Join-Path $latest.FullName 'main.log'
        $web = Join-Path $latest.FullName 'web.log'
        if (Test-Path $main) {
          Ok "最近日志：$($latest.FullName)"
          $tail = Get-Content $main -Tail 200
          foreach ($pat in @('灵壳 LingShell 启动', 'dsh runtime booted', 'boot: closing splash')) {
            if ($tail -match [regex]::Escape($pat)) { Ok "日志包含：$pat" } else { Warn "最近 200 行没看到：$pat" }
          }
          $errs = @()
          if (Test-Path $main) { $errs += Select-String -Path $main -Pattern ' ERROR ' -ErrorAction SilentlyContinue }
          if (Test-Path $web) { $errs += Select-String -Path $web -Pattern ' ERROR ' -ErrorAction SilentlyContinue }
          if ($errs.Count) {
            Warn "最近日志有 $($errs.Count) 条 ERROR（最后 10 条）："
            $errs | Select-Object -Last 10 | ForEach-Object { Write-Host "        $($_.Line)" -ForegroundColor DarkYellow }
          } else { Ok '最近日志没有 ERROR' }
        } else { Warn "没有 $main；先启动应用一次再运行本脚本" }
      } else { Warn "日志目录为空：$logs" }
    } else { Warn "没有日志目录：$logs（先启动应用一次）" }
  } else { Warn "还没生成数据目录：$data（首次启动后生成）" }

  $ud = Join-Path $env:APPDATA 'LingShell'
  if (Test-Path $ud) { Ok "浏览器数据 / 加密钥匙目录：$ud" } else { Warn "没有 $ud（首次启动后生成）" }

  $proc = Get-Process LingShell -ErrorAction SilentlyContinue
  if ($proc) { Ok ("应用正在运行（PID：{0}）" -f (($proc | ForEach-Object Id) -join ', ')) } else { Warn '应用当前未运行（可以在启动后再跑一次本脚本）' }
}

if ($script:fail) {
  Write-Host "自检失败：$($script:fail) 项，见上面 [FAIL]" -ForegroundColor Red
  exit 1
}
Write-Host '自检通过：安装包 / 安装目录 / 关键资源 / 日志检查没有失败项。' -ForegroundColor Green
Write-Host 'UI 功能请继续按 docs\打包回归验收.md 的 P0 / P1 清单逐项操作。'
