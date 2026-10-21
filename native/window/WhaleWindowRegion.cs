using System;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;

// Clip the native HWND, including its WebView, rather than racing cursor probes.
public static class WhaleWindowRegion
{
    [StructLayout(LayoutKind.Sequential)] private struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] private struct POINT { public int X, Y; }
    [DllImport("user32.dll")] private static extern bool GetClientRect(IntPtr hwnd, out RECT rect);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
    [DllImport("user32.dll")] private static extern bool ClientToScreen(IntPtr hwnd, ref POINT point);
    [DllImport("user32.dll")] private static extern int SetWindowRgn(IntPtr hwnd, IntPtr region, bool redraw);
    [DllImport("gdi32.dll")] private static extern IntPtr CreateRectRgn(int left, int top, int right, int bottom);
    [DllImport("gdi32.dll")] private static extern int CombineRgn(IntPtr dest, IntPtr a, IntPtr b, int mode);
    [DllImport("gdi32.dll")] private static extern bool DeleteObject(IntPtr obj);

    public static bool Clear(IntPtr hwnd)
    {
        IntPtr region = CreateRectRgn(0, 0, 0, 0);
        if (region == IntPtr.Zero) return false;
        if (SetWindowRgn(hwnd, region, true) != 0) return true; // Windows owns it now.
        DeleteObject(region);
        return false;
    }

    private static double Number(string value)
    {
        double n = double.Parse(value, CultureInfo.InvariantCulture);
        if (double.IsNaN(n) || double.IsInfinity(n) || Math.Abs(n) > 1000000) throw new FormatException();
        return n;
    }

    // ExecuteScriptAsync returns a JSON string containing numbers and separators only.
    // Format: viewportWidth,viewportHeight;left,top,right,bottom;...
    public static bool Apply(IntPtr hwnd, string result)
    {
        IntPtr region = IntPtr.Zero;
        try
        {
            if (result == null || result.Length < 2 || result[0] != '"' || result[result.Length - 1] != '"') return false;
            string[] rows = result.Substring(1, result.Length - 2).Split(';');
            if (rows.Length > 257) return false;
            string[] viewport = rows[0].Split(',');
            if (viewport.Length != 2) return false;
            double vw = Number(viewport[0]), vh = Number(viewport[1]);
            if (vw <= 0 || vh <= 0) return false;
            RECT client, window;
            POINT origin = new POINT();
            if (!GetClientRect(hwnd, out client) || !GetWindowRect(hwnd, out window) || !ClientToScreen(hwnd, ref origin)) return false;
            // CSS viewport -> physical client pixels accounts for both DPI and browser zoom.
            double sx = (client.Right - client.Left) / vw, sy = (client.Bottom - client.Top) / vh;
            if (sx <= 0 || sy <= 0) return false;
            int dx = origin.X - window.Left, dy = origin.Y - window.Top;
            region = CreateRectRgn(0, 0, 0, 0);
            if (region == IntPtr.Zero) return false;
            for (int i = 1; i < rows.Length; i++)
            {
                string[] cells = rows[i].Split(',');
                if (cells.Length != 4) return false;
                double l = Math.Max(0, Number(cells[0])), t = Math.Max(0, Number(cells[1]));
                double r = Math.Min(vw, Number(cells[2])), b = Math.Min(vh, Number(cells[3]));
                if (r <= l || b <= t) continue;
                // A fullscreen container/backdrop must never restore the glass pane.
                if (l == 0 && t == 0 && r == vw && b == vh) return false;
                IntPtr part = CreateRectRgn(dx + (int)Math.Floor(l * sx), dy + (int)Math.Floor(t * sy),
                    dx + (int)Math.Ceiling(r * sx), dy + (int)Math.Ceiling(b * sy));
                if (part == IntPtr.Zero) return false;
                try { if (CombineRgn(region, region, part, 2) == 0) return false; }
                finally { DeleteObject(part); }
            }
            if (SetWindowRgn(hwnd, region, true) == 0) return false;
            region = IntPtr.Zero; // Ownership transferred to Windows; never delete it.
            return true;
        }
        catch { return false; }
        finally { if (region != IntPtr.Zero) DeleteObject(region); }
    }
}

