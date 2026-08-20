# ============================================================
#  DSH Whale Balance Desktop Widget - host script (pure WinForms,
#  no WebView2, no dependencies beyond the OS).
#
#  Renders the whale PNG as the window background and draws the
#  balance text with GDI+ directly on the form. Reliable, instant
#  startup, all interactions are native Win32.
#
#  This file is pure ASCII on purpose: all user-facing Chinese text
#  is in the menu strings below. Paths are resolved at runtime via
#  $PSScriptRoot, so the folder can live anywhere.
#
#  Launch:  powershell.exe -NoProfile -STA -ExecutionPolicy Bypass
#           -WindowStyle Hidden -File whale-widget.ps1
# ============================================================
$ErrorActionPreference = 'Stop'

$script:root = $PSScriptRoot
if (-not $script:root) { $script:root = Split-Path -Parent $MyInvocation.MyCommand.Path }

function Write-Log([string]$text) {
  try {
    Add-Content -Path (Join-Path $script:root 'widget-error.log') -Value ("[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $text)
  } catch {}
}

# ---------- single instance ----------
$script:mtx = New-Object System.Threading.Mutex($false, 'Global\dsh-whale-desktop-widget')
if (-not $script:mtx.WaitOne(0)) { exit 0 }

try {

# ---------- native helpers ----------
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class Native {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern IntPtr SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern bool ReleaseCapture();
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wp, IntPtr lp);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindowW(string cls, string title);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindowExW(IntPtr parent, IntPtr after, string cls, string title);
  [DllImport("user32.dll")] public static extern bool SetParent(IntPtr hWnd, IntPtr parent);
  [DllImport("user32.dll")] public static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int idx);
  [DllImport("user32.dll")] public static extern IntPtr SetWindowLongPtr(IntPtr hWnd, int idx, IntPtr val);
  public delegate bool EnumProc(IntPtr hwnd, IntPtr lparam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lparam);
}
'@
try {
  $r = [Native]::SetProcessDpiAwarenessContext([IntPtr](-4))
  if ($r -eq [IntPtr]::Zero) { [void][Native]::SetProcessDPIAware() }
} catch {
  try { [void][Native]::SetProcessDPIAware() } catch {}
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Net.Http

# threshold the whale PNG's alpha at load time (hard 0/255). This kills the
# magenta fringe: with color-key transparency, semi-transparent anti-aliased
# edge pixels blend toward the key color and show up as a purple outline.
Add-Type -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
public static class ImageHelper {
  public static Bitmap ScaleThreshold(Image src, int w, int h) {
    var bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb);
    using (var g = Graphics.FromImage(bmp)) {
      g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
      g.Clear(Color.Transparent);
      g.DrawImage(src, new Rectangle(0, 0, w, h));
    }
    var rect = new Rectangle(0, 0, w, h);
    var data = bmp.LockBits(rect, ImageLockMode.ReadWrite, PixelFormat.Format32bppArgb);
    int n = data.Stride * h;
    var buf = new byte[n];
    Marshal.Copy(data.Scan0, buf, 0, n);
    for (int i = 3; i < n; i += 4) buf[i] = (byte)(buf[i] >= 128 ? 255 : 0);
    Marshal.Copy(buf, 0, data.Scan0, n);
    bmp.UnlockBits(data);
    return bmp;
  }
}
'@ -ReferencedAssemblies System.Drawing

# ---------- touch support (WM_TOUCH -> synthetic mouse messages) ----------
# A window that calls RegisterTouchWindow receives WM_TOUCH instead of the
# system's coalesced mouse messages, so we translate single-finger touches
# into WM_LBUTTONDOWN / WM_MOUSEMOVE / WM_LBUTTONUP ourselves. This makes the
# press-squish, drag and click work on touch screens.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;
public static class NativeTouch {
  [StructLayout(LayoutKind.Sequential)]
  public struct TOUCHINPUT { public int x; public int y; public IntPtr hSource; public uint dwID; public uint dwFlags; public uint dwMask; public uint dwTime; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)]
  public struct POINT { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern bool RegisterTouchWindow(IntPtr hwnd, uint flags);
  [DllImport("user32.dll")] public static extern bool GetTouchInputInfo(IntPtr h, uint c, [In, Out] TOUCHINPUT[] i, int s);
  [DllImport("user32.dll")] public static extern bool CloseTouchInputHandle(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ScreenToClient(IntPtr hwnd, ref POINT pt);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wp, IntPtr lp);
}
public class TouchFilter : IMessageFilter {
  public IntPtr Target;
  const uint WM_TOUCH = 0x0240;
  const uint TOUCHEVENTF_DOWN = 0x0001;
  const uint TOUCHEVENTF_UP   = 0x0004;
  const uint MK_LBUTTON = 0x0001;
  public bool PreFilterMessage(ref Message m) {
    if (m.HWnd != Target || m.Msg != WM_TOUCH) return false;
    int count = m.WParam.ToInt32() & 0xFFFF;
    if (count <= 0) return true;
    var inputs = new NativeTouch.TOUCHINPUT[count];
    int sz = Marshal.SizeOf(typeof(NativeTouch.TOUCHINPUT));
    if (!NativeTouch.GetTouchInputInfo(m.LParam, (uint)count, inputs, sz)) return true;
    foreach (var t in inputs) {
      uint f = t.dwFlags;
      if ((f & TOUCHEVENTF_UP) != 0)        PostMouse(0x0202, 0, t.x, t.y);            // WM_LBUTTONUP
      else if ((f & TOUCHEVENTF_DOWN) != 0) PostMouse(0x0201, MK_LBUTTON, t.x, t.y);   // WM_LBUTTONDOWN
      else                                  PostMouse(0x0200, MK_LBUTTON, t.x, t.y);   // WM_MOUSEMOVE
    }
    NativeTouch.CloseTouchInputHandle(m.LParam);
    return true;
  }
  void PostMouse(uint msg, uint wp, int sx, int sy) {
    var pt = new NativeTouch.POINT(); pt.X = sx; pt.Y = sy;
    NativeTouch.ScreenToClient(Target, ref pt);
    int lp = ((pt.Y & 0xFFFF) << 16) | (pt.X & 0xFFFF);
    NativeTouch.PostMessage(Target, msg, (IntPtr)wp, (IntPtr)lp);
  }
}
'@ -ReferencedAssemblies System.Windows.Forms, System.Drawing

