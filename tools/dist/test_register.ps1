# 验证"官方登记入口"在隔离 DSH_HOME 里真能用：
#   dsh plugin --profile web add link:<插件目录>
# 断言：profile 的 package.json 出现依赖 + dsh.profile.bundles 里出现插件 id
$ErrorActionPreference = 'Continue'
$sandbox = Join-Path $env:TEMP ("dsh-register-test-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
$extract = Join-Path $env:TEMP ("dsh-register-extract-" + (Get-Date -Format 'HHmmss'))
$zip = 'E:\文档\Trea 代码项目\想法\dsh-whale-widget\tools\dist\out\dsh-whale-widget-0.4.0-code.zip'

Write-Host "沙箱 DSH_HOME: $sandbox"
Expand-Archive -Path $zip -DestinationPath $extract -Force
$root = Join-Path $extract 'dsh-whale-widget-0.4.0-code'

$env:DSH_HOME = $sandbox
$env:npm_config_yes = 'true'

Write-Host "`n=== 运行官方登记命令 ==="
$out = & node (Join-Path $root 'installer\install.mjs') --home $sandbox 2>&1 | Out-String
Write-Host ($out -split "`n" | Select-Object -Last 22 | Out-String)

Write-Host "`n=== profile 目录 ==="
$prof = Join-Path $sandbox 'profiles\web'
if (Test-Path $prof) {
  $pjPath = Join-Path $prof 'package.json'
  if (Test-Path $pjPath) {
    $pj = Get-Content $pjPath -Raw | ConvertFrom-Json
    Write-Host "依赖: $($pj.dependencies.PSObject.Properties.Name -join ', ')"
    Write-Host "dsh-whale-widget 依赖值: $($pj.dependencies.'dsh-whale-widget')"
    Write-Host "bundles: $($pj.dsh.profile.bundles -join ', ')"
    Write-Host ""
    if ($pj.dependencies.'dsh-whale-widget') { Write-Host "[OK]   依赖已登记" } else { Write-Host "[FAIL] 依赖未登记" }
    if ($pj.dsh.profile.bundles -contains 'dsh-whale-widget') { Write-Host "[OK]   bundles 已对账" } else { Write-Host "[FAIL] bundles 未对账" }
  } else { Write-Host "[FAIL] 没有 profile package.json" }
} else { Write-Host "[FAIL] 没有创建 profile 目录" }
Write-Host "`n沙箱目录：$sandbox"
