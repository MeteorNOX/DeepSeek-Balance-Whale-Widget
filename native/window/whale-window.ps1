# ============================================================================
# dsh-whale-widget · 独立窗口（原生 WPF + WebView2）
# ============================================================================
# 由宿主插件（lib/index.js）拉起，把「小鲸鱼挂件」从 DSH 页面里搬到一个**原生透明
# 覆盖窗口**上 —— DSH 最小化/被遮挡时鲸鱼仍然在桌面上。
#
# 为什么是 WebView2 而不是用 WPF 重画界面：
#   挂件 UI 是 HTML/CSS/JS（1MB+，含大量面板/编辑器/逐帧动图），重画一遍既维护不起
#   也不会有同等还原度。WebView2 是 Windows 自带的 Edge 内核（Windows 10/11 预装
#   Runtime），把它嵌进一个透明 WPF 窗口，就能让**同一份网页 UI** 原样跑在桌面上，
#   功能与网页版逐字节一致。
#
# 窗口形态：
#   · 覆盖主屏工作区（不含任务栏）的全屏覆盖层，无边框、背景全透明、不进任务栏、
#     不抢焦点、默认可置顶；
#   · 透明不等于鼠标穿透：WebView2/WPF 的输入表面可能覆盖透明像素。
#     使用 SetWindowRgn 将 HWND 裁剪到可见挂件/气泡/面板，桌面其余区域不属于窗口。
#     加载中/页面故障时保持空区域和 WS_EX_TRANSPARENT，禁止回退到全屏输入面。
#   · 因此挂件的拖动/吸附/翻转直接作用于整个桌面（拖到屏幕边缘就贴边），
#     与在 DSH 页面里是同一套逻辑，没有第二份实现。
#
# ⚠️ 为什么要一个 C# 桥（WhaleWindowBridge）而不是在 PowerShell 里直接 await：
#   WebView2 的 ExecuteScriptAsync 完成回调要回到 WPF 的 UI 线程，而 PowerShell 的
#   tick 就跑在 UI 线程上，"Wait() 等它完成"会自锁（实测：永远超时、拿不到结果）；
#   同一个原因也让 .NET 事件上的脚本块处理器不可靠。所以：C# 静态类里订阅事件/挂
#   Task 续体，只写静态字段；PowerShell 这边只读字段 —— 全程不阻塞、不跨线程跑脚本。
#   桥目前只服务两件事：页面状态诊断（写进日志）与「页面 → 宿主」消息通道。
#
# 与宿主的约定（文件 IPC，简单、可调试、跨进程安全）：
#   · 命令文件 CmdFile：  {"topmost":bool,"close":bool,"quit":bool}
#   · 状态文件 StateFile：{"alive":bool,"topmost":bool,"pid":int,"ts":int}
#   · 宿主进程（HostPid）消失 → 本窗口自行退出，不留孤儿进程。
#
# 说明：本文件是 UTF-8 **带 BOM** 保存的（Windows PowerShell 5.1 对无 BOM 的
#       UTF-8 会按 ANSI 解析，中文注释会把脚本解析坏）。
# ============================================================================
param(
  [Parameter(Mandatory = $true)][string]$Url,
  [string]$Title = 'DSH 小鲸鱼',
  [int]$HostPid = 0,
  [string]$CmdFile = '',
  [string]$StateFile = '',
  [string]$ProfileDir = '',
  [string]$LogFile = '',
  [int]$Topmost = 0,
  [int]$TickMs = 250
)

$ErrorActionPreference = 'SilentlyContinue'
# Private parent -> child transport; never place the cookie in HTTP responses,
# command-line arguments, diagnostic files, or Chromium's inherited environment.
$script:authCookie = $env:DSHW_WINDOW_AUTH_COOKIE
Remove-Item Env:DSHW_WINDOW_AUTH_COOKIE -ErrorAction SilentlyContinue