# swallow + log unhandled UI-thread exceptions instead of showing the .NET
# crash dialog (which would freeze the widget and steal focus)
try {
  [System.Windows.Forms.Application]::SetUnhandledExceptionMode([System.Windows.Forms.UnhandledExceptionMode]::CatchException)
  [System.Windows.Forms.Application]::Add_ThreadException({
    param($s, $e)
    try { Write-Log ('ui-ex: ' + $e.Exception.Message) } catch {}
  })
} catch {}

# ---------- constants / state ----------
$script:BASE = 196
$script:MIN_SCALE = 0.6
$script:MAX_SCALE = 1.4
$script:BALANCE_URL = 'https://api.deepseek.com/user/balance'
$script:stateFile = Join-Path $script:root 'widget-state.json'
$script:keyFile   = Join-Path $script:root 'widget-key.json'
$script:pngPath   = Join-Path $script:root 'DSniang02.png'

$script:scale = 1.0
$script:mode = 'top'
$script:autoRefresh = $true
$script:posX = $null
$script:posY = $null
if (Test-Path $script:stateFile) {
  try {
    $st = Get-Content $script:stateFile -Raw | ConvertFrom-Json
    if ($st.scale) { $s = [double]$st.scale; if ($s -ge $script:MIN_SCALE -and $s -le $script:MAX_SCALE) { $script:scale = $s } }
    if ($st.mode) { $m = [string]$st.mode; if ($m -eq 'top' -or $m -eq 'normal' -or $m -eq 'desktop') { $script:mode = $m } }
    if ($null -ne $st.autoRefresh) { $script:autoRefresh = [bool]$st.autoRefresh }
    if ($null -ne $st.x -and $null -ne $st.y) { $script:posX = [int]$st.x; $script:posY = [int]$st.y }
  } catch {}
}

$script:state = @{ status = 'loading'; message = ''; balance = $null; currency = $null }
$script:displayValue = $null
$script:settleTimer = $null
$script:dragInfo = $null
$script:flip = $false

# ---------- api key ----------
function Get-KeySource {
  if ($env:DEEPSEEK_API_KEY) { return 'env' }
  if (Test-Path $script:keyFile) {
    try {
      $k = Get-Content $script:keyFile -Raw | ConvertFrom-Json
      if ($k.apiKey) { return 'file' }
    } catch {}
  }
  return 'none'
}
function Get-Key {
  if ($env:DEEPSEEK_API_KEY) { return [string]$env:DEEPSEEK_API_KEY }
  if (Test-Path $script:keyFile) {
    try {
      $k = Get-Content $script:keyFile -Raw | ConvertFrom-Json
      if ($k.apiKey) { return [string]$k.apiKey }
    } catch {}
  }
  return $null
}
function Save-Key([string]$key) {
  try {
    if ($key) {
      @{ apiKey = $key } | ConvertTo-Json -Compress | Set-Content -Path $script:keyFile -Encoding ASCII
    } elseif (Test-Path $script:keyFile) {
      Remove-Item -Path $script:keyFile -Force -ErrorAction SilentlyContinue
    }
  } catch { Write-Log ('save-key failed: ' + $_) }
}

# ---------- form ----------
$script:form = New-Object System.Windows.Forms.Form
$script:form.Text = 'DSHW Whale Widget'
$script:form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$script:form.ShowInTaskbar = $false
$script:form.StartPosition = 'Manual'
$script:form.AutoScaleMode = 'None'
$script:form.BackColor = [System.Drawing.Color]::Magenta
$script:form.TransparencyKey = [System.Drawing.Color]::Magenta
# double-buffer the form: flicker-free repaints during the press squish / roll
# animation (DoubleBuffered is protected -> set via reflection)
try {
  $dbProp = $script:form.GetType().GetProperty('DoubleBuffered', [System.Reflection.BindingFlags]'Instance,NonPublic')
  if ($null -ne $dbProp) { $dbProp.SetValue($script:form, $true, $null) }
} catch {}

$script:whaleImg = $null
$script:scaledWhale = $null
$script:scaledWhaleSize = 0
if (Test-Path $script:pngPath) {
  try {
    # load + alpha-threshold in one go; dispose the source so GDI+ does NOT
    # hold a file lock on DSniang02.png for the whole session
    $srcImg = [System.Drawing.Image]::FromFile($script:pngPath)
    $script:whaleImg = [ImageHelper]::ScaleThreshold($srcImg, 1026, 1026)
    $srcImg.Dispose()
  } catch { Write-Log ('png load failed: ' + $_) }
}

