# 安装、验证与回滚（0.2.4）

本插件的界面由透明辅助窗口承载，随 Codex 桌面应用自动启停；没有独立网页、浏览器面板或本地网页端口。

## 一、前置条件

- Windows 10/11 x64。
- Node.js **24 或更高**（`node -v` 可查）；首次安装桌面组件需要联网下载 Electron 44.3.0。
- 已安装 Codex 桌面应用（Microsoft Store 版 `OpenAI.Codex_*`，进程 `ChatGPT.exe` / `Codex.exe`）。
- 无需管理员权限；安装脚本不会调整执行策略或安全软件设置。

## 二、安装

1. 把压缩包内的 `api-balance-whale` 目录解压到 `%USERPROFILE%\plugins\api-balance-whale`（若该目录已存在，请先按第五节备份）。
2. 在该目录里运行 `node scripts\install-desktop.mjs`，等待 Electron 44.3.0 下载完成。
3. 运行 `node scripts\install-follow.ps1`（或在系统 Windows PowerShell 里执行同名 ps1），它会编译 GUI 启动器并注册当前用户的计划任务 `Codex API Balance Whale`。
4. 打开（或重开）Codex 桌面应用，小鲸鱼应自动出现，无需发消息或打开网页。
5. 在 Codex 中新建任务后，可以说“打开小鲸鱼”“查看当前 API 余额”。

压缩包里附带 `启动桌面挂件.cmd` 与 `停止挂件服务.cmd` 两个便捷入口；“安装桌面组件”“安装自动跟随”“停用自动跟随”三个 `.cmd` 未包含在发布包内，请按上面的 `node` 命令执行。

注册计划任务时若使用 PowerShell 7，脚本会自动转交系统 Windows PowerShell 执行；安装脚本会先验证任务与真实 GUI 进程父链，失败不会报告成功。

## 三、装完必须确认的四件事

1. **跟随**：拖动/缩放 Codex 窗口，鲸鱼跟着走；最小化 Codex 时鲸鱼隐藏，还原后回到原位。
2. **汇率说明**：点开菜单，`刷新汇率` 右侧有一个灰色圆形 **!**；点击后展开报价、日期、最近成功获取、最近检查与“每天 00:15 检查”说明；再点一次或按 `Esc` 关闭。
3. **失败／暂停提示**：让一轮任务失败或中途取消，气泡只显示中性的“上一轮期间 API 扣费（未成功/已暂停）:”与金额或“待记账/金额未知”，不再出现卖萌文案，也不播放成功音。
4. **服务商痕迹**：打开菜单 → API 设置，`余额接口` 等文字里不应出现任何特定服务商名称；余额仍按本机 Codex 配置查询。

辅助诊断文件（都在数据目录 `%USERPROFILE%\.codex\whale-widget`，不含密钥）：

- `follow-state.json`：`attached` 与 `nativeFollowing` 应为 `true`。
- `startup-timings.json`：`revision` 应为 `codex-0.2.4`。
- `renderer-gone.json`：仅在渲染进程崩溃过时出现，记录时间与原因。

## 四、停用

- `node scripts\uninstall-follow.ps1`：停止监视器与挂件并移除开机启动项，保留设置、素材和账本。
- `停止挂件服务.cmd`：只停止当前挂件进程。
- 托盘菜单“本次退出挂件（下次打开 Codex 恢复）”：只暂停当前这次 Codex 运行期间的挂件。

## 五、回滚

插件不修改 Codex 自身文件；回滚插件只需恢复插件目录并重启挂件。**用户数据目录 `%USERPROFILE%\.codex\whale-widget` 不在覆盖范围内**，设置、素材与账本会保留。

升级前请先备份整个插件目录：

```powershell
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = Join-Path $env:USERPROFILE "plugins-backup\api-balance-whale-$stamp"
New-Item -ItemType Directory -Force -Path $backup | Out-Null
Copy-Item -Path (Join-Path $env:USERPROFILE 'plugins\api-balance-whale\*') -Destination $backup -Recurse -Force
```

回滚（先用 `-CheckOnly` 核验，再实际执行）：

```powershell
& "$env:USERPROFILE\plugins\api-balance-whale\scripts\rollback-0.2.0.ps1" -CheckOnly -Backup $backup
& "$env:USERPROFILE\plugins\api-balance-whale\scripts\rollback-0.2.0.ps1" -Backup $backup
```

脚本只做三件事：核验备份完整性（`backup-manifest.sha256` 或逐文件 SHA-256）、停止正在运行的挂件、把备份目录覆盖回插件目录。它不会删除用户数据目录，也不会回退计划任务以外的任何系统设置。

也可以手工回滚：运行 `node scripts\control.mjs stop` 停掉挂件，把备份目录内容复制回插件目录，再打开 Codex。

## 六、常见问题

- **鲸鱼不出现**：先看 `%USERPROFILE%\.codex\whale-widget\follow-state.json` 是否存在且 `attached`/`nativeFollowing` 为 `true`；再确认计划任务 `Codex API Balance Whale` 处于“正在运行/就绪”，以及 `follow-config.json` 里的 `pluginRoot` 指向你解压的目录。
- **鲸鱼消失后不回来**：0.2.0 已加入每秒重断言与窗口 `restore` 事件重断言，正常情况下 1 秒内自行恢复；若仍复现，请保留 `follow-state.json` 与 `renderer-gone.json` 用于定位。
- **端口占用**：本插件不使用任何 TCP 端口，只使用本机命名管道 `\\.\pipe\codex-whale-*`。
- **汇率说明不见了**：说明现在收在 `刷新汇率` 右侧的 **!** 按钮里，点击才展开。
