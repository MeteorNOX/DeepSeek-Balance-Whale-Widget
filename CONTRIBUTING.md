# 贡献指南.CONTRIBUTING

感谢你愿意贡献！为了不让任何人的努力白费，请先花一分钟读完本文，无论你是人类，鲸鱼娘，还是硅基生命！

## 如何贡献？

- 欢迎在issue任何bug反馈和功能建议！bug一定会修，但不一定所有的功能建议都会采纳，这是为了避免代码无限变臃肿成为我们痛恨的一些国产软件的样子。issue请明，你想实现这个issue，还是你希望维护者或者其他人帮你实现这个issue
- pr必须关联 issue 并写 `close #编号`。你可以自由发起任何关联bug-issue的pr，但是feat（新功能）pr或者refactoring（重构）pr必须关联到已经被维护者批准的issue，否则会被关闭

## 有什么需要注意的？

- 可以完全用ai发起pr，但我们希望pr的正文描述自己来写，说明你自己做了什么。完全由ai生成的pr可能关闭
- 代码请保持简洁，解耦性——现有的巨大单文件和耦合代码会慢慢拆分，请不要增加后续拆解难度

## 仓库结构和说明

如果你的pr更新了仓库结构，请顺便更改CONTRIBUTING中的本部分以保持最新

### 分支

| 你要改的东西                                                 | 用哪条分支       | 说明                                     |
| ------------------------------------------------------------ | ---------------- | ---------------------------------------- |
| **DSH Web 界面里的挂件**（本仓库的主产品，README 描述的就是它） | **`main`**       | npm 包 `dsh-whale-widget`                |
| Codex 桌面伴随挂件                                           | `For-Codex`      | npm 包 `api-balance-whale`，**独立维护** |
| Windows 桌面版（Tauri）                                      | `For–WinDesktop` | /                                        |

在当前，平台移植类改动请提到对应分支。提到 `main` 会被关闭，未来三个分支会整合成同一个 —— 除非你的多平台重构方案issue通过了维护者的批准

### 目录结构

下面是你打开仓库第一时间看到的东西。行数按仓库内 LF 内容统计（git 里的真实内容，不是 Windows 工作区的 CRLF），口径与维护者的自检脚本一致。

```
dsh-whale-widget/
├── package.json                     35 行   DSH bundle 插件元数据（dsh.bundle.patch → cordis.patch.yml）
├── cordis.patch.yml                 15 行   插件挂载声明
├── README.md                       471 行   安装 / 使用 / 定价 / 完整目录结构（动代码前先读它）
├── PROVENANCE.md                    35 行   素材来源与许可范围（动 assets/ 前必读）
├── whale-widget-prompt.md          202 行   完整规格、视觉参数、路由清单、维护提示词（二次开发入口）
│
├── lib/
│   ├── index.js                  3,953 行   宿主侧本体：23 条路由 + 记账接线 + 音效/图片/角色服务
│   └── accounting.mjs              252 行   记账内核：定点金额运算 + 余额观测/校正账本
│
├── assets/
│   ├── whale-widget.js          16,853 行   前端挂件本体（**宿主按 mtime 热读这个单文件**）
│   ├── DSH2.png / DSniang1.png / DSniang02.png   角色图与 README 展示图
│   ├── rua.gif / bubble-petpet.gif / bubble-money1.gif
│   ├── Ya1.mp3 / Ya2.mp3 / D1.mp3 / D2.mp3  预置音效
│   └── minecraft-exp-orb.wav / task-end-a.wav
│
├── tools/
│   └── z-layer-audit.mjs            59 行   浮层 z 层级自检（CI 与发布流程都会跑）
│
└── .github/workflows/
    ├── ci.yml                       68 行   push / PR 到 main：图层审计 + 语法 + 开发机路径扫描
    └── publish.yml                 186 行   **手动触发**：发布 npm + 建 GitHub Release
```

> 上面的行数会随代码变化，不是硬约束。想核对或更新，用 `git ls-tree -r --long main` 看文件清单，用 `git show main:<路径>` 自行统计行数即可；改完请顺手更新本节和 README 里对应的数字。

### 发布流程（改版本号前必读）

**发布是手动触发的，push 不会发版。**

- **日常检查**：`.github/workflows/ci.yml` 在 push 到 `main` 和 PR 到 `main` 时自动跑，只做检查、权限 `contents: read`、**永不发布**。它跑三件事：图层自检、两个前端/宿主文件的语法检查、以及"发布副本不得含开发机绝对路径"的扫描。
- **真正发版**：`.github/workflows/publish.yml` **只有手动触发**（GitHub Actions 页面的 Run workflow，或 `gh workflow run publish.yml`）。它可以填一个"发版原因"（会写在 Release 说明最前面），也支持 `dry_run` 演练 —— 跑完全部门禁并生成 Release 说明，但**不发布、不建 Release**。
- **版本号不自动递增**：发出去的版本号就是 `package.json` 里的 `version` 字段。改版本号 → push → 手动触发，才会发布 npm 并创建 `v<version>` tag 与 GitHub Release。
- **为什么必须手动**：npm 同名版本一旦发布就**不能覆盖**，只能 deprecate。所以"某次 push 恰好带了 version 变更就自动发布"是不安全的，这一步必须有人把关。
- **发布前的门禁**：`publish.yml` 会在发布前把与 `ci.yml` 相同的检查再跑一遍（图层审计 + 语法 + 开发机路径），**审计不过就不允许发布**；另外如果 `package.json` 的版本号在 npm 上已经存在，会直接跳过发布，避免重复触发把 workflow 炸掉。
- **发布副本必须先 strip**：宿主发布前必须跑一次 `_strip-dev-paths.mjs --apply`（它会删掉 `RUA_GIF_CANDIDATES` / `IMAGE_CANDIDATES` 这类开发机候选路径）。忘了跑的后果是老用户拿到的包会去读不存在的本机路径 —— 这正是 CI 里那个 `TestBox` 扫描要拦的东西。
- 发布只允许在 `main` 上触发：手动触发时如果 `Use workflow from` 选成了别的分支，workflow 会硬失败并提示。

### 运行时数据放

运行时的东西都在 `$DSH_HOME`（默认 `~/.dsh`）：

| 文件 / 目录                | 用途                                           |
| -------------------------- | ---------------------------------------------- |
| `.dshw-size.json`          | 外观与开关（缩放、音量、音效组、吸附相关）     |
| `.dshw-usage.json`         | 记账账本 + 按日余额观测 + 用量设置             |
| `.dshw-turn.json`          | 每轮消耗的 seq（避免热重载后把新轮次当旧轮次） |
| `.dshw-bubble.json`        | 自定义泡泡配置（点击序列 + 模块库）            |
| `.dshw-api.json`           | 自定义 API 模型注册表（**不含密钥**）          |
| `.dshw-usage-archive.json` | 账本归档（明细 90 天 / 2 万条，逐日 365 天）   |
| `.dshw-codex.json`         | Codex 本地会话统计缓存（**不含任何凭据**）     |
| `whale-roles/`             | 自定义角色图 + `roles.json` 索引               |
| `whale-audio/`             | 音频片段 + `audio.json` 索引                   |
| `whale-bubble-imgs/`       | 泡泡图库 + `bubble-imgs.json` 索引             |

### 关于那两个超大文件

`assets/whale-widget.js`（16,853 行）和 `lib/index.js`（3,953 行）确实已经很大，我们知道而且正在计划拆分，在拆分落地之前，请按拆分友好的方式写：新逻辑尽量自成一块、少依赖全局状态、不要加深既有耦合