# the widget is drawn at a fixed per-size cached bitmap: the source is scaled
# down with bicubic THEN thresholded again, so the display bitmap has hard
# alpha edges (no semi-transparent pixels -> no magenta fringe at any size).
function Get-ScaledWhale([int]$size) {
  if ($size -lt 8) { return $script:whaleImg }
  if ($null -ne $script:scaledWhale -and $script:scaledWhaleSize -eq $size) { return $script:scaledWhale }
  try {
    $tmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($tmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.Clear([System.Drawing.Color]::Transparent)
    $g.DrawImage($script:whaleImg, 0, 0, $size, $size)
    $g.Dispose()
    $script:scaledWhale = [ImageHelper]::ScaleThreshold($tmp, $size, $size)
    $tmp.Dispose()
    $script:scaledWhaleSize = $size
  } catch {
    Write-Log ('scale whale failed: ' + $_)
    if ($null -eq $script:scaledWhale) { $script:scaledWhale = $script:whaleImg }
  }
  return $script:scaledWhale
}

$sz = [int][Math]::Round($script:BASE * $script:scale)
$script:form.ClientSize = New-Object System.Drawing.Size($sz, $sz)

$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
$x = $vs.X + $vs.Width - $sz
$y = $vs.Y + $vs.Height - $sz
if ($null -ne $script:posX) {
  if ($script:posX -ge ($vs.X - $sz + 48) -and $script:posX -le ($vs.Right - 48) -and
      $script:posY -ge ($vs.Y - $sz + 48) -and $script:posY -le ($vs.Bottom - 48)) {
    $x = $script:posX; $y = $script:posY
  }
}
$script:form.Location = New-Object System.Drawing.Point([int]$x, [int]$y)

# ---------- painting ----------
function Format-Amount([double]$v, [string]$cur) {
  if ($cur -eq 'CNY') { return '¥ ' + $v.ToString('F2') }
  return $v.ToString('F2') + ' ' + $cur
}

$script:form.Add_Paint({
  param($s, $e)
  try {
    $w = $script:form.ClientSize.Width
    $h = $script:form.ClientSize.Height
    if ($w -le 0 -or $h -le 0) { return }
    $g = $e.Graphics
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    # ---- compose the full frame (whale + text, incl. flip) off-screen ----
    $frame = New-Object System.Drawing.Bitmap($w, $h)
    $g2 = [System.Drawing.Graphics]::FromImage($frame)
    $g2.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g2.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
    $g2.Clear([System.Drawing.Color]::Transparent)
    if ($script:flip) {
      $g2.TranslateTransform($w, 0)
      $g2.ScaleTransform(-1, 1)
    }
    # whale image (pre-scaled + alpha-hardened per size; draw 1:1, no interpolation)
    $img = Get-ScaledWhale $w
    if ($img) {
      $g2.DrawImage($img, 0, 0, $w, $h)
    }
    # text (always drawn un-mirrored; when flipped, position at the mirrored bubble)
    $u = $w / 1026.0
    $labelSize = 68 * $u
    $amountSize = 119 * $u
    $hintSize = 54 * $u
    $textCenterX = $w * 0.44346
    if ($script:flip) {
      $g2.ResetTransform()
      $textCenterX = $w - $textCenterX
    }
    $rectX = $textCenterX - $w / 2
    $cy = $h * 0.255
    $yPos = $cy - $labelSize * 0.59 - $amountSize * 0.53 - $hintSize * 0.55
    $labelFont = New-Object System.Drawing.Font('Segoe UI', [single]$labelSize, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $amountFont = New-Object System.Drawing.Font('Segoe UI', [single]$amountSize, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $hintFont = New-Object System.Drawing.Font('Segoe UI', [single]$hintSize, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
    $center = New-Object System.Drawing.StringFormat
    $center.Alignment = [System.Drawing.StringAlignment]::Center
    $center.LineAlignment = [System.Drawing.StringAlignment]::Center

    $labelBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 83, 107, 169))
    $amountBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 83, 107, 169))
    $hintBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 159, 176, 217))

    $st = $script:state
    $noKey = ((Get-KeySource) -eq 'none')
    if ($noKey) {
      $label = 'DeepSeek 余额'
      $amount = if ($null -ne $script:displayValue) { Format-Amount $script:displayValue $st.currency } else { '--' }
      $hint = '右键设置 Key'
    } elseif ($st.status -eq 'loading') {
      $label = 'DeepSeek 余额'
      $amount = if ($null -ne $script:displayValue) { Format-Amount $script:displayValue $st.currency } else { '…' }
      $hint = '加载中…'
    } elseif ($st.status -eq 'error') {
      $label = 'DeepSeek 余额'
      $amount = if ($null -ne $script:displayValue) { Format-Amount $script:displayValue $st.currency } else { '--' }
      $hint = if ($st.message) { $st.message.Substring(0, [Math]::Min(14, $st.message.Length)) } else { '获取失败 · 点击重试' }
    } else {
      $label = 'DeepSeek 余额'
      $amount = if ($null -ne $script:displayValue) { Format-Amount $script:displayValue $st.currency } else { '--' }
      $hint = if ($st.status -eq 'changing') { '加载中…' } else { '点击刷新' }
    }

    $labelRect = New-Object System.Drawing.RectangleF($rectX, $yPos, $w, $labelSize * 1.18)
    $amountRect = New-Object System.Drawing.RectangleF($rectX, ($yPos + $labelSize * 1.18), $w, $amountSize * 1.05)
    $hintRect = New-Object System.Drawing.RectangleF($rectX, ($yPos + $labelSize * 1.18 + $amountSize * 1.05), $w, $hintSize * 1.2)
    $g2.DrawString($label, $labelFont, $labelBrush, $labelRect, $center)
    $g2.DrawString($amount, $amountFont, $amountBrush, $amountRect, $center)
    $g2.DrawString($hint, $hintFont, $hintBrush, $hintRect, $center)

    $labelFont.Dispose(); $amountFont.Dispose(); $hintFont.Dispose()
    $center.Dispose(); $labelBrush.Dispose(); $amountBrush.Dispose(); $hintBrush.Dispose()
    $g2.Dispose()

    # ---- draw the frame with the press squish (bottom-center origin) ----
    # NearestNeighbor + integer target rect: the frame keeps its hard alpha
    # edges (0/255) - no new semi-transparent pixels are created, so the
    # magenta color-key never bleeds through -> no purple fringe while squished.
    $sx = 1.0
    $sy = 1.0
    if ($script:squish) { $sx = 1.05; $sy = 0.88 }
    elseif ($null -ne $script:squishAnim) { $sx = $script:squishAnim.sx; $sy = $script:squishAnim.sy }
    if ($sx -ne 1.0 -or $sy -ne 1.0) {
      $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
      $dw = [int][Math]::Round($w * $sx)
      $dh = [int][Math]::Round($h * $sy)
      $dx = [int][Math]::Round(($w - $dw) / 2.0)
      $dy = $h - $dh
      $g.DrawImage($frame, (New-Object System.Drawing.Rectangle($dx, $dy, $dw, $dh)))
    } else {
      $g.DrawImage($frame, 0, 0)
    }
    $frame.Dispose()
  } catch { Write-Log ('paint failed: ' + $_) }
})

