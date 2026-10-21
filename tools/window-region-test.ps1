$ErrorActionPreference = 'Stop'
$rootPath = Split-Path -Parent $PSScriptRoot
$windowPath = Join-Path $rootPath 'native/window/whale-window.ps1'
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($windowPath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
# Compile the actual embedded bridge as well as the native-region helper.
$sdk = Join-Path $rootPath 'native/window/sdk'
[void][Reflection.Assembly]::Load([IO.File]::ReadAllBytes((Join-Path $sdk 'Microsoft.Web.WebView2.Core.dll')))
$source = [IO.File]::ReadAllText($windowPath)
$bridge = [regex]::Match($source, "(?s)-TypeDefinition @'\r?\n(.*?)\r?\n'@").Groups[1].Value
Add-Type -TypeDefinition $bridge -ReferencedAssemblies (Join-Path $sdk 'Microsoft.Web.WebView2.Core.dll')
Add-Type -Path (Join-Path $rootPath 'native/window/WhaleWindowRegion.cs')
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class RegionTestNative {
  [DllImport("gdi32.dll")] public static extern IntPtr CreateRectRgn(int l,int t,int r,int b);
  [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr r);
  [DllImport("gdi32.dll")] public static extern bool PtInRegion(IntPtr r,int x,int y);
  [DllImport("user32.dll")] public static extern int GetWindowRgn(IntPtr w,IntPtr r);
  [DllImport("user32.dll")] public static extern int GetGuiResources(IntPtr p,int flag);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr w,int index);
  [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr w,int index,int value);
  [DllImport("user32.dll")] public static extern bool SetLayeredWindowAttributes(IntPtr w,uint key,byte alpha,uint flags);
  [DllImport("user32.dll")] public static extern bool DestroyWindow(IntPtr w);
  private delegate IntPtr WndProc(IntPtr w,uint message,IntPtr wp,IntPtr lp);
  private static WndProc proc = DefWindowProc;
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  private struct WindowClass {
    public uint style; public WndProc proc; public int classExtra,windowExtra;
    public IntPtr instance,icon,cursor,background; public string menu,name;
  }
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] private static extern ushort RegisterClass(ref WindowClass wc);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] private static extern IntPtr CreateWindowEx(int ex,string cls,string name,int style,int x,int y,int w,int h,IntPtr parent,IntPtr menu,IntPtr instance,IntPtr arg);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] private static extern IntPtr DefWindowProc(IntPtr w,uint msg,IntPtr wp,IntPtr lp);
  public static IntPtr Surface(string name,int ex,byte alpha) {
    WindowClass wc=new WindowClass();wc.proc=proc;wc.name=name;
    RegisterClass(ref wc);
    IntPtr hwnd=CreateWindowEx(ex,name,"input regression",unchecked((int)0x90000000),-24000,-24000,400,300,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero);
    if(hwnd==IntPtr.Zero) throw new Exception("create backing-window fixture");
    SetLayeredWindowAttributes(hwnd,0,alpha,2);
    return hwnd;
  }
}
'@
$script:checks = 0
function Assert($condition, $message) {
  if (-not $condition) { throw $message }
  $script:checks++
}
$form = New-Object System.Windows.Forms.Form
$form.FormBorderStyle = 'None'
$form.StartPosition = 'Manual'
$form.Left = -20000
$form.Top = -20000
$form.ClientSize = New-Object System.Drawing.Size(1000, 800)
$hwnd = $form.Handle
function Contains($x, $y) {
  $r = [RegionTestNative]::CreateRectRgn(0,0,0,0)
  try {
    [void][RegionTestNative]::GetWindowRgn($hwnd,$r)
    return [RegionTestNative]::PtInRegion($r,$x,$y)
  } finally { [void][RegionTestNative]::DeleteObject($r) }
}
try {
  Assert ([WhaleWindowRegion]::Clear($hwnd)) 'initial empty region'
  Assert (-not (Contains 100 100)) 'startup must not intercept desktop'
  foreach ($scale in @(1.0, 1.25, 1.5, 2.0)) {
    $vw = 1000 / $scale
    $vh = 800 / $scale
    $protocol = '"' + $vw.ToString([Globalization.CultureInfo]::InvariantCulture) + ',' + $vh.ToString([Globalization.CultureInfo]::InvariantCulture) + ';10,20,110,120;200,100,300,200"'
    Assert ([WhaleWindowRegion]::Apply($hwnd,$protocol)) "apply at $scale scale/zoom"
    Assert (Contains ([int](30*$scale)) ([int](40*$scale))) 'whale accepts input'
    Assert (Contains ([int](230*$scale)) ([int](140*$scale))) 'detached panel accepts input'
    Assert (-not (Contains ([int](150*$scale)) ([int](100*$scale)))) 'desktop gap excluded'
    Assert (-not (Contains 990 790)) 'distant desktop excluded'
  }
  foreach ($bad in @('null','""','"0,800"','"NaN,800"','"1000,800;0,0,1000,800"','"1000,800;10,20,Infinity,30"','"1000,800;1,2,3"')) {
    Assert (-not [WhaleWindowRegion]::Apply($hwnd,$bad)) "reject malformed/fullscreen: $bad"
    Assert ([WhaleWindowRegion]::Clear($hwnd)) 'host failure path clears region'
    Assert (-not (Contains 30 40)) 'failed snapshot leaves desktop free'
  }
  Assert ([WhaleWindowRegion]::Apply($hwnd,'"1000,800;-20,-10,50,60;950,750,1100,900"')) 'clip offscreen surfaces'
  Assert (Contains 0 0) 'partly offscreen widget retained'
  Assert (-not (Contains 500 400)) 'offscreen surfaces do not expand to viewport'
  $processHandle = [Diagnostics.Process]::GetCurrentProcess().Handle
  $before = [RegionTestNative]::GetGuiResources($processHandle,0)
  for ($i=0; $i -lt 1000; $i++) {
    if (-not [WhaleWindowRegion]::Apply($hwnd,'"1000,800;10,20,110,120;200,100,300,200"')) { throw 'repeated region apply' }
  }
  $after = [RegionTestNative]::GetGuiResources($processHandle,0)
  Assert (($after-$before) -le 2) 'no GDI region leak across 1000 updates'

  # Reproduce the independent alpha-zero Chromium HWND; clipping the WPF parent
  # cannot affect it. The fixtures remain offscreen and receive no real input.
  $ghost = [RegionTestNative]::Surface('Chrome_WidgetWin_1',0x8280080,0)
  $otherClass = [RegionTestNative]::Surface('WhaleRegionUnrelatedTest',0x8280080,0)
  try {
    Assert ([WhaleWebViewInput]::Guard([uint32]($PID + 100000))) 'other browser process ignored'
    Assert (([RegionTestNative]::GetWindowLong($ghost,-20) -band 0x20) -eq 0) 'other process window left untouched'
    Assert ([WhaleWebViewInput]::Guard([uint32]$PID)) 'guard own alpha-zero backing window'
    Assert (([RegionTestNative]::GetWindowLong($ghost,-20) -band 0x20) -ne 0) 'backing window becomes input transparent'
    Assert (([RegionTestNative]::GetWindowLong($otherClass,-20) -band 0x20) -eq 0) 'unrelated window class left untouched'
    [void][RegionTestNative]::SetWindowLong($ghost,-20,0x8280080)
    Assert ([WhaleWebViewInput]::Guard([uint32]$PID)) 'SDK style reset repaired'
    Assert (([RegionTestNative]::GetWindowLong($ghost,-20) -band 0x20) -ne 0) 'repaired transparency verified'
    [void][RegionTestNative]::SetLayeredWindowAttributes($ghost,0,255,2)
    Assert ([WhaleWebViewInput]::Guard([uint32]$PID)) 'visible surface restored'
    Assert (([RegionTestNative]::GetWindowLong($ghost,-20) -band 0x20) -eq 0) 'visible surface regains original input'
    [void][RegionTestNative]::SetLayeredWindowAttributes($ghost,0,0,2)
    Assert ([WhaleWebViewInput]::Guard([uint32]$PID)) 'protect again before SDK style change'
    [void][RegionTestNative]::SetWindowLong($ghost,-20,0x2800a0)
    [void][RegionTestNative]::SetLayeredWindowAttributes($ghost,0,255,2)
    Assert ([WhaleWebViewInput]::Guard([uint32]$PID)) 'restore after SDK changes backing styles'
    Assert (([RegionTestNative]::GetWindowLong($ghost,-20) -band 0x20) -eq 0) 'style change does not strand transparent input'
    [void][RegionTestNative]::SetWindowLong($ghost,-20,0x82800a0)
    [void][RegionTestNative]::SetLayeredWindowAttributes($ghost,0,0,2)
    Assert ([WhaleWebViewInput]::Guard([uint32]$PID)) 'existing SDK transparency accepted'
    [void][RegionTestNative]::SetLayeredWindowAttributes($ghost,0,255,2)
    Assert ([WhaleWebViewInput]::Guard([uint32]$PID)) 'SDK-owned transparency retained'
    Assert (([RegionTestNative]::GetWindowLong($ghost,-20) -band 0x20) -ne 0) 'never remove a flag not added by the guard'
    [void][RegionTestNative]::DestroyWindow($ghost)
    $ghost = [RegionTestNative]::Surface('Chrome_WidgetWin_1',0x8280080,0)
    Assert ([WhaleWebViewInput]::Guard([uint32]$PID)) 'replacement backing HWND discovered'
    Assert (([RegionTestNative]::GetWindowLong($ghost,-20) -band 0x20) -ne 0) 'replacement backing HWND protected'
    [void][RegionTestNative]::DestroyWindow($ghost)
    $ghost = [RegionTestNative]::Surface('Chrome_WidgetWin_1',0x82800a0,255)
    Assert ([WhaleWebViewInput]::Guard([uint32]$PID)) 'new SDK-transparent visible window accepted'
    Assert (([RegionTestNative]::GetWindowLong($ghost,-20) -band 0x20) -ne 0) 'new HWND never inherits old modification ownership'
  } finally {
    [void][RegionTestNative]::DestroyWindow($ghost)
    [void][RegionTestNative]::DestroyWindow($otherClass)
  }
  Write-Output "PASS: $script:checks native/parse/compile checks; 1000 region updates; GDI delta $($after-$before)"
} finally { $form.Dispose() }
