"""Read actual HRGN and screen pixels of explicitly identified isolated fixtures."""
import ctypes
import json
import os
import struct
import sys
import time
from ctypes import wintypes as W
from PIL import ImageGrab

u = ctypes.WinDLL('user32', use_last_error=True)
g = ctypes.WinDLL('gdi32', use_last_error=True)
u.SetThreadDpiAwarenessContext.argtypes = [W.HANDLE]
u.SetThreadDpiAwarenessContext(ctypes.c_void_p(-4))
u.GetWindowThreadProcessId.argtypes = [W.HWND, ctypes.POINTER(W.DWORD)]
u.GetWindowRgn.argtypes = [W.HWND, W.HANDLE]
u.GetWindowRect.argtypes = [W.HWND, ctypes.POINTER(W.RECT)]
u.IsWindowVisible.argtypes = [W.HWND]
u.GetWindow.argtypes = [W.HWND, W.UINT]
u.GetWindow.restype = W.HWND
u.GetWindowLongPtrW.argtypes = [W.HWND, ctypes.c_int]
u.GetWindowLongPtrW.restype = ctypes.c_ssize_t
u.GetClassNameW.argtypes = [W.HWND, W.LPWSTR, ctypes.c_int]
u.GetLayeredWindowAttributes.argtypes = [W.HWND, ctypes.POINTER(W.DWORD), ctypes.POINTER(W.BYTE), ctypes.POINTER(W.DWORD)]
u.WindowFromPoint.argtypes = [W.POINT]
u.WindowFromPoint.restype = W.HWND
u.GetAncestor.argtypes = [W.HWND, W.UINT]
u.GetAncestor.restype = W.HWND
g.CreateRectRgn.argtypes = [ctypes.c_int] * 4
g.CreateRectRgn.restype = W.HANDLE
g.GetRegionData.argtypes = [W.HANDLE, W.DWORD, ctypes.c_void_p]
g.GetRegionData.restype = W.DWORD
g.PtInRegion.argtypes = [W.HANDLE, ctypes.c_int, ctypes.c_int]
g.DeleteObject.argtypes = [W.HANDLE]
hwnd, pid, backdrop = map(int, sys.argv[1:4])
output = os.path.abspath(sys.argv[4])

def identity(h):
    actual = W.DWORD()
    u.GetWindowThreadProcessId(h, ctypes.byref(actual))
    if actual.value != pid:
        raise RuntimeError('Isolated fixture PID mismatch')

def rect(h):
    r = W.RECT()
    if not u.GetWindowRect(h, ctypes.byref(r)):
        raise RuntimeError('Fixture window no longer exists')
    return (r.left, r.top, r.right, r.bottom)

def unobscured(box):
    # Inspect all windows above our opaque backdrop before reading any screen
    # pixels. A foreign intersecting window makes capture inconclusive.
    h = u.GetWindow(backdrop, 0)
    overlays = []
    while h and h != backdrop:
        if u.IsWindowVisible(h):
            r = rect(h)
            p = W.DWORD()
            u.GetWindowThreadProcessId(h, ctypes.byref(p))
            if p.value != pid and r[0] < box[2] and r[2] > box[0] and r[1] < box[3] and r[3] > box[1]:
                name = ctypes.create_unicode_buffer(256)
                u.GetClassNameW(h, name, len(name))
                key, alpha, flags = W.DWORD(), W.BYTE(), W.DWORD()
                layered = u.GetLayeredWindowAttributes(h, ctypes.byref(key), ctypes.byref(alpha), ctypes.byref(flags))
                style = u.GetWindowLongPtrW(h, -20)
                if layered and flags.value & 2 and alpha.value == 0:
                    pass  # Explicit zero global opacity contributes no pixels.
                elif style & 0x80020 == 0x80020:
                    # Click-through per-pixel overlays (e.g. recording HUDs) are
                    # not opaque occluders. Record them for visual review rather
                    # than treating their full-screen bounds as solid coverage.
                    overlays.append({'class': name.value, 'rect': r})
                else:
                    return {'clear': False, 'class': name.value, 'rect': r, 'pid': p.value}
        h = u.GetWindow(h, 2)
    return {'clear': h == backdrop, 'backdropFound': h == backdrop, 'passThroughOverlays': overlays}

identity(hwnd)
identity(backdrop)
print(json.dumps({'ready': True}), flush=True)
for line in sys.stdin:
    request = json.loads(line)
    if request.get('quit'):
        break
    region = g.CreateRectRgn(0, 0, 0, 0)
    try:
        identity(hwnd)
        kind = u.GetWindowRgn(hwnd, region)
        size = g.GetRegionData(region, 0, None)
        buf = ctypes.create_string_buffer(size)
        if size:
            g.GetRegionData(region, size, buf)
        raw = buf.raw
        count = struct.unpack_from('<I', raw, 8)[0] if size >= 32 else 0
        rectangles = [list(struct.unpack_from('<4i', raw, 32 + i * 16)) for i in range(count)]
        answer = {'id': request['id'], 'kind': kind, 'rectangles': rectangles,
                  'windowRect': rect(hwnd), 'backdropRect': rect(backdrop), 'backdropVisible': bool(u.IsWindowVisible(backdrop)),
                  'contains': [bool(g.PtInRegion(region, int(x), int(y))) for x, y in request.get('points', [])],
                  'sampledAt': time.time() * 1000}
        origin = rect(hwnd)
        answer['hitsWidget'] = [u.GetAncestor(u.WindowFromPoint(W.POINT(origin[0]+int(x), origin[1]+int(y))), 2) == hwnd for x,y in request.get('hitPoints', [])]
        if request.get('capture'):
            name = request['capture']
            if os.path.basename(name) != name or not name.endswith('.png'):
                raise RuntimeError('Invalid fixture capture filename')
            box = rect(hwnd)
            answer['occlusion'] = unobscured(box)
            answer['unobscured'] = answer['occlusion']['clear']
            if answer['unobscured']:
                image = ImageGrab.grab(bbox=box, all_screens=True, include_layered_windows=True)
                # Opaque test backdrop uses this deliberately uncommon RGB.
                colors = image.convert('RGB').crop((8, 8, image.width-8, image.height-8))
                answer['pixelCount'] = colors.width * colors.height
                palette = colors.getcolors(answer['pixelCount'])
                answer['backdropPixels'] = sum(count for count,px in palette if max(abs(a-b) for a,b in zip(px,(37,57,83))) <= 2)
                answer['nonBackdropPixels'] = answer['pixelCount'] - answer['backdropPixels']
                # The expanded menu legitimately covers most of this fixture.
                minimum = .1 if name.startswith('menu-') else .5
                if answer['backdropPixels'] > answer['pixelCount'] * minimum:
                    image.save(os.path.join(output, name))
                    answer['capture'] = name
        print(json.dumps(answer), flush=True)
    except Exception as exc:
        print(json.dumps({'id': request['id'], 'error': str(exc)}), flush=True)
    finally:
        g.DeleteObject(region)