# ---------- press squish (squish while held, bounce-back on release) ----------
$script:squish = $false
$script:squishAnim = $null
$script:squishTimer = New-Object System.Windows.Forms.Timer
$script:squishTimer.Interval = 15
$script:squishTimer.Add_Tick({
  if ($null -eq $script:squishAnim) { $script:squishTimer.Stop(); return }
  $a = $script:squishAnim
  $t = ([DateTime]::UtcNow.Ticks - $a.start) / $a.dur
  if ($t -ge 1) {
    $script:squishAnim = $null
    $script:squishTimer.Stop()
    $script:form.Invalidate()
    return
  }
  $c1 = 1.70158
  $c3 = 2.70158
  $tm = $t - 1
  $eob = 1 + $c3 * $tm * $tm * $tm + $c1 * $tm * $tm   # easeOutBack: overshoot bounce
  $a.sx = 1.05 - 0.05 * $eob
  $a.sy = 0.88 + 0.12 * $eob
  $script:form.Invalidate()
})
function Start-SquishRelease {
  # ALWAYS clear the squish flag first - if a bounce animation from a previous
  # quick click is still running we return early, but squish must not stay true
  # (otherwise the whale freezes squished until the next click)
  $script:squish = $false
  if ($null -ne $script:squishAnim) { return }
  $script:squishAnim = @{ sx = 1.05; sy = 0.88; start = [DateTime]::UtcNow.Ticks; dur = [TimeSpan]::FromMilliseconds(220).Ticks }
  $script:squishTimer.Start()
  $script:form.Invalidate()
}

# ---------- balance refresh (async via HttpClient + UI-thread poll timer) ----------
# The fetch runs inside .NET's own I/O threads (no PowerShell involved); a
# WinForms timer polls the task and finishes the work ON THE UI THREAD. This
# avoids running PowerShell scriptblocks on background threads, which contends
# with the UI thread's runspace lock and freezes the widget.
$script:httpClient = New-Object System.Net.Http.HttpClient
$script:httpClient.Timeout = [TimeSpan]::FromSeconds(25)
$script:fetchTask = $null

$script:pollTimer = New-Object System.Windows.Forms.Timer
$script:pollTimer.Interval = 120
$script:pollTimer.Add_Tick({
  if ($null -eq $script:fetchTask -or -not $script:fetchTask.IsCompleted) { return }
  $script:pollTimer.Stop()
  $task = $script:fetchTask
  $script:fetchTask = $null
  try {
    $resp = $task.Result
    try {
      $code = [int]$resp.StatusCode
      $body = $resp.Content.ReadAsStringAsync().GetAwaiter().GetResult()
      if ($code -eq 401) { On-BalanceResult @{ ok = $false; msg = 'HTTP 401 · Key 无效' } }
      elseif (-not $resp.IsSuccessStatusCode) { On-BalanceResult @{ ok = $false; msg = 'HTTP ' + $code } }
      else {
        $data = $null
        try { $data = $body | ConvertFrom-Json } catch {}
        $infos = @($data.balance_infos)
        if ($infos.Count -eq 0 -or $null -eq $infos[0].total_balance) { On-BalanceResult @{ ok = $false; msg = '接口结构异常' } }
        else { On-BalanceResult @{ ok = $true; balance = [double]$infos[0].total_balance; currency = [string]$infos[0].currency } }
      }
    } finally {
      try { $resp.Dispose() } catch {}
    }
  } catch {
    On-BalanceResult @{ ok = $false; msg = '网络错误' }
  }
})