$script:logPath = $LogFile
function Write-Log([string]$message) {
  if (-not $script:logPath) { return }
  try {
    Add-Content -LiteralPath $script:logPath -Value ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss.fff'), $message) -Encoding UTF8
  } catch { }
}
# 日志上限：这个文件常驻（每次开窗都往里写），不设上限会一直长。
# 超过 1MB 就滚动一次（保留上一份 .1，便于回溯"上次为什么没起来"）。
try {
  if ($script:logPath -and (Test-Path -LiteralPath $script:logPath)) {
    $logItem = Get-Item -LiteralPath $script:logPath
    if ($logItem.Length -gt 1MB) {
      Move-Item -LiteralPath $script:logPath -Destination ($script:logPath + '.1') -Force
    }
  }
} catch { }
Write-Log ("window start: url=$Url hostPid=$HostPid topmost=$Topmost")

# ---------------------------------------------------------------------------
# 1. 加载 WebView2 SDK
#    随包携带三个文件（native/window/sdk/）：Core.dll（托管）/ Wpf.dll（WPF 控件）
#    / WebView2Loader.dll（原生加载器）。运行时装机里也有 WebView2 Runtime，
#    但托管 SDK 程序集不在系统里，必须随包提供。
#    ⚠️ 用 Assembly::Load(byte[]) 而不是 LoadFrom：某些环境（受限令牌、沙箱化的
#       工作目录）会把文件判定为"不受信任位置"，LoadFrom 直接抛 0x80131515；
#       从字节加载绕开该检查。原生 WebView2Loader.dll 靠 PATH 解析。
# ---------------------------------------------------------------------------
$script:scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$script:sdkDir = Join-Path $script:scriptDir 'sdk'
$env:PATH = "$script:sdkDir;$env:PATH"

function Import-AssemblyFromFile([string]$path) {
  return [System.Reflection.Assembly]::Load([System.IO.File]::ReadAllBytes($path))
}

try {
  Add-Type -AssemblyName PresentationFramework
  Add-Type -AssemblyName PresentationCore
  Add-Type -AssemblyName WindowsBase
  Add-Type -AssemblyName System.Drawing
  [void](Import-AssemblyFromFile (Join-Path $script:sdkDir 'Microsoft.Web.WebView2.Core.dll'))
  [void](Import-AssemblyFromFile (Join-Path $script:sdkDir 'Microsoft.Web.WebView2.Wpf.dll'))
  Write-Log 'webview2 sdk loaded'
} catch {
  Write-Log ("FATAL: 加载 WebView2 SDK 失败：" + $_.Exception.Message)
  exit 2
}

