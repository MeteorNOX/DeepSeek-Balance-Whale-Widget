param([string]$DataDir)
$ErrorActionPreference = 'Stop'
function Get-WhaleDigest([string]$Path) {
    $whaleStream = [IO.File]::OpenRead($Path)
    $whaleHasher = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($whaleHasher.ComputeHash($whaleStream)).Replace('-', '').ToLowerInvariant() }
    finally { $whaleHasher.Dispose(); $whaleStream.Dispose() }
}
$whaleRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (!$DataDir) {
    $whaleCodexDir = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
    $DataDir = if ($env:WHALE_HOME) { $env:WHALE_HOME } else { Join-Path $whaleCodexDir 'whale-widget' }
}
$DataDir = [IO.Path]::GetFullPath($DataDir)
$whaleSource = Join-Path $whaleRoot 'desktop\WhaleLauncher.cs'
$whaleHash = Get-WhaleDigest $whaleSource
$whaleNative = Join-Path $DataDir 'native'
New-Item -ItemType Directory -Path $whaleNative -Force | Out-Null
$whaleExe = Join-Path $whaleNative ('WhaleLauncher-' + $whaleHash.Substring(0,20) + '.exe')
$whaleDigestFile = $whaleExe + '.sha256'
function Test-WhaleGuiExecutable([string]$Path) {
    $whaleStream = [IO.File]::OpenRead($Path)
    $whaleReader = [IO.BinaryReader]::new($whaleStream)
    try {
        if ($whaleReader.ReadUInt16() -ne 0x5a4d) { return $false }
        $whaleStream.Position = 0x3c; $whalePE = $whaleReader.ReadInt32()
        $whaleStream.Position = $whalePE
        if ($whaleReader.ReadUInt32() -ne 0x4550) { return $false }
        $whaleStream.Position = $whalePE + 24 + 68
        return $whaleReader.ReadUInt16() -eq 2
    } finally { $whaleReader.Dispose(); $whaleStream.Dispose() }
}
if (Test-Path -LiteralPath $whaleExe -PathType Leaf) {
    if (!(Test-WhaleGuiExecutable $whaleExe) -or !(Test-Path -LiteralPath $whaleDigestFile) -or (Get-WhaleDigest $whaleExe) -cne (Get-Content -LiteralPath $whaleDigestFile -Raw).Trim()) { throw 'Existing launcher failed integrity validation.' }
    Write-Output $whaleExe; return
}
$whaleCompiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (!(Test-Path -LiteralPath $whaleCompiler -PathType Leaf)) { throw 'The Windows .NET Framework C# compiler is unavailable.' }
$whaleTemp = Join-Path $whaleNative ('WhaleLauncher-' + [guid]::NewGuid().ToString('N') + '.exe')
$whaleStart = [Diagnostics.ProcessStartInfo]::new()
$whaleStart.FileName = $whaleCompiler
$whaleStart.Arguments = '/nologo /target:winexe /platform:x64 /optimize+ /reference:System.Web.Extensions.dll /out:"' + $whaleTemp + '" "' + $whaleSource + '"'
$whaleStart.UseShellExecute = $false
$whaleStart.CreateNoWindow = $true
$whaleStart.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
$whaleStart.RedirectStandardOutput = $true
$whaleStart.RedirectStandardError = $true
$whaleCompilerProcess = [Diagnostics.Process]::new(); $whaleCompilerProcess.StartInfo = $whaleStart
try {
    [void]$whaleCompilerProcess.Start()
    $whaleOutput = $whaleCompilerProcess.StandardOutput.ReadToEndAsync()
    $whaleError = $whaleCompilerProcess.StandardError.ReadToEndAsync()
    $whaleCompilerProcess.WaitForExit()
    if ($whaleCompilerProcess.ExitCode -ne 0) { throw ('Launcher compilation failed: ' + $whaleOutput.GetAwaiter().GetResult() + $whaleError.GetAwaiter().GetResult()) }
    if (!(Test-WhaleGuiExecutable $whaleTemp)) { throw 'Compiler output is not a Windows GUI executable.' }
    Move-Item -LiteralPath $whaleTemp -Destination $whaleExe
    (Get-WhaleDigest $whaleExe) | Set-Content -LiteralPath $whaleDigestFile -Encoding ascii
} finally {
    $whaleCompilerProcess.Dispose()
    if (Test-Path -LiteralPath $whaleTemp -PathType Leaf) { Remove-Item -LiteralPath $whaleTemp }
}
Write-Output $whaleExe