function On-BalanceResult($result) {
  if ($null -eq $result) { $result = @{ ok = $false; msg = '请求失败' } }
  if ($result.ok) {
    $nb = [double]$result.balance
    $nc = [string]$result.currency
    $prev = $script:state.balance
    $prevc = $script:state.currency
    $script:state.balance = $nb
    $script:state.currency = $nc
    $script:state.message = ''
    if ($null -ne $prev -and $nb -ne $prev -and $nc -eq $prevc) {
      # roll animation
      if ($null -eq $script:displayValue) { $script:displayValue = $prev }
      $script:roll = @{ from = [double]$script:displayValue; to = $nb; start = [DateTime]::UtcNow.Ticks; dur = [TimeSpan]::FromMilliseconds(700).Ticks }
      $script:rollTimer.Start()
      $script:state.status = 'ok'
      if ($script:settleTimer) { [void]$script:settleTimer.Stop() }
      $script:settleTimer = New-Object System.Windows.Forms.Timer
      $script:settleTimer.Interval = 900
      $script:settleTimer.Add_Tick({
        $script:settleTimer.Stop()
        $script:state.status = 'ok'
        $script:form.Invalidate()
      })
      $script:settleTimer.Start()
      $script:form.Invalidate()
    } else {
      $script:displayValue = $nb
      $script:state.status = 'ok'
      $script:form.Invalidate()
    }
  } else {
    $script:state.status = 'error'
    $script:state.message = [string]$result.msg
    $script:form.Invalidate()
  }
  # live feedback into the settings dialog (if it is open): success shows the
  # fetched balance, failure shows the concrete error / HTTP code
  if ($null -ne $script:setStatus -and $null -ne $script:settingsForm -and $script:settingsForm.Visible) {
    try {
      if ($result.ok) {
        $script:setStatus.Text = '验证成功：' + (Format-Amount $nb $nc)
        $script:setStatus.ForeColor = [System.Drawing.Color]::FromArgb(0, 140, 0)
      } else {
        $script:setStatus.Text = '验证失败：' + $script:state.message
        $script:setStatus.ForeColor = [System.Drawing.Color]::FromArgb(200, 40, 40)
      }
    } catch {}
  }
}

function Refresh-Balance([bool]$manual) {
  if ($null -ne $script:fetchTask) { return }   # in-flight guard
  $key = Get-Key
  if (-not $key) {
    $script:state.status = 'error'
    $script:state.message = ''
    $script:form.Invalidate()
    return
  }
  if ($manual -or $null -eq $script:state.balance) {
    $script:state.status = 'loading'
    $script:form.Invalidate()
  }
  $req = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::Get, $script:BALANCE_URL)
  $req.Headers.Authorization = New-Object System.Net.Http.Headers.AuthenticationHeaderValue('Bearer', $key)
  try {
    $script:fetchTask = $script:httpClient.SendAsync($req)
    $script:pollTimer.Start()
  } catch {
    $script:fetchTask = $null
    On-BalanceResult @{ ok = $false; msg = '网络错误' }
  }
}

# ---------- roll animation ----------
$script:rollTimer = New-Object System.Windows.Forms.Timer
$script:rollTimer.Interval = 15
$script:roll = $null
$script:rollTimer.Add_Tick({
  if ($null -eq $script:roll) { $script:rollTimer.Stop(); return }
  $r = $script:roll
  $t = ([DateTime]::UtcNow.Ticks - $r.start) / $r.dur
  if ($t -ge 1) {
    $script:roll = $null
    $script:rollTimer.Stop()
    $script:displayValue = $r.to
    $script:form.Invalidate()
    return
  }
  $p = 1 - [Math]::Pow((1 - $t), 3)
  $script:displayValue = $r.from + ($r.to - $r.from) * $p
  $script:form.Invalidate()
})

# ---------- helpers ----------
function Get-ScreenBounds {
  $scr = [System.Windows.Forms.Screen]::FromHandle($script:form.Handle)
  if ($script:mode -eq 'desktop') { return $scr.Bounds }
  return $scr.WorkingArea
}
function Clamp-Pos([int]$x, [int]$y, [int]$w, [int]$h) {
  $b = Get-ScreenBounds
  if ($x -lt $b.X) { $x = $b.X }
  if ($y -lt $b.Y) { $y = $b.Y }
  if ($x -gt ($b.Right - $w)) { $x = $b.Right - $w }
  if ($y -gt ($b.Bottom - $h)) { $y = $b.Bottom - $h }
  return @{ x = $x; y = $y }
}
function Save-State {
  try {
    @{ x = [int]$script:form.Left; y = [int]$script:form.Top; scale = $script:scale; mode = $script:mode; autoRefresh = $script:autoRefresh } |
      ConvertTo-Json -Compress | Set-Content -Path $script:stateFile -Encoding ASCII
  } catch { Write-Log ('save-state failed: ' + $_) }
}