# ---------------------------------------------------------------------------
# 2. C# 桥：把 WebView2 的异步能力收敛成「静态字段 + 非阻塞请求」
# ---------------------------------------------------------------------------
try {
  Add-Type -ReferencedAssemblies @(
    (Join-Path $script:sdkDir 'Microsoft.Web.WebView2.Core.dll'),
    (Join-Path $script:sdkDir 'Microsoft.Web.WebView2.Wpf.dll')
  ) -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using Microsoft.Web.WebView2.Core;

public static class WhaleWindowBridge
{
    // ---------- Win32 ----------
    private const int GWL_EXSTYLE = -20;
    private const int WS_EX_TOOLWINDOW = 0x80;
    private const int WS_EX_TRANSPARENT = 0x20;
    private const int VK_LBUTTON = 0x01;
    private const uint SWP_NOSIZE = 0x0001;
    private const uint SWP_NOMOVE = 0x0002;
    private const uint SWP_NOZORDER = 0x0004;
    private const uint SWP_NOACTIVATE = 0x0010;
    private const uint SWP_FRAMECHANGED = 0x0020;

    [DllImport("user32.dll")] private static extern int GetWindowLong(IntPtr hWnd, int nIndex);
    [DllImport("user32.dll")] private static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);
    [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] private static extern bool GetCursorPos(out POINT point);
    [DllImport("user32.dll")] private static extern IntPtr SetCapture(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern IntPtr GetCapture();
    [DllImport("user32.dll")] private static extern bool ReleaseCapture();
    [DllImport("user32.dll")] private static extern short GetAsyncKeyState(int vKey);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);

    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }

    // ---------- 输入故障时的整窗穿透兜底 ----------
    // 正常输入由 WhaleWindowRegion 限定；失败时额外启用 WS_EX_TRANSPARENT。
    private static IntPtr hitHwnd = IntPtr.Zero;
    private static bool clickThrough = true;

    public static bool ClickThrough { get { return clickThrough; } }

    public static void SetHitWindow(IntPtr hwnd) { hitHwnd = hwnd; }

    public static bool SetClickThrough(bool on)
    {
        if (hitHwnd == IntPtr.Zero) return false;
        try
        {
            int ex = GetWindowLong(hitHwnd, GWL_EXSTYLE);
            int want = on ? (ex | WS_EX_TRANSPARENT) : (ex & ~WS_EX_TRANSPARENT);
            if (want != ex)
            {
                SetWindowLong(hitHwnd, GWL_EXSTYLE, want);
                if (!SetWindowPos(hitHwnd, IntPtr.Zero, 0, 0, 0, 0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED)) return false;
            }
            if ((GetWindowLong(hitHwnd, GWL_EXSTYLE) & WS_EX_TRANSPARENT) != (want & WS_EX_TRANSPARENT)) return false;
            clickThrough = on;
            return true;
        }
        catch { return false; }
    }

    // 独立的区域快照通道，不与诊断请求共用 pending 位。
    private static readonly object hitGate = new object();
    private static string hitResult = "";
    private static bool hitPending = false;
    private static int hitGeneration = 0;
    private static bool navigationStarted = false;

    public static bool HitPending { get { lock (hitGate) { return hitPending; } } }

    public static void CancelHitRequest()
    {
        lock (hitGate)
        {
            hitGeneration++;
            hitPending = false;
            hitResult = "";
        }
    }

    public static bool TakeNavigationStarted()
    {
        lock (hitGate)
        {
            bool value = navigationStarted;
            navigationStarted = false;
            return value;
        }
    }

    public static void HitRequest(CoreWebView2 core, string script)
    {
        if (core == null) return;
        int generation;
        lock (hitGate)
        {
            if (hitPending) return;
            hitPending = true;
            generation = ++hitGeneration;
        }
        try
        {
            core.ExecuteScriptAsync(script).ContinueWith(delegate(Task<string> t)
            {
                string value = "";
                try { value = (t.Status == TaskStatus.RanToCompletion && t.Result != null) ? t.Result : ""; }
                catch { }
                lock (hitGate)
                {
                    if (generation != hitGeneration) return; // Timed out / old navigation.
                    hitResult = value;
                    hitPending = false;
                }
            }, TaskScheduler.Default);
        }
        catch
        {
            lock (hitGate) { if (generation == hitGeneration) hitPending = false; }
        }
    }

    public static string TakeHitResult()
    {
        lock (hitGate)
        {
            string value = hitResult;
            hitResult = "";
            return value;
        }
    }

    // 不进 Alt-Tab、不占任务栏。（窗口创建前 Handle 是 0，调用方先 EnsureHandle）
    public static bool ApplyToolWindowStyle(IntPtr hwnd)
    {
        if (hwnd == IntPtr.Zero) return false;
        try
        {
            int exStyle = GetWindowLong(hwnd, GWL_EXSTYLE);
            SetWindowLong(hwnd, GWL_EXSTYLE, exStyle | WS_EX_TOOLWINDOW);
            return true;
        }
        catch { return false; }
    }

    // ---------- 拖动期间的鼠标捕获 ----------
    // 分层窗口只有不透明像素算实体：快速拖动时鲸鱼被甩在光标后面、光标落到透明像素上，
    // 鼠标消息就转给下层窗口 —— 页面收不到 pointermove（拖不动）也收不到 pointerup（松不开）。
    // 按下时 SetCapture 让鼠标消息始终归我们这条线程；之后由 PowerShell 侧的定时器复核
    // （松手事件丢了或捕获转交到其他窗口就收尾），不做窗口消息钩子。
    private static IntPtr targetHwnd = IntPtr.Zero;
    private static CoreWebView2 attachedCore = null;
    public static volatile bool Captured = false;
    public static long dragStarts = 0;
    public static long dragEnds = 0;
    public static long capturesRegained = 0;
    public static long forcedEnds = 0;

    public static void SetTargetWindow(IntPtr hwnd) { targetHwnd = hwnd; }

    public static void BeginDrag()
    {
        // Web messages can arrive after the physical button was released.
        if (!LeftButtonDown) return;
        try
        {
            if (targetHwnd != IntPtr.Zero) SetCapture(targetHwnd);
            Captured = GetCapture() == targetHwnd && targetHwnd != IntPtr.Zero;
        }
        catch { Captured = false; }
        if (Captured) dragStarts++;
    }

    public static void EndDrag()
    {
        bool wasCaptured = Captured;
        Captured = false;
        try { if (GetCapture() == targetHwnd && targetHwnd != IntPtr.Zero) ReleaseCapture(); } catch { }
        if (wasCaptured) dragEnds++;
    }

    // 左键现在是否真的按着（供定时器复核"松手事件是不是丢了"）
    public static bool LeftButtonDown
    {
        get { try { return (GetAsyncKeyState(VK_LBUTTON) & 0x8000) != 0; } catch { return false; } }
    }

    // GetCapture only reports this UI thread. Zero also means another thread
    // has taken over. End our drag instead of stealing capture back from it.
    public static bool CaptureLost
    {
        get { try { return GetCapture() != targetHwnd; } catch { return true; } }
    }

    // 让页面在最后一次指针位置上补一个合成 pointerup，走挂件自己的 endDrag 收尾
    public static void ForcePageDragEnd()
    {
        forcedEnds++;
        CoreWebView2 core = attachedCore;
        if (core == null) return;
        try { core.ExecuteScriptAsync("window.__dshwForceEndDrag&&window.__dshwForceEndDrag()"); } catch { }
    }

    // ---------- 页面 -> 宿主 ----------
    private static readonly object gate = new object();
    private static string pendingMessage = null;
    private static long received = 0;

    public static void Attach(CoreWebView2 core)
    {
        if (core == null) return;
        attachedCore = core;
        core.WebMessageReceived += OnWebMessage;
        core.NavigationStarting += delegate
        {
            CancelHitRequest();
            lock (hitGate) { navigationStarted = true; }
        };
    }

    private static void OnWebMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        try
        {
            string text = e.TryGetWebMessageAsString();
            if (text == null) return;
            // 拖动开关就地处理，不进日志队列（否则每次拖动都刷屏）
            if (text == "drag:1") { BeginDrag(); return; }
            if (text == "drag:0") { EndDrag(); return; }
            lock (gate)
            {
                pendingMessage = text;
                received++;
            }
        }
        catch { }
    }

    public static string TakeMessage()
    {
        lock (gate)
        {
            string value = pendingMessage;
            pendingMessage = null;
            return value;
        }
    }

    public static long Received { get { lock (gate) { return received; } } }

    // ---------- 宿主 -> 页面：非阻塞脚本请求（结果放静态字段，由 PowerShell 轮询读取）----------
    private static string scriptResult = "";
    private static int scriptPending = 0;

    public static void Request(CoreWebView2 core, string script)
    {
        if (core == null) return;
        if (System.Threading.Interlocked.CompareExchange(ref scriptPending, 1, 0) != 0) return;
        try
        {
            core.ExecuteScriptAsync(script).ContinueWith(delegate(Task<string> t)
            {
                string value = "";
                try { value = (t.Status == TaskStatus.RanToCompletion && t.Result != null) ? t.Result : ""; }
                catch { value = ""; }
                scriptResult = value;
                System.Threading.Interlocked.Exchange(ref scriptPending, 0);
            }, TaskScheduler.Default);
        }
        catch
        {
            System.Threading.Interlocked.Exchange(ref scriptPending, 0);
        }
    }

    public static bool ScriptPending { get { return System.Threading.Volatile.Read(ref scriptPending) != 0; } }

    public static string TakeScriptResult()
    {
        string value = scriptResult;
        scriptResult = "";
        return value;
    }
}
'@
  Add-Type -Path (Join-Path $script:scriptDir 'WhaleWindowRegion.cs')
  Write-Log 'native bridge compiled'
} catch {
  Write-Log ("FATAL: 编译桥接类型失败：" + $_.Exception.Message)
  exit 3
}

