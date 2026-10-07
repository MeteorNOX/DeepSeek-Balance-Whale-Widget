using System;
using System.Runtime.InteropServices;

public static class WhaleWindowStacking {
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h,uint command);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsWindowEnabled(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h,IntPtr after,int x,int y,int width,int height,uint flags);
    public static bool Repair(long overlayValue,int expectedOverlayPid,long hostValue,int expectedHostPid) {
        var overlay=new IntPtr(overlayValue);var host=new IntPtr(hostValue);uint overlayPid,hostPid;
        if(overlay==IntPtr.Zero||host==IntPtr.Zero||expectedOverlayPid<=0||expectedHostPid<=0)return false;
        GetWindowThreadProcessId(overlay,out overlayPid);GetWindowThreadProcessId(host,out hostPid);
        if(overlayPid!=(uint)expectedOverlayPid||hostPid!=(uint)expectedHostPid||GetWindow(overlay,4)!=host)return false;
        if(GetForegroundWindow()!=host||!IsWindowVisible(overlay)||!IsWindowVisible(host)||!IsWindowEnabled(host)||IsIconic(host))return false;
        var current=GetWindow(overlay,0);bool below=false;
        for(int n=0;current!=IntPtr.Zero&&n<4096;n++,current=GetWindow(current,2)) {
            if(current==overlay)return false; // Already above its host: leave it alone.
            if(current==host){below=true;break;}
        }
        if(!below)return false;
        // HWND_TOP (not TOPMOST), no move/resize/activation/owner reordering.
        // Async position avoids blocking the supervisor on another GUI thread.
        return SetWindowPos(overlay,IntPtr.Zero,0,0,0,0,0x4213);
    }
}
