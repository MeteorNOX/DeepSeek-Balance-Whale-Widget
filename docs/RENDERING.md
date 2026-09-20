# 渲染实现

技术栈：Electron 44.3.0 / Chromium 152，DOM + SVG + CSS 合成；插件版本前缀为 0.2.0。

`desktop/main.cjs` 在启动前启用 GPU 光栅化，在 `gpu-info-update` 后记录实际合成状态。透明无边框窗口交给 Chromium 进行预乘 Alpha 合成；不重复乘 Alpha，也不绕过显卡驱动限制。`render-status.json` 可用于确认本机是否实际启用硬件加速。

`desktop/ui/input.js` 只报告当前人偶、气泡和按钮的 DOM 命中矩形；macOS standalone 的 `desktop/standalone-main.cjs` 使用屏幕 DIP 光标与窗口 content bounds 在主进程决定 `setIgnoreMouseEvents`，不让 renderer 的 hover 消息反复切换透明窗口输入。悬停按钮不属于扩展 surface，只有真正打开菜单、弹窗或编辑面板才扩大原生窗口；扩大时通过受控 root offset 保持人偶屏幕锚点。按下后由 renderer 与主进程共同保持捕获，拖动阈值和窗口位移统一使用屏幕坐标，松开、取消、失焦或 renderer reload 都会清理手势。Windows `follow-main.cjs` 仍保留上游的兼容路径。

`desktop/ui/alpha-worker.js` 在 Worker 中用一个复用的 OffscreenCanvas 解码、读取 Alpha，结果只用于输入检测。缓存按资源 URL（含版本参数）区分，最多保留 8 项 / 8 MiB。动画角色使用帧 Alpha 的并集；超过 120 帧的导入角色采用完整图片矩形作为输入区域，限制一次性解码开销。视觉本身不受输入区域影响。

`desktop/ui/render.js` 的 `BubbleRenderer` 是双缓冲渲染类：两个持久 DOM 层，隐藏层生成完整内容，等待图片和字体就绪，再用 160 毫秒交叉淡入淡出呈现。旧内容不提前删除。`switching` 与递增 `epoch` 一起拒绝过期异步回调；关闭和场景抢占取消过渡。解码失败时保留上一完整画面。

`assets/whale-widget.js` 中的 `sceneOpen` 是唯一场景入口。`bubbleSnapshot` 克隆模块并一次性解析余额、今日用量和随机行；上次随机索引用 WeakMap 保存，界面重绘不修改用户配置。`refresh` 和用量回调仅更新数据，已显示气泡不因加载、成功或失败回调重新生成；下次打开或切换时使用最新数据。系统费用与提醒仍按原优先级进入独立场景。

镜像在鲸鱼根层使用原版 `transform .3s ease` 过渡，文本按相同时长反向镜像。命中检测读取当前矩阵，位置计算使用未压缩的尺寸。移动动画独立放在 `translate3d` 父层，按压动画保留在身体层。合成器自行呈现动画，JavaScript 不逐帧请求原生整窗重绘。

Windows 工具窗口标识把透明挂件排除在 Chromium 的宿主遮挡计算之外。保留正常激活，避免 `focusable:false` 导致首次鼠标按下被系统吞掉。金额显示换算使用独立状态和 DOM 文字绑定，重用气泡缓冲区前清除旧绑定；不会因切币而重抽随机行。详细说明见 `UI-CURRENCY-RESTART-VERIFY-ROLLBACK.md`。

界面状态保存改为内存缓存与异步合并写入，避免鼠标路径中的同步磁盘写入。窗口首次初始化读取一次配置；正常退出时等待最后一次保存。

回归入口：`node --test tests/*.test.mjs`；`node scripts/smoke-desktop.mjs <输出目录>`。完整桌面回归需用 `WHALE_TEST_PYTHON` 指定本机 Python，以读取 Win32 标志和点击经过身份校验的测试窗口。桌面测试使用隔离的虚构余额，不读取真实 API 凭据。`WHALE_TEST_SCALE=1/1.25/1.5/2` 可分别测试显示缩放；`WHALE_RENDER_GRAPHICS_ONLY=1` 只运行图形相关检查。

气泡图片解码失败、慢解码和快速取消由测试注入；点击、拖动、窗口显隐、帧截图和透明区域穿透使用实际 Electron 窗口。帧截图能检查 Chromium 输出，仍需在实际显示器上复核最终桌面合成结果。