# ---------------------------------------------------------------------------
# 3. 窗口：覆盖主屏工作区的透明、无边框、不激活、不进任务栏的覆盖层
# ---------------------------------------------------------------------------
$work = [System.Windows.SystemParameters]::WorkArea

$window = New-Object System.Windows.Window
$window.Title = $Title
$window.WindowStyle = [System.Windows.WindowStyle]::None
$window.AllowsTransparency = $true
$window.Background = [System.Windows.Media.Brushes]::Transparent
$window.ShowInTaskbar = $false
$window.ShowActivated = $false
$window.ResizeMode = [System.Windows.ResizeMode]::NoResize
$window.Focusable = $false
$window.Topmost = ($Topmost -ne 0)
$window.Left = $work.Left
$window.Top = $work.Top
$window.Width = $work.Width
$window.Height = $work.Height
$window.WindowStartupLocation = [System.Windows.WindowStartupLocation]::Manual

$wv = New-Object Microsoft.Web.WebView2.Wpf.WebView2CompositionControl
$creation = New-Object Microsoft.Web.WebView2.Wpf.CoreWebView2CreationProperties
if ($ProfileDir) { $creation.UserDataFolder = $ProfileDir }
# 关掉后台节流（否则窗口不在前台时挂件的 1 秒轮询会被降频），并允许无手势自动播放
# （任务结束音不是用户手势触发的，默认自动播放策略会把它挡掉）。
$creation.AdditionalBrowserArguments = '--disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows --autoplay-policy=no-user-gesture-required'
$wv.CreationProperties = $creation
$wv.HorizontalAlignment = [System.Windows.HorizontalAlignment]::Stretch
$wv.VerticalAlignment = [System.Windows.VerticalAlignment]::Stretch
$window.Content = $wv

