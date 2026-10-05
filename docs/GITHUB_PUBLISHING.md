# Codex-v0.4(fixed) 打包与发布流程

本修复版已获得明确发布授权，目标为 For-Codex 分支及独立 Release。以下记录构建与发布流程；实际远端状态以 GitHub 为准。

## 目标标识

| 项目 | 值 |
| --- | --- |
| 仓库 | `MeteorNOX/DeepSeek-Balance-Whale-Widget` |
| 产品分支 | `For-Codex`，与 DSH 主线独立 |
| 对外名称 / Release 标题 | `Codex-v0.4(fixed)` |
| 发布标签 | 精确为 `codex-v0.4.0(fixed)`，括号属于标签本身 |
| 内部版本 | `0.4.1`，插件/package/lockfile/runtime 应一致 |
| 构建标识 | `auto-probe-fixed-20261005` |
| Latest | 保留 DSH 主线，发布必须 `makeLatest: false` |

仓库所有者和上游作者是 MeteorNOX；Yang-huai406 为 Codex 适配协作者；保留 1llysviel 的 macOS PR #128 及其它已有来源，不将协作者改写为所有者。

## 本地构建与隐私检查

需要 Python 3.10+；Node.js 24+ 用于运行和开发测试。不要以 Python 优化模式执行构建器，它会拒绝可能关闭检查的模式。

在源码根目录运行：

```powershell
python scripts/build-release.py --release-tag "codex-v0.4.0(fixed)" --publication-ready
```

默认输出到 `dist`，也可用 `--output "<本地输出目录>"` 指定位置。本命令只把发布标签写入本地清单，不创建 Git 标签、不推送、不上传。`--publication-ready` 记录本次明确发布授权，清单为 `publicationReady: true`。构建时 `published: false` 只是构建快照；脚本自身从不上传，远端结果须另行核验。

核对输出包括：

- `Codex-v0.4(fixed).zip` 与 `Codex-v0.4(fixed)-source.zip`。
- 两个包各自的 `.sha256` 和 `release-manifest.json`。
- 本次交付检查生成的 `verification-report.json`，记录真实执行的检查，不伪造未运行的验收。

安装包与源码包均需检查；源码包额外保留开发测试，安装包不含测试集。公开包不得含用户配置、密钥、账本、聊天、原始日志、测试截图录屏、私有安装回执、缓存、Electron 下载、嵌套旧包或 `.git` 历史。链接/junction 和异常文件按构建器规则处理，不手工跳过隐私检查。

解压到新的干净目录，核对 manifest/package/lockfile/runtime 版本、构建标识、入口脚本、README、文件清单和 SHA-256。不要把维护者的运行数据或私有回执放进包；接收者通过安装器生成自己的回执。

当前运行构建已有 482 项自动测试、9 项隐私门禁及 Electron 6 组流程、7 个布局样本、8 张截图的通过记录。本轮若只整理文档与打包，不把它们写成重新执行了整套运行测试；成品检查按本次实际结果单列。合成测试不等于 Mac、所有第三方账号或长期验收。

## 正文与标签准备

发布正文使用根目录 [RELEASE_NOTES.md](../RELEASE_NOTES.md)，新用户操作使用完整 [README](../README.md)，不再把旧版说明作为本次正文。

可先校验标签格式并查看本地同名标签是否存在：

```powershell
git check-ref-format "refs/tags/codex-v0.4.0(fixed)"
git tag --list "codex-v0.4.0(fixed)"
```

括号标签在 shell 参数中保持引号。发布标签不等于已经创建；如已有同名标签，先确认指向的提交，不移动或覆盖它。按下列步骤推送已核验提交和新标签，并上传 Release。

## 发布步骤

1. 重新读取远端分支、标签、Release 和协作规则，确认 `codex-v0.4.0(fixed)` 尚未占用，不把当前本地状态当远端事实。
2. 审查最终源码差异和署名，用普通提交或要求的 PR 流程整理，不改写远端历史，不用 ZIP 覆盖整个仓库。
3. 把待发布提交与实际构建包绑定，重新核对成品清单及哈希。仅在明确授权后考虑 `--publication-ready`；构建器本身依然不会上传。
4. 使用精确标签 `codex-v0.4.0(fixed)` 和 fixed 正文，显式设置 **`makeLatest: false`**；GitHub REST 对应 `make_latest: "false"`，不要替代 DSH 主线 Latest。
5. 上传已核验安装包、源码包、SHA-256、清单/报告后，再核对远端附件哈希、标签目标及链接，保留旧 `codex-v0.4.0` 和主线发布。
6. 只有实际完成后才记录发布时间、URL、提交与结果；部分 issue 和未验收平台不得批量宣称完成。

发布后核对分支、标签、附件哈希和主线 Latest。协议边界见 [fixed 说明](AUTO-PROBE-FIXED.md)，部分修复见 [issue 状态表](ISSUE-STATUS-FIXED.md)。
