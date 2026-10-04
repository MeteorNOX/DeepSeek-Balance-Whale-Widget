# v0.4.0 GitHub 发布与构建记录

**本次 v0.4.0 已获用户明确授权发布到 For-Codex 并创建 Release。** 发布者为协作者 Yang-huai406，仓库所有者仍为 MeteorNOX。发布授权不等于清单所有人工测试完成；保留真实账号、Mac、其他硬件和长期稳定性的未验证范围。

## 目标

- 仓库：MeteorNOX/DeepSeek-Balance-Whale-Widget。
- 产品分支：For-Codex，与 DSH 主线独立。
- 发布标签：codex-v0.4.0；标题：Codex v0.4 — API 余额小鲸鱼。
- 插件、package、lockfile 和运行时版本均为 0.4.0。
- 保留 MeteorNOX、Yang-huai406、macOS PR #128 作者 1llysviel 的署名与原代码来源。

## 本地重建

需要 Python 3.10+，运行 `python scripts/build-release.py`。优化模式会被拒绝，防止隐私校验被关闭。

输出安装包、源码包、各自 SHA-256 与 release-manifest.json。安装包排除测试与 GitHub 模板，源码包包含开发测试；两者都不包含个人配置、账本、原始会话、回滚回执、缓存或 Git 历史。Node.js 24+ 用于运行与自动测试；部分原生开发测试另需 Python/Pillow，普通安装不需要它们。

已获授权的发布构建使用：

```sh
python scripts/build-release.py --publication-ready --release-tag codex-v0.4.0
```

`--publication-ready` 必须同时提供 `--release-tag`，构建状态为 `release-ready-user-authorized`。构建器不执行上传，生成记录中的 `published: false` 只表示生成附件时尚未执行远端发布，不代表发布授权缺失。远端 Release 创建及附件核验后，另以真实发布记录说明 URL、tag 和提交；不要把历史构建或测试记录改写成当时已经发布。

`candidate-20261005` 保留为同一已测试代码的构建标识，不是当前发行状态。本包不预装 Electron，首次安装需要联网。

## 发布操作清单

1. 重新读取远端 For-Codex、标签、Release 和协作规则，核对新提交及标签占用情况。
2. 在远端最新基础上整理普通提交；用源码包对照差异，不把 ZIP 覆盖整个仓库。保留归档、macOS 来源和其他协作者文件。
3. 按仓库流程提交或创建 PR，不改写远端历史，不移动已有标签。
4. 对实际提交重建附件，核对版本、SHA-256、文案和测试报告；运行代码变化后重新验证。
5. 创建新标签和 Release，默认不改变 DSH 主线的 Latest 标记，上传安装包、源码包、SHA-256、manifest 和验证报告。
6. 复查远端附件与提交，仅按实际范围说明 issue；部分修复和跨平台待验收不能批量声称解决。保留 DSH 主线 Latest（本次核对为 v0.3.18）。

发布正文见根目录 RELEASE_NOTES.md；修复范围见 [版本说明](RELEASE-0.4.md)，未验收项见 [已知限制](KNOWN-ISSUES-0.4.md)。