$script:coreReady = $false
$script:ticks = 0
$script:lastCmdStamp = 0
$script:hostObservable = $false
$script:lastDiagTick = 0
# 页面状态：pending -> ready / error:<原因> / timeout。宿主靠它判断"窗口起来了但页面没起来"
# 这种最坑的失败（用户看不到任何东西，DSH 里那份挂件却已经让位了）。
$script:pageState = 'pending'
$script:pageDetail = ''

function Write-StateFile {
  if (-not $StateFile) { return }
  try {
    $body = ([ordered]@{
      alive = $true
      topmost = [bool]$window.Topmost
      pid = $PID
      page = $script:pageState
      detail = $script:pageDetail
      ts = [int64]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
    } | ConvertTo-Json -Compress)
    # 必须写成**不带 BOM** 的 UTF-8：宿主是 Node，JSON.parse 不接受 BOM，
    # 带 BOM 会让宿主读状态一律失败（PowerShell 5.1 的 Set-Content -Encoding UTF8 会加 BOM）。
    [System.IO.File]::WriteAllText($StateFile, $body, (New-Object System.Text.UTF8Encoding($false)))
  } catch { }
}

function Read-CommandFile {
  if (-not $CmdFile) { return }
  try {
    $item = Get-Item -LiteralPath $CmdFile -ErrorAction SilentlyContinue
    if (-not $item -or $item.LastWriteTimeUtc.Ticks -eq $script:lastCmdStamp) { return }
    $script:lastCmdStamp = $item.LastWriteTimeUtc.Ticks
    $json = (Get-Content -LiteralPath $CmdFile -Raw -ErrorAction SilentlyContinue) | ConvertFrom-Json
    if (-not $json) { return }
    if ($json.quit -eq $true -or $json.close -eq $true) {
      Write-Log 'command: close/quit'
      $window.Close()
      return
    }
    if ($json.topmost -ne $null) {
      $desired = [bool]$json.topmost
      if ($desired -ne [bool]$window.Topmost) {
        $window.Topmost = $desired
        Write-Log ('topmost -> ' + $desired)
      }
    }
  } catch { }
}

