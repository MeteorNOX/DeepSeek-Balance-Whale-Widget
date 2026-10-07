using System;
using System.Runtime.InteropServices;

// Read-only metadata: no titles, process paths, pixels, focus or redraw calls.
public static class WhaleWindowDiagnostics {
    [StructLayout(LayoutKind.Sequential)] public struct Rect { public int left, top, right, bottom; }
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out Rect r);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint command);
    [DllImport("user32.dll", EntryPoint="GetWindowLongPtrW")] static extern IntPtr GetWindowLongPtr(IntPtr h, int index);
    [DllImport("user32.dll")] static extern int GetWindowRgn(IntPtr h, IntPtr region);
    [DllImport("gdi32.dll")] static extern IntPtr CreateRectRgn(int left, int top, int right, int bottom);
    [DllImport("gdi32.dll")] static extern int GetRgnBox(IntPtr region, out Rect r);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr value);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attribute, out int value, int size);
    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);

    public static object Snapshot(long overlayValue, long hostValue) {
        var overlay = new IntPtr(overlayValue); var host = new IntPtr(hostValue);
        IntPtr previous = IntPtr.Zero;
        try { previous = SetThreadDpiAwarenessContext(new IntPtr(-4)); } catch { }
        try {
            bool exists = overlay != IntPtr.Zero && IsWindow(overlay);
            Rect bounds = new Rect(), regionBounds = new Rect(); int regionType = 0, cloak = 0;
            int cloakResult = -1; long style = 0; bool aboveHost = false; bool orderKnown = false;
            if (exists) {
                GetWindowRect(overlay, out bounds); style = GetWindowLongPtr(overlay, -20).ToInt64();
                cloakResult = DwmGetWindowAttribute(overlay, 14, out cloak, 4);
                var region = CreateRectRgn(0, 0, 0, 0);
                if (region != IntPtr.Zero) { try { regionType = GetWindowRgn(overlay, region); if (regionType > 0) GetRgnBox(region, out regionBounds); } finally { DeleteObject(region); } }
                // A bounded read through the Z order; HWNDs may vanish during sampling.
                if (host != IntPtr.Zero && IsWindow(host)) {
                    var current = GetWindow(overlay, 0);
                    for (int n = 0; current != IntPtr.Zero && n < 4096; n++, current = GetWindow(current, 2)) {
                        if (current == overlay) { aboveHost = true; orderKnown = true; break; }
                        if (current == host) { orderKnown = true; break; }
                    }
                }
            }
            var foreground = GetForegroundWindow();
            return new {
                sampledAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), exists,
                visible = exists && IsWindowVisible(overlay), iconic = exists && IsIconic(overlay),
                ownerMatches = exists && host != IntPtr.Zero && GetWindow(overlay, 4) == host,
                hostForeground = host != IntPtr.Zero && foreground == host,
                overlayForeground = exists && foreground == overlay,
                aboveHost, orderKnown, topmost = (style & 8) != 0,
                toolWindow = (style & 0x80) != 0, transparent = (style & 0x20) != 0,
                cloakKnown = cloakResult == 0, cloaked = cloak != 0,
                regionType, regionBounds, bounds
            };
        } finally { if (previous != IntPtr.Zero) SetThreadDpiAwarenessContext(previous); }
    }
}
