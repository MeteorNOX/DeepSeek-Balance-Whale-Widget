# smtc-helper.ps1 -- one-shot Windows SMTC (media session) bridge for the NetEase Cloud
# Music ("netease") backend of dsh-whale-widget.
#
# Contract with the host (lib/index.js):
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File smtc-helper.ps1 -Cmd <get|play|pause|next|prev>
#     stdout : EXACTLY one line of UTF-8 JSON -- nothing else, ever
#     stderr : diagnostics only (the host forwards them to its console on failure)
#     exit   : always 0; success/failure travels inside the JSON, so a non-zero exit from
#              PowerShell itself (unhandled error, parse error) is the only "no JSON" case
#              and the host already turns that into a readable message.
#
# Output shapes (the host parses stdout as JSON, so these keys are a contract):
#   get                -> {"ok":true,"nowPlaying":{"title":"","artist":"","status":"Playing","appId":"cloudmusic.exe"}}
#   get, no session    -> {"ok":true,"nowPlaying":null}
#   play/pause/next/prev -> {"ok":true,"did":"pause"}
#   any failure        -> {"ok":false,"error":"no-session" | "smtc-unavailable" | "control-failed"}
#
# Why ASCII-only: Windows PowerShell 5.1 decodes .ps1 files as ANSI unless they carry a
# UTF-8 BOM, so a non-ASCII byte here would be mangled on a non-UTF8 system codepage.
# Every string a user actually reads is produced host-side (lib/index.js).
#
# Why Windows PowerShell 5.1 and not pwsh 7: the WinRT projection used below is built on
# System.Runtime.WindowsRuntime, a .NET Framework assembly that pwsh 7 cannot load.
# The host defaults to %SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe.

param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('get', 'play', 'pause', 'next', 'prev')]
  [string]$Cmd
)

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# stdout: one JSON line, written as raw UTF-8 bytes.
# Redirected stdout uses the OEM code page by default (e.g. GBK on zh-CN), so a Chinese
# song title written through [Console]::Out would reach the host as GBK bytes and be
# decoded as UTF-8 => mojibake. Writing the encoded bytes ourselves sidesteps the code
# page entirely. Diagnostics go to stderr so stdout stays a single parseable line.
# ---------------------------------------------------------------------------
function Write-JsonLine([string]$Json) {
  $text = $Json + "`n"
  try {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($text)
    $out = [System.Console]::OpenStandardOutput()
    $out.Write($bytes, 0, $bytes.Length)
    $out.Flush()
  } catch {
    try { [Console]::Out.Write($text) } catch { }
  }
}
function Write-Result($Result) {
  $json = $null
  try { $json = $Result | ConvertTo-Json -Compress -Depth 4 } catch { }
  if ([string]::IsNullOrEmpty($json)) { $json = '{"ok":false,"error":"smtc-unavailable"}' }
  Write-JsonLine $json
}
function Write-Failure([string]$Reason) {
  Write-Result @{ ok = $false; error = $Reason }
}
function Write-Diag([string]$Message) {
  try { [Console]::Error.WriteLine('[smtc] ' + $Message) } catch { }
}

# ---------------------------------------------------------------------------
# The classic WinRT "await" shim: WinRT async operations are IAsyncOperation<T>, which
# PowerShell cannot await directly. System.WindowsRuntimeSystemExtensions.AsTask<T> turns
# one into a .NET Task<T>; the generic method has to be picked by reflection because the
# T of the method is only known from the operation we were handed.
# ---------------------------------------------------------------------------
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null

  $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and
    $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]
  if ($null -eq $asTaskGeneric) {
    Write-Diag 'AsTask<IAsyncOperation<T>> not found in System.Runtime.WindowsRuntime'
    Write-Failure 'smtc-unavailable'
    exit 0
  }
} catch {
  Write-Diag ('WinRT bootstrap failed: ' + $_.Exception.Message)
  Write-Failure 'smtc-unavailable'
  exit 0
}

function Await-Operation($Operation, $ResultType) {
  $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
  $netTask = $asTask.Invoke($null, @($Operation))
  $netTask.Wait(-1) | Out-Null
  return $netTask.Result
}

try {
  $managerType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
  $manager = Await-Operation ($managerType::RequestAsync()) $managerType

  # Only ever touch NetEase Cloud Music's own session. The media session list is shared
  # machine-wide (browsers, other players, DSH itself can all publish sessions), so the
  # AppId filter is the whole safety boundary of this helper: without it we would be
  # pausing whatever the user happens to be watching in Chrome. Measured AppId for the
  # official client is "cloudmusic.exe"; "netease" is accepted as a defensive alias.
  $session = $null
  $sessions = @()
  try { $sessions = $manager.GetSessions() } catch { $sessions = @() }
  foreach ($candidate in $sessions) {
    $candidateId = ''
    try { $candidateId = [string]$candidate.SourceAppUserModelId } catch { $candidateId = '' }
    if ($candidateId -match '(?i)cloudmusic|netease') { $session = $candidate; break }
  }

  if ($Cmd -eq 'get') {
    if ($null -eq $session) {
      # No NetEase session == "nothing is playing as far as we are concerned". This is not
      # an error: the host turns it into nowPlaying:null and the frontend shows "not running".
      Write-Result @{ ok = $true; nowPlaying = $null }
      exit 0
    }
    $propsType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType = WindowsRuntime]
    $props = Await-Operation ($session.TryGetMediaPropertiesAsync()) $propsType
    $status = ''
    try { $status = [string]$session.GetPlaybackInfo().PlaybackStatus } catch { $status = '' }
    $appId = ''
    try { $appId = [string]$session.SourceAppUserModelId } catch { $appId = '' }
    Write-Result @{
      ok         = $true
      nowPlaying = @{
        title  = [string]$props.Title
        artist = [string]$props.Artist
        status = $status
        appId  = $appId
      }
    }
    exit 0
  }

  if ($null -eq $session) {
    Write-Failure 'no-session'
    exit 0
  }

  # TryPlayAsync/TryPauseAsync/TrySkipNextAsync/TrySkipPreviousAsync all return
  # IAsyncOperation<bool>; false means "the client refused" (e.g. nothing queued for next).
  switch ($Cmd) {
    'play' { $operation = $session.TryPlayAsync() }
    'pause' { $operation = $session.TryPauseAsync() }
    'next' { $operation = $session.TrySkipNextAsync() }
    'prev' { $operation = $session.TrySkipPreviousAsync() }
    default { $operation = $null }
  }
  if ($null -eq $operation) {
    Write-Failure 'smtc-unavailable'
    exit 0
  }
  $done = Await-Operation $operation ([bool])
  if ($done -eq $true) {
    Write-Result @{ ok = $true; did = $Cmd }
  } else {
    Write-Failure 'control-failed'
  }
  exit 0
} catch {
  # Never leak a full .NET exception (stack traces, HRESULTs, localised framework text) into
  # stdout: the host maps these short tokens to Chinese sentences for the user.
  Write-Diag ('command failed: ' + $Cmd + ' -- ' + $_.Exception.GetType().Name + ': ' + $_.Exception.Message)
  Write-Failure 'smtc-unavailable'
  exit 0
}
