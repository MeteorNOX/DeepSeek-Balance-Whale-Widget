param([string]$DataDir)
$ErrorActionPreference = 'Stop'
$whaleRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (!$DataDir) { $whaleCodex = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }; $DataDir = if ($env:WHALE_HOME) { $env:WHALE_HOME } else { Join-Path $whaleCodex 'whale-widget' } }
$DataDir = [IO.Path]::GetFullPath($DataDir)
& (Join-Path $whaleRoot 'desktop\supervisor.ps1') -DataDir $DataDir -Stop
$whaleConfigFile = Join-Path $DataDir 'follow-config.json'
if (Test-Path -LiteralPath $whaleConfigFile) { $whaleConfig = Get-Content -LiteralPath $whaleConfigFile -Raw | ConvertFrom-Json; $whaleConfig.enabled = $false; $whaleConfig | ConvertTo-Json | Set-Content -LiteralPath $whaleConfigFile -Encoding utf8 }
$whaleTaskName = 'Codex API Balance Whale'
$whaleTask = Get-ScheduledTask -TaskName $whaleTaskName -ErrorAction SilentlyContinue
if ($whaleTask -and (@($whaleTask.Actions) | Where-Object { $_.Arguments.Contains((Join-Path $whaleRoot 'desktop\supervisor.ps1')) -and $_.Arguments.Contains($DataDir) })) {
    Disable-ScheduledTask -TaskName $whaleTaskName | Out-Null
    for ($whaleAttempt=0; $whaleAttempt -lt 40; $whaleAttempt++) { if ((Get-ScheduledTask -TaskName $whaleTaskName).State -ne 'Running') { break }; Start-Sleep -Milliseconds 200 }
    Stop-ScheduledTask -TaskName $whaleTaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $whaleTaskName -Confirm:$false
}
$whaleStartup = Join-Path ([Environment]::GetFolderPath('Startup')) 'Codex API Balance Whale.lnk'
if (Test-Path -LiteralPath $whaleStartup) {
    $whaleShell = New-Object -ComObject WScript.Shell
    $whaleShortcut = $whaleShell.CreateShortcut($whaleStartup)
    if ($whaleShortcut.Arguments.Contains((Join-Path $whaleRoot 'desktop\supervisor.ps1'))) { Remove-Item -LiteralPath $whaleStartup }
}
Write-Output 'Automatic following disabled. Settings, resources and records are retained.'
