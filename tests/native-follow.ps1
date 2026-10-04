param([long]$Overlay, [int]$OverlayPid, [long]$FixtureHost, [int]$FixturePid)
$ErrorActionPreference='Stop'
$whaleRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$whaleHostProcess=Get-CimInstance Win32_Process -Filter ('ProcessId='+$FixturePid)
$whaleOverlayProcess=Get-CimInstance Win32_Process -Filter ('ProcessId='+$OverlayPid)
if (!$whaleHostProcess.CommandLine.Contains('occlusion-host.cjs') -or !$whaleOverlayProcess.CommandLine.Contains('main.cjs')) { throw 'Only isolated test windows are allowed.' }
Add-Type -Path (Join-Path $whaleRoot 'desktop\WindowApi.cs')
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
public static class WhaleFollowProbe {
    [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct Point { public int X,Y; }
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out Rect r);
    [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr h, out Rect r);
    [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr h, ref Point p);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr p);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int height, uint flags);
    public static object Run(long overlayId, int overlayPid, long hostId, int hostPid) {
        var overlay=new IntPtr(overlayId); var host=new IntPtr(hostId); uint p;
        GetWindowThreadProcessId(host,out p); if (p!=(uint)hostPid) throw new Exception("Host PID mismatch");
        GetWindowThreadProcessId(overlay,out p); if (p!=(uint)overlayPid) throw new Exception("Overlay PID mismatch");
        var previous=SetThreadDpiAwarenessContext(new IntPtr(-4));
        Rect original; GetWindowRect(host,out original);
        var foreground=GetForegroundWindow();
        var delays=new List<double>(); int completed=0;
        try {
            for(int i=0;i<72;i++) {
                int x=original.Left+(int)(Math.Sin(i*0.14)*90), y=original.Top+(int)(Math.Cos(i*0.14)*45);
                int w=original.Right-original.Left-(i>=54?100:0), h=original.Bottom-original.Top-(i>=54?60:0);
                var watch=Stopwatch.StartNew();
                if(!SetWindowPos(host,IntPtr.Zero,x,y,w,h,0x4014)) throw new Exception("Move failed");
                bool matched=false;
                while(watch.ElapsedMilliseconds<400) {
                    Rect a,b,c;GetWindowRect(host,out a);GetWindowRect(overlay,out b);GetClientRect(host,out c);var origin=new Point();ClientToScreen(host,ref origin);
                    int tolerance=Math.Max(1,(int)Math.Ceiling(GetDpiForWindow(overlay)/96.0));
                    if(a.Left==x && a.Top==y && a.Right-a.Left==w && a.Bottom-a.Top==h &&
                       Math.Abs(origin.X-b.Left)<=1 && Math.Abs(origin.Y-b.Top)<=1 && Math.Abs(c.Right-(b.Right-b.Left))<=tolerance && Math.Abs(c.Bottom-(b.Bottom-b.Top))<=tolerance) {matched=true;break;}
                    Thread.Sleep(2);
                }
                if(!matched) {
                    Rect a,b,c;GetWindowRect(host,out a);GetWindowRect(overlay,out b);GetClientRect(host,out c);var origin=new Point();ClientToScreen(host,ref origin);
                    throw new Exception("Native follow step "+i+" target="+x+","+y+","+w+","+h+" host="+a.Left+","+a.Top+","+(a.Right-a.Left)+","+(a.Bottom-a.Top)+" client="+origin.X+","+origin.Y+","+c.Right+","+c.Bottom+" overlay="+b.Left+","+b.Top+","+(b.Right-b.Left)+","+(b.Bottom-b.Top));
                }
                delays.Add(watch.Elapsed.TotalMilliseconds);completed++;
                Thread.Sleep(Math.Max(1,16-(int)watch.ElapsedMilliseconds));
            }
            delays.Sort();
            return new { steps=completed, p50Ms=delays[delays.Count/2], p95Ms=delays[(int)(delays.Count*0.95)], maxMs=delays[delays.Count-1], focusUnchanged=GetForegroundWindow()==foreground, resized=true };
        } finally {
            SetWindowPos(host,IntPtr.Zero,original.Left,original.Top,original.Right-original.Left,original.Bottom-original.Top,0x4014);
            Thread.Sleep(200);SetThreadDpiAwarenessContext(previous);
        }
    }
}
'@
$whaleType=[WhaleWindows].GetNestedType('NativeFollower',[Reflection.BindingFlags]::NonPublic)
$whaleFollower=[Activator]::CreateInstance($whaleType,([Reflection.BindingFlags]'Instance,Public,NonPublic'),$null,([object[]]@([IntPtr]::new($Overlay),[IntPtr]::new($FixtureHost))),$null)
try {
    $whaleType.GetMethod('Start').Invoke($whaleFollower,@()) | Out-Null
    if (!$whaleType.GetField('Running').GetValue($whaleFollower)) { throw 'Native hook did not start.' }
    $whaleResult=[WhaleFollowProbe]::Run($Overlay,$OverlayPid,$FixtureHost,$FixturePid)
    if ($whaleResult.p95Ms -ge 60 -or !$whaleResult.focusUnchanged) { throw ('Native follow failed latency/focus check: '+($whaleResult | ConvertTo-Json -Compress)) }
    if ($whaleType.GetField('Moves').GetValue($whaleFollower) -gt 200) { throw 'Unexpected resize feedback loop.' }
    @{ok=$true;result=$whaleResult;events=$whaleType.GetField('Events').GetValue($whaleFollower);moves=$whaleType.GetField('Moves').GetValue($whaleFollower)} | ConvertTo-Json -Depth 4 -Compress
} catch {
    @{ok=$false;error=$_.Exception.Message;events=$whaleType.GetField('Events').GetValue($whaleFollower);moves=$whaleType.GetField('Moves').GetValue($whaleFollower);nativeError=$whaleType.GetField('Error').GetValue($whaleFollower)} | ConvertTo-Json -Compress
    throw
} finally { $whaleType.GetMethod('Stop').Invoke($whaleFollower,@()) | Out-Null }