$window.Add_Loaded({
  Write-Log 'window loaded'
  try { [void]$wv.EnsureCoreWebView2Async() } catch { Write-Log ('FATAL: WebView2 initialization failed: ' + $_.Exception.Message) }
})

$window.Add_Closed({
  Write-Log 'window closed'
  try { [WhaleWindowBridge]::EndDrag() } catch { }
  try { $wv.Dispose() } catch { }
  if ($StateFile) {
    try { Set-Content -LiteralPath $StateFile -Value '{"alive":false}' -Encoding UTF8 } catch { }
  }
  [System.Windows.Threading.Dispatcher]::CurrentDispatcher.InvokeShutdown()
})

# Tool 窗口 + 拖动捕获的消息钩子
# ⚠️ 必须先 EnsureHandle()：WindowInteropHelper.Handle 在窗口尚未创建时返回 0，
#    直接用 .Handle 会让 SetWindowLong 静默不执行（实测踩过）。
$interop = New-Object System.Windows.Interop.WindowInteropHelper($window)
[void]$interop.EnsureHandle()
$script:hwnd = $interop.Handle
[WhaleWindowBridge]::SetTargetWindow($script:hwnd)
if ([WhaleWindowBridge]::ApplyToolWindowStyle($script:hwnd)) {
  Write-Log 'window styled as tool window'
} else {
  Write-Log 'window handle unavailable; tool-window style skipped'
}

# ---------------------------------------------------------------------------
# 3b. 原生窗口区域：不按光标位置开关整窗输入（异步命中会过期并丢首击）。
# 初始空区域；快照失败/页面无响应超过 1 秒也清空。区域更新不依赖鼠标移动。
# 拖动继续使用既有捕获，不扩大为全屏区域；watchdog 也处理捕获中的页面卡死。
# ---------------------------------------------------------------------------
[WhaleWindowBridge]::SetHitWindow($script:hwnd)
if (-not [WhaleWindowBridge]::SetClickThrough($true)) {
  Write-Log 'FATAL: cannot initialize input safety style'
  exit 4
}
if (-not [WhaleWindowRegion]::Clear($script:hwnd)) {
  Write-Log 'FATAL: cannot initialize empty native region'
  exit 4
}
$script:regionLastOk = [Environment]::TickCount
$script:regionLastSnapshot = ''
$script:regionFailures = 0
$script:regionRequestedAt = [Environment]::TickCount
$script:inputRepairs = 0

function Protect-WebViewInput {
  if (-not [WhaleWebViewInput]::Guard([uint32]$wv.CoreWebView2.BrowserProcessId)) {
    Write-Log 'FATAL: cannot release WebView2 backing-window input'
    $window.Close()
    return $false
  }
  if ([WhaleWebViewInput]::Repairs -ne $script:inputRepairs) {
    $script:inputRepairs = [WhaleWebViewInput]::Repairs
    Write-Log ('WebView2 backing input protected; windows=' + [WhaleWebViewInput]::ProtectedWindows + ' repairs=' + $script:inputRepairs)
  }
  return $true
}

function Clear-InputRegion {
  [void][WhaleWindowBridge]::SetClickThrough($true)
  if (-not [WhaleWindowRegion]::Clear($script:hwnd)) {
    Write-Log 'FATAL: cannot clear native input region'
    $window.Close()
    return
  }
  $script:regionLastSnapshot = ''
  if ([WhaleWindowBridge]::Captured) {
    [WhaleWindowBridge]::EndDrag()
    [WhaleWindowBridge]::ForcePageDragEnd()
  }
}

