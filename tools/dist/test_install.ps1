# 在沙箱 DSH_HOME 里真跑一遍分发安装器，逐项断言（不碰真实 ~/.dsh）
#
# 覆盖：zip 解压 → SHA256 自检 → 装插件 → 建链接 → 装语音包 → 幂等 →
#       不覆盖用户已有 config.json → 卸载保留数据 → --purge-data 清语音包
$ErrorActionPreference = 'Continue'
$dist = 'E:\文档\Trea 代码项目\想法\dsh-whale-widget\tools\dist'
$zip  = Join-Path $dist 'out\dsh-whale-widget-0.4.0-full.zip'
$base = Join-Path $env:TEMP ("dsh-dist-test-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
$sandbox = Join-Path $base 'home'
$extract = Join-Path $base 'extract'
$pass = 0; $fail = 0

function Check($name, [scriptblock]$cond) {
  try {
    if (& $cond) { Write-Host "  [OK]   $name"; $scriptA = $true; $script:pass++ }
    else { Write-Host "  [FAIL] $name"; $script:fail++ }
  } catch { Write-Host "  [FAIL] $name  ($($_.Exception.Message))"; $script:fail++ }
}

Write-Host "沙箱: $base"
New-Item -ItemType Directory -Force -Path $extract | Out-Null
Expand-Archive -Path $zip -DestinationPath $extract -Force
$root = Join-Path $extract 'dsh-whale-widget-0.4.0-full'
Write-Host "解压到: $root"

Check 'zip 内含插件本体'        { Test-Path (Join-Path $root 'plugin\lib\index.js') }
Check 'zip 内含前端运行时'      { Test-Path (Join-Path $root 'plugin\assets\whale-voice-runtime.js') }
Check 'zip 内含语音包(47条)'    { (Get-Content (Join-Path $root 'voicepacks\diona-v1\manifest.json') -Raw | ConvertFrom-Json).utterances.Count -eq 47 }
Check 'zip 内含安装器与说明'    { (Test-Path (Join-Path $root 'installer\install.mjs')) -and (Test-Path (Join-Path $root 'INSTALL.md')) -and (Test-Path (Join-Path $root 'NOTICE-VOICE.md')) }
Check '语音包带校验和'          { Test-Path (Join-Path $root 'voicepacks\diona-v1\SHA256SUMS') }
Check '语音包带出处声明'        { Test-Path (Join-Path $root 'voicepacks\diona-v1\PROVENANCE.json') }

Write-Host "`n--- 1) dry-run 不改任何东西 ---"
$out = & node (Join-Path $root 'installer\install.mjs') --home $sandbox --dry-run 2>&1 | Out-String
Check 'dry-run 输出含"将建立链接"' { $out -match '将建立链接' }
Check 'dry-run 没有创建沙箱目录'  { -not (Test-Path $sandbox) }

Write-Host "`n--- 2) 真装（--no-register 跳过 dsh 命令，避免沙箱里跑 pnpm）---"
$out = & node (Join-Path $root 'installer\install.mjs') --home $sandbox --no-register 2>&1 | Out-String
Write-Host ($out -split "`n" | Select-Object -Last 12 | Out-String)
Check '插件解到版本目录'        { Test-Path (Join-Path $sandbox 'dev\dsh-whale-widget-0.4.0\lib\index.js') }
Check '稳定链接已建立(junction)' { (Get-Item (Join-Path $sandbox 'dev\dsh-whale-widget') -Force).LinkType -eq 'Junction' }
Check '链接能读到插件入口'      { Test-Path (Join-Path $sandbox 'dev\dsh-whale-widget\lib\index.js') }
Check '语音包已安装'            { (Get-ChildItem (Join-Path $sandbox 'whale-voice\packs\diona-v1\*.wav')).Count -eq 50 }
Check '语音包已登记到 registry'  { (Get-Content (Join-Path $sandbox 'whale-voice\registry.json') -Raw | ConvertFrom-Json).defaultPackId -eq 'diona-v1' }
Check 'config.json 已启用该包'   { ((Get-Content (Join-Path $sandbox 'whale-voice\config.json') -Raw | ConvertFrom-Json).packId) -eq 'diona-v1' }
Check '安装状态已记录'          { (Get-Content (Join-Path $sandbox 'install-state\dsh-whale-widget.json') -Raw | ConvertFrom-Json).version -eq '0.4.0' }

Write-Host "`n--- 3) 幂等 + 不覆盖用户自己的音色选择 ---"
$cfgPath = Join-Path $sandbox 'whale-voice\config.json'
@{ enabled = $true; packId = 'my-own-pack' } | ConvertTo-Json | Set-Content -Path $cfgPath -Encoding UTF8
$before = (Get-Item $cfgPath).LastWriteTimeUtc
Start-Sleep -Milliseconds 1100
$out = & node (Join-Path $root 'installer\install.mjs') --home $sandbox --no-register 2>&1 | Out-String
Check '重跑提示语音包已存在'      { $out -match '已存在，保持不动' }
$cfgNow = (Get-Content $cfgPath -Raw | ConvertFrom-Json)
Check '用户选的音色没被改'        { $cfgNow.packId -eq 'my-own-pack' }
Check 'config.json 没被重写'      { (Get-Item $cfgPath).LastWriteTimeUtc -eq $before }
Check '重跑后插件文件仍在'        { Test-Path (Join-Path $sandbox 'dev\dsh-whale-widget\lib\index.js') }

Write-Host "`n--- 4) 卸载：保留用户数据 ---"
$out = & node (Join-Path $root 'installer\install.mjs') --home $sandbox --no-register --uninstall 2>&1 | Out-String
Check '链接已移除'              { -not (Test-Path (Join-Path $sandbox 'dev\dsh-whale-widget')) }
Check '版本目录保留(便于回滚)'   { Test-Path (Join-Path $sandbox 'dev\dsh-whale-widget-0.4.0') }
Check '语音包保留(未加 --purge)' { Test-Path (Join-Path $sandbox 'whale-voice\packs\diona-v1\manifest.json') }

Write-Host "`n--- 5) --purge-data：连语音包一起清 ---"
$out = & node (Join-Path $root 'installer\install.mjs') --home $sandbox --no-register --uninstall --purge-data 2>&1 | Out-String
Check '语音包已删除'            { -not (Test-Path (Join-Path $sandbox 'whale-voice\packs\diona-v1')) }

Write-Host "`n--- 6) code 版（不含语音包）行为 ---"
$root2 = Join-Path $extract 'dsh-whale-widget-0.4.0-code'
Expand-Archive -Path (Join-Path $dist 'out\dsh-whale-widget-0.4.0-code.zip') -DestinationPath $extract -Force
$sandbox2 = Join-Path $base 'home2'
$out = & node (Join-Path $root2 'installer\install.mjs') --home $sandbox2 --no-register 2>&1 | Out-String
Check 'code 版提示不含语音包'    { $out -match '不含语音包' }
Check 'code 版插件仍然装好'      { Test-Path (Join-Path $sandbox2 'dev\dsh-whale-widget\lib\index.js') }
Check 'code 版不产生语音目录'    { -not (Test-Path (Join-Path $sandbox2 'whale-voice')) }

Write-Host "`n================ 结果：$pass 通过 / $fail 失败 ================"
Write-Host "沙箱目录（可自行检查）：$base"
if ($fail -eq 0) { Write-Host "全部通过，可清理：Remove-Item -Recurse -Force '$base'" }
exit $fail
