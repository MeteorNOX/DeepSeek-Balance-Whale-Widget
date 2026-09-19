# DSH 小鲸鱼记账挂件（DeepSeek Balance Whale Widget）

![DSH 小鲸鱼记账挂件](assets/DSH2.png)

DeepSeek Harness（DSH）Web 界面右下角的常驻挂件：小鲸鱼气泡图 + DeepSeek API 余额 + 今日已用 + 每轮对话消耗，并且**泡泡内容可以完全自定义**（点击序列、模块化排版、并列加权出泡、随机语句/随机图片）。标准 DSH bundle 插件，`dsh plugin` 一键安装，无需任何会话令牌。

## 两条分支怎么选

本仓库有两条**互不兼容**的产品线，按你要挂在哪里选一条：

| 你要挂在哪 | 用哪条分支 | 安装方式 |
|---|---|---|
| **DSH Web 界面右下角**（就是这个 README 描述的插件） | `main`（默认分支） | `dsh plugin --profile web add dsh-whale-widget`（推荐，装 npm 已发布版）；也可以从本仓库装 `dsh plugin --profile web add github:MeteorNOX/DeepSeek-Balance-Whale-Widget`，但那样装的是 **main 当前状态、不跟随已发布版本** |
| **Codex 桌面应用**（跟随 Codex 窗口、无独立网页） | [`For-Codex`](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/tree/For-Codex) | 该分支的 `api-balance-whale`：解压到 `%USERPROFILE%\plugins\api-balance-whale`，再按分支内的 [安装说明](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/blob/For-Codex/docs/INSTALL-AND-ROLLBACK-0.2.0.md) 注册计划任务（也可以直接交给 Codex 自己装喵~） |

⚠️ **两条分支互不兼容**：`For-Codex` 的插件不能用 `dsh plugin … add` 装进 DSH 网页；本主分支的插件也不能在 Codex 桌面里运行。上表第一行是本仓库默认分支（`main`）的能力，第二行是另一个分支的能力。

⚠️ 同一分支的两种安装方式（npm 名 / `github:`）**二选一、别混用** —— 它们是同一个包名，先后安装会并存冲突；已经是 `github:` 装的，要换 npm 名请先 `dsh plugin --profile web remove dsh-whale-widget`。

> 两条产品线**各自独立维护**（无共享代码/无跨分支依赖）：`main` = DSH Web 插件，`For-Codex` = Codex 桌面端口，各自的版本线、发布方式与测试互不影响。

## 特性

### 记账与显示

- 🐋 **常驻自启**：随 DSH Web 界面每次打开自动出现（标准 DSH bundle 插件）
- 💰 **余额**：60 秒自动刷新 + 点击鲸鱼手动刷新；余额变化时数字**滚动动画**；瞬时网络抖动自动沿用最近余额不报错
- 📊 **今日已用（小鲸鱼记账）**：不需要任何令牌。余额**下降**按观测累计为消费，余额**上升**（充值 / 赠金）单独记录、不会冲掉已有消费；检测到余额增加会提示「待核对余额调整」，可在「小鲸鱼记账 → **DeepSeek（内置）→ 设置 → 余额校正**」按实际累计到账金额与非调用扣减校正 —— **「已观测消费」与「余额校正」都是 DeepSeek 账户口径**（由该 API key 的余额观测得出，不含其它厂商；「本机模型费用」才是所有模型的本地估算）（逐轮明细保留 90 天或最多 2 万条、逐日归档保留 365 天，超期数据归档到 `.dshw-usage-archive.json`）；金额按 8 位小数记账、显示保留两位
- 💬 **每轮对话消耗**：监听 DSH 本机会话事件，按模型**真实 usage**（input / cache / output / reasoning tokens）换算金额，每轮结束弹出消耗泡泡；可开关、自动关闭秒数可设（0 = 不自动关闭），**泡泡内容可自定义**（模块化，金额用 `{cost}` 引用），入口：菜单 → 每轮消耗提示 → 「自定义提示」
- ⛰️ **峰谷定价**：工作日高峰 9:00–12:00、14:00–18:00（北京时间），其余空闲；2026-08-23 起**周末全天谷价**。峰谷模块支持状态文字、倒计时、"梁文峰谷 / !?强强?! / 简洁"等多种样式
- 📒 **用量记录窗口**：今日模型消费、近 7 天、全部记录；模型占比条；按日期展开逐条明细（含时间与金额）；支持按日期或**模型名搜索**；模型名带友好标注（`deepseek-flash` → `DeepSeek-V4.1-Flash`，旧名标注"同 V4.1 Flash"）

### 交互

- 🖱️ **拖拽 + 吸附**：四边吸附区可自定义（按比例或像素），角落可组合；可关闭吸附自由摆放
- 🔄 贴左吸附时整体**水平镜像翻转**（文字同步反向、带动画）
- 🧸 **按压 Q 弹**玩偶效果（按压时底部坐标不变）
- 🎚️ **主菜单**：大小滑块、音效开关/音量、峰值文案、泡泡开关、每轮消耗开关 + 「自定义提示」（每轮消耗内容 / 自动关闭秒数 / 任务结束音效）、吸附设置、角色/资源管理、自定义泡泡、余额预警、今日预算
- 🙈 **可隐藏菜单按钮**：隐藏后，电脑端**右键鲸鱼**、手机端**长按鲸鱼约 1.5 秒**唤出菜单
- 📱 **移动端友好**：鲸鱼可触摸拖动（自研触摸接管，不会把页面手势判成滚动导致拖不动）；泡泡编辑器支持**长按 0.4 秒进入拖拽排序**；去掉了浏览器默认的点击高亮方块

### 泡泡系统（核心）