$hitTimer = New-Object System.Windows.Threading.DispatcherTimer
$hitTimer.Interval = [TimeSpan]::FromMilliseconds(33)
$hitTimer.Add_Tick({
  try {
    Test-DragCapture
    # The Chromium backing HWND is independent of the WPF window region.
    # Recheck even when the DOM region is unchanged: Chromium can recreate it.
    if ($script:coreReady -and -not (Protect-WebViewInput)) { return }
    if ([WhaleWindowBridge]::TakeNavigationStarted()) {
      [WhaleWindowBridge]::CancelHitRequest()
      $script:regionRequestedAt = [Environment]::TickCount
      $script:regionFailures = 0
      $script:pageState = 'pending'
      Clear-InputRegion
    }
    if (-not $script:coreReady -or $script:pageState -ne 'ready') {
      Clear-InputRegion
      return
    }
    # Unsigned subtraction survives Environment.TickCount's signed wraparound.
    $age = ([int64][Environment]::TickCount - [int64]$script:regionLastOk + 4294967296) % 4294967296
    if ($age -gt 1000) { Clear-InputRegion }
    $requestAge = ([int64][Environment]::TickCount - [int64]$script:regionRequestedAt + 4294967296) % 4294967296
    if ($requestAge -gt 1000) {
      [WhaleWindowBridge]::CancelHitRequest()
      Clear-InputRegion
      $script:regionFailures++
      if ($script:regionFailures -ge 3) {
        Write-Log 'input region repeatedly timed out; restoring embedded widget'
        $window.Close()
        return
      }
    }
    if ([WhaleWindowBridge]::HitPending) { return }
    $raw = [WhaleWindowBridge]::TakeHitResult()
    if ($raw) {
      # Include physical dimensions: a DPI/size change requires remapping even if
      # the CSS snapshot has not changed. Apply also validates the protocol.
      $dpi = [System.Windows.PresentationSource]::FromVisual($window).CompositionTarget.TransformToDevice
      $snapshot = $raw + ':' + $window.ActualWidth + ':' + $window.ActualHeight + ':' + $dpi.M11 + ':' + $dpi.M22
      if ($snapshot -eq $script:regionLastSnapshot -or [WhaleWindowRegion]::Apply($script:hwnd, $raw)) {
        $script:regionLastSnapshot = $snapshot
        $script:regionLastOk = [Environment]::TickCount
        $script:regionFailures = 0
        if (-not [WhaleWindowBridge]::SetClickThrough($false)) {
          Clear-InputRegion
          Write-Log 'FATAL: cannot enable bounded window input'
          $window.Close()
          return
        }
      } else {
        Clear-InputRegion
        $script:regionFailures++
        if ($script:regionFailures -ge 3) {
          Write-Log 'input region repeatedly invalid; restoring embedded widget'
          $window.Close()
          return
        }
      }
    }
    $script:regionRequestedAt = [Environment]::TickCount
    [WhaleWindowBridge]::HitRequest($wv.CoreWebView2, 'window.__dshwGetWindowRegion ? window.__dshwGetWindowRegion() : ""')
  } catch {
    Clear-InputRegion
    Write-Log ('input region error: ' + $_.Exception.Message)
    $window.Close()
  }
})

# ---------------------------------------------------------------------------
# 4. 心跳：读命令、上报状态、收页面消息、宿主没了就退出
# ---------------------------------------------------------------------------
$script:hostObservable = ($HostPid -gt 0 -and [bool](Get-Process -Id $HostPid -ErrorAction SilentlyContinue))