# ---------- snap animation ----------
$script:animTimer = New-Object System.Windows.Forms.Timer
$script:animTimer.Interval = 15
$script:anim = $null
$script:animTimer.Add_Tick({
  if ($null -eq $script:anim) { $script:animTimer.Stop(); return }
  $a = $script:anim
  $t = ([DateTime]::UtcNow.Ticks - $a.start) / $a.dur
  if ($t -ge 1) {
    $script:form.Location = New-Object System.Drawing.Point([int]$a.tx, [int]$a.ty)
    $script:anim = $null
    $script:animTimer.Stop()
    Save-State
    return
  }
  $p = 1 - [Math]::Pow((1 - $t), 3)
  $nx = $a.fx + ($a.tx - $a.fx) * $p
  $ny = $a.fy + ($a.ty - $a.fy) * $p
  $script:form.Location = New-Object System.Drawing.Point([int][Math]::Round($nx), [int][Math]::Round($ny))
})
function Start-Anim([double]$tx, [double]$ty) {
  $fx = [double]$script:form.Left
  $fy = [double]$script:form.Top
  if ([Math]::Abs($fx - $tx) -lt 1 -and [Math]::Abs($fy - $ty) -lt 1) { Save-State; return }
  $script:anim = @{
    fx = $fx; fy = $fy; tx = $tx; ty = $ty
    start = [DateTime]::UtcNow.Ticks
    dur = [TimeSpan]::FromMilliseconds(260).Ticks
  }
  $script:animTimer.Start()
}
function Start-Snap {
  $w = $script:form.Width
  $h = $script:form.Height
  $b = Get-ScreenBounds
  $cx = $script:form.Left + $w / 2
  $cy = $script:form.Top + $h / 2
  $tx = [double]$script:form.Left
  $ty = [double]$script:form.Top
  $flip = $false
  if ($cx -lt ($b.X + $b.Width / 4)) { $tx = [double]$b.X; $flip = $true }
  elseif ($cx -gt ($b.X + 3 * $b.Width / 4)) { $tx = [double]($b.Right - $w) }
  if ($cy -lt ($b.Y + $b.Height / 4)) { $ty = [double]$b.Y }
  elseif ($cy -gt ($b.Y + 3 * $b.Height / 4)) { $ty = [double]($b.Bottom - $h) }
  $cp = Clamp-Pos ([int]$tx) ([int]$ty) $w $h
  $script:flip = $flip
  $script:form.Invalidate()
  Start-Anim $cp.x $cp.y
}

# ---------- interactions ----------
$script:form.Add_MouseDown({
  param($s, $e)
  if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
    $script:dragInfo = @{ startX = $e.X; startY = $e.Y; moved = $false }
    $script:squish = $true
    # rapid re-click while the bounce animation is running: stop it and go
    # straight back to the squished pose instead of fighting the animation
    if ($null -ne $script:squishAnim) {
      $script:squishAnim = $null
      $script:squishTimer.Stop()
    }
    $script:form.Invalidate()
  }
})
$script:form.Add_MouseMove({
  param($s, $e)
  if ($null -ne $script:dragInfo -and -not $script:dragInfo.moved) {
    $dx = $e.X - $script:dragInfo.startX
    $dy = $e.Y - $script:dragInfo.startY
    if ($dx * $dx + $dy * $dy -ge 9) {
      $script:dragInfo.moved = $true
      [void][Native]::ReleaseCapture()
      [void][Native]::SendMessage($script:form.Handle, 0xA1, [IntPtr]2, [IntPtr]::Zero)
      $script:dragInfo = $null
      # the modal move loop is over -> release the squish with a bounce
      Start-SquishRelease
      Start-Snap
    }
  }
})
$script:form.Add_MouseUp({
  param($s, $e)
  if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left -and $null -ne $script:dragInfo) {
    $moved = $script:dragInfo.moved
    $script:dragInfo = $null
    Start-SquishRelease
    if (-not $moved) {
      if ((Get-KeySource) -eq 'none') { Show-Settings }
      else { Refresh-Balance $true }
    }
  }
})
$script:form.Add_MouseWheel({
  param($s, $e)
  if ($e.Delta -ne 0) {
    $d = if ($e.Delta -gt 0) { 0.1 } else { -0.1 }
    Invoke-Resize ($script:scale + $d)
  }
})

function Invoke-Resize([double]$newScale) {
  if ($newScale -lt $script:MIN_SCALE) { $newScale = $script:MIN_SCALE }
  if ($newScale -gt $script:MAX_SCALE) { $newScale = $script:MAX_SCALE }
  $newScale = [Math]::Round($newScale, 2)
  if ([Math]::Abs($newScale - $script:scale) -lt 0.001) { return }
  $script:scale = $newScale
  $n = [int][Math]::Round($script:BASE * $newScale)
  $b = Get-ScreenBounds
  $w = $script:form.Width
  $h = $script:form.Height
  $cx = $script:form.Left + $w / 2
  $cy = $script:form.Top + $h / 2
  $nx = [double]$script:form.Left
  if ($cx -gt ($b.X + $b.Width / 2)) { $nx = [double](($script:form.Left + $w) - $n) }
  $ny = [double]$script:form.Top
  if ($cy -gt ($b.Y + $b.Height / 2)) { $ny = [double](($script:form.Top + $h) - $n) }
  $cp = Clamp-Pos ([int]$nx) ([int]$ny) $n $n
  $script:form.SuspendLayout()
  $script:form.ClientSize = New-Object System.Drawing.Size($n, $n)
  $script:form.Location = New-Object System.Drawing.Point([int]$cp.x, [int]$cp.y)
  $script:form.ResumeLayout()
  $script:form.Invalidate()
  Start-Snap
  Save-State
}