- 💬 **点击序列**：第一次点击显示"首次点击泡"，再点进入"再次点击"队列；队列可任意增删排序，还能把两泡**并列为 A/B 加权选择**（每轮按权重抽一个）
- 🔁 **点按角色推进队列**（可选，在「自定义泡泡」窗口里开）：开启后**点一下角色＝往后推进一项**（第 1→2→3…，走到最后一项再点收起泡泡，下次点按从第 1 项重新开始）；关闭时是原来的行为 —— 点角色回到"首次点击泡"。设置只在这个窗口里，随窗口的「保存」一起生效
- 🧩 **模块化内容**：一个泡泡由若干模块按行组成，支持类型
  - 文本、超链接
  - **随机语句**（多条句子带权重，每次显示抽 1 条且不连续重复）
  - **图片/动图**（从泡泡图库选，独占一整行）
  - **随机图片**（多张图带权重，抽 1 张且不连续重复，同样独占一行）
  - 余额数值、今日已用、峰谷时段（内置数值，内容自动获取，可调占位符与样式）
- 🎨 **逐模块样式**：字体（含自定义字体）、字号、加粗/斜体/下划线、纯色或**跑马灯渐变**配色、底色；文本与随机语句支持悬浮快捷编辑
- 🖐️ **拖拽排版**：桌面端原生拖拽、移动端长按拖拽；模块可并入某行首/尾、可拆行、整行可排序；**每行最多 6 个模块、泡泡最多 6 行**，图片类模块独占一行且一个泡泡只允许一个
- 📚 **模块库**：把常用模块"另存"进库，之后在任意泡泡里点击或拖入复用

### 提醒

- 🔔 **余额预警**：余额低于设定值时弹提醒，内容可编辑（含图片/随机图片模块）
- 💸 **今日预算**：今日已用达到设定金额时弹提醒，内容同样可编辑
- 💬 **每轮消耗提示**：一轮对话结束后弹消耗泡泡，内容同样可编辑（模块化，金额用 `{cost}`）；内容、自动关闭秒数与**任务结束音效**都在菜单 → 每轮消耗提示 → 「自定义提示」里设置
- 三者都支持自动关闭秒数设置；气泡模式不可用时自动退化为居中卡片（卡片内也会渲染图片模块）

### 音效 / 角色 / 图片

- 🔊 **按压 & 松开音效**：内置「小黄鸭」「音效1」两套预置；也可导入音频片段并自由组合成**自定义音效组**（槽位可留空 = 该事件静音）
- 🎵 **任务结束音**：一轮回复完成时播放；内置两个预设音效 —— 默认 **Minecraft·经验球**（`assets/minecraft-exp-orb.wav`）与 **A**（`assets/task-end-a.wav`），也可选任意片段或音效组
- ✂️ **音频片段管理**：导入时可视化裁剪、试听；资源管理窗口统一查看/试听/删除
- 🐳 **自定义角色**：上传自己的鲸鱼图片（图库管理，可回退默认）
- 🖼️ **泡泡图库**：内置 `petpet`、`money1` 两张图，也可上传 png/gif，供图片/随机图片模块使用

### 戳一戳（petpet）与彩蛋动画

- 👆 **两段式:按下定格、松开才播**：鼠标 / 手指在角色上**一按下**，素材图层先出现并**定格在第 1 帧**（GIF 也一并冻住 —— 定格是把画面画到 canvas 上实现的，因为 `<img>` 里的 GIF 没有暂停 API），**松开**才从第 1 帧开始播；按住不放不会有任何新动作，松开后重新武装。泡泡仍走「松开且没拖动」判定，所以拖动不会误弹泡泡。（彩蛋同样是两段式：按下只把铁砧摆出来，松开才下坠）<br>
  **开关**：设置 → 戳一戳 → 「**按下定格**」。关掉就回到「按下立刻播」，试播按钮一直是立刻播。
- 🧩 **素材完全自定义**：素材库支持上传 png / gif / webp / apng（≤ 8 MB），内置 1 个（经典拍头） + 自己的随便加；素材文件放 `$DSH_HOME/whale-pet/`
- 🎛️ **大小 / 位置可调**：素材图层的 X / Y / 缩放 / 旋转 / 透明度，**锚点**可选「角色区域」或「整个挂件」
- 🎯 **基准落点**：滑块调的是**相对基准落点的偏移**，出厂就已调好（代码里的 PET_POS_BASE，当前 -3% / -12% 的视觉效果即基准 = 滑块 0/0）；窗口里有「**归零（回到基准）**」一键还原
- 🖼️ **两种显示方式**：默认 **叠加** —— 素材直接盖在角色当前所在区域上（滑块 0/0 就正好覆盖角色）；也可切 **合成** —— 把当前角色图按 .dshwv-img 的 contain + 右下对齐**画进素材框**，角色本身再单独缩放/偏移
- 🎞️ **动画脚本可选择 / 可添加**：
  - 内置 5 条：跟随素材（GIF 自播放 + 轻 Q 弹）、拍击、抖动、弹跳、旋转
  - 自定义脚本用 **受限 JSON DSL** 写，5 条轨道 `x / y / scale / rotate / opacity`，每条二选一：
    **关键帧** `{"k":[[0,0],[0.5,-6],[1,0]]}`（时间 0~1 线性插值）或 **表达式** `{"expr":"sin(t*PI*6)*6"}`；
    表达式可用 `t`（0~1 单圈进度）、`c`（第几圈）、`PI`、`sin cos tan abs floor ceil round sqrt sign min max pow clamp` 与 `+ - * / %`、比较、`&& || ?:`
  - 编辑器带语法校验：写错的轨道/表达式会被拦下并给出原因，不会写坏配置
  - **刻意不使用 `eval` / `new Function`** —— 这份配置能通过 HTTP 写进来，只解释白名单语法，不放行任意 JS
  - **随机播放**：勾上后每次触发都从「内置 5 条 + 你的自定义脚本」里随机抽一条（不再固定用下拉那条）；窗口里会显示本次抽到哪条，「编辑 / 删除」也是针对那一条。常规戳一戳专用，彩蛋走自己的动画档位
- 👀 **窗口内实时预览**：设置窗口里挂着一个 150×150 的预览台，用与正式播放**完全相同**的几何与脚本求值，拖滑块立刻能看到效果
- 🥚 **彩蛋动画（默认 1% 概率）**：点角色时按概率触发，完整动作 ——<br>
  （彩蛋**防打断**：运行期间按角色会被彻底吞掉 —— 不重掷彩蛋、也不让戳一戳盖上来；同时**临时屏蔽挂件自带的「按压 Q 弹」压扁**与**按压 / 松开音效**，否则那个形变作用在 `body` 上、彩蛋的压扁作用在 `img` 上，两层叠起来会把「按铁砧位置同步压扁」的时序搅乱）
  ① **按下只把铁砧摆出来**（悬在挂件上方，时间轴一帧不跑），**松手**才开始下坠（设置 → 彩蛋 → 「**按下定格**」可关掉，关掉＝按下即整段播）；铁砧从上方砸下，**底边越过小鲸鱼头顶之后**才开始随铁砧深度同步压扁（没到头顶不会压，且**只压缩、不回弹**，命中后一直保持压到底） → ② 命中：屏幕抖动 + WebAudio 合成的铁砧闷响 + **小鲸鱼变红** →
  ③ **短暂消失** → ④ **烟雾 + 爆装备同时触发**：同一刻炸出 MC 烟雾粒子（原版 `particle/generic_0..7` 八帧逐帧播放）和装备 ——
  ⑤ 装备斜着炸出去后受重力**落到窗口底部**（左右也夹在窗口内，下落段约 0.4s），落地后原地**绕竖轴缓慢旋转**几圈 + **上下轻微浮动** →
  ⑥ 过几秒**复原**（褪红 + 淡回 + 压扁归位 + 装备淡出）
- 🔧 **彩蛋可调**：开关、**按下定格**（按下只出铁砧 / 按下即整段播）、**落体素材**（默认「**不锈钢盆**」，另有原版 Minecraft 铁砧可选，也能自己上传）、**触发概率**（0~100%，默认 1%）、**动画 4 档** —— 完整铁砧 / 铁砧·不爆装备 / 无铁砧·爆装备 / 无铁砧·不爆装备（也可选自定义脚本驱动铁砧轨迹），铁砧素材 + 缩放 / 位置、**烟雾素材 + 数量**、经验球素材 + 数量（默认 0）、装备素材（多选）+ 数量、屏幕抖动、音效（只有 WebAudio 现场合成的铁砧闷响，**不带经验球那段音效**）
- ⚖️ **触发优先级**：一次点击只播一个动画 —— 先掷彩蛋，中则走彩蛋，否则走戳一戳；**泡泡照旧弹出**，两者互不干扰
- 🎨 **内置落体 / 粒子 / 装备素材**：默认落体是「**不锈钢盆**」（用户提供的 AI 生成图，已抠图去底，见 `PROVENANCE.md`），另有 **Minecraft 原版**资源可选 —— 铁砧 = 原版背包图标渲染图、经验球 = `entity/experience_orb.png`、烟雾 = `particle/generic_0..7.png`、装备 = `item/*.png`（这些由 `tools/gen-fx-assets.py` 自动下载原版贴图后**只做最近邻放大 / 裁切**，没有任何手绘改画）。**注意版权**：MC 素材归 Mojang，不在 MIT 覆盖范围内，详见 `PROVENANCE.md` 第三节五。

### 自定义 API（多厂商余额 / 额度）

除内置的 DeepSeek 余额外，可在「小鲸鱼记账 → 模型」里添加任意厂商；每个模型独立配置余额预警 / 今日预算 / 额度：

- 🧩 **厂商模板（34 个，选完自动带好凭据名 / 币种 / 接口 / 字段路径 / 事件匹配 / 探活地址）**：
  - **可直接查到余额或额度**：DeepSeek（内置）、OpenRouter、Kimi / Moonshot（CN / 国际）、阶跃星辰 StepFun、Novita、智谱 GLM Coding Plan（国内 / 国际 z.ai）、Kimi Coding、MiniMax Coding（国内 / 国际）、**OpenCode Go（订阅，5h / 周 / 月三窗口）**、OpenAI 兼容中转站（OneAPI / New API）
  - **官方没有「用 API key 查余额」的接口**（下拉里标注「（无余额接口）」，选完会用 `probeUrl` 探活验证 key，余额显示「—」，今日已用按会话事件估算）：硅基流动（CN / EN）、火山方舟 Ark、OpenAI、Anthropic Claude、Google Gemini、xAI Grok、Groq、Mistral AI、Together AI、Fireworks AI、DeepInfra、Cerebras、阿里云百炼（通义千问）、百度千帆（文心）、腾讯混元、讯飞星火、魔搭 ModelScope、本地模型（Ollama / LM Studio）
  - **全手填**：自定义 HTTP（URL 与字段路径自己写）、Codex（本地会话，无需接口）
- 🔑 **密钥不落配置**：密钥写入 DSH 官方凭据服务，配置文件里只存**凭据名**（如 `OPENROUTER_API_KEY`）；删除模型会连带清理该模型的额度模块与设置
- 💰 **余额**：按模板的接口与 JSON 字段路径读取（支持 `a.b[0].c` 与 `scale` 乘数）；点「测试连通性」可先验证 key
- 📉 **今日已用**：有余额接口时记录观测到的**下降额**（当天首次观测为统计起点，充值等增加额不会冲掉消费），无余额接口的厂商显示本机会话**估算**
- 🎯 **额度（订阅 / 资源包）**：填总量即可，已用**按 DSH 会话 token 自动累计**（口径 `input + cacheRead + output`，推理 token 已含在 output 内，跨天保留），也可切换手动填写；支持「不重置 / 每日 / 每月」
- 🧾 **订阅额度接口（`kind:'quota'` 模板）**：直接读厂商官方接口的「窗口已用% + 重置时间」，与上面按会话统计的额度互补。**支持一个接口返回多个窗口**（目前 OpenCode Go 为 5h / 周 / 月三窗口），逐窗口展示已用百分比与各自的紧凑重置倒计时；模板用 `quota.json.windows` 描述各窗口的字段路径
- 💱 **单价（可选）**：位置在「密钥 / 接口」面板 → 展开「接口与字段（高级）」→「单价（可选）」。每个模型可自填单价 —— **缓存命中 / 未命中输入 / 输出**，单位是「币种 / 百万 token」；币种支持人民币（CNY）与美元（USD），**选美元时必须填汇率（元/USD）**；记账与账本**统一按人民币结算**（美元单价会按汇率折算）；单价**不分峰谷**（两个时段同价）。留空则沿用内置价目表（DeepSeek flash / pro）。注意：**内置 DeepSeek 不支持自定义单价**（始终用内置峰谷价）；额度单位选「金额（元）」时，已用**只能手动填写**
- 🫧 **泡泡模块**：每个模型自动获得「余额·<模型名>」与「额度·<模型名>」两个模块，占位符 `{balance}`、`{today}`、`{quota}`、`{quota_used}`、`{quota_left}`、`{quota_total}`、`{quota_reset}`

> 说明：并非所有厂商都提供「用 API key 查余额」的接口。**硅基流动**的余额接口已被官方下线（[2026-08-11 更新公告](https://api-docs.siliconflow.cn/docs/release-notes/overview)：`/user/info` 自 **2026-08-14** 起停止服务，「后续将适时提供替代 API」，截至发版仍未见替代接口），**火山方舟**的余额 / 用量与**阿里云百炼 / 百度千帆 / 腾讯混元**一样属于各家云平台 AK/SK 签名的 OpenAPI，**OpenAI / Anthropic / Gemini / xAI / Groq / Mistral / Together / Fireworks / DeepInfra / Cerebras** 则根本没有公开的余额查询接口 —— 这些模板统一是「无余额接口 + 探活验证 key」，今日已用按会话事件估算。厂商的**订阅额度**接口（智谱 / Kimi Coding / MiniMax Coding / OpenCode Go）只对订阅套餐账号有效：Token 资源包账号调用智谱接口会返回「当前用户不存在coding plan」，这种情况请用上面的「额度（订阅 / 资源包）」自动统计。
>
> 模板只提供**默认值**：选完模板后可以随意改写接口地址与字段路径；留空的字段会**继续沿用模板默认值**（不会因为留空而失效）。

### Codex 模式（本地会话统计）

> ⚠️ **限制**：Codex 支持目前只是**部分接口适配**，本挂件**不能安装到 Codex 里**（它是 DSH Web 插件，Codex 仅作为数据来源被读取）；订阅窗口没有真实订阅样本可验证，遇异常欢迎反馈。

挂件可以直接读本机 Codex 的会话日志统计 token 用量 —— 因此**不限于 DSH 内部**，你在 Codex CLI / 桌面版里跑的消耗也能看到。

- 📂 **数据来源**：`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl`（含 `archived_sessions/`），明文 JSONL；只读本机文件、**不联网、不需要密钥**，也不会写入 `~/.codex`
- 📈 **统计口径**：优先用日志里累计量（`total_token_usage`）的**差值**累加，天然避免同一轮多条记录被重复计数；模型归属由 `turn_context.payload.model` 判定；按天 + 模型聚合，带增量缓存（`$DSH_HOME/.dshw-codex.json`，只存聚合与文件偏移）
- 🖥️ **显示**：模型列表显示 `Codex 今日 x · 近7天 y tokens`；模型子菜单显示今日 / 本月 / 累计 / 近7天与会话文件数；「测试」按钮直接返回本地统计
- 🎯 **额度**：该模型的「额度」里，已用来源可选 **Codex 本地会话 token**（不重置＝累计−基准、每日＝今日、每月＝本月），复用同一套展示与泡泡模块
- 🪟 **订阅窗口（5h / 周）**：日志里的 `rate_limits` 带窗口快照，有 ChatGPT 订阅时子菜单自动追加 `5h 已用 x% · 2小时30分后重置 | 周 已用 y% · 3天后重置`（字段名已做容错；API-key 计费或无订阅时该行不显示）

## 目录结构

```text
dsh-whale-widget/
├── package.json              # DSH bundle 插件元数据（dsh.bundle.patch 指向 cordis.patch.yml）
├── README.md                 # 本文件
├── cordis.patch.yml          # 插件挂载声明
├── lib/
│   ├── index.js              # 宿主侧插件本体（路由 + 记账 + 音效/图片/角色服务）
│   └── accounting.mjs        # 记账内核（定点金额运算 + 余额观测/校正账本）
├── assets/
│   ├── whale-widget.js       # 前端挂件本体（由宿主按 mtime 热读取）
│   ├── DSH2.png              # README 顶部展示图
│   ├── DSniang1.png          # 小鲸鱼本体（cut-out，气泡由代码绘制）
│   ├── DSniang02.png         # 备用整图（兼容旧版手动安装路径）
│   ├── rua.gif               # 随机台词/撒娇动图（可选）
│   ├── Ya1.mp3 / Ya2.mp3     # 预置音效「小黄鸭」按压 / 松开
│   ├── D1.mp3 / D2.mp3       # 预置音效「音效1」按压 / 松开
│   ├── minecraft-exp-orb.wav # 任务结束音内置默认音效（Minecraft·经验球）
│   ├── task-end-a.wav        # 任务结束音内置预设（A）
│   ├── bubble-petpet.gif     # 内置泡泡图：petpet
│   └── bubble-money1.gif     # 内置泡泡图：money1（余额预警默认内容的配图）
├── petpet-template.gif       # 内置戳一戳素材：经典拍头（手，112×112 十帧）
├── fx-basin.png              # 彩蛋：不锈钢盆（默认落体素材，抠图去底）
├── fx-anvil.png              # 彩蛋：Minecraft 铁砧（像素风）
├── fx-exp-orb.png            # 彩蛋：经验球
├── fx-smoke.png              # 彩蛋：MC 烟雾粒子（原版 generic_0..7 八帧精灵表）
├── fx-item-*.png             # 彩蛋：装备（钻石剑 / 钻石镐 / 金苹果 / 金锭 / 绿宝石）
└── whale-widget-prompt.md    # 完整规格/维护提示词（面向二次开发）
```

运行时数据（都放在 `$DSH_HOME`，默认 `~/.dsh`；本机开发环境为 `D:\TestBox\deepseek\`）：

| 文件 / 目录 | 用途 |
|---|---|
| `.dshw-size.json` | 挂件外观与开关（缩放、音量、音效组、峰值样式、吸附相关等） |
| `.dshw-usage.json` | 记账账本 + 按日余额观测/校正摘要 + 用量设置（任务结束音、余额预警、今日预算、每轮消耗提示内容） |
| `.dshw-usage.json.before-recharge-fix.bak` | 旧格式账本备份（0.3.1 首次写入旧账本前自动创建；已存在则不覆盖） |
| `.dshw-turn.json` | 每轮消耗的 seq（避免热重载后前端把新轮次当旧轮次） |
| `.dshw-bubble.json` | 自定义泡泡配置（点击序列 + 模块库 + 点按角色推进队列开关） |
| `.dshw-api.json` | 自定义 API 模型注册表（厂商 / 凭据名 / 接口字段 / 自定义单价 / 额度与用量累计；**不含密钥**） |
| `.dshw-usage-archive.json` | 账本归档（超过保留期的逐轮明细与逐日汇总；明细 90 天/2 万条、逐日 365 天） |
| `.dshw-codex.json` | Codex 本地会话统计缓存（按天/模型聚合 + 文件偏移；**不含任何凭据**） |
| `whale-roles/` | 自定义角色图 + `roles.json` 索引 |
| `whale-audio/` | 音频片段 `<id>.wav` + `audio.json` 索引（音效组/片段） |
| `whale-bubble-imgs/` | 泡泡图库图片 + `bubble-imgs.json` 索引 |
| `.dshw-pet.json` | 戳一戳 / 彩蛋设置（开关、触发概率、素材 id、大小位置、自定义动画脚本） |
| `whale-pet/` | 戳一戳与彩蛋的自定义素材 `<id>.<ext>` + `assets.json` 索引 |

## ⚠️ 本地补丁说明（0.3.5 + 戳一戳/彩蛋）

当前这份 `assets/` + `lib/` 是**在 npm 包 `dsh-whale-widget@0.3.5` 基础上就地打补丁**的版本，
新增了「戳一戳（petpet）」与「Minecraft 铁砧彩蛋」。与官方 npm 包的区别：

| 文件 | 变化 |
|---|---|
| `lib/index.js` | 新增 `/dsh-whale/pet.json`、`/dsh-whale/pet-assets.json`、`/dsh-whale/pet-asset.png` 三条路由与 `.dshw-pet.json` / `whale-pet/` 的读写 |
| `assets/whale-widget.js` | 新增受限脚本 DSL、petpet 图层与播放引擎、彩蛋引擎、两个设置窗口与预览台 |
| `assets/petpet-template.gif`、`assets/fx-*.png`（含 `fx-smoke.png`）、`assets/fx-basin.png` | 新增内置素材（fx-* 里除不锈钢盆外均为 MC 原版） |
| `tools/gen-fx-assets.py` | 彩蛋像素素材的生成脚本（可复现） |

### 与上游合并的记录

本版以 **0.3.2 原始包**为共同祖先做三方合并（上游 0.3.3 / 0.3.4 / 0.3.5 的改动 + 本补丁）：

- `lib/index.js`、`README.md`、`package.json`：**自动合并干净，0 冲突**
- `assets/whale-widget.js`：仅文件尾 **1 处冲突** —— 上游把末尾的「DOM 守护（issue #102）」重构为
  `dshwTryStart()` 主界面检测 + 新的 `dshwReattachRoot()`（还会补挂菜单浮层），而本补丁的 v800 整块插在
  同一个初始化函数的末尾。**解决方式：采用上游的新尾部结构，把本补丁整块插进去、丢掉被上游搬走的旧守卫** ——
  那段功能由上游的新实现完整覆盖，没有丢东西。
- 校验：上游相对 0.3.2 的 **234 行新增全部存在于合并结果里**；全树 md5 比对确认只有这 4 个文件有差异，无新增/删除文件。
- 上游 0.3.3 ~ 0.3.5 带来的修复：Android 触摸 / 长按、右键菜单不再被 5 秒闸门卡住、挂件隐藏或缩小时设置不生效、
  DOM 守护（PR #105），以及**把按压 / 松开音从 `new Audio()` 换成 WebAudio shim**（不再弹系统媒体条、更顺）。

**生效方式**：`assets/whale-widget.js` 由宿主按 mtime 热读取 —— 改完**硬刷新页面**即生效；
但 `lib/index.js`（新增的三条路由）**必须重启 DSH 或重载该插件**才会注册，否则挂件会提示「设置读取失败」。

**注意**：用 `dsh plugin update` / 重新 `add dsh-whale-widget@x` 会把 npm 包重新解包，**覆盖掉本补丁**。
想长期保留，建议把这份目录放到一个固定位置，并改成链接安装：

```powershell
dsh plugin --profile web add link:<这份目录的绝对路径>
```

## 安装

### 方式 A：已有本插件的完整资源包（本地目录 / 压缩包）（推荐）

适用于别人直接发给你一个 zip，或你手上已有一份解压好的插件目录（目录里应有 `package.json`、`cordis.patch.yml`、`lib/`、`assets/`、`README.md`）。

```powershell
# 1) 若是 zip：先解压到一个固定、以后不会移动或删除的目录（不要放临时目录/下载目录）
#    例：D:\Plugins\dsh-whale-widget
#    要安装的是「包含 package.json 的那一层」，不要多套一层同名目录

# 2) 确认关键文件都在（缺 assets/ 会导致没图、没声）
Test-Path "D:\Plugins\dsh-whale-widget\package.json",
          "D:\Plugins\dsh-whale-widget\lib\index.js",
          "D:\Plugins\dsh-whale-widget\assets\whale-widget.js"

# 3) 如果之前从 GitHub / npm 装过同名插件，先卸载避免版本冲突
dsh plugin --profile web remove dsh-whale-widget

# 4) 用绝对路径安装（路径含空格要加引号）
dsh plugin --profile web add link:D:\Plugins\dsh-whale-widget
```

说明：

- `link:` 是**软链安装**：源目录里的文件改了立即生效；但安装后**不能移动/重命名该目录**，移动了要重新 add 一次
- 想改用拷贝安装：`dsh plugin --profile web add file:D:\Plugins\dsh-whale-widget`（此后源目录再改不会同步，需重新 add）
- 资源包自带 `assets/minecraft-exp-orb.wav`、`assets/task-end-a.wav` 等内置资源；**删掉 assets 里的文件会让对应功能静默降级**（无图/无声）
- 装完同样要重启 `dsh web`，再 F5 刷新浏览器

### 方式 B：直接从 GitHub 安装

无需本地克隆，一条命令安装：

```powershell
dsh plugin --profile web add github:MeteorNOX/DeepSeek-Balance-Whale-Widget
```

说明：

- 装完后插件会出现在 DSH 的**插件管理页面**里，之后可以直接在页面里更新，无需再手动执行命令
- 网络环境需要代理时，先设置代理环境变量再执行：
  ```powershell
  $env:http_proxy="http://<ip>:<port>"; $env:https_proxy="http://<ip>:<port>"; $env:all_proxy="socks5://<ip>:<port>"; dsh plugin --profile web add github:MeteorNOX/DeepSeek-Balance-Whale-Widget
  ```
- 安装完成后重启 `dsh web`，再 F5 刷新浏览器

### 方式 C：本地安装（从当前仓库）

在**仓库根目录**（`package.json` 所在目录）执行：

```powershell
dsh plugin --profile web add link:.
```

说明：

- `dsh plugin` 会把参数转发给 pnpm，并在成功后自动把 `dsh-whale-widget` 加入 `dsh.profile.bundles`
- **`link:.` 表示链接当前目录**（仓库根目录本身就是插件包）。如果仓库在别处，用绝对路径：
  ```powershell
  dsh plugin --profile web add link:D:\你的路径\DeepSeek-Balance-Whale-Widget
  ```
- ⚠️ 不要用 `link:.\dsh-whale-widget`——仓库里**没有** `dsh-whale-widget/` 子目录，这样会安装成普通依赖而非插件
- 安装完成后重启 `dsh web`，再 F5 刷新浏览器
- **移动了源码目录**后必须重新执行一次 `add link:<新路径>`；若提示冲突，先 `dsh plugin --profile web remove dsh-whale-widget` 再 add

### 方式 D：发布到 npm 后安装

```powershell
dsh plugin --profile web add dsh-whale-widget
```

### 给 AI 的安装说明（直接复制给 AI 助手）

```
请帮我安装插件 dsh-whale-widget。可能的来源有两种：GitHub 仓库
MeteorNOX/DeepSeek-Balance-Whale-Widget，或者我本地已经有这个插件的「完整资源包」。

步骤：
1. 确保 pnpm 可用（没有就先：npm install -g pnpm）
2. 在 Web profile 安装（按我实际拿到的来源任选一种）：

   【来源一：从 GitHub 安装】
     dsh plugin --profile web add github:MeteorNOX/DeepSeek-Balance-Whale-Widget
   或从本地 git 仓库链接安装：
     dsh plugin --profile web add link:<仓库绝对路径>
   （注意：仓库根目录就是插件包，不要写成 link:.\dsh-whale-widget 这种带子目录的路径）

   【来源二：我本地已有完整资源包（zip 或已解压目录）】
   先确认「完整资源包」长什么样：一个目录，里面应当有
     package.json、cordis.patch.yml、lib/index.js、
     assets/（含 whale-widget.js、DSniang1.png、Ya1.mp3、minecraft-exp-orb.wav、task-end-a.wav 等）、README.md
   然后按下面做：
   a) 如果给我的是 zip：先解压到一个**固定、以后不会移动或删除**的目录，例如
        D:\Plugins\dsh-whale-widget
      不要解压到临时目录/下载目录/会被清理的位置；也不要多套一层——
      要安装的是**包含 package.json 的那一层**，不是外面那个同名压缩包目录
   b) 检查文件完整性（任意一条 False 就先告诉我，不要继续装）：
        Test-Path "<资源包目录>\package.json"
        Test-Path "<资源包目录>\lib\index.js"
        Test-Path "<资源包目录>\assets\whale-widget.js"
      并确认 package.json 里 name 是 dsh-whale-widget、带 dsh.bundle.patch 字段
   c) 如果之前从 GitHub / npm 装过同名插件，先卸载避免版本冲突：
        dsh plugin --profile web remove dsh-whale-widget
   d) 用**绝对路径**安装（路径含空格要加引号）：
        dsh plugin --profile web add link:<资源包目录>
      link: 是软链安装：源目录改了立即生效，但安装后不能移动/重命名该目录；
      移动后必须重新执行一次 add。若想按拷贝安装可用：
        dsh plugin --profile web add file:<资源包目录>
      （file: 以后源目录改动不会同步，需要重新 add）

3. 如果报 pnpm 阻止构建脚本（allowBuilds 相关），在 ~/.dsh/profiles/web/pnpm-workspace.yaml 的
   allowBuilds 下加对应 key，然后重跑
4. 重启 dsh web，然后 F5 刷新浏览器

安装后验证：
- dsh --profile web --dump-config 应该能看到 dsh-whale-widget 在 bundles 里
- curl http://127.0.0.1:3080/dsh-whale/balance.json 应返回 200 JSON（含 totalBalance）
- curl http://127.0.0.1:3080/dsh-whale/widget.js 应返回 200 JS
- curl "http://127.0.0.1:3080/dsh-whale/audio-fragment.wav?id=exp_orb" 应返回 200 audio/wav
- curl "http://127.0.0.1:3080/dsh-whale/audio-fragment.wav?id=end_a" 也应返回 200 audio/wav
  （用来确认资源包里的内置音效已随包就位；若是 404 说明 assets/ 不完整）

另外请检查 DSH 凭据里是否配置了 DEEPSEEK_API_KEY（没有就提示用户配置）。
```

## 凭据（安装后必读）

只需一个凭据：

- **`DEEPSEEK_API_KEY`（必需）**：DeepSeek API 密钥，用于拉取余额（`GET https://api.deepseek.com/user/balance`）。在 DSH 凭据服务里配置（凭据管理界面 / `.dsh/.credentials.yaml`）。

> **不需要** `DEEPSEEK_PLATFORM_TOKEN`。早期版本的"实时·令牌"模式已下线，今日已用统一由**小鲸鱼记账**（余额差 + 会话事件）计算，零令牌开箱即用。

添加自定义模型时，还会按需用到各自厂商的凭据名（都可不配，用到哪个配哪个）：

| 凭据名 | 用途 |
|---|---|
| `OPENROUTER_API_KEY` | OpenRouter 余额（`/api/v1/credits`） |
| `MOONSHOT_API_KEY` | Kimi / Moonshot 大陆站余额（人民币） |
| `MOONSHOT_INTL_API_KEY` | Kimi / Moonshot 国际站余额（美元，独立账号体系） |
| `SILICONFLOW_API_KEY` | 硅基流动 `/v1/models` 探活 |
| `ARK_API_KEY` | 火山方舟 `/api/v3/models` 探活 |
| `ZHIPU_API_KEY` | 智谱（订阅额度接口 / Coding 端点） |
| `OPENCODE_GO_API_KEY` | OpenCode Go 订阅额度（`opencode.ai/zen/go/v1/usage`，鉴权为 `Authorization: Bearer <key>`） |
| `CUSTOM_API_KEY` | 自定义 HTTP / OpenAI 兼容中转站 |

> ⚠️ 自定义模型面板里的「凭据名」决定密钥写进哪个 ref。换厂商时请确认这一栏跟着模板变了，否则新密钥会写进上一家厂商的凭据名里（覆盖掉原来的 key）。v679 起新增模型会自动跟随模板。

## 卸载

```powershell
dsh plugin --profile web remove dsh-whale-widget
```

## 从旧手动安装升级

如果你之前按旧方式手动安装过（复制 `whale-balance.mjs` + 改 `cordis.patch.yml`），先清理：

```powershell
$web = "$env:USERPROFILE\.dsh\profiles\web"

Remove-Item "$web\whale-balance.mjs" -ErrorAction SilentlyContinue
Remove-Item "$web\whale-balance.cjs" -ErrorAction SilentlyContinue
Remove-Item "$web\DSniang1.png" -ErrorAction SilentlyContinue
Remove-Item "$web\DSniang02.png" -ErrorAction SilentlyContinue
```

然后编辑 `$web\cordis.patch.yml`，删除这段旧补丁：

```yaml
- insert:
    - id: whale-balance-widget
      name: ./whale-balance.mjs?v=1
```

如果里面只有这段，直接改成：

```yaml
[]
```

清理后再执行上面的安装命令。

## 验证

```powershell
dsh --profile web --dump-config | Select-String -Pattern "whale"

curl http://127.0.0.1:3080/dsh-whale/balance.json
curl http://127.0.0.1:3080/dsh-whale/size.json
curl http://127.0.0.1:3080/dsh-whale/widget.js
curl http://127.0.0.1:3080/dsh-whale/image.png
curl http://127.0.0.1:3080/dsh-whale/audio.json
```

- `/dsh-whale/balance.json` → 200 JSON，含 `{ok:true, totalBalance, currency, todayUsage}`
- `/dsh-whale/size.json` → GET 返回配置；PUT 写入
- `/dsh-whale/widget.js` → 200 JS（前端挂件本体）
- `/dsh-whale/image.png` → 200 `image/png`
- `/dsh-whale/audio.json` → 200，含 `groups` / `fragments`（其中内置片段 `exp_orb` = Minecraft·经验球、`end_a` = A）
- `/dsh-whale/audio-fragment.wav?id=exp_orb` → 200 `audio/wav`（内置任务结束音；无需用户导入）
- `/dsh-whale/audio-fragment.wav?id=end_a` → 200 `audio/wav`（内置任务结束音 A）
- 浏览器 F5 后右下角出现挂件

> ⚠️ **关于上面这些 `curl`**：全部 21 个 `/dsh-whale/*` 路由现已接入 **DSH 浏览器信任栅栏**（`connection.requestRejection`）。
> 因此**不带会话凭据的裸 `curl` 会返回 401**（伪造 `Host` 头则是 403）—— 这是预期行为，不是接口坏了。
> 想验证接口是否存活，看返回 **401/403** 即说明路由已注册且栅栏在工作；在浏览器里访问同一条路径（带会话）才是 200。

## 常见问题

- **挂件不出现**：确认安装命令成功；`dsh --profile web --dump-config` 里能看到 `dsh-whale-widget`；重启 `dsh web` 后 F5。
- **图片/音效不显示、没声音**：确认插件包内 `assets/` 完整（`DSniang1.png`、`*.mp3`、`minecraft-exp-orb.wav` 等）；缺失时相关功能静默降级。
- **余额报「未配置 DEEPSEEK_API_KEY」**：去 DSH 凭据里配置。
- **今日已用显示 `--`**：先等一次成功的余额观测；统计从该观测时刻开始，起点之前的消费不在此区间内。
- **今日已用与官网有差异**：先核对同一账户、同一币种与同一统计区间；若有充值或其它余额调整，用「小鲸鱼记账 → DeepSeek（内置）→ 设置 → 余额校正」填写实际到账金额。余额接口只返回余额快照、不提供充值流水，充值与消费发生在同一次刷新间隔时需要实际到账金额才能校正。
- **充值后消费数字没变**：这是预期行为——充值不会增加消费；数字上方会出现「待核对余额调整」，提示你补充本统计区间的累计到账金额。
- **每轮消耗不显示**：确认菜单里「每轮对话后自动显示消耗金额」已勾选；一轮对话要完整结束（`turn/end`）才结算。余额变化泡泡与消耗泡泡抢层时，提醒会退化为居中卡片。
- **每轮消耗泡泡的内容**：菜单 → 每轮消耗提示 → 「自定义提示」里编辑（模块化，金额用 `{cost}`）；这里同时能设自动关闭秒数与任务结束音效。
- **任务结束音没响**：该开关默认**关闭**（默认已选中内置的 Minecraft·经验球；另有内置预设 **A** 可选）；到菜单 → 每轮消耗提示 → 「自定义提示」里打开即可。若自定义片段文件被删，会回退/静音。
- **手机上拖不动鲸鱼**：本版本已用触摸事件接管拖拽，请硬刷新页面拿到最新 `whale-widget.js`；仍不行请反馈浏览器型号。
- **隐藏了菜单按钮怎么进菜单**：电脑端右键鲸鱼，手机端长按鲸鱼约 1.5 秒。
- **改了前端代码不生效**：前端 `assets/whale-widget.js` 由宿主按 mtime 热读取，**硬刷新**（Ctrl+F5）即可；改了宿主 `lib/index.js` 必须**重启 `dsh web`**。
- **模型名看不懂**：账本记录的是 API 模型 id；`deepseek-flash` 即 DeepSeek-V4.1-Flash，旧名 `deepseek-v4-flash` / `-vision-exp` 现在也由同一颗 V4.1-Flash 提供并按 Flash 计价（面板里已加标注）。

## 定价表

金额按 **CNY / 百万 tokens** 计，`[空闲时段, 高峰时段]`；高峰 = 工作日 9:00–12:00、14:00–18:00（北京时间），空闲价为高峰价的一半；2026-08-23 起周末全天按谷价。表在 `lib/index.js` 顶部 `PRICING` / `BASE_PRICE` / `PRO_PRICE`，官方调价时改这里。

| 模型 | 缓存命中 | 缓存未命中 | 输出 |
|---|---|---|---|
| `deepseek-flash`（DeepSeek-V4.1-Flash） | 0.02 / 0.04 | 1 / 2 | 4 / 8 |
| `deepseek-v4-pro`（V4 Pro） | 0.15 / 0.30 | 4.5 / 9.0 | 13.5 / 27.0 |

> 旧模型名 `deepseek-v4-flash`、`deepseek-v4-flash-vision-exp` 仍可调用，按 Flash 价计费。

## 开发与维护

- 仓库里 `lib/index.js` 是宿主本体、`lib/accounting.mjs` 是记账内核（定点金额运算 + 观测/校正账本）、`assets/whale-widget.js` 是前端本体；宿主改动（含记账内核）需重启 `dsh web`，仅前端改动硬刷新页面即生效。
- 完整规格、视觉参数、路由清单、架构结论与生成提示词见 [`whale-widget-prompt.md`](whale-widget-prompt.md)。
- 本地联调：`dsh plugin --profile web add link:.` 后，改前端 → Ctrl+F5；改宿主 → 重启 `dsh web`。

## 致谢

- 充值记账修复方案（余额上升与下降分开记账、显式余额校正公式、按账户/币种隔离观测窗口、账本原子写入与迁移备份）由 GitHub 用户 [@Yang-huai406](https://github.com/Yang-huai406) 独立设计并实现为可运行的修复分支；**0.3.1 在该方案基础上移植合并**，并保留本项目既有的音效修复。感谢他的支持。
- OpenCode Go 订阅额度（多窗口额度 `quota.json.windows`、按窗口展示与紧凑重置倒计时、「订阅额度」模块的窗口选择）由 GitHub 用户 [@ELFsay](https://github.com/ELFsay) 提交（[#99](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/pull/99)），已合入 `main`。感谢他的贡献。
- **历史合并 PR 的贡献者**（按合入顺序，均已进入本仓库代码 / 发布流程）：
  - [@ztzpro](https://github.com/ztzpro)（[#1](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/pull/1)）：把余额小鲸鱼挂件**改造成标准 DSH 插件包**（今天的 `cordis.patch.yml` + bundle 结构就来自这里）；
  - [@under-the-ocean](https://github.com/under-the-ocean)（[#6](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/pull/6) / [#7](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/pull/7)）：push 触发**自动发布 npm**、升级 npm 以支持 Trusted Publishing（OIDC）—— 现在的发版流程仍是这套；
  - [@21253soursweetlemon](https://github.com/21253soursweetlemon)（[#16](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/pull/16) / [#18](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/pull/18)）：gif 加载失败降级为文字台词、右缘滚动条避让、**锚点位置记忆**（窗口变化不悬空、能吸回原位 —— 位置系统的起点）；
  - [@fangbm](https://github.com/fangbm)（[#15](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/pull/15) / [#19](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/pull/19) / [#31](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/pull/31) / [#33](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/pull/33) / [#46](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/pull/46)）：多币种余额顺序稳定、每轮消耗泡泡两处缺陷、**周末全天谷价**、记账币种感知、发布时自动建 Release 并生成 PR changelog；
  - [@xiaolinnnnnnn](https://github.com/xiaolinnnnnnn)（[#26](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/pull/26)）：Windows 桌面端（Tauri v2）重构。

## 许可证

本项目**代码**基于 **MIT License** 开源，详见 [LICENSE](LICENSE)。

⚠️ **`assets/` 下的美术素材（图片 / 动图 / 音效）不在 MIT 覆盖范围内**：它们由维护者提供或使用 AI 工具生成，按「原样（as-is）」随插件分发、仅供运行本插件使用，不授予再许可、也不声明为原创作品。逐项来源、元数据清理说明与权利主张（takedown）方式见 **[PROVENANCE.md](PROVENANCE.md)**。
