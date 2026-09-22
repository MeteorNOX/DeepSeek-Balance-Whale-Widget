# matte_work 保留说明

原来的作图中间产物（帧数据、大图、试错脚本）已清理，只留下面几个关键脚本备查。

## 保留的脚本

| 文件 | 作用 |
|---|---|
| `DEFINITIVE2.py` | **最终有效的那一版**：从中间帧数据导出 `assets/DSniang_eating_rice_2.*`。含 R/B 通道校正 + 编码 + 校验 |
| `export_3.py` | 生成 `frames610_3.npy` 中间帧（含 edge bleed 处理） |
| `look.py` | 生成带红/蓝色卡的自检对比图，用来确认"看图这件事本身没被通道顺序搞混" |

真正跑通的产出是 `assets/DSniang_eating_rice_2.{webm,png,webp}`，
详细规格见 `assets/DSniang_eating_rice_2.README.md`。

## 两个已修的坑（重做素材时一定要知道）

1. **`cv2.imwrite` 不接受负步长数组**。
   `img[..., ::-1]` 是负步长视图，交给 `cv2.imwrite` 写 4 通道 PNG 会**静默破坏 alpha**
   （alpha 均值 167 → 118、不透明占比 0.651 → 0.192，画面发白）。正确写法：
   ```python
   np.ascontiguousarray(cv2.cvtColor(np.ascontiguousarray(x), cv2.COLOR_RGBA2BGRA))
   ```
2. **上游 1080p alpha 序列的 RGB 是 R/B 互换的**。
   `output/VideoProject5_transparent/png_sequence_1920x1080/`（已删）里帧的主色调 hue 是
   1.7°（红），而参考素材 `DSniang1.png` 是 231°（蓝）。直接用会得到橙色/棕色的角色。
   重做时要么修上游，要么在导出前对 R/B 做一次互换。

## 另一条路径

透明抠像那套（纯黑底反解 `C = a·F`，不依赖神经网络）在 `../vbg_work/`，那边保留了
`extract2.py` / `render.py` / `mux_audio.py` / `verify.py`。
