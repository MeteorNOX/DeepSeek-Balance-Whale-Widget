# Video Project 5 —— 人物透明底成品

**源素材**：`Video Project 5.mp4`（1920×1080 / 30fps / 122 帧 / 4.07 秒 / 含 AAC 音轨）
**画面**：蓝色女仆装角色吃米饭，原背景为**纯黑 RGB(0,0,0)**，人物未被画幅裁切。
**结果**：背景全部去干净，只留角色（含呆毛、发梢、蝴蝶结等细节），保留原始音轨。

---

## 交付文件

| 文件 | 规格 | 用在哪 |
|---|---|---|
| `character_transparent_1920x1080.mov` | ProRes 4444 + alpha（125 MB） | Premiere / AE / DaVinci / FCP |
| `character_transparent_tight.mov` | ProRes 4444 + alpha，828×842（91 MB） | 同上 |
| `character_transparent_1920x1080.webm` | VP9 + alpha（1.5 MB） | Chrome / Edge / Firefox / OBS |
| `character_transparent_tight.webm` | VP9 + alpha，828×842（1.5 MB） | 同上 |
| `preview_checkerboard_1080p.mp4` | H.264（无 alpha）+ 棋盘格底（1.4 MB） | **任何播放器快速验收** |
| `png_sequence_1920x1080/0000.png … 0121.png` | RGBA PNG，原画幅 | 通用，任何软件 |
| `png_sequence_tight/0000.png … 0121.png` | RGBA PNG，裁剪版 | 通用 |
| `qc_decoded_webm.png` | 成品视频解码后的对比图 | 检查用 |

**原画幅 vs 裁剪版**：原画幅保持人物在原始画面中的位置，叠回原视频/原构图可直接对齐；
裁剪版只保留人物（四周留 8px），适合当贴纸、挂件素材或叠到别的画面上。

---

## 使用须知

1. **透明通道只有编辑软件和浏览器能显示**。Windows 资源管理器缩略图、系统自带播放器、
   微信/QQ 会显示成黑底或白底，这不是文件坏了 —— 想快速确认效果就播放
   `preview_checkerboard_1080p.mp4`。
2. **ProRes 4444** 需要软件支持 alpha（AE / Premiere / DaVinci / FCP 正常；
   QuickTime Player 会显示成黑底）。
3. **WebM/VP9 alpha** 在 Chrome / Edge / Firefox / OBS 正常；Safari 与 iOS 不支持 VP9 alpha
   （需要 HEVC with alpha，本机 ffmpeg 无法生成，如有需要请告知）。
4. PNG 序列帧号从 `0000` 开始，30fps。
5. 所有成品**保留原音轨**（PNG 序列无声）。
6. PNG/ProRes 使用**直通 alpha（straight alpha，未预乘）**；透明区域的 RGB 做了
   **色彩外扩（edge bleed）**填满，因此缩放、旋转、二次压缩时不会出现黑边。

---

## 抠像质量（实测，以第 61 帧为样本解码回比）

| 成品 | alpha 平均误差 | 边缘带平均误差 | 实心区 RGB 平均误差 |
|---|---|---|---|
| ProRes 4444 | 0.0000 | 0.0021 | 0.04 / 255 |
| WebM VP9 | 0.0001 | 0.016 | 1.86 / 255 |

帧间 alpha 差异集中在轮廓处，是人物呼吸/微动的真实运动，未做时域模糊，边缘不糊。

---

## 方法（`../vbg_work/` 内脚本，可复现）

素材是**纯黑底**的赛璐璐上色插画，合成模型就是 `C = a·F`（背景为 0），所以没有用
神经网络抠像（试过 anime-seg 的 `isnetis.onnx`，对本素材会把角色判成半透明，已放弃），
而是直接反解：

1. `strong = max(R,G,B) > 26` —— 确定为实心画稿的部分；
2. 以 `max > 8` 作掩膜做形态学重建，把与主体连通的像素纳入 `keep`（背景压缩噪声块不连通，被排除）；
3. 距实心区 >4px 的内部像素直接判为实心；只有距边缘 ≤4px 的窄带才做软边；
4. 软边处按最小二乘解 `a = <C,F>/<F,F>`，参考色 `F` 取最近的实心像素颜色；
5. 颜色按黑底反解 `F = C/a`，透明区用最近前景色外扩填充。

关键点：一开始弱阈值取了 3，把 H.264 的 8×8 块噪声（亮度可到 9 左右）当成半透明前景吸了进来，
人物周围出现一圈灰雾；把软边限制在实心区 4px 内、噪声阈值提到 8 之后消失。

脚本：`matte.py`（试神经网络）→ `extract2.py`（黑底反解，产出 alpha/color npy）
→ `render.py`（出 PNG 序列 + 三种视频）→ `mux_audio.py`（混音轨）→ `verify.py`（校验）。