# 每次区域刷新前复核原生捕获（33ms），不等待页面快照或主心跳：
# ① 松手事件丢了（松在任务栏上最典型）→ 释放捕获并让页面收尾，别让挂件停在按下态；
# ② 捕获转交到其他窗口 → 结束本次拖动，不抢回其他应用的输入。
function Test-DragCapture {
  if (-not [WhaleWindowBridge]::Captured) { return }
  if (-not [WhaleWindowBridge]::LeftButtonDown) {
    [WhaleWindowBridge]::EndDrag()
    Write-Log 'drag capture released (left button no longer down)'
    [WhaleWindowBridge]::ForcePageDragEnd()
    return
  }
  if ([WhaleWindowBridge]::CaptureLost) {
    [WhaleWindowBridge]::EndDrag()
    [WhaleWindowBridge]::ForcePageDragEnd()
    Write-Log 'drag ended (capture transferred to another window)'
  }
}
$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds($TickMs)
$timer.Add_Tick({
  $script:ticks++
  try {
    if ($script:ticks % 4 -eq 1) { Read-CommandFile }
    if ($script:ticks % 4 -eq 3) { Write-StateFile }
    if ($script:hostObservable -and ($script:ticks % 20 -eq 0)) {
      if (-not (Get-Process -Id $HostPid -ErrorAction SilentlyContinue)) {
        Write-Log 'host gone -> exit'
        $window.Close()
        return
      }
    }

    # 首次拿到 CoreWebView2 后：设置透明背景（预置会被忽略，表现为整窗白底）并挂桥
    if (-not $script:coreReady -and $wv.CoreWebView2 -ne $null) {
      $script:coreReady = $true
      try { $wv.DefaultBackgroundColor = [System.Drawing.Color]::Transparent } catch { Write-Log ("set transparent bg failed: " + $_.Exception.Message) }
      try { [WhaleWindowBridge]::Attach($wv.CoreWebView2) } catch { Write-Log ("bridge attach failed: " + $_.Exception.Message) }
      if (-not (Protect-WebViewInput)) { return }
      try {
        if ($script:authCookie) {
          $uri = [Uri]$Url
          $pair = $script:authCookie.Split([char[]]'=', 2)
          $cookie = $wv.CoreWebView2.CookieManager.CreateCookie($pair[0], $pair[1], $uri.Host, '/')
          $cookie.IsHttpOnly = $true
          $cookie.IsSecure = ($uri.Scheme -eq 'https')
          $cookie.SameSite = [Microsoft.Web.WebView2.Core.CoreWebView2CookieSameSiteKind]::Strict
          $wv.CoreWebView2.CookieManager.AddOrUpdateCookie($cookie)
        }
        $script:authCookie = $null
        # Bridge is attached before the page can post ready or drag messages.
        $wv.CoreWebView2.Navigate($Url)
      } catch {
        $script:authCookie = $null
        $script:pageState = 'error'
        Write-Log 'FATAL: authenticated page navigation failed'
        $window.Close()
        return
      }
      Write-Log 'webview2 ready (transparent background applied, bridge attached)'
    }

    if ($script:coreReady) {
      # 页面主动发来的消息（目前只作诊断；留给后续 IPC，例如页面里点「关闭窗口」）
      $msg = [WhaleWindowBridge]::TakeMessage()
      if ($msg) {
        Write-Log ("page msg: " + $msg)
        # 页面侧的唯一确证：挂件挂载成功 = ready；脚本炸了 = error:...；20 秒没挂上 = timeout
        if ($msg -eq 'ready') { $script:pageState = 'ready'; $script:pageDetail = '' }
        elseif ($msg.StartsWith('error')) { $script:pageState = 'error'; $script:pageDetail = $msg }
        elseif ($msg -eq 'timeout') { $script:pageState = 'timeout'; $script:pageDetail = $msg }
        Write-StateFile
      }

      # 页面状态诊断：前 20 秒每 5 秒一次、之后每 60 秒一次（只写日志，绝不阻塞）
      $diagDue = ($script:ticks -lt 80 -and ($script:ticks - $script:lastDiagTick) -ge 20) -or (($script:ticks - $script:lastDiagTick) -ge 240)
      if ($diagDue) {
        $script:lastDiagTick = $script:ticks
        [WhaleWindowBridge]::Request($wv.CoreWebView2, 'JSON.stringify({rs:document.readyState,widget:!!window.__dshWhaleWidget,root:!!window.__dshWhaleRoot,nodes:document.querySelectorAll("[class*=dshwv-]").length,err:window.__dshwLastError||"",rect:(window.__dshWhaleRoot&&window.__dshWhaleRoot.getBoundingClientRect?JSON.stringify(window.__dshWhaleRoot.getBoundingClientRect()):null)})')
      }
      if (-not [WhaleWindowBridge]::ScriptPending) {
        $result = [WhaleWindowBridge]::TakeScriptResult()
        if ($result) { Write-Log ("page state: " + $result) }
      }
    }
  } catch { Write-Log ("tick error: " + $_.Exception.Message) }
})
$timer.Start()
$hitTimer.Start()

$window.Show()
Write-Log 'window shown'
[System.Windows.Threading.Dispatcher]::Run() | Out-Null
Write-Log 'dispatcher exited'
exit 0
