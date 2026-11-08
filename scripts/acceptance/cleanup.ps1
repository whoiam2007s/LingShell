# 清掉验收脚本自己起的 LingShell 实例：只认命令行里带 lingshell-accept 的，
# 用户正在用的窗口（没有这个标记）绝不会被碰。
Get-CimInstance Win32_Process -Filter "name='LingShell.exe'" |
  Where-Object { $_.CommandLine -match 'lingshell-accept|ls-accept' } |
  ForEach-Object {
    Write-Output ("kill " + $_.ProcessId)
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }
