# 皮肤化改造说明（PR 分支 pr-skins）

> 基于 MeteorNOX/DeepSeek-Balance-Whale-Widget 的定制。
> 原则：**默认仍是鲸鱼娘，皮肤全部可选**（assets/skin/ 目录，不替换默认资源）。
> 仓库附带 `tiaotiao` 示例皮肤；更多形象可直接放入 `assets/skin/<name>/DSniang1.png` 生效（如奶龙）。
> 附带音效：小黄鸭 / 音效1 / 猫喵（E1/E2）/ 奶龙大笑（N1 按压 + N2 回弹）。

## 改动清单

### 1. 皮肤机制（核心）
- 宿主端：`/dsh-whale/image.png?skin=<name>` —— 先查 `assets/skin/<name>/DSniang1.png`，不存在则回退默认鲸鱼娘
- 前端：菜单新增「形象」选择项（鲸鱼娘(默认) / 跳跳喵 / 奶龙 / 奶龙·大笑），localStorage 记忆选择，切换即时生效
- 默认资源未动：`assets/DSniang1.png` 仍是原版鲸鱼娘（`DSniang1.orig.png` 副本保留）

### 2. 三款皮肤素材（assets/skin/）
| skin | 内容 | 制作方式 |
|---|---|---|
| `tiaotiao` | 跳跳（像素风坐姿猫） | `tiaotiao-base.png` 蓝底颜色键抠图（glob 色键会打穿白肚皮，故用 flood-fill 方案见下） |
| `naillong` | 奶龙（跳跃姿势） | 白底泛洪填充抠图（flood-fill 从边缘扩展，避免吃掉乳白肚皮） |
| `naiwa` | 奶龙·大笑（拍肚大笑姿势） | 从应用截图 crop + 白底泛洪填充 |

抠图脚本：`make_skins.py`（PIL + scipy.ndimage 连通域 flood-fill + 边缘羽化 + 内容裁剪）

### 3. 待机动画
- `.dshwv-img` 2.8s 循环呼吸浮动（上下 1.5% + 微缩放）；不与按压（`.dshwv-body`）、左吸附翻转（`.dshwv-root`）冲突

### 4. 音效
- 新增「猫喵」音效组：`assets/E1.mp3`（按压 pip）/ `assets/E2.mp3`（回弹 boop），ffmpeg 合成
- 音效选择菜单新增「猫喵」项
- ⚠️ "我是奶龙"/"雷霆奶龙笑" 为官方配音/版权音效，**不放入本仓库**；个人本地使用可从剪映音效库等平台获取（平台内使用约定），或自行录制

### 5. 预览
- `preview.html`：本地双击预览，`?skin=tiaotiao|naillong|naiwa|default` 切换，无需重启 DSH
- `preview-<skin>.png`：各皮肤预览截图

## 进 DSH 使用
重启 DSH（关 "DSH Server" 窗口 → 重新启动脚本）→ F5 → 菜单「形象」选择。

## 提 PR 建议
上游若愿接纳：本分支保持了"默认不动、皮肤可选"的姿势，commit 信息建议同为
`feat: optional skins (tiaotiao / naillong / naiwa) via /dsh-whale/image.png?skin=`
