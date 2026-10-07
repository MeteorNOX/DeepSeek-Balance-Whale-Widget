"""Guarded real Windows mouse bursts, limited to two identified test windows."""
import ctypes, json, sys, time
from ctypes import wintypes as W
u=ctypes.WinDLL('user32',use_last_error=True)
g=ctypes.WinDLL('gdi32',use_last_error=True)
u.SetThreadDpiAwarenessContext.argtypes=[W.HANDLE]
u.SetThreadDpiAwarenessContext(ctypes.c_void_p(-4))
u.GetWindowThreadProcessId.argtypes=[W.HWND,ctypes.POINTER(W.DWORD)]
u.GetAncestor.argtypes=[W.HWND,W.UINT];u.GetAncestor.restype=W.HWND
u.WindowFromPoint.argtypes=[W.POINT];u.WindowFromPoint.restype=W.HWND
u.GetWindowRect.argtypes=[W.HWND,ctypes.POINTER(W.RECT)]
u.IsWindowVisible.argtypes=[W.HWND]
u.GetWindowLongPtrW.argtypes=[W.HWND,ctypes.c_int];u.GetWindowLongPtrW.restype=ctypes.c_ssize_t
u.GetWindowRgn.argtypes=[W.HWND,W.HANDLE]
g.CreateRectRgn.argtypes=[ctypes.c_int]*4;g.CreateRectRgn.restype=W.HANDLE
g.PtInRegion.argtypes=[W.HANDLE,ctypes.c_int,ctypes.c_int]
g.DeleteObject.argtypes=[W.HANDLE]
class Mouse(ctypes.Structure):
    _fields_=[('dx',W.LONG),('dy',W.LONG),('data',W.DWORD),('flags',W.DWORD),('time',W.DWORD),('extra',ctypes.c_size_t)]
class Payload(ctypes.Union):
    _fields_=[('mouse',Mouse)]
class Input(ctypes.Structure):
    _fields_=[('kind',W.DWORD),('payload',Payload)]
u.SendInput.argtypes=[W.UINT,ctypes.POINTER(Input),ctypes.c_int];u.SendInput.restype=W.UINT
widget,widget_pid,host,host_pid,x,y,count,interval,lead=map(int,sys.argv[1:])
if not (1<=count<=80 and 16<=interval<=250 and 0<=lead<=100):raise RuntimeError('Invalid bounded burst')
def identity(hwnd,pid):
    actual=W.DWORD();u.GetWindowThreadProcessId(hwnd,ctypes.byref(actual))
    if actual.value!=pid or not u.IsWindowVisible(hwnd):raise RuntimeError('Test window identity/visibility changed')
def check():
    identity(widget,widget_pid);identity(host,host_pid)
    r=W.RECT();u.GetWindowRect(host,ctypes.byref(r))
    if not (r.left+2<x<r.right-2 and r.top+2<y<r.bottom-2):raise RuntimeError('Outside isolated host')
    hit=u.GetAncestor(u.WindowFromPoint(W.POINT(x,y)),2)
    if hit not in [widget,host]:raise RuntimeError('Foreign window at test point; input cancelled')
    wr=W.RECT();u.GetWindowRect(widget,ctypes.byref(wr));region=g.CreateRectRgn(0,0,0,0)
    try:
        kind=u.GetWindowRgn(widget,region)
        contained=bool(g.PtInRegion(region,x-wr.left,y-wr.top)) if kind>0 else None
    finally:g.DeleteObject(region)
    return {'hit':'widget' if hit==widget else 'host','regionContains':contained,'regionKind':kind,
            'transparent':bool(u.GetWindowLongPtrW(widget,-20)&0x20),'widgetOrigin':[wr.left,wr.top]}
def send(flags):
    event=Input(0,Payload(mouse=Mouse(0,0,0,flags,0,0)))
    if u.SendInput(1,ctypes.byref(event),ctypes.sizeof(event))!=1:raise RuntimeError('SendInput failed')
old=W.POINT();u.GetCursorPos(ctypes.byref(old));pressed=False;records=[];sent=0
try:
    check();u.SetCursorPos(x,y);time.sleep(lead/1000)
    begin=time.perf_counter()
    for index in range(count):
        wait=begin+index*interval/1000-time.perf_counter()
        if wait>0:time.sleep(wait)
        cursor=W.POINT();u.GetCursorPos(ctypes.byref(cursor))
        if (cursor.x,cursor.y)!=(x,y):raise RuntimeError('Pointer moved outside test control; input cancelled')
        before=check();send(2);pressed=True;sent+=1
        time.sleep(.006);during=check();time.sleep(.006)
        send(4);pressed=False
        records.append({'index':index,'elapsedMs':round((time.perf_counter()-begin)*1000,3),'before':before,'during':during})
    print(json.dumps({'ok':True,'sent':sent,'intervalMs':interval,'leadMs':lead,'point':[x,y],'records':records}))
except Exception as error:
    print(json.dumps({'ok':False,'sent':sent,'error':str(error),'records':records}));sys.exit(1)
finally:
    if pressed:send(4)
    cursor=W.POINT();u.GetCursorPos(ctypes.byref(cursor))
    if (cursor.x,cursor.y)==(x,y):u.SetCursorPos(old.x,old.y)