# ---------- layer modes ----------
function Set-WidgetMode([string]$m) {
  if ($m -ne 'top' -and $m -ne 'normal' -and $m -ne 'desktop') { return }
  $script:mode = $m
  $h = $script:form.Handle
  if ($m -eq 'desktop') {
    $script:form.TopMost = $false
    $prog = [Native]::FindWindowW('Progman', $null)
    if ($prog -ne [IntPtr]::Zero) {
      $ok = [Native]::SetParent($h, $prog)
      Write-Log ('setparent->progman ok=' + $ok)
      # keep the widget at its current screen spot (coords become relative to Progman)
      $cp = Clamp-Pos $script:form.Left $script:form.Top $script:form.Width $script:form.Height
      $script:form.Location = New-Object System.Drawing.Point([int]$cp.x, [int]$cp.y)
    }
  } else {
    [void][Native]::SetParent($h, [IntPtr]::Zero)
    $script:form.TopMost = ($m -eq 'top')
    $cp = Clamp-Pos $script:form.Left $script:form.Top $script:form.Width $script:form.Height
    $script:form.Location = New-Object System.Drawing.Point([int]$cp.x, [int]$cp.y)
    $script:form.Invalidate()
  }
  Save-State
  Update-MenuChecks
}

# ---------- autostart ----------
function Get-AutostartLnk {
  return Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::Startup)) 'DSHW Whale Widget.lnk'
}
function Set-Autostart([bool]$on) {
  $lnk = Get-AutostartLnk
  try {
    if ($on) {
      $ws = New-Object -ComObject WScript.Shell
      $sc = $ws.CreateShortcut($lnk)
      $sc.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
      $sc.Arguments = '-NoProfile -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $script:root 'whale-widget.ps1') + '"'
      $sc.WorkingDirectory = $script:root
      $sc.Description = 'DeepSeek whale balance desktop widget'
      $sc.Save()
      [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($ws)
    } else {
      if (Test-Path $lnk) { Remove-Item -Path $lnk -Force -ErrorAction SilentlyContinue }
    }
  } catch { Write-Log ('autostart failed: ' + $_) }
  Update-MenuChecks
}

# ---------- settings dialog ----------
$script:settingsForm = $null
$script:setTxt = $null
$script:setStatus = $null
function Show-Settings {
  if ($null -ne $script:settingsForm -and $script:settingsForm.Visible) { $script:settingsForm.Activate(); return }
  $f = New-Object System.Windows.Forms.Form
  $script:settingsForm = $f
  $f.Text = 'API Key 设置'
  $f.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedDialog
  $f.MaximizeBox = $false
  $f.MinimizeBox = $false
  $f.ShowInTaskbar = $false
  $f.TopMost = $true
  $f.ClientSize = New-Object System.Drawing.Size(300, 150)
  $f.StartPosition = 'Manual'
  $f.Font = New-Object System.Drawing.Font('Segoe UI', 10)
  $pf = New-Object System.Drawing.Point([int]($script:form.Left + $script:form.Width - 60), [int]($script:form.Top + $script:form.Height - 40))
  $scr = [System.Windows.Forms.Screen]::FromControl($script:form)
  if ($pf.X + 300 -gt $scr.WorkingArea.Right) { $pf.X = $scr.WorkingArea.Right - 310 }
  if ($pf.Y + 150 -gt $scr.WorkingArea.Bottom) { $pf.Y = $scr.WorkingArea.Bottom - 160 }
  if ($pf.X -lt $scr.WorkingArea.X) { $pf.X = $scr.WorkingArea.X + 10 }
  if ($pf.Y -lt $scr.WorkingArea.Y) { $pf.Y = $scr.WorkingArea.Y + 10 }
  $f.Location = $pf

  $lbl = New-Object System.Windows.Forms.Label
  $lbl.Text = 'DeepSeek API Key:'
  $lbl.Location = New-Object System.Drawing.Point(12, 14)
  $lbl.Size = New-Object System.Drawing.Size(120, 18)
  $f.Controls.Add($lbl)

  $txt = New-Object System.Windows.Forms.TextBox
  $txt.Location = New-Object System.Drawing.Point(132, 11)
  $txt.Size = New-Object System.Drawing.Size(156, 24)
  $txt.UseSystemPasswordChar = $true
  $k = Get-Key
  if ($k) { $txt.Text = $k }
  $f.Controls.Add($txt)
  $script:setTxt = $txt

  $status = New-Object System.Windows.Forms.Label
  $status.Location = New-Object System.Drawing.Point(12, 42)
  $status.Size = New-Object System.Drawing.Size(276, 18)
  $status.ForeColor = [System.Drawing.Color]::Gray
  $src = Get-KeySource
  if ($src -eq 'env') { $status.Text = '当前来自环境变量 DEEPSEEK_API_KEY' }
  elseif ($src -eq 'file') { $status.Text = '当前来自本地文件 widget-key.json' }
  else { $status.Text = '未配置' }
  $f.Controls.Add($status)
  $script:setStatus = $status

  $btnSave = New-Object System.Windows.Forms.Button
  $btnSave.Text = '保存'
  $btnSave.Location = New-Object System.Drawing.Point(12, 78)
  $btnSave.Size = New-Object System.Drawing.Size(80, 30)
  $btnSave.Add_Click({
    $v = $script:setTxt.Text.Trim()
    Save-Key $v
    $script:state.message = ''
    $script:displayValue = $null
    if ($v) {
      $script:setStatus.Text = '正在验证 Key…'
      $script:setStatus.ForeColor = [System.Drawing.Color]::Gray
    } else {
      $script:setStatus.Text = '已清除'
      $script:setStatus.ForeColor = [System.Drawing.Color]::Gray
    }
    Refresh-Balance $true
  })
  $f.Controls.Add($btnSave)

  $btnClear = New-Object System.Windows.Forms.Button
  $btnClear.Text = '清除'
  $btnClear.Location = New-Object System.Drawing.Point(100, 78)
  $btnClear.Size = New-Object System.Drawing.Size(80, 30)
  $btnClear.Add_Click({
    $script:setTxt.Text = ''
    Save-Key ''
    $script:setStatus.Text = '已清除'
    $script:state.message = ''
    $script:displayValue = $null
    $script:form.Invalidate()
  })
  $f.Controls.Add($btnClear)

  $btnClose = New-Object System.Windows.Forms.Button
  $btnClose.Text = '关闭'
  $btnClose.Location = New-Object System.Drawing.Point(188, 78)
  $btnClose.Size = New-Object System.Drawing.Size(100, 30)
  $btnClose.Add_Click({ $script:settingsForm.Close() })
  $f.Controls.Add($btnClose)

  $f.Add_FormClosed({
    param($s, $e)
    $script:settingsForm = $null
    $script:setTxt = $null
    $script:setStatus = $null
  })
  $f.Show()
  $txt.Focus()
}

# ---------- context menu ----------
$script:menu = New-Object System.Windows.Forms.ContextMenuStrip
$miTop = New-Object System.Windows.Forms.ToolStripMenuItem('置顶显示')
$miNormal = New-Object System.Windows.Forms.ToolStripMenuItem('正常层级')
$miDesktop = New-Object System.Windows.Forms.ToolStripMenuItem('贴到桌面层')
$miTop.Add_Click({ Set-WidgetMode 'top' })
$miNormal.Add_Click({ Set-WidgetMode 'normal' })
$miDesktop.Add_Click({ Set-WidgetMode 'desktop' })
$script:menu.Items.Add($miTop)
$script:menu.Items.Add($miNormal)
$script:menu.Items.Add($miDesktop)
$script:menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$miGrow = New-Object System.Windows.Forms.ToolStripMenuItem('放大')
$miShrink = New-Object System.Windows.Forms.ToolStripMenuItem('缩小')
$miGrow.Add_Click({ Invoke-Resize ($script:scale + 0.1) })
$miShrink.Add_Click({ Invoke-Resize ($script:scale - 0.1) })
$script:menu.Items.Add($miGrow)
$script:menu.Items.Add($miShrink)
$script:menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$miRefresh = New-Object System.Windows.Forms.ToolStripMenuItem('刷新余额')
$miRefresh.Add_Click({ Refresh-Balance $true })
$script:menu.Items.Add($miRefresh)
$miAutoRefresh = New-Object System.Windows.Forms.ToolStripMenuItem('自动刷新')
$miAutoRefresh.Add_Click({
  $script:autoRefresh = -not $script:autoRefresh
  if ($script:refreshTimer) {
    if ($script:autoRefresh) { $script:refreshTimer.Start() }
    else { $script:refreshTimer.Stop() }
  }
  Update-MenuChecks
  Save-State
})
$script:menu.Items.Add($miAutoRefresh)
$miKey = New-Object System.Windows.Forms.ToolStripMenuItem('设置 API Key…')
$miKey.Add_Click({ Show-Settings })
$script:menu.Items.Add($miKey)
$miAuto = New-Object System.Windows.Forms.ToolStripMenuItem('开机自启')
$miAuto.Add_Click({ Set-Autostart (-not (Test-Path (Get-AutostartLnk))) })
$script:menu.Items.Add($miAuto)
$script:menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$miExit = New-Object System.Windows.Forms.ToolStripMenuItem('退出挂件')
$miExit.Add_Click({ $script:form.Close() })
$script:menu.Items.Add($miExit)
$script:form.ContextMenuStrip = $script:menu

function Update-MenuChecks {
  $miTop.Checked = ($script:mode -eq 'top')
  $miNormal.Checked = ($script:mode -eq 'normal')
  $miDesktop.Checked = ($script:mode -eq 'desktop')
  $miAuto.Checked = (Test-Path (Get-AutostartLnk))
  $miAutoRefresh.Checked = $script:autoRefresh
}

# ---------- lifecycle ----------
$script:form.Add_FormClosing({
  try {
    if ($script:animTimer) { $script:animTimer.Stop() }
    if ($script:rollTimer) { $script:rollTimer.Stop() }
    if ($script:squishTimer) { $script:squishTimer.Stop() }
    if ($script:refreshTimer) { $script:refreshTimer.Stop() }
  } catch {}
  Save-State
})
$script:form.Add_FormClosed({
  try {
    if ($script:whaleImg) { $script:whaleImg.Dispose() }
    $script:mtx.ReleaseMutex() | Out-Null
  } catch {}
})

# ---------- run ----------
$script:form.Show()
Set-WidgetMode $script:mode
# touch support: after RegisterTouchWindow the system no longer coalesces
# touches into mouse messages for this window - our filter translates them.
try {
  $touchHwnd = $script:form.Handle
  [void][NativeTouch]::RegisterTouchWindow($touchHwnd, 0)
  $script:touchFilter = New-Object TouchFilter
  $script:touchFilter.Target = $touchHwnd
  [System.Windows.Forms.Application]::AddMessageFilter($script:touchFilter)
} catch { Write-Log ('touch init failed: ' + $_) }
Update-MenuChecks
$script:refreshTimer = New-Object System.Windows.Forms.Timer
$script:refreshTimer.Interval = 5000
$script:refreshTimer.Add_Tick({ Refresh-Balance $false })
if ($script:autoRefresh) { $script:refreshTimer.Start() }
Refresh-Balance $false
[System.Windows.Forms.Application]::Run($script:form)

} catch {
  Write-Log ($_ | Out-String)
  throw
} finally {
  try { $script:mtx.ReleaseMutex() | Out-Null } catch {}
}
