param([string]$Source, [string]$DataDir, [string]$CodexCli, [switch]$CheckOnly, [switch]$Resume, [switch]$KeepExistingTask)
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSEdition -ne 'Desktop') { throw 'Run this installer with Windows PowerShell (powershell.exe), not pwsh.' }
. (Join-Path $PSScriptRoot 'package-common.ps1')
if (!$Source) { $Source = Join-Path $PSScriptRoot '..' }
$Source = Get-WhaleFullPath $Source
$target = Get-WhaleFullPath (Join-Path $env:USERPROFILE 'plugins\api-balance-whale')
$codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
if (!$DataDir) { $DataDir = if ($env:WHALE_HOME) { $env:WHALE_HOME } else { Join-Path $codexHome 'whale-widget' } }
$DataDir = Get-WhaleFullPath $DataDir
foreach ($location in @($Source,$target,$DataDir)) { Assert-WhalePlainPath $location }
if ($DataDir -eq $target -or $DataDir.StartsWith($target + '\',[StringComparison]::OrdinalIgnoreCase) -or $target.StartsWith($DataDir + '\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Plugin code and user data must be separate directories.' }
$manifest = Get-Content -LiteralPath (Join-Path $Source '.codex-plugin\plugin.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($manifest.name -cne 'api-balance-whale' -or $manifest.version -notmatch '^\d+\.\d+\.\d+(?:\+[A-Za-z0-9.-]+)?$') { throw 'This installer requires a valid api-balance-whale release manifest.' }
$node = Find-WhaleNode
Invoke-WhaleCommand $node @((Join-Path $Source 'scripts\check-package.mjs'))
$cli = Find-WhaleCodex $CodexCli
$helper = Join-Path $Source 'scripts\marketplace-helper.mjs'
$marketplaceInfo = & $node $helper inspect
if ($LASTEXITCODE -ne 0) { throw 'Personal marketplace validation failed.' }
$marketplaceInfo = $marketplaceInfo | ConvertFrom-Json
$task = Get-ScheduledTask -TaskName 'Codex API Balance Whale' -ErrorAction SilentlyContinue
Assert-WhaleTaskOwner $task $DataDir
if ($KeepExistingTask) { Assert-WhaleReusableTask $task $DataDir $target }
$previousVersion = $null
if (Test-Path -LiteralPath $target) {
    $previousManifest = Get-Content -LiteralPath (Join-Path $target '.codex-plugin\plugin.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($previousManifest.name -cne 'api-balance-whale') { throw 'Destination belongs to another plugin.' }
    $previousVersion = $previousManifest.version
}
if ($CheckOnly) { @{ ok=$true; version=$manifest.version; destination=$target; data=$DataDir; codexCli=$cli; marketplace=$marketplaceInfo.marketplaceName; previousVersion=$previousVersion } | ConvertTo-Json; return }
$backupRoot = Get-WhaleFullPath (Join-Path $env:LOCALAPPDATA ('CodexWhale\backups\' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0,8)))
Assert-WhalePlainPath $backupRoot
$null = New-Item -ItemType Directory -Path $backupRoot
$receipt = @{ format=1; plugin='api-balance-whale'; version=$manifest.version; installedAt=[DateTime]::UtcNow.ToString('o'); target=$target; dataDir=$DataDir; backup=$backupRoot; codexCli=$cli; previousVersion=$previousVersion; previousTask=($null -ne $task); stage='backup'; marketplace=$marketplaceInfo.marketplaceName }
$receipt.keepExistingTask = [bool]$KeepExistingTask
if (Test-Path -LiteralPath $target) { Copy-WhaleTree $target (Join-Path $backupRoot 'plugin') @('node_modules','.git') }
if (Test-Path -LiteralPath $DataDir) { Copy-WhaleTree $DataDir (Join-Path $backupRoot 'data') @('desktop-runtime','desktop-profile','native','npm-cache','runtime.json','service.lock','supervisor-state.json','launcher-state.json') }
if ($task) { Export-ScheduledTask -TaskName 'Codex API Balance Whale' | Set-Content -LiteralPath (Join-Path $backupRoot 'scheduled-task.xml') -Encoding UTF8 }
# Keep rollback code outside the plugin tree so replacing that tree cannot remove it.
Copy-WhaleTree (Join-Path $Source 'scripts') (Join-Path $backupRoot 'recovery-scripts')
Write-WhaleReceipt (Join-Path $backupRoot 'installation.json') $receipt
try {
    if ($Source -ine $target) {
        $stage = $target + '.stage-' + [Guid]::NewGuid().ToString('N')
        Copy-WhaleTree $Source $stage @('node_modules','.git')
        if ($task) {
            if ($KeepExistingTask) { Stop-WhaleExistingTask $task $DataDir $target }
            else { & (Join-Path $target 'scripts\uninstall-follow.ps1') -DataDir $DataDir }
        }
        if (Test-Path -LiteralPath $target) {
            # Both absolute locations were validated; the old tree remains a private checkpoint.
            $old = Join-Path $backupRoot 'previous-source'
            Assert-WhalePlainPath $target; Assert-WhalePlainPath $old
            try { Move-Item -LiteralPath $target -Destination $old -ErrorAction Stop }
            catch [System.IO.IOException] { Sync-WhaleCode $stage $target (Join-Path $backupRoot 'retired-files') }
            catch [System.UnauthorizedAccessException] { Sync-WhaleCode $stage $target (Join-Path $backupRoot 'retired-files') }
        }
        if(!(Test-Path -LiteralPath $target)){ Move-Item -LiteralPath $stage -Destination $target }
    }
    $receipt.stage='source-ready'; Write-WhaleReceipt (Join-Path $backupRoot 'installation.json') $receipt
    $savedWhaleHome = $env:WHALE_HOME
    try {
        $env:WHALE_HOME = $DataDir
        Invoke-WhaleCommand $node @((Join-Path $target 'scripts\install-desktop.mjs'))
        Invoke-WhaleCommand $node @((Join-Path $target 'scripts\marketplace-helper.mjs'),'install',(Join-Path $backupRoot 'marketplace-entry.json'))
        $receipt.stage='marketplace-ready'; Write-WhaleReceipt (Join-Path $backupRoot 'installation.json') $receipt
        $installResult = & $cli plugin add ('api-balance-whale@' + $marketplaceInfo.marketplaceName) --json
        if ($LASTEXITCODE -ne 0) { throw 'Codex rejected the plugin installation.' }
        $installResult | ConvertFrom-Json | Out-Null
        $receipt.stage='plugin-registered'; Write-WhaleReceipt (Join-Path $backupRoot 'installation.json') $receipt
        $catalog = & $cli plugin list --json
        if ($LASTEXITCODE -ne 0) { throw 'Cannot verify installed plugin registration.' }
        $installed = @((($catalog | ConvertFrom-Json).installed) | Where-Object { $_.pluginId -ceq ('api-balance-whale@' + $marketplaceInfo.marketplaceName) -and $_.version -ceq $manifest.version -and $_.installed -eq $true -and $_.enabled -eq $true })
        if ($installed.Count -ne 1) { throw ('Codex did not report one enabled v' + $manifest.version + ' installation.') }
        # Explicit resume is opt-in; the original pause marker is already backed up.
        if ($Resume) { Remove-Item -LiteralPath (Join-Path $DataDir 'pause-until-host-exit.json') -Force -ErrorAction SilentlyContinue }
        if ($KeepExistingTask) { Start-ScheduledTask -TaskName 'Codex API Balance Whale' -ErrorAction Stop }
        else { & (Join-Path $target 'scripts\install-follow.ps1') -DataDir $DataDir }
        Invoke-WhaleCommand $node @((Join-Path $target 'scripts\verify-runtime.mjs'),'--allow-idle')
    } finally { $env:WHALE_HOME = $savedWhaleHome }
    $receipt.stage='complete'; Write-WhaleReceipt (Join-Path $backupRoot 'installation.json') $receipt
    $null = New-Item -ItemType Directory -Path $DataDir -Force
    Write-WhaleReceipt (Join-Path $DataDir 'package-installation.json') @{ receipt=(Join-Path $backupRoot 'installation.json'); version=$manifest.version }
    Write-Output ('Installed v' + $manifest.version + '. Private rollback receipt: ' + (Join-Path $backupRoot 'installation.json'))
    Write-Output 'Open a new Codex chat to load the updated skill and tools. User settings, media and usage records were retained.'
} catch {
    $receipt.failure=$_.Exception.Message; Write-WhaleReceipt (Join-Path $backupRoot 'installation.json') $receipt
    Write-Warning ('Installation incomplete. Keep this private backup: ' + $backupRoot)
    Write-Warning ('Rollback: powershell.exe -NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $backupRoot 'recovery-scripts\rollback-package.ps1') + '" -Receipt "' + (Join-Path $backupRoot 'installation.json') + '"')
    throw
}
