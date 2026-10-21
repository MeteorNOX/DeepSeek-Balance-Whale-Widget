# Optional Windows native window

This directory is packaged in the existing `dsh-whale-widget` npm bundle; the
feature defaults to off and supports x64 Windows systems.

`whale-window.ps1` loads the bundled x64 WebView2 SDK and uses the installed
Evergreen Runtime. See `sdk/NOTICE.md` and the Microsoft license. Windows
PowerShell 5.1 requires the script's UTF-8 BOM. If the Runtime is missing, the host
returns to the embedded widget.

The host passes its session cookie only in the child environment. The child
removes that environment variable before WebView initialization, seeds its cookie
jar, attaches its bridge, and only then navigates. Every HTTP route uses the
original registration/authentication wrapper. Do not reintroduce an unauthenticated
HTML route that signs a host session or writes `Set-Cookie` responses.

The host brackets IPv6 addresses when constructing the local origin. Plugin
disposal cancels the startup-restore timer. Reopening a closing window waits for
the previous process to exit before launching another one.

The HWND covers the primary working area for the existing widget's layout, but
`WhaleWindowRegion.cs` clips the native window to bounded UI rectangles. Empty
startup and error regions are real empty regions, not `SetWindowRgn(hwnd, NULL)`
(which would remove clipping). Region handles transfer to Windows only after a
successful `SetWindowRgn`; temporary GDI handles must be disposed.

CompositionControl also creates an independent Chromium backing HWND. Some
Runtime versions leave this alpha-zero surface visible and input-enabled, outside
the WPF region. `WhaleWebViewInput` identifies these surfaces by the current
WebView browser PID, window class, owner and layered-window attributes, then sets
`WS_EX_TRANSPARENT`. It rechecks recreated windows and SDK style resets. WPF
continues forwarding widget input through the composition controller. Closing
the host disposes WebView2 and its backing windows. See
[WebView2 issue #5668](https://github.com/MicrosoftEdge/WebView2Feedback/issues/5668).

CSS viewport dimensions map to physical client pixels and then to window-relative
coordinates. The region watchdog drops snapshots older than one second and
releases capture on failure. Three consecutive timeouts or invalid snapshots close
the native window and restore the embedded widget. Mouse capture starts with a
whale drag and releases when dragging ends; the native input tick also releases
capture when the left button is up. Menus and panels use their normal input paths.
Dragging retains the bounded window region. Rectangular transparent corners
receive input, and region updates can briefly clip animations. The window uses
the primary working area. Modal backdrops are excluded, so clicks outside cards
reach the desktop; close dialogs with their card buttons.

Run these checks from the repository root:

```text
node tools/window-region-test.mjs
powershell -NoProfile -ExecutionPolicy Bypass -File tools/window-region-test.ps1
node tools/z-layer-audit.mjs assets/whale-widget.js
node tools/ci-audit.mjs
node tools/ci-audit-selftest.mjs
node tools/check-dead-settings.mjs
```

CI and the manually invoked publication workflow both run DOM and native region
regression checks; publishing depends on the Windows native job. Publication
remains manual, with the existing main-branch and npm-version guards.
