param([long]$Overlay, [int]$OverlayPid, [long]$FixtureHost, [int]$FixturePid)
$ErrorActionPreference='Stop'
$whaleRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$whaleHostProcess=Get-CimInstance Win32_Process -Filter ('ProcessId='+$FixturePid)
$whaleOverlayProcess=Get-CimInstance Win32_Process -Filter ('ProcessId='+$OverlayPid)
if (!$whaleHostProcess.CommandLine.Contains('visibility-stress-host.cjs') -or !$whaleOverlayProcess.CommandLine.Contains('main.cjs')) { throw 'Only isolated visibility fixtures are allowed.' }
Add-Type -Path (Join-Path $whaleRoot 'desktop\WindowApi.cs')
Add-Type -Path (Join-Path $whaleRoot 'desktop\WindowDiagnostics.cs')
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
public static class WhaleVisibilityFixture {
    public sealed class Bounds { public int x,y,width,height; }
    public sealed class State { public bool visible,modal,widgetVisible,hostTopmost,overlayTopmost,owned; public uint dpi; public string foreground; public Bounds bounds; }
    [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left,Top,Right,Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct Point { public int X,Y; }
    delegate bool EnumProc(IntPtr h,IntPtr p);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb,IntPtr p);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h,uint flags);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsWindowEnabled(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern bool ShowWindowAsync(IntPtr h,int command);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll",EntryPoint="GetWindowLongPtrW")] static extern IntPtr GetWindowLongPtr(IntPtr h,int index);
    public static bool Show(long h,int command) { return ShowWindowAsync(new IntPtr(h),command); }
    [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr h,out Rect r);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point p);
    [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr h,ref Point p);
    [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr SetWindowLongPtr(IntPtr h,int index,IntPtr v);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h,uint cmd);
    [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h,uint msg,IntPtr w,IntPtr l);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h,StringBuilder text,int len);
    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr p);
    public static void Attach(long overlay,long host) { SetWindowLongPtr(new IntPtr(overlay),-8,new IntPtr(host)); if(GetWindow(new IntPtr(overlay),4)!=new IntPtr(host))throw new Exception("Owner attach failed"); }
    public static object Probe(long id,long overlayId) {
        var previous=SetThreadDpiAwarenessContext(new IntPtr(-4));
        try { var h=new IntPtr(id);var overlay=new IntPtr(overlayId); Rect r; var p=new Point();GetClientRect(h,out r);ClientToScreen(h,ref p);
            return new State { visible=IsWindowVisible(h)&&!IsIconic(h),modal=!IsWindowEnabled(h),widgetVisible=IsWindowVisible(overlay)&&!IsIconic(overlay),hostTopmost=(GetWindowLongPtr(h,-20).ToInt64()&8)!=0,overlayTopmost=(GetWindowLongPtr(overlay,-20).ToInt64()&8)!=0,owned=GetWindow(overlay,4)==h,foreground=GetForegroundWindow().ToInt64().ToString(),dpi=GetDpiForWindow(h),bounds=new Bounds {x=p.X,y=p.Y,width=r.Right,height=r.Bottom} };
        } finally {SetThreadDpiAwarenessContext(previous);}
    }
    public static int Cancel(long hostId,int hostPid) {
        int count=0;var host=new IntPtr(hostId);
        EnumWindows((h,p)=>{uint pid;GetWindowThreadProcessId(h,out pid);var name=new StringBuilder(100);GetClassName(h,name,100);
            if(pid==(uint)hostPid&&h!=host&&GetAncestor(h,3)==host&&name.ToString()=="#32770"&&IsWindowVisible(h)) { if(PostMessage(h,0x0010,IntPtr.Zero,IntPtr.Zero))count++; }return true;
        },IntPtr.Zero);return count;
    }
    public static string Capture(long id) {
        var previous=SetThreadDpiAwarenessContext(new IntPtr(-4));
        try {var h=new IntPtr(id);Rect r;var p=new Point();GetClientRect(h,out r);ClientToScreen(h,ref p);
            using(var bitmap=new Bitmap(r.Right,r.Bottom))using(var graphics=Graphics.FromImage(bitmap))using(var bytes=new MemoryStream()){
                graphics.CopyFromScreen(p.X,p.Y,0,0,new Size(r.Right,r.Bottom),CopyPixelOperation.SourceCopy);bitmap.Save(bytes,ImageFormat.Png);return Convert.ToBase64String(bytes.ToArray());
            }
        }finally{SetThreadDpiAwarenessContext(previous);}
    }
    public static bool Unobscured(long hostId,long overlayId) {
        var previous=SetThreadDpiAwarenessContext(new IntPtr(-4));
        try {
            var host=new IntPtr(hostId);uint hostPid,overlayPid;GetWindowThreadProcessId(host,out hostPid);GetWindowThreadProcessId(new IntPtr(overlayId),out overlayPid);
            Rect r;var origin=new Point();GetClientRect(host,out r);ClientToScreen(host,ref origin);
            foreach(double x in new double[]{.2,.5,.8})foreach(double y in new double[]{.2,.5,.8}){
                uint pid;GetWindowThreadProcessId(WindowFromPoint(new Point{X=origin.X+(int)(r.Right*x),Y=origin.Y+(int)(r.Bottom*y)}),out pid);
                if(pid!=hostPid&&pid!=overlayPid)return false;
            }
            return true;
        }finally{SetThreadDpiAwarenessContext(previous);}
    }
}
'@
[WhaleVisibilityFixture]::Attach($Overlay,$FixtureHost)
$whaleType=[WhaleWindows].GetNestedType('NativeFollower',[Reflection.BindingFlags]::NonPublic)
$whaleFollower=[Activator]::CreateInstance($whaleType,([Reflection.BindingFlags]'Instance,Public,NonPublic'),$null,([object[]]@([IntPtr]::new($Overlay),[IntPtr]::new($FixtureHost))),$null)
try {
    $whaleType.GetMethod('Start').Invoke($whaleFollower,@()) | Out-Null
    if (!$whaleType.GetField('Running').GetValue($whaleFollower)) { throw 'Native hooks failed.' }
    @{ready=$true} | ConvertTo-Json -Compress
    while ($whaleLine=[Console]::ReadLine()) {
        $whaleRequest=$whaleLine | ConvertFrom-Json
        if ($whaleRequest.command -eq 'quit') { break }
        try {
            $whaleResult=@{id=$whaleRequest.id}
            if ($whaleRequest.command -eq 'probe') { $whaleResult.state=[WhaleVisibilityFixture]::Probe($FixtureHost,$Overlay); $whaleResult.visibilityRevision=[WhaleWindows]::VisibilityRevision(); $whaleResult.visualDiagnostics=[WhaleWindowDiagnostics]::Snapshot($Overlay,$FixtureHost) }
            elseif ($whaleRequest.command -eq 'minimize') { $whaleResult.ok=[WhaleVisibilityFixture]::Show($FixtureHost,6) }
            elseif ($whaleRequest.command -eq 'restore') { $whaleResult.ok=[WhaleVisibilityFixture]::Show($FixtureHost,9) }
            elseif ($whaleRequest.command -eq 'capture') { $whaleResult.png=[WhaleVisibilityFixture]::Capture($FixtureHost);$whaleResult.unobscured=[WhaleVisibilityFixture]::Unobscured($FixtureHost,$Overlay);$whaleResult.state=[WhaleVisibilityFixture]::Probe($FixtureHost,$Overlay) }
            elseif ($whaleRequest.command -eq 'cancel') { $whaleResult.closed=[WhaleVisibilityFixture]::Cancel($FixtureHost,$FixturePid) }
            $whaleResult | ConvertTo-Json -Depth 5 -Compress
        } catch { @{id=$whaleRequest.id;error=$_.Exception.Message} | ConvertTo-Json -Compress }
    }
} finally { $whaleType.GetMethod('Stop').Invoke($whaleFollower,@()) | Out-Null; [WhaleVisibilityFixture]::Attach($Overlay,0) }