// CompositionControl captures a Chromium backing window into a WPF Image.
// That separate, alpha-zero top-level HWND must not receive desktop input.
// WPF still forwards widget input through the composition controller.
public static class WhaleWebViewInput
{
    private const int ExStyle = -20, Transparent = 0x20;
    private const int BackingStyles = 0x80000 | 0x8000000 | 0x80; // layered, no-activate, tool
    private const uint Alpha = 2;
    private delegate bool EnumWindowProc(IntPtr hwnd, IntPtr data);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowProc callback, IntPtr data);
    [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr hwnd, uint command);
    [DllImport("user32.dll")] private static extern IntPtr GetParent(IntPtr hwnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr hwnd, StringBuilder name, int length);
    [DllImport("user32.dll")] private static extern int GetWindowLong(IntPtr hwnd, int index);
    [DllImport("user32.dll", SetLastError = true)] private static extern int SetWindowLong(IntPtr hwnd, int index, int value);
    [DllImport("user32.dll")] private static extern bool GetLayeredWindowAttributes(IntPtr hwnd, out uint key, out byte alpha, out uint flags);
    [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern bool SetProp(IntPtr hwnd, string name, IntPtr value);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr GetProp(IntPtr hwnd, string name);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr RemoveProp(IntPtr hwnd, string name);
    // Only remember flags we added, so a surface that becomes visible can regain
    // its original input behavior without changing SDK-owned transparent flags.
    // Window properties disappear on destruction, including when Windows later
    // reuses the same HWND value in this browser process.
    private static readonly string marker = "DSHWhale.Input." + Guid.NewGuid().ToString("N");
    public static int ProtectedWindows { get; private set; }
    public static long Repairs { get; private set; }

    private static bool WriteStyle(IntPtr hwnd, int style)
    {
        if (SetWindowLong(hwnd, ExStyle, style) == 0 && Marshal.GetLastWin32Error() != 0) return !IsWindow(hwnd);
        // Do not wait for another process's input thread while it is unresponsive.
        if (!SetWindowPos(hwnd, IntPtr.Zero, 0, 0, 0, 0, 0x1 | 0x2 | 0x4 | 0x10 | 0x20 | 0x4000)) return !IsWindow(hwnd);
        return !IsWindow(hwnd) || (GetWindowLong(hwnd, ExStyle) & Transparent) == (style & Transparent);
    }

    public static bool Guard(uint browserPid)
    {
        if (browserPid == 0) return false;
        bool ok = true;
        int count = 0;
        bool enumerated = EnumWindows(delegate(IntPtr hwnd, IntPtr data)
        {
            try
            {
                uint pid;
                GetWindowThreadProcessId(hwnd, out pid);
                if (pid != browserPid) return true;
                int style = GetWindowLong(hwnd, ExStyle);
                bool ours = GetProp(hwnd, marker) != IntPtr.Zero;
                uint key = 0, flags = 0;
                byte alpha = 255;
                if (ours)
                {
                    if ((style & 0x80000) != 0 && !GetLayeredWindowAttributes(hwnd, out key, out alpha, out flags))
                    {
                        if (IsWindow(hwnd)) ok = false;
                        return true;
                    }
                    // Restore first, even if the SDK also changed class/owner/styles.
                    if ((flags & Alpha) == 0 || alpha != 0)
                    {
                        if (!WriteStyle(hwnd, style & ~Transparent)) { ok = false; return true; }
                        RemoveProp(hwnd, marker);
                        return true;
                    }
                }
                else
                {
                    if (GetWindow(hwnd, 4) != IntPtr.Zero || GetParent(hwnd) != IntPtr.Zero || (style & BackingStyles) != BackingStyles) return true;
                    var name = new StringBuilder(64);
                    if (GetClassName(hwnd, name, name.Capacity) == 0 || name.ToString() != "Chrome_WidgetWin_1") return true;
                    if (!GetLayeredWindowAttributes(hwnd, out key, out alpha, out flags)) return true;
                }
                if ((flags & Alpha) != 0 && alpha == 0)
                {
                    if (IsWindowVisible(hwnd)) count++;
                    if ((style & Transparent) == 0)
                    {
                        if (!SetProp(hwnd, marker, new IntPtr(1)))
                        {
                            if (IsWindow(hwnd)) ok = false;
                            return true;
                        }
                        if (!WriteStyle(hwnd, style | Transparent)) { ok = false; return true; }
                        Repairs++;
                    }
                }
            }
            catch { ok = false; }
            return true;
        }, IntPtr.Zero);
        ProtectedWindows = count;
        return enumerated && ok;
    }
}
