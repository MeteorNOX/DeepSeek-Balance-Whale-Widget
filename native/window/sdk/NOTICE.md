# 随包携带的 WebView2 SDK

本目录里的三个文件来自微软官方 NuGet 包 [`Microsoft.Web.WebView2`](https://www.nuget.org/packages/Microsoft.Web.WebView2)：

| 文件 | 来源（包内路径） |
|---|---|
| `Microsoft.Web.WebView2.Core.dll` | `lib/net462/Microsoft.Web.WebView2.Core.dll` |
| `Microsoft.Web.WebView2.Wpf.dll` | `lib/net462/Microsoft.Web.WebView2.Wpf.dll` |
| `WebView2Loader.dll` | `runtimes/win-x64/native/WebView2Loader.dll` |
| `LICENSE.txt` | 包根目录的 `LICENSE.txt`（原样保留） |

- 版本：**1.0.4258.31**（`lib/net462` → 供 Windows PowerShell 5.1 / .NET Framework 使用）
- 获取方式：`https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/1.0.4258.31/microsoft.web.webview2.1.0.4258.31.nupkg`（解压后按上表取出，未做任何修改）
- 为什么随包带：原生独立窗口用 WebView2 渲染既有网页挂件 UI，**WebView2 Runtime 本身由 Windows 10/11 预装**（Edge 内核），所以最终用户零安装；但托管 SDK 程序集不在系统里，必须随包提供。
- 运行条件：系统需存在 WebView2 Runtime（Windows 10/11 默认已装；缺失时可在微软官网下载 Evergreen Runtime）。
- 授权：按包内 `LICENSE.txt` 分发（允许随应用再分发这些程序集）。

`whale-window.ps1` 通过 `Assembly::Load(byte[])` 加载这两个托管程序集，并把本目录加入
`PATH` 以便原生加载器 `WebView2Loader.dll` 被解析。

Redistribution was verified byte-for-byte against the official NuGet package above.
SHA-256:

```text
Microsoft.Web.WebView2.Core.dll d60e6e94245078cb56e44ebd5f360dc04bf18e460136be93bfc4cfca43b98505
Microsoft.Web.WebView2.Wpf.dll  f05a06bbc03afcb83dc98168b8d343d9015b2a533edbfac90c52d88894b653e4
WebView2Loader.dll             3426dcc55fdfb8b5e7ac623cf33b4ccf283fbf68a0c5a65bddfdb4d749a8abee
```
