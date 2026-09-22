# DSniang_eating_rice_2 —— 挂件用「吃饭」动画素材

给鲸鱼挂件做「AI 完成工作 → 播放一次吃饭动画 → 切回 DSniang1.png」用的素材。
全部为 **610×610**，与 `DSniang1.png` 的画布规格一致。

| 文件 | 规格 | 体积 | 用途 |
|---|---|---|---|
| `DSniang_eating_rice_2.webm` | VP9 + alpha，610×610，30fps，122 帧 / 4.07s | **829 KB** | **主用**：`<video>` 元素播放 |
| `DSniang_eating_rice_2.png` | 单帧 RGBA（第 1 帧，无损） | 306 KB | 静态回退 / 命中检测探针 |
| `DSniang_eating_rice_2.webp` | 动图 WebP（RGBA），122 帧 | 3.28 MB | 备选：不想引入 `<video>` 时用 `<img>` |

## 尺寸与对位（对齐 DSniang1.png）

```
素材画布            610 × 610
人物 bbox           x 45–609, y 11–609   （DSniang1.png 为 x 45–609, y 10–609）
右边距 / 下边距     0 / 0                （与 DSniang1.png 相同）
不透明像素占比      0.651                （DSniang1.png 为 0.652）
主色调 hue          236–239°             （DSniang1.png 为 231°，同为蓝色）
```

人物右下角对齐画布右下角，可直接复用现有 CSS
`.dshwv-img{right:0;bottom:0;width:59.45%;height:59.45%}`，无需新增定位规则。
同样落在 610×610 内，`lib/index.js` 的命中检测（素材拉伸到 610×610 取 alpha）
与缩放/翻转坐标映射都不受影响 —— 这正是 `DSniang02.png`（1026×1026）踩过的坑。

## 实测校验（第 61 帧）

| 成品 | 对比源帧 | alpha 平均误差 | RGB 平均误差 |
|---|---|---|---|
| PNG | **逐字节相同**（max diff = 0） | 0 | 0 |
| WebM VP9 | 相对源帧 | 0.07 / 255 | 1.96 / 255 |
| WebP | 相对源帧 | 0.00 / 255 | 3.01 / 255 |

- alpha 分布：mean 167.0 / 不透明占比 0.652（与参考素材 166.7 / 0.652 一致）
- 全 122 帧主色调均为蓝色
- 白底合成抽检：边缘干净，无黑边、无脏点
- 自检对比图（带红/蓝色卡）：由 `../matte_work/look.py` 重新生成

## alpha 约定

- **直通 alpha（straight，未预乘）**，8bit。
- 全透明像素的 RGB 用最近的前景像素颜色填充（edge bleed），
  缩放 / 浏览器预乘合成 / 二次压缩都不会从透明区拉出黑边。

## 制作中的两个坑（已修，勿重蹈）

1. **`cv2.imwrite` 不接受负步长视图**。用 `img[..., ::-1]` 这种切片再交给 `cv2.imwrite`
   写 4 通道 PNG，会**静默破坏 alpha 通道**（alpha 均值从 167 掉到 118、
   不透明像素比例从 0.651 掉到 0.192，画面发白）。
   必须写成 `np.ascontiguousarray(cv2.cvtColor(np.ascontiguousarray(x), cv2.COLOR_RGBA2BGRA))`。
2. **上游 alpha 序列的 RGB 通道是 R/B 互换的**。
   当年那套 1080p 透明成品的帧蓝红是反的（主色调 hue 1.7° = 红，而非 231° = 蓝），
   该中间产物已清理。本次导出已对 R/B 做了一次互换校正，
   **下游不要再对这个素材做通道互换**。

## 集成注意

1. **首尾不是无缝循环**：第 1 帧与第 122 帧平均差 13.6。按「播放一次后切回静态图」用没问题；
   要循环待机需先对齐首尾。
2. **建议叠层 + opacity 切换**，不要直接换 `img.src`：动画资源异步加载，直接换 src 会闪空白。
   `<video>` 常态叠在 `<img>` 上，靠 `play()` / `ended` 控制 opacity 更稳；
   `dshwv-left` 翻转时记得一起镜像。
3. **触发点已现成**：前端轮询 `/dsh-whale/last-turn.json`，`seq` 递增即调
   `showCostBubble()`（`lib/index.js:1404`），后端在 `turn/end` 结算（`lib/index.js:1460`）。
   注意后端按 session 分桶，**子代理完成的 turn 也会触发**，只想主会话播放需筛一下。

## 源素材与可复现脚本

- 原始素材：`Video Project 5.mp4`（1920×1080，30fps，122 帧，含音轨）
- 本次导出：`../matte_work/DEFINITIVE2.py`（R/B 校正 + 编码 + 校验）、
  `../matte_work/look.py`（带色卡自检对比图）
- 中间产物（1080p 抠像序列、610×610 帧数据）已清理；重做须知见 `../matte_work/README.md`
